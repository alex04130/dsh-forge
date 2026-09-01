// description: 代理团队（team_*）：队长 + 角色成员 + 依赖任务板，成员间可直接互发消息。
import { collectModelEscalations, collectPresetEscalations, collectSandboxEscalations, installChildPolicy, validateEffort } from './lib/subagent-policy.mjs'
import { errText, jsonText } from './lib/forge-common.mjs'
import { registerTool } from './lib/forge-tools.mjs'

let idCounter = 0
function makeId(prefix) {
  idCounter += 1
  return prefix + '-' + Date.now().toString(36) + '-' + idCounter.toString(36) + '-' + Math.floor(Math.random() * 1679615).toString(36)
}
function callerId(exec, agents) {
  // Identity for team AUTHORIZATION decisions must come from the tool's own
  // execution context only. The initiator fallback previously misattributed
  // members as the captain in some call paths (a member was refused as
  // "you are the captain", and team_delete authorization could be spoofed);
  // without exec.agent we fail closed instead of guessing.
  if (exec !== undefined && exec.agent !== undefined && typeof exec.agent.id === 'string') return exec.agent.id
  return undefined
}
const TASK_STATUSES = ['pending', 'claimed', 'in_progress', 'completed', 'failed', 'cancelled']
const TASK_TRANSITIONS = {
  pending: ['claimed', 'cancelled'],
  claimed: ['in_progress', 'pending', 'cancelled'],
  in_progress: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
}

export default {
  inject: ['tools', 'agents', 'storage', 'subagents', 'llm', 'sessionmgmt'],
  apply(ctx) {
    const agents = ctx.agents
    const storage = ctx.storage
    const subagents = ctx.subagents
    const skills = ctx.get('skills')
    const presets = ctx.get('agentPresets')
    const approval = ctx.get('approval')
    const llm = ctx.get('llm')
    const sandboxPolicy = ctx.get('sandboxPolicy')
    const timer = ctx.get('timer')

    // team_wait 挂起注册表：成员调用 team_wait 后回合挂起，直到目标成员的
    // 消息到达、目标任务完成、队长发消息（消息到达即唤醒）、或超时。
    const waiters = []
    function wakeWaiters(predicate, payload) {
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        const w = waiters[i]
        if (predicate(w)) {
          waiters.splice(i, 1)
          try { w.finish(payload) } catch (error) { /* best-effort */ }
        }
      }
    }

    // Same delegation policy as spawn_model_subagent: team members get the
    // explicit mode / effort applied before their first prompt assembly, and
    // any escalation (model tier/series, preset capability face) asks the user.
    const policy = installChildPolicy(ctx, presets)

    let teamsUnit = undefined
    let openError = undefined
    const opening = (async () => {
      const backend = storage.backend.get('json')
      if (backend === undefined || backend.kv === undefined) throw new Error('no "json" storage backend with a kv facet is mounted')
      teamsUnit = await backend.kv.open({ name: 'agent_teams', version: 0, tables: ['team', 'archive', 'mail', 'template'], hasGlobal: false })
    })()
    opening.catch((error) => { openError = errText(error) })
    async function requireUnit() {
      await opening
      if (teamsUnit === undefined) throw new Error('team storage failed to open: ' + (openError ?? 'unknown error'))
      return teamsUnit
    }

    let chain = Promise.resolve()
    function enqueue(operation) {
      const next = chain.then(operation, operation)
      chain = next.then(() => undefined, () => undefined)
      return next
    }

    ctx.effect(() => () => {
      try { if (teamsUnit !== undefined) teamsUnit.close() } catch (error) { /* best-effort */ }
    })

    function cleanId(value) {
      const id = String(value ?? '').trim()
      if (id.length === 0 || id.length > 48) return ''
      if (!/^[0-9a-zA-Z_.\-]+$/.test(id)) return ''
      return id
    }

    async function getTeam(caller) {
      const teamsUnit = await requireUnit()
      const snapshot = await teamsUnit.loadAll()
      const table = snapshot !== undefined && snapshot.tables !== undefined && snapshot.tables['team'] !== undefined ? snapshot.tables['team'] : {}
      const direct = table[caller]
      if (direct !== null && typeof direct === 'object') return direct
      // 成员视角：按成员会话 id 反查所属团队
      for (const key of Object.keys(table)) {
        const record = table[key]
        if (record !== null && typeof record === 'object' && memberOf(record, caller)) return record
      }
      return undefined
    }

    function memberOf(team, id) {
      return Array.isArray(team.members) && team.members.some((m) => m !== null && typeof m === 'object' && (m.id === id || m.sessionId === id))
    }

    // Shared member-adding path: validation, escalation approval, spawn, and
    // registration. Used by both team_add_member and team_create(members: [...]).
    // Returns { ok, member?, error?, cancelled?, escalations?, mode? }.
    async function addMember(team, spec, agent, exec, toolName, persist) {
      const memberId = cleanId(spec.memberId)
      const role = String(spec.role ?? '').trim()
      if (memberId.length === 0 || role.length === 0 || role.length > 120) {
        return { ok: false, memberId: String(spec.memberId ?? ''), error: 'memberId must match [0-9a-zA-Z._-] (<=48) and role must be 1-120 characters' }
      }
      if (memberOf(team, memberId)) return { ok: false, memberId, error: 'member "' + memberId + '" already exists' }
      if (team.members.length >= 16) return { ok: false, memberId, error: 'team member limit (16) reached' }

      const explicitProvider = typeof spec.provider === 'string' && spec.provider.trim() !== '' ? spec.provider.trim() : undefined
      const explicitModel = typeof spec.model === 'string' && spec.model.trim() !== '' ? spec.model.trim() : undefined
      const explicitEffort = typeof spec.reasoningEffort === 'string' && spec.reasoningEffort.trim() !== '' ? spec.reasoningEffort.trim() : undefined
      const modeId = typeof spec.mode === 'string' && spec.mode.trim() !== '' ? spec.mode.trim() : undefined
      const sandboxMode = typeof spec.sandbox === 'string' && spec.sandbox.trim() !== '' ? spec.sandbox.trim() : undefined

      const route = policy.liveRoute(agent)
      const parentHeader = agent.session?.requestHeader?.()
      const parentPreset = presets !== undefined ? presets.composedPreset(agent.ctx) : undefined
      const parentModel = route.model ?? parentHeader?.config?.model
      const childModel = explicitModel ?? parentModel
      const childProvider = explicitProvider ?? route.provider
      const effort = explicitEffort ?? parentHeader?.config?.reasoningEffort
      let parentSandbox = undefined
      if (sandboxPolicy !== undefined && typeof sandboxPolicy.overrideOf === 'function') {
        try { parentSandbox = sandboxPolicy.overrideOf(agent.session) } catch (error) { parentSandbox = undefined }
      }
      if (parentSandbox === undefined) parentSandbox = sandboxPolicy !== undefined ? sandboxPolicy.defaultMode : undefined

      if (explicitEffort !== undefined && childProvider !== undefined && childModel !== undefined) {
        const check = await validateEffort(llm, childProvider, childModel, explicitEffort)
        if (check.ok === false) return { ok: false, memberId, error: check.error }
      }

      const escalations = [
        ...collectModelEscalations(parentModel, childModel),
        ...(await collectPresetEscalations({ parentPreset, targetPreset: modeId, presets })),
        ...collectSandboxEscalations(parentSandbox, sandboxMode),
      ]
      if (escalations.length > 0) {
        if (approval === undefined) {
          return { ok: false, memberId, error: 'adding this member escalates (' + escalations.join('; ') + ') but no approval service is mounted to confirm it' }
        }
        const outcome = await approval.request({
          agent,
          toolName,
          reason: 'team member escalation: ' + escalations.join('; '),
          signal: exec !== undefined ? exec.signal : undefined,
        })
        if (outcome !== 'allowed-once') {
          return { ok: false, memberId, cancelled: true, reason: 'the user did not allow this member escalation (approval outcome "' + String(outcome) + '"); no member was added', escalations }
        }
      }

      const persona = 'You are member "' + memberId + '" (' + role + ') of agent team "' + team.name + '" led by captain session ' + team.captain + '. Team goal: ' + String(team.goal ?? '(none)') + '.\n\nWork protocol:\n- Claim and work only on tasks assigned to you (team_claim_task / team_update_task).\n- When a task is done, call team_update_task with status "completed" and put your result in output.\n- Talk to the captain or other members with team_send_message (their ids are in team_status).\n- Check team_status for your inbox and task state before acting.\n- Load the agent-teamwork skill for the full team protocol.\n\nYour mission from the captain:\n' + String(spec.prompt ?? '')
      const agentOptions = {}
      if (explicitProvider !== undefined) agentOptions.provider = explicitProvider
      if (explicitModel !== undefined) agentOptions.model = explicitModel
      // Stage mode/effort BEFORE the spawn (startContinuable dispatches
      // agent/created synchronously before resolving — same timing contract
      // as modsub; see lib/subagent-policy.mjs installChildPolicy).
      const staged = policy.prepare({
        parentId: agent.id,
        ...(modeId !== undefined ? { mode: modeId } : {}),
        ...(effort !== undefined && typeof effort === 'string' ? { effort } : {}),
        ...(sandboxMode !== undefined ? { sandbox: sandboxMode } : {}),
      })
      // ── existingSessionId 分支：成员=已有 peer 会话（不 spawn）——"把现有项目会话拉成 team" 场景 ──
      // 用途：现有协作是 peer 会话（自编辑/前端/审计/grok/relay），拉进 team 共享任务板/消息墙，不新起会话。
      const existingSid = typeof spec.existingSessionId === 'string' && spec.existingSessionId.length > 0 ? spec.existingSessionId : undefined
      if (existingSid !== undefined) {
        staged.cancel?.()
        team.members.push({ id: memberId, sessionId: existingSid, role, createdAt: Date.now(), existing: true })
        if (persist !== false) await teamsUnit.putRecord('team', team.captain, team)
        return { ok: true, member: { id: memberId, sessionId: existingSid, role, existing: true } }
      }
      let started
      try {
        started = await subagents.startContinuable({
          provider: 'spawn',
          label: memberId + ' (' + role + ')',
          request: {
            prompt: [{ type: 'text', text: persona }],
            parent: agent,
            ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
          },
          signal: exec !== undefined ? exec.signal : undefined,
        })
      } catch (error) {
        staged.cancel()
        throw error
      }
      team.members.push({ id: memberId, sessionId: started.childId, role, createdAt: Date.now() })
      // P1-1：addMember 不再实例内写库——由调用方（team_add_member/team_create）统一 putRecord，
      // team_create 只在成员全部处理完（含失败隔离）后落库，实现"部分失败不残留中间态"。
      if (persist !== false) await teamsUnit.putRecord('team', team.captain, team)
      return { ok: true, member: { id: memberId, sessionId: started.childId, role }, ...(modeId !== undefined ? { mode: modeId } : {}), ...(escalations.length > 0 ? { approvedEscalations: escalations } : {}) }
    }


    const OPS = {}
    OPS['team_create'] = { name: 'team_create',
      desc: '一键建队并派发成员与任务。用 `members` 数组一次加成员（memberId/role/prompt + 可选 provider/model/reasoningEffort/mode/sandbox），`tasks` 数组一次建任务（title/assignee/dependencies；依赖须先出现）。提权（更高模型档位/跨系列/能力面新增）自动审批，失败逐项隔离。先准备角色清单与依赖顺序再建；完整工作流见 agent-teamwork 技能。',
      schema: {
        name: { type: 'string', required: true, description: '简短团队名，如 "migration-squad"。' },
        goal: { type: 'string', description: '一行团队目标，送达各成员。' },
        members: {
          type: 'array',
          description: '可选：建队时一次添加的成员数组；每项 { memberId, role, prompt, provider?, model?, reasoningEffort?, mode? }。逐项独立审批与失败隔离。',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              memberId: { type: 'string', required: true, description: '成员 id，如 "researcher"。' },
              role: { type: 'string', required: true, description: '角色描述。' },
              prompt: { type: 'string', description: '成员初始任务（existingSessionId 时省略）。' },
              existingSessionId: { type: 'string', description: '可选：已有 peer 会话 id——拉现有会话进 team（不 spawn），共享任务板/消息墙。' },
              provider: { type: 'string', description: '可选供应商路由。' },
              model: { type: 'string', description: '可选模型 id。' },
              reasoningEffort: { type: 'string', description: '可选思考强度。' },
              mode: { type: 'string', description: '可选模式 id。' },
              sandbox: { type: 'string', description: '可选沙箱模式（read-only | workspace-write | danger-full-access）；比队长更宽的写权限会请求审批。' },
            },
          },
        },
        tasks: {
          type: 'array',
          description: '可选：建队时按数组序创建的任务；每项 { title, description?, assignee?, dependencies? }。依赖引用的任务必须先出现在本数组或已存在于团队。',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              title: { type: 'string', required: true, description: '简短任务标题。' },
              description: { type: 'string', description: '任务要求及验收标准。' },
              assignee: { type: 'string', description: '要指派的成员 id，省略则进入可认领池。' },
              dependencies: { type: 'array', description: '必须先完成的任务 id。' },
            },
          },
        },
      },
      handler: async (args, exec) => {
        const captain = callerId(exec, agents)
        if (captain === undefined) return jsonText({ ok: false, error: 'cannot determine the calling session id' })
        const agent = exec !== undefined ? exec.agent : undefined
        if (agent === undefined) return jsonText({ ok: false, error: 'no calling agent; team_create must run inside a session' })
        const name = String(args.name ?? '').trim()
        if (name.length === 0 || name.length > 64) return jsonText({ ok: false, error: 'team name must be 1-64 characters' })
        const specs = Array.isArray(args.members) ? args.members.filter((m) => m !== null && typeof m === 'object') : []
        if (specs.length > 16) return jsonText({ ok: false, error: 'at most 16 members per team' })
        const taskSpecs = Array.isArray(args.tasks) ? args.tasks.filter((t) => t !== null && typeof t === 'object') : []
        const teamsUnit = await requireUnit()
        const created = await enqueue(async () => {
          const existing = await getTeam(captain)
          if (existing !== undefined) throw new Error('you already lead team "' + String(existing.name ?? '') + '"; use team_delete first')
          const record = {
            teamId: makeId('team'),
            name,
            goal: String(args.goal ?? ''),
            captain,
            members: [],
            tasks: [],
            nextTask: 1,
            createdAt: Date.now(),
          }
          await teamsUnit.putRecord('team', captain, record)
          const memberResults = []
          for (const spec of specs) {
            try {
              // P1-1：persist=false——成员 spawn 期间不写库，成员全部处理完后统一落库；
              // 部分成员失败注入 memberResults（隔离语义保留），成功成员留在 record，最终一起写入。
              const result = await addMember(record, spec, agent, exec, 'team_create', false)
              memberResults.push(result)
            } catch (error) {
              memberResults.push({ ok: false, memberId: String(spec.memberId ?? ''), error: errText(error) })
            }
          }
          const taskResults = []
          for (const spec of taskSpecs) {
            const title = String(spec.title ?? '').trim()
            if (title.length === 0 || title.length > 160) {
              taskResults.push({ ok: false, error: 'title must be 1-160 characters' })
              continue
            }
            const taskId = 't' + String(record.nextTask)
            const deps = Array.isArray(spec.dependencies) ? spec.dependencies.map((d) => String(d)).filter((d) => d.length > 0) : []
            const assignee = String(spec.assignee ?? '').trim()
            const badDep = deps.find((dep) => !record.tasks.some((t) => t !== null && typeof t === 'object' && t.id === dep))
            if (badDep !== undefined) {
              taskResults.push({ ok: false, title, error: 'dependency "' + badDep + '" is not an earlier task of this team' })
              continue
            }
            if (assignee.length > 0 && !memberOf(record, assignee)) {
              taskResults.push({ ok: false, title, error: 'assignee "' + assignee + '" is not a team member' })
              continue
            }
            record.tasks.push({
              id: taskId,
              title,
              description: String(spec.description ?? ''),
              assignee: assignee.length > 0 ? assignee : null,
              dependencies: deps,
              status: 'pending',
              output: null,
              createdAt: Date.now(),
            })
            record.nextTask += 1
            taskResults.push({ ok: true, taskId, title })
          }
          await teamsUnit.putRecord('team', captain, record)
          return { record, memberResults, taskResults }
        })
        return jsonText({
          ok: true,
          team: created.record,
          ...(created.memberResults.length > 0 ? { memberResults: created.memberResults } : {}),
          ...(created.taskResults.length > 0 ? { taskResults: created.taskResults } : {}),
        })
      },
    }

    OPS['team_add_member'] = { name: 'team_add_member',
      desc: '给现有团队补一个成员：派发持久子代理会话。成员 id 是 `team_send_message` 的收件地址；提权（更高模型档位/跨系列/能力面新增）自动审批。完整工作流见 agent-teamwork 技能。',
      schema: {
        memberId: { type: 'string', required: true, description: '简短成员 id/名字，如 "researcher" 或 "alice"。' },
        role: { type: 'string', required: true, description: '角色描述，如 "frontend reviewer"。' },
        prompt: { type: 'string', description: '成员的初始任务（existingSessionId 时省略——已有会话自有上下文）。' },
        existingSessionId: { type: 'string', description: '可选：已有 peer 会话 id——拉现有会话进 team（不 spawn），共享任务板/消息墙。' },
        provider: { type: 'string', description: '可选的成员供应商路由；省略则继承队长的供应商。' },
        model: { type: 'string', description: '可选的成员模型 id；省略则继承队长当前模型。' },
        reasoningEffort: { type: 'string', description: '可选的成员思考强度；省略则继承队长当前强度。' },
        mode: { type: 'string', description: '可选的成员模式 id（如 "router-standard"、"cordis"）；省略则继承队长组合。' },
        sandbox: { type: 'string', description: '可选的成员沙箱模式（"read-only" | "workspace-write" | "danger-full-access"）；比队长更宽的写权限会请求审批。' },
      },
      handler: async (args, exec) => {
        const captain = callerId(exec, agents)
        if (captain === undefined) return jsonText({ ok: false, error: 'cannot determine the calling session id' })
        const agent = exec !== undefined ? exec.agent : undefined
        if (agent === undefined) return jsonText({ ok: false, error: 'no calling agent; team_add_member must run inside a session' })
        const teamsUnit = await requireUnit()
        return await enqueue(async () => {
          const team = await getTeam(captain)
          if (team === undefined) return jsonText({ ok: false, error: 'no team found; call team_create first' })
          const result = await addMember(team, args, agent, exec, 'team_add_member')
          return jsonText(result)
        })
      },
    }

    OPS['team_add_members'] = { name: 'team_add_members',
      desc: '批量补成员：一次传多个成员数组，逐项独立审批与失败隔离（某个失败只影响该项）。与 team_add_member 同策略。完整工作流见 agent-teamwork 技能。',
      schema: {
        members: {
          type: 'array',
          required: true,
          description: '成员数组；每项 { memberId, role, prompt, provider?, model?, reasoningEffort?, mode? }。',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              memberId: { type: 'string', required: true, description: '成员 id，如 "researcher"。' },
              role: { type: 'string', required: true, description: '角色描述。' },
              prompt: { type: 'string', description: '成员初始任务（existingSessionId 时省略）。' },
              existingSessionId: { type: 'string', description: '可选：已有 peer 会话 id——拉现有会话进 team（不 spawn），共享任务板/消息墙。' },
              provider: { type: 'string', description: '可选供应商路由。' },
              model: { type: 'string', description: '可选模型 id。' },
              reasoningEffort: { type: 'string', description: '可选思考强度。' },
              mode: { type: 'string', description: '可选模式 id。' },
              sandbox: { type: 'string', description: '可选沙箱模式（read-only | workspace-write | danger-full-access）；比队长更宽的写权限会请求审批。' },
            },
          },
        },
      },
      handler: async (args, exec) => {
        const captain = callerId(exec, agents)
        if (captain === undefined) return jsonText({ ok: false, error: 'cannot determine the calling session id' })
        const agent = exec !== undefined ? exec.agent : undefined
        if (agent === undefined) return jsonText({ ok: false, error: 'no calling agent; team_add_members must run inside a session' })
        const specs = Array.isArray(args.members) ? args.members.filter((m) => m !== null && typeof m === 'object') : []
        if (specs.length === 0) return jsonText({ ok: false, error: 'members must be a non-empty array' })
        const teamsUnit = await requireUnit()
        return await enqueue(async () => {
          const team = await getTeam(captain)
          if (team === undefined) return jsonText({ ok: false, error: 'no team found; call team_create first' })
          const results = []
          for (const spec of specs) {
            try {
              const result = await addMember(team, spec, agent, exec, 'team_add_members')
              results.push(result)
            } catch (error) {
              results.push({ ok: false, memberId: String(spec.memberId ?? ''), error: errText(error) })
            }
          }
          return jsonText({ ok: true, teamName: team.name, results })
        })
      },
    }

    OPS['team_create_task'] = { name: 'team_create_task',
      desc: '把目标拆成一个任务：title 必填、可选 assignee（成员 id，省略进认领池）、dependencies（必须先完成的任务 id）。依赖须已验证存在。完整工作流见 agent-teamwork 技能。',
      schema: {
        title: { type: 'string', required: true, description: '简短任务标题。' },
        description: { type: 'string', description: '任务要求及验收标准。' },
        assignee: { type: 'string', description: '要指派的成员 id，省略则进入可认领池。' },
        dependencies: { type: 'array', description: '必须先完成的任务 id。' },
      },
      handler: async (args, exec) => {
        const captain = callerId(exec, agents)
        if (captain === undefined) return jsonText({ ok: false, error: 'cannot determine the calling session id' })
        const title = String(args.title ?? '').trim()
        if (title.length === 0 || title.length > 160) return jsonText({ ok: false, error: 'title must be 1-160 characters' })
        const teamsUnit = await requireUnit()
        return await enqueue(async () => {
          const team = await getTeam(captain)
          if (team === undefined) return jsonText({ ok: false, error: 'no team found; call team_create first' })
          const taskId = 't' + String(team.nextTask)
          const deps = Array.isArray(args.dependencies) ? args.dependencies.map((d) => String(d)).filter((d) => d.length > 0) : []
          const assignee = String(args.assignee ?? '').trim()
          if (assignee.length > 0 && !memberOf(team, assignee)) return jsonText({ ok: false, error: 'assignee "' + assignee + '" is not a team member' })
          for (const dep of deps) {
            const found = team.tasks.some((t) => t !== null && typeof t === 'object' && t.id === dep)
            if (!found) return jsonText({ ok: false, error: 'dependency "' + dep + '" is not a task of this team' })
          }
          team.tasks.push({
            id: taskId,
            title,
            description: String(args.description ?? ''),
            assignee: assignee.length > 0 ? assignee : null,
            dependencies: deps,
            status: 'pending',
            output: null,
            createdAt: Date.now(),
          })
          team.nextTask += 1
          await teamsUnit.putRecord('team', captain, team)
          return jsonText({ ok: true, taskId, teamName: team.name })
        })
      },
    }

    OPS['team_claim_task'] = { name: 'team_claim_task',
      desc: '为成员认领一个待处理任务（或取消认领退回待处理）。所有依赖必须已完成。队长可为任何人认领；成员只能为自己或未指派任务认领。完整工作流见 agent-teamwork 技能。',
      schema: {
        taskId: { type: 'string', required: true, description: '任务 id，如 "t1"。' },
        memberId: { type: 'string', description: '认领任务的成员；省略表示调用者（队长或成员）。' },
      },
      handler: async (args, exec) => {
        const me = callerId(exec, agents)
        if (me === undefined) return jsonText({ ok: false, error: 'cannot determine the calling session id' })
        const taskId = String(args.taskId ?? '').trim()
        const teamsUnit = await requireUnit()
        return await enqueue(async () => {
          const snapshot = await teamsUnit.loadAll()
          const table = snapshot !== undefined && snapshot.tables !== undefined && snapshot.tables['team'] !== undefined ? snapshot.tables['team'] : {}
          let captain = undefined
          let team = undefined
          let claimant = String(args.memberId ?? '').trim()
          const direct = table[me]
          if (direct !== null && typeof direct === 'object') { captain = me; team = direct }
          else {
            for (const key of Object.keys(table)) {
              const record = table[key]
              if (record !== null && typeof record === 'object' && memberOf(record, me)) {
                captain = key; team = record
                // P1-1：成员自领解析其 memberId（存 memberId 而非 sessionId，与任务建立语义一致）
                const selfMember = record.members.find((m) => m !== null && typeof m === 'object' && m.sessionId === me)
                claimant = typeof selfMember === 'object' && selfMember !== null ? String(selfMember.id) : ''
                break
              }
            }
          }
          if (team === undefined) return jsonText({ ok: false, error: 'you are neither a captain nor a member of any team' })
          const task = team.tasks.find((t) => t !== null && typeof t === 'object' && t.id === taskId)
          if (task === undefined) return jsonText({ ok: false, error: 'unknown task "' + taskId + '"' })
          if (claimant.length === 0) return jsonText({ ok: false, error: 'no claimant resolved' })
          if (me === captain) {
            if (!memberOf(team, claimant)) return jsonText({ ok: false, error: 'claimant "' + claimant + '" is not a team member' })
          } else if (claimant !== me) {
            return jsonText({ ok: false, error: 'a member may only claim for itself' })
          }
          for (const dep of task.dependencies) {
            const depTask = team.tasks.find((t) => t !== null && typeof t === 'object' && t.id === dep)
            if (depTask === undefined || depTask.status !== 'completed') return jsonText({ ok: false, error: 'dependency "' + dep + '" is not completed' })
          }
          task.status = 'claimed'
          task.assignee = claimant
          await teamsUnit.putRecord('team', captain, team)
          return jsonText({ ok: true, taskId, claimedBy: claimant, teamName: team.name })
        })
      },
    }

    OPS['team_update_task'] = { name: 'team_update_task',
      desc: '推进任务状态（claimed → in_progress → completed | failed | cancelled）并可选记录其输出。成员更新自己的任务；队长可更新任何任务。完整工作流见 agent-teamwork 技能。',
      schema: {
        taskId: { type: 'string', required: true, description: '任务 id，如 "t1"。' },
        status: { type: 'string', required: true, description: '新状态：claimed | in_progress | completed | failed | cancelled。' },
        output: { type: 'string', description: '要存储的结果文本（交付物或摘要放这里）。' },
      },
      handler: async (args, exec) => {
        const me = callerId(exec, agents)
        if (me === undefined) return jsonText({ ok: false, error: 'cannot determine the calling session id' })
        const taskId = String(args.taskId ?? '').trim()
        const status = String(args.status ?? '').trim()
        if (!TASK_STATUSES.includes(status)) return jsonText({ ok: false, error: 'status must be one of: ' + TASK_STATUSES.join(', ') })
        const teamsUnit = await requireUnit()
        return await enqueue(async () => {
          const snapshot = await teamsUnit.loadAll()
          const table = snapshot !== undefined && snapshot.tables !== undefined && snapshot.tables['team'] !== undefined ? snapshot.tables['team'] : {}
          let captain = undefined
          let team = undefined
          const direct = table[me]
          if (direct !== null && typeof direct === 'object') { captain = me; team = direct }
          else {
            for (const key of Object.keys(table)) {
              const record = table[key]
              if (record !== null && typeof record === 'object' && memberOf(record, me)) { captain = key; team = record; break }
            }
          }
          if (team === undefined) return jsonText({ ok: false, error: 'you are neither a captain nor a member of any team' })
          const task = team.tasks.find((t) => t !== null && typeof t === 'object' && t.id === taskId)
          if (task === undefined) return jsonText({ ok: false, error: 'unknown task "' + taskId + '"' })
          // P1-1：assignee 存成员 id（memberId），me 是 sessionId——比对须经成员表解析，直接用字符串比较在多成员时误判
          const isAssignee = task.assignee !== null && task.assignee !== undefined && task.assignee !== ''
            ? (me === captain || team.members.some((m) => m !== null && typeof m === 'object' && m.id === task.assignee && m.sessionId === me))
            : me === captain
          if (!isAssignee) return jsonText({ ok: false, error: 'only the assignee or the captain may update task "' + taskId + '"' })
          const allowed = TASK_TRANSITIONS[task.status] ?? []
          if (!allowed.includes(status)) return jsonText({ ok: false, error: 'cannot move task "' + taskId + '" from "' + task.status + '" to "' + status + '" (allowed: ' + allowed.join(', ') + ')' })
          task.status = status
          if (typeof args.output === 'string' && args.output.length > 0) task.output = args.output
          await teamsUnit.putRecord('team', captain, team)
          if (status === 'completed') wakeWaiters((w) => w.taskId !== null && w.taskId !== undefined && w.taskId === taskId, { ok: true, wokenBy: 'task-completed', taskId })
          return jsonText({ ok: true, taskId, status, teamName: team.name })
        })
      },
    }

    OPS['team_wait'] = { name: 'team_wait',
      desc: '暂停当前回合，等待另一名队员的消息或某个任务的完成（任一满足即唤醒）。等待不消耗额外步骤，超时（默认 600 秒，上限 3600 秒）后返回 timeout，可再等；队长随时可发消息拆掉等待，不会死锁。用它替代轮询 team_status，别做重复劳动。',
      schema: {
        memberId: { type: 'string', description: '要等待的成员 id；省略则等待任意消息。' },
        taskId: { type: 'string', description: '要等待的任务 id（如 "t2"）；该任务 completed 时唤醒。' },
        timeoutSeconds: { type: 'number', description: '最长等待秒数（默认 600，上限 3600）。' },
      },
      handler: async (args, exec) => {
        const me = callerId(exec, agents)
        if (me === undefined) return jsonText({ ok: false, error: 'cannot determine the calling session id' })
        const memberId = cleanId(args.memberId)
        const taskId = String(args.taskId ?? '').trim()
        if (memberId.length === 0 && taskId.length === 0) return jsonText({ ok: false, error: 'memberId or taskId is required' })
        const team = await getTeam(me)
        if (team === undefined) return jsonText({ ok: false, error: 'you are not part of any team; call team_create first' })
        if (memberId.length > 0 && !memberOf(team, memberId)) return jsonText({ ok: false, error: 'member "' + memberId + '" is not a team member' })
        if (taskId.length > 0) {
          const target = team.tasks.find((t) => t !== null && typeof t === 'object' && t.id === taskId)
          if (target === undefined) return jsonText({ ok: false, error: 'task "' + taskId + '" is not a task of this team' })
          if (target.status === 'completed') return jsonText({ ok: true, wokenBy: 'task-completed', taskId, note: 'the task was already completed before the wait started' })
        }
        const timeoutSec = typeof args.timeoutSeconds === 'number' && args.timeoutSeconds > 0 ? Math.min(Math.floor(args.timeoutSeconds), 3600) : 600
        if (timer === undefined || typeof timer.timeout !== 'function') {
          return jsonText({ ok: false, error: 'timer service unavailable; waiting is disabled — poll team_status instead' })
        }
        return await new Promise((resolve) => {
          let settled = false
          const entry = { sessionId: me, memberId: memberId.length > 0 ? memberId : null, taskId: taskId.length > 0 ? taskId : null, finish: null }
          let timeoutDispose = null
          let abortListener = null
          const finish = (payload) => {
            if (settled) return
            settled = true
            const idx = waiters.indexOf(entry)
            if (idx >= 0) waiters.splice(idx, 1)
            if (timeoutDispose !== null) { try { timeoutDispose() } catch (error) { /* best-effort */ } }
            // P1-1：abort 监听器 finish 后必须摘掉，否则每次 team_wait 泄漏一条
            if (abortListener !== null && signal !== undefined && typeof signal.removeEventListener === 'function') {
              try { signal.removeEventListener('abort', abortListener) } catch (error) { /* best-effort */ }
              abortListener = null
            }
            resolve(jsonText(payload))
          }
          entry.finish = finish
          waiters.push(entry)
          timeoutDispose = timer.timeout(() => finish({ ok: true, wokenBy: 'timeout', afterSeconds: timeoutSec }), timeoutSec * 1000)
          const signal = exec !== undefined ? exec.signal : undefined
          if (signal !== undefined && typeof signal.addEventListener === 'function') {
            abortListener = () => finish({ ok: false, error: 'wait aborted (turn cancelled)' })
            signal.addEventListener('abort', abortListener, { once: true })
          }
        })
      },
    }

    OPS['team_send_message'] = { name: 'team_send_message',
      desc: '给队长或另一成员发消息：在线立即投递并唤醒，离线持久排队下次启动送达。发送方永远是调用会话（不可伪造）。完整工作流见 agent-teamwork 技能。',
      schema: {
        to: { type: 'string', required: true, description: '接收方：成员 id 或 "captain"。' },
        text: { type: 'string', required: true, description: '消息正文。' },
      },
      handler: async (args, exec) => {
        const me = callerId(exec, agents)
        if (me === undefined) return jsonText({ ok: false, error: 'cannot determine the calling session id' })
        const text = String(args.text ?? '')
        if (text.length === 0) return jsonText({ ok: false, error: 'text must not be empty' })
        const to = String(args.to ?? '').trim()
        const teamsUnit = await requireUnit()
        return await enqueue(async () => {
          const snapshot = await teamsUnit.loadAll()
          const table = snapshot !== undefined && snapshot.tables !== undefined && snapshot.tables['team'] !== undefined ? snapshot.tables['team'] : {}
          let targetSession = undefined
          if (to === 'captain') {
            const direct = table[me]
            if (direct !== null && typeof direct === 'object') return jsonText({ ok: false, error: 'you are the captain; address members by id' })
            for (const key of Object.keys(table)) {
              const record = table[key]
              if (record !== null && typeof record === 'object' && memberOf(record, me)) { targetSession = key; break }
            }
          } else {
            const direct = table[me]
            if (direct !== null && typeof direct === 'object') {
              const member = direct.members.find((m) => m !== null && typeof m === 'object' && m.id === to)
              if (member !== undefined) targetSession = member.sessionId
            } else {
              for (const key of Object.keys(table)) {
                const record = table[key]
                if (record !== null && typeof record === 'object' && memberOf(record, me)) {
                  if (key === to) return jsonText({ ok: false, error: 'members address the captain as "captain"' })
                  const member = record.members.find((m) => m !== null && typeof m === 'object' && m.id === to)
                  if (member !== undefined) targetSession = member.sessionId
                  break
                }
              }
            }
          }
          if (targetSession === undefined) return jsonText({ ok: false, error: 'recipient "' + to + '" is not part of your team' })
          const prefix = '[team message from ' + me + ']'
          const cleanText = text.replace(/(\n*\s*(?:\[\/team message\]|\[team message end\])\s*)+$/, '')
          const wrapped = prefix + '\n\n' + cleanText + '\n\n[team message end]'
          const message = {
            id: makeId('m'),
            role: 'user',
            content: [{ type: 'text', text: wrapped }],
            source: { kind: 'user', rpcId: makeId('rpc'), senderSessionId: me },
          }
          const target = agents.get(targetSession)
          if (target !== undefined) {
            try {
              if (typeof target.status === 'string' && target.status === 'running') target.steer(message)
              else target.followup(message)
              wakeWaiters((w) => w.sessionId === targetSession, { ok: true, wokenBy: 'message', from: me })
              return jsonText({ ok: true, delivered: 'live', to, messageId: message.id })
            } catch (error) { /* fall through to the durable queue */ }
          }
          await teamsUnit.putRecord('mail', message.id, {
            id: message.id,
            from: me,
            to: targetSession,
            text: wrapped,
            ts: Date.now(),
          })
          wakeWaiters((w) => w.sessionId === targetSession, { ok: true, wokenBy: 'message', from: me })
          return jsonText({ ok: true, delivered: 'queued', to, messageId: message.id })
        })
      },
    }

    OPS['team_status'] = { name: 'team_status',
      desc: '团队全貌：成员及其在线状态、带依赖和输出的任务板、以及排在你收件箱里的消息。轮询它以收集成员输出并决定下一步。完整工作流见 agent-teamwork 技能。',
      schema: {},
      handler: async (args, exec) => {
        const me = callerId(exec, agents)
        if (me === undefined) return jsonText({ ok: false, error: 'cannot determine the calling session id' })
        const teamsUnit = await requireUnit()
        return await enqueue(async () => {
          const snapshot = await teamsUnit.loadAll()
          const table = snapshot !== undefined && snapshot.tables !== undefined && snapshot.tables['team'] !== undefined ? snapshot.tables['team'] : {}
          let captain = undefined
          let team = undefined
          const direct = table[me]
          if (direct !== null && typeof direct === 'object') { captain = me; team = direct }
          else {
            for (const key of Object.keys(table)) {
              const record = table[key]
              if (record !== null && typeof record === 'object' && memberOf(record, me)) { captain = key; team = record; break }
            }
          }
          if (team === undefined) return jsonText({ ok: true, inTeam: false, note: 'you are not part of any team; use team_create to lead one' })
          const members = team.members.map((m) => {
            const live = agents.get(m.sessionId)
            return { id: m.id, sessionId: m.sessionId, role: m.role, status: live !== undefined ? live.status : 'offline' }
          })
          const mailSnapshot = await teamsUnit.loadAll()
          const mailTable = mailSnapshot !== undefined && mailSnapshot.tables !== undefined && mailSnapshot.tables['mail'] !== undefined ? mailSnapshot.tables['mail'] : {}
          const inbox = []
          for (const key of Object.keys(mailTable)) {
            const record = mailTable[key]
            if (record !== null && typeof record === 'object' && record.to === me) {
              inbox.push(record)
              // P1-1：收件箱消费——team_status 即用户/成员查收动作，投递后删除，避免在线轮询重复收同一封
              try { await teamsUnit.deleteRecord('mail', key) } catch (error) { /* best-effort；删除失败仅下次再收 */ }
            }
          }
          return jsonText({
            ok: true,
            inTeam: true,
            teamId: team.teamId,
            name: team.name,
            captain,
            youAreCaptain: me === captain,
            members,
            tasks: team.tasks,
            inbox,
          })
        })
      },
    }

    OPS['team_delete'] = { name: 'team_delete',
      desc: '结束团队：打断在线成员，然后归档团队记录。可选成员会话清理（cleanup）：archive=默认，成员会话归档（可捞回）；delete=销毁（不可逆需确认）；none=只打断不归档。用完团队别留一堆成员会话——默认 archive 清掉。',
      schema: { cleanup: { type: 'string', description: '成员清理方式：archive（默认，归档可捞回）| delete（销毁不可逆，需 cleanupConfirm）| none（只打断）。' }, cleanupConfirm: { type: 'string', description: 'cleanup=delete 时必须为 "DELETE"（防误删）。' } },
      handler: async (args, exec) => {
        // captainId 直传（console teamDeleteApi 路径）优先；否则 callerId（工具路径）
        let captain = typeof args?.captainId === 'string' && args.captainId.length > 0 ? args.captainId : callerId(exec, agents)
        if (captain === undefined || captain === '') return jsonText({ ok: false, error: 'cannot determine the calling session id' })
        const agent = exec !== undefined ? exec.agent : undefined
        const cleanup = String(args?.cleanup ?? 'archive')
        if (!['archive', 'delete', 'none'].includes(cleanup)) return jsonText({ ok: false, error: 'cleanup must be archive | delete | none' })
        if (cleanup === 'delete' && String(args?.cleanupConfirm ?? '') !== 'DELETE') {
          return jsonText({ ok: false, error: 'cleanup=delete 销毁不可逆，需 cleanupConfirm="DELETE"' })
        }
        // 删除键在人手里：cleanup=delete（销毁成员会话）仅主会话（人）可执行；代理/子代理传 DELETE 也拒。
        if (cleanup === 'delete') {
          let main = false
          try {
            const header = agent !== undefined && agent.session !== undefined ? agent.session.header : undefined
            if (header === undefined || header === null) { main = false }
            else {
              const origin = String(header.origin ?? '')
              const parent = String(header.parentSession ?? '')
              main = origin !== 'subagent' && parent.length === 0
            }
          } catch (error) { main = false }
          if (!main) return jsonText({ ok: false, error: 'cleanup=delete 仅主会话可执行（销毁成员会话是人的操作；代理请用 archive）' })
        }
        const teamsUnit = await requireUnit()
        return await enqueue(async () => {
          const team = await getTeam(captain)
          if (team === undefined) return jsonText({ ok: false, error: 'no team found for this captain' })
          if (team.captain !== captain) return jsonText({ ok: false, error: 'only the team captain may delete the team' })
          if (agent !== undefined) {
            for (const member of team.members) {
              try { subagents.interrupt(member.sessionId, { kind: 'ancestor', agent }) } catch (error) { /* best-effort */ }
            }
          }
          // 成员会话级联清理（用户痛点：拉起 team 后一堆成员会话不好删）。主会话不可能是成员（成员是子代理），
          // 但防御性过滤：只清理 isSubHeader 的子会话。
          const svc = ctx.get('sessionmgmt')
          const memberIds = (Array.isArray(team.members) ? team.members : []).map((m) => m?.sessionId).filter((s) => typeof s === 'string' && s.length > 0)
          let cleanupResults = []
          if (cleanup !== 'none' && memberIds.length > 0 && svc !== undefined && typeof svc.archive === 'function') {
            for (const sid of memberIds) {
              try {
                if (cleanup === 'delete' && typeof svc.deleteSessions === 'function') {
                  await svc.deleteSessions([sid], captain, true, true)
                  cleanupResults.push({ sessionId: sid, ok: true, action: 'delete' })
                } else {
                  await svc.archive([sid], captain, 'team_delete')
                  cleanupResults.push({ sessionId: sid, ok: true, action: 'archive' })
                }
              } catch (error) {
                cleanupResults.push({ sessionId: sid, ok: false, error: errText(error) })
              }
            }
          }
          const archived = { ...team, archivedAt: Date.now() }
          await teamsUnit.putRecord('archive', team.teamId, archived)
          await teamsUnit.deleteRecord('team', captain)
          return jsonText({ ok: true, archived: team.teamId, name: team.name, cleanup, cleanupResults: cleanupResults.length > 0 ? cleanupResults : undefined, note: 'team archived; members ' + (cleanup === 'none' ? 'stopped only' : cleanup === 'delete' ? 'deleted' : 'archived') + (cleanupResults !== undefined && cleanupResults.some((r) => r.ok === false) ? '（部分失败见 cleanupResults）' : '') })
        })
      },
    }

    // ── 注册（旧名保留兼容）+ 元工具 teams ──
    for (const key of Object.keys(OPS)) {
      const op = OPS[key]
      registerTool(ctx, op.name, op.desc, op.schema, op.handler)
    }
    // 元工具 description 程序生成（grok §4：参数面不能散文，要从 OPS[i].schema 拉，不手写第二份）
    const opParamTable = Object.keys(OPS).map((key) => {
      const op = OPS[key]
      const params = Object.entries(op.schema ?? {}).map(([pname, pdef]) => {
        const t = pdef !== null && typeof pdef === 'object' ? (pdef.type ?? '?') : '?'
        const req = pdef !== null && typeof pdef === 'object' && pdef.required === true ? ' (必填)' : ''
        const desc = pdef !== null && typeof pdef === 'object' && typeof pdef.description === 'string' ? ': ' + pdef.description.slice(0, 60) : ''
        return pname + '〈' + t + '〉' + req + desc
      }).join(', ')
      return '- `' + key.replace('team_', '') + '` → ' + params
    }).join('\n')
    registerTool(ctx, 'teams',
      '团队协作入口（元工具）。何时用 team 而不是 spawn_model_subagent / session_send：需要多角色协作（写码+评审+测试）、成员互发消息、任务依赖与等待时用 teams；一次性隔离抛件用 spawn_model_subagent；跨会话简单投递用 session_send。\nop 必填，子操作参数如下：\n' + opParamTable,
      { op: { type: 'string', required: true, description: '子操作名（见参数表）：' + Object.keys(OPS).map((k) => k.replace('team_', '')).join(' | ') + '。' } },
      async (args, exec) => {
        const opName = String(args?.op ?? '')
        const full = opName.startsWith('team_') ? opName : 'team_' + opName
        const op = OPS[full]
        if (op === undefined) return jsonText({ ok: false, error: 'unknown team op "' + opName + '"; expected one of ' + Object.keys(OPS).map((k) => k.replace('team_', '')).join(', ') })
        return await op.handler(args, exec)
      })

    // ── 模板系统（P1-v0 骨架：save/capture + search + distill；modelHint 结构先定） ──
    // 模板 = 角色骨架 + 每角色 modelHint（推荐类别，非具体模型——导出分享无模型差异）+ 任务骨架。
    // modelHint 三轴：{ series?: 'deepseek'|'claude'|..., tier?: 'flash'|'lite'|'plus'|'pro'|'max', purpose?: 'code-main'|'code-review'|'code-test'|'vision'|'cheap-fast'|'deep-architect' }
    // 自适应：实例化时（LLM/手动）按本地 provider/model 目录匹配最接近的模型；不匹配降级继承队长。
    function sanitizeTemplate(rec) {
      const members = (Array.isArray(rec.members) ? rec.members : []).map((m) => ({
        memberId: cleanId(m?.memberId),
        role: String(m?.role ?? '').slice(0, 120),
        prompt: String(m?.prompt ?? '').slice(0, 4000),
        // 导出不带具体模型：modelHint 推荐类别
        modelHint: (m?.modelHint !== null && typeof m?.modelHint === 'object') ? {
          ...(typeof m.modelHint.series === 'string' ? { series: m.modelHint.series } : {}),
          ...(typeof m.modelHint.tier === 'string' ? { tier: m.modelHint.tier } : {}),
          ...(typeof m.modelHint.purpose === 'string' ? { purpose: m.modelHint.purpose } : {}),
        } : (typeof m?.model === 'string' && m.model.length > 0
          ? { purpose: 'general', modelHintNote: 'from raw model ' + m.model }  // 旧数据兜底：标来源，模型实例化时解析
          : null),
      })).filter((m) => m.memberId !== '')
      return {
        templateId: String(rec?.templateId ?? ''),
        name: String(rec?.name ?? '').slice(0, 64),
        description: String(rec?.description ?? '').slice(0, 300),
        members,
        tasks: (Array.isArray(rec.tasks) ? rec.tasks : []).map((t) => ({
          title: String(t?.title ?? '').slice(0, 160),
          ...(typeof t?.description === 'string' ? { description: t.description } : {}),
          ...(typeof t?.assignee === 'string' ? { assignee: t.assignee } : {}),
          dependencies: (Array.isArray(t?.dependencies) ? t.dependencies : []).map((d) => String(d)).filter((d) => d.length > 0),
        })).filter((t) => t.title.length > 0),
        createdAt: typeof rec?.createdAt === 'number' ? rec.createdAt : Date.now(),
        source: String(rec?.source ?? 'local'),
      }
    }
    async function templatePut(rec) {
      const unit = await requireUnit()
      await unit.putRecord('template', String(rec.templateId), rec)
    }
    async function templateGet(id) {
      const unit = await requireUnit()
      const snapshot = await unit.loadAll()
      const t = snapshot !== undefined && snapshot.tables !== undefined && snapshot.tables['template'] !== undefined ? snapshot.tables['template'] : {}
      const rec = t[id]
      return rec !== null && typeof rec === 'object' ? rec : undefined
    }
    async function templateList() {
      const unit = await requireUnit()
      const snapshot = await unit.loadAll()
      const t = snapshot !== undefined && snapshot.tables !== undefined && snapshot.tables['template'] !== undefined ? snapshot.tables['template'] : {}
      return Object.values(t).map(sanitizeTemplate).filter((r) => r.templateId !== '')
    }
    // capture：把调用方所在 team 快照为模板（清洗模型→modelHint；若成员带具体 model 且无 modelHint 则给 general+来源注记）
    async function captureTeam(team, source) {
      const rec = {
        templateId: 'tpl-' + team.teamId.slice(0, 8),
        name: team.name + ' 模板',
        description: '捕获自团队 ' + team.teamId,
        members: team.members.map((m) => ({ memberId: m.id, role: m.role, prompt: '', model: m.model ?? undefined })),
        tasks: (Array.isArray(team.tasks) ? team.tasks : []).map((t) => ({ title: t.title, description: t.description ?? '', assignee: t.assignee ?? null, dependencies: t.dependencies ?? [] })),
        source: source ?? 'capture',
        createdAt: Date.now(),
      }
      return sanitizeTemplate(rec)
    }
    registerTool(ctx, 'team_template_save',
      '保存一个团队模板：members（memberId/role/prompt + 可选 modelHint 推荐类别）+ tasks 骨架。modelHint 是推荐类别（series/tier/purpose），不带具体模型——导出分享无模型差异（实际模型实例化时按本地目录适配）。也用于 capture（从当前队伍蒸馏模板）。完整工作流见 agent-teamwork 技能。',
      {
        name: { type: 'string', required: true, description: '模板名（1-64 字）。' },
        description: { type: 'string', description: '模板说明（≤300 字）。' },
        members: { type: 'array', description: '角色骨架：每项 { memberId, role, prompt?, modelHint? }；modelHint={ series?, tier?, purpose? }。' },
        tasks: { type: 'array', description: '任务骨架：每项 { title, description?, assignee?, dependencies? }。' },
        source: { type: 'string', description: '来源标注：local | capture | import。' },
      },
      async (args, exec) => {
        const captain = callerId(exec, agents)
        if (captain === undefined) return jsonText({ ok: false, error: 'cannot determine the calling session id' })
        const sanitized = sanitizeTemplate({ templateId: 'tpl-' + makeId('x').slice(0, 10), ...args })
        if (sanitized.name === '') return jsonText({ ok: false, error: 'name is required' })
        if (sanitized.members.length === 0) return jsonText({ ok: false, error: 'at least one member required' })
        await templatePut(sanitized)
        return jsonText({ ok: true, templateId: sanitized.templateId, note: '模板已保存' })
      })
    registerTool(ctx, 'team_template_search',
      '搜索团队模板库（关键词分词命中：name+description+角色），返回**匹配模板的完整内容**（每角色 memberId/role/prompt/modelHint 全量 + tasks 全量）。两种用法：①主管/人管理模板库时翻找；②**代理被指定"用 xxx 模板"时定位那条**（搜到全量后自行适配——按本地模型目录解析 modelHint、增删角色、微调任务，再 teams({op:"create"}) 建队）。**query 为空返回全部模板**（列表铺开用）。日常任务无需先搜（模板直接贴给代理即可），库大了/指定用哪条才搜。',
      { query: { type: 'string', description: '任务描述搜索词（如"写码评审测试三人组"）；为空返回全部模板。' }, limit: { type: 'number', description: '最多返回条数（默认 50）。' } },
      async (args) => {
        const q = String(args?.query ?? '').trim().toLowerCase()
        const list = await templateList()
        let scored
        if (q === '') {
          scored = list.map((t) => ({ t, hits: 0 }))
        } else {
          scored = list.map((t) => {
            const hay = (t.name + ' ' + t.description + ' ' + t.members.map((m) => m.role).join(' ')).toLowerCase()
            const hits = q.split(/\s+/).filter((w) => w.length > 1 && hay.includes(w)).length
            return { t, hits }
          }).filter((x) => x.hits > 0)
        }
        scored = scored.sort((a, b) => b.hits - a.hits).slice(0, Math.max(1, Math.min(100, Number(args?.limit ?? 50) || 50)))
        // 返回全量（代理读模板内容做适配，不是读摘要）
        return jsonText({ ok: true, count: scored.length, templates: scored.map((x) => x.t) })
      })
    registerTool(ctx, 'team_template_distill',
      '把当前队伍蒸馏成模板（capm 或团队会话用）：把调用方所在 team（或 targetSessionId 指定 captain 的队伍）的成员/任务快照为模板，具体模型清洗为 modelHint 推荐类别，分享无模型差异。也可以在完成任务后调用——把这次成功的队伍配置沉淀为可复用模板。',
      { source: { type: 'string', description: '来源标注（默认 capture）。' }, targetSessionId: { type: 'string', description: '队伍 captain 会话 id；省略=调用方自己（UI 路径必传——UI 不在会话里跑）。' } },
      async (args, exec) => {
        const captain = String(args?.targetSessionId ?? '') !== '' ? String(args.targetSessionId) : callerId(exec, agents)
        if (captain === undefined) return jsonText({ ok: false, error: 'cannot determine the calling session id' })
        const unit = await requireUnit()
        return await enqueue(async () => {
          const team = await getTeam(captain)
          if (team === undefined) return jsonText({ ok: false, error: 'no team found; create one first' })
          const rec = await captureTeam(team, String(args?.source ?? 'capture'))
          await templatePut(rec)
          return jsonText({ ok: true, templateId: rec.templateId, note: '当前队伍已蒸馏为模板；模板只含角色/任务骨架 + modelHint 推荐类别，不含具体模型' })
        })
      })
    registerTool(ctx, 'team_template_export',
      '导出团队模板为 JSON 文本（分享/下载）。返回模板完整 JSON（含 modelHint 推荐类别，不含具体模型/密钥/路径）——分享给他人，导入方 LLM 按本地目录适配。',
      { templateId: { type: 'string', required: true, description: '模板 id。' } },
      async (args) => {
        const rec = await templateGet(String(args?.templateId ?? ''))
        if (rec === undefined) return jsonText({ ok: false, error: 'template not found' })
        return jsonText({ ok: true, templateId: rec.templateId, json: JSON.stringify(sanitizeTemplate(rec), null, 2), note: '导出成功；modelHint 为推荐类别，实例化时按本地适配' })
      })
    registerTool(ctx, 'team_template_import',
      '导入团队模板（分享来的 JSON 文本）——**人工/UI 分享用**：人贴 JSON 校验（memberId/role 合法性）后入库。代理请勿用本工具（代理路径=search 读全量 → 自己多轮适配 → teams({op:"create"}) 创建）。',
      { json: { type: 'string', required: true, description: '模板 JSON 文本（来自 team_template_export）。' } },
      async (args) => {
        try {
          const parsed = JSON.parse(String(args?.json ?? ''))
          if (parsed === null || typeof parsed !== 'object') return jsonText({ ok: false, error: 'invalid template JSON' })
          const sanitized = sanitizeTemplate(parsed)
          if (sanitized.name === '' || sanitized.members.length === 0) return jsonText({ ok: false, error: 'template missing name or members' })
          if (sanitized.templateId === '' ) sanitized.templateId = 'tpl-' + makeId('x').slice(0, 10)
          sanitized.source = 'import'
          await templatePut(sanitized)
          return jsonText({ ok: true, templateId: sanitized.templateId, note: '已导入模板库（人工分享）；模型适配由代理在套用时按本地目录自行决定' })
        } catch (error) {
          return jsonText({ ok: false, error: 'bad template JSON: ' + errText(error) })
        }
      })
    registerTool(ctx, 'team_template_remove',
      '删除一条模板（模板库管理）。删除键在人工——本工具删除不可恢复；代理一般不需要（模板是给人工管理的）。',
      { templateId: { type: 'string', required: true, description: '模板 id。' } },
      async (args) => {
        const id = String(args?.templateId ?? '')
        if (id === '') return jsonText({ ok: false, error: 'templateId required' })
        const unit = await requireUnit()
        return await enqueue(async () => {
          const snapshot = await unit.loadAll()
          const t = snapshot !== undefined && snapshot.tables !== undefined && snapshot.tables['template'] !== undefined ? snapshot.tables['template'] : {}
          if (t[id] === undefined) return jsonText({ ok: false, error: 'template not found' })
          try { await unit.deleteRecord('template', id) } catch (error) { return jsonText({ ok: false, error: errText(error) }) }
          return jsonText({ ok: true, templateId: id, note: '模板已删除' })
        })
      })

    ctx.on('agent/disposed', (payload) => {
      const agent = payload !== undefined && payload.agent !== undefined ? payload.agent : undefined
      if (agent === undefined || typeof agent.id !== 'string') return
      wakeWaiters((w) => w.sessionId === agent.id, { ok: false, error: 'wait aborted (member session disposed)' })
      // 审计 t7/存储评审 R4：幽灵成员修复——会话销毁时从所有 team 花名册摘除该成员（多重归属一并清理）
      requireUnit().then((unit) => enqueue(async () => {
        const snapshot = await unit.loadAll()
        const table = snapshot !== undefined && snapshot.tables !== undefined && snapshot.tables['team'] !== undefined ? snapshot.tables['team'] : {}
        for (const key of Object.keys(table)) {
          const record = table[key]
          if (record === null || typeof record !== 'object' || !Array.isArray(record.members)) continue
          const before = record.members.length
          record.members = record.members.filter((m) => m === null || typeof m !== 'object' || m.sessionId !== agent.id)
          if (record.members.length !== before) {
            try { await unit.putRecord('team', key, record) } catch (error) { /* best-effort */ }
          }
        }
      })).catch(() => { /* never throw from listener */ })
    })

    ctx.on('agent/session-start', (payload) => {
      const agent = payload !== undefined && payload.agent !== undefined ? payload.agent : undefined
      if (agent === undefined || typeof agent.id !== 'string') return
      requireUnit().then((unit) => enqueue(async () => {
        const snapshot = await unit.loadAll()
        const mailTable = snapshot !== undefined && snapshot.tables !== undefined && snapshot.tables['mail'] !== undefined ? snapshot.tables['mail'] : {}
        const pending = []
        for (const key of Object.keys(mailTable)) {
          const record = mailTable[key]
          if (record !== null && typeof record === 'object' && record.to === agent.id) pending.push({ key, record })
        }
        for (const item of pending) {
          const record = item.record
          const message = {
            id: typeof record.id === 'string' ? record.id : makeId('m'),
            role: 'user',
            content: [{ type: 'text', text: typeof record.text === 'string' ? record.text : '' }],
            source: typeof record.from === 'string'
              ? { kind: 'user', rpcId: makeId('rpc'), senderSessionId: record.from }
              : { kind: 'user', rpcId: makeId('rpc') },
          }
          try { agent.followup(message) } catch (error) { continue }
          await unit.deleteRecord('mail', item.key)
        }
      })).catch(() => { /* never throw from a listener */ })
    })

    // ── teamDeleteApi：console（Web 控制台 3081）调 team_delete 逻辑（cleanup 三模式）──
    // console 是独立 HTTP（无 exec.agent）；UI 路径=人操作（token + 确认卡已挡），captain 由 UI 指定。
    ctx.provide('teamDeleteApi', {
      async delete(options) {
        const captain = String(options?.captainId ?? '')
        const cleanup = String(options?.cleanup ?? 'archive')
        const confirm = String(options?.cleanupConfirm ?? '')
        if (captain === '') return { ok: false, error: 'captainId required' }
        if (!['archive', 'delete', 'none'].includes(cleanup)) return { ok: false, error: 'cleanup must be archive | delete | none' }
        if (cleanup === 'delete' && confirm !== 'DELETE') return { ok: false, error: 'cleanup=delete 销毁不可逆，需 cleanupConfirm="DELETE"' }
        // delete 模式：console UI 路径人操作（token+确认卡），assumeMain 授权让主会话门通过
        const exec = cleanup === 'delete'
          ? { agent: { session: { header: { origin: 'main', parentSession: '' } } }, signal: undefined }
          : undefined
        const out = await OPS['team_delete'].handler({ captainId: captain, cleanup, cleanupConfirm: confirm }, exec)
        return JSON.parse(out)
      },
    })
  },
}

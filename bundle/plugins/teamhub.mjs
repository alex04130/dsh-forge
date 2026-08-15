// description: 代理团队（team_*）：队长 + 角色成员 + 依赖任务板，成员间可直接互发消息。
import { defineTool } from '@deepseek-ai/dsh-tools'
import { collectModelEscalations, collectPresetEscalations, installChildPolicy } from './lib/subagent-policy.mjs'

let idCounter = 0
function makeId(prefix) {
  idCounter += 1
  return prefix + '-' + Date.now().toString(36) + '-' + idCounter.toString(36) + '-' + Math.floor(Math.random() * 1679615).toString(36)
}
function errText(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}
function jsonText(value) {
  return JSON.stringify(value, null, 2)
}
function callerId(exec, agents) {
  if (exec !== undefined && exec.agent !== undefined && typeof exec.agent.id === 'string') return exec.agent.id
  const initiator = agents.currentInitiator()
  if (initiator !== undefined && typeof initiator.id === 'string') return initiator.id
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
  inject: ['tools', 'agents', 'storage', 'subagents'],
  apply(ctx) {
    const agents = ctx.agents
    const storage = ctx.storage
    const subagents = ctx.subagents
    const skills = ctx.get('skills')
    const presets = ctx.get('agentPresets')
    const approval = ctx.get('approval')
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
      teamsUnit = await backend.kv.open({ name: 'agent_teams', version: 0, tables: ['team', 'archive', 'mail'], hasGlobal: false })
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

    function registerTool(name, description, parameters, execute, timeoutMs) {
      const tool = defineTool({
        name,
        description,
        parameters,
        output: {
          schema: { type: 'string' },
          render(_args, value) { return [{ type: 'text', text: typeof value === 'string' ? value : String(value) }] },
        },
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        async execute(args, exec) {
          try {
            return await execute(args, exec)
          } catch (error) {
            return jsonText({ ok: false, error: errText(error) })
          }
        },
      })
      const dispose = ctx.tools.register(tool)
      ctx.effect(() => () => { try { dispose() } catch (error) { /* best-effort */ } })
    }

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
    async function addMember(team, spec, agent, exec, toolName) {
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

      const route = policy.liveRoute(agent)
      const parentHeader = agent.session?.requestHeader?.()
      const parentPreset = presets !== undefined ? presets.composedPreset(agent.ctx) : undefined
      const parentModel = route.model ?? parentHeader?.config?.model
      const childModel = explicitModel ?? parentModel
      const effort = explicitEffort ?? parentHeader?.config?.reasoningEffort

      const escalations = [
        ...collectModelEscalations(parentModel, childModel),
        ...(await collectPresetEscalations({ parentPreset, targetPreset: modeId, presets })),
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
      const started = await subagents.startContinuable({
        provider: 'spawn',
        label: memberId + ' (' + role + ')',
        request: {
          prompt: [{ type: 'text', text: persona }],
          parent: agent,
          ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
        },
        signal: exec !== undefined ? exec.signal : undefined,
      })
      policy.register(started.childId, {
        ...(modeId !== undefined ? { mode: modeId } : {}),
        ...(effort !== undefined && typeof effort === 'string' ? { effort } : {}),
      })
      team.members.push({ id: memberId, sessionId: started.childId, role, createdAt: Date.now() })
      await teamsUnit.putRecord('team', team.captain, team)
      return { ok: true, member: { id: memberId, sessionId: started.childId, role }, ...(modeId !== undefined ? { mode: modeId } : {}), ...(escalations.length > 0 ? { approvedEscalations: escalations } : {}) }
    }

    registerTool('team_create',
      '创建一个以你（调用会话）为队长的代理团队；一个队长同一时间只带领一个团队。可用 `members` 数组在建队时一次添加多个成员（每项含 memberId/role/prompt 及可选的 provider/model/reasoningEffort/mode，与 `team_add_member` 同策略：默认继承队长、提权逐项审批），可用 `tasks` 数组在建队时按数组序创建任务（每项含 title/description/assignee/dependencies；依赖引用的任务必须先出现在本数组或已存在于团队）。之后用 `team_add_member` 补成员、`team_add_members` 批量补成员、`team_create_task` 补任务、`team_send_message` 与成员交流。编排团队前先加载 agent-teamwork 技能：它涵盖团队设计、工作流和何时该沟通。',
      {
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
              prompt: { type: 'string', required: true, description: '成员初始任务。' },
              provider: { type: 'string', description: '可选供应商路由。' },
              model: { type: 'string', description: '可选模型 id。' },
              reasoningEffort: { type: 'string', description: '可选思考强度。' },
              mode: { type: 'string', description: '可选模式 id。' },
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
      async (args, exec) => {
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
              const result = await addMember(record, spec, agent, exec, 'team_create')
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
      })

    registerTool('team_add_member',
      '添加团队成员：派发一个带指定角色和任务提示词的可续子代理会话（成员继承本会话的组合，包括团队工具）。你选的成员 id 就是 `team_send_message` 发给它的地址。与 `spawn_model_subagent` 一样，可选的 `provider`/`model`/`reasoningEffort`/`mode` 覆盖默认继承队长；任何提权（更高的模型档位、跨系列换模型，或插件行能力面不是队长子集的模式）都会请求用户审批。完整工作流见 agent-teamwork 技能。',
      {
        memberId: { type: 'string', required: true, description: '简短成员 id/名字，如 "researcher" 或 "alice"。' },
        role: { type: 'string', required: true, description: '角色描述，如 "frontend reviewer"。' },
        prompt: { type: 'string', required: true, description: '成员的初始任务（作为其第一条消息送达）。' },
        provider: { type: 'string', description: '可选的成员供应商路由；省略则继承队长的供应商。' },
        model: { type: 'string', description: '可选的成员模型 id；省略则继承队长当前模型。' },
        reasoningEffort: { type: 'string', description: '可选的成员思考强度；省略则继承队长当前强度。' },
        mode: { type: 'string', description: '可选的成员模式 id（如 "router-standard"、"cordis"）；省略则继承队长组合。' },
      },
      async (args, exec) => {
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
      })

    registerTool('team_add_members',
      '批量添加团队成员：一次传入多个成员数组（每项含 memberId/role/prompt 及可选的 provider/model/reasoningEffort/mode）。逐项独立审批与失败隔离：某个成员提权被拒绝或 spawn 失败只影响该项，其余继续。与 `team_add_member`（单个）同策略。完整工作流见 agent-teamwork 技能。',
      {
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
              prompt: { type: 'string', required: true, description: '成员初始任务。' },
              provider: { type: 'string', description: '可选供应商路由。' },
              model: { type: 'string', description: '可选模型 id。' },
              reasoningEffort: { type: 'string', description: '可选思考强度。' },
              mode: { type: 'string', description: '可选模式 id。' },
            },
          },
        },
      },
      async (args, exec) => {
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
      })

    registerTool('team_create_task',
      '把团队工作拆成一个任务；可选声明依赖（必须先完成的任务 id）和指派人（成员 id；未指派的任务留在可认领池里等待）。完整工作流见 agent-teamwork 技能。',
      {
        title: { type: 'string', required: true, description: '简短任务标题。' },
        description: { type: 'string', description: '任务要求及验收标准。' },
        assignee: { type: 'string', description: '要指派的成员 id，省略则进入可认领池。' },
        dependencies: { type: 'array', description: '必须先完成的任务 id。' },
      },
      async (args, exec) => {
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
      })

    registerTool('team_claim_task',
      '为成员认领一个待处理任务（或取消认领退回待处理）。所有依赖必须已完成。队长可为任何人认领；成员只能为自己或未指派任务认领。完整工作流见 agent-teamwork 技能。',
      {
        taskId: { type: 'string', required: true, description: '任务 id，如 "t1"。' },
        memberId: { type: 'string', description: '认领任务的成员；省略表示调用者（队长或成员）。' },
      },
      async (args, exec) => {
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
              if (record !== null && typeof record === 'object' && memberOf(record, me)) { captain = key; team = record; claimant = me; break }
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
      })

    registerTool('team_update_task',
      '推进任务状态（claimed → in_progress → completed | failed | cancelled）并可选记录其输出。成员更新自己的任务；队长可更新任何任务。完整工作流见 agent-teamwork 技能。',
      {
        taskId: { type: 'string', required: true, description: '任务 id，如 "t1"。' },
        status: { type: 'string', required: true, description: '新状态：claimed | in_progress | completed | failed | cancelled。' },
        output: { type: 'string', description: '要存储的结果文本（交付物或摘要放这里）。' },
      },
      async (args, exec) => {
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
          if (me !== captain && task.assignee !== me) return jsonText({ ok: false, error: 'only the assignee or the captain may update task "' + taskId + '"' })
          const allowed = TASK_TRANSITIONS[task.status] ?? []
          if (!allowed.includes(status)) return jsonText({ ok: false, error: 'cannot move task "' + taskId + '" from "' + task.status + '" to "' + status + '" (allowed: ' + allowed.join(', ') + ')' })
          task.status = status
          if (typeof args.output === 'string' && args.output.length > 0) task.output = args.output
          await teamsUnit.putRecord('team', captain, team)
          if (status === 'completed') wakeWaiters((w) => w.taskId !== null && w.taskId !== undefined && w.taskId === taskId, { ok: true, wokenBy: 'task-completed', taskId })
          return jsonText({ ok: true, taskId, status, teamName: team.name })
        })
      })

    registerTool('team_wait',
      '暂停当前回合，等待另一名队员的消息或某个任务的完成（两者都给时任一满足即唤醒）。等待期间回合挂起、不消耗额外步骤：目标发来消息、目标任务 completed、或队长发来任何消息都会立即唤醒你继续。超时（默认 600 秒，上限 3600 秒）后返回 timeout，模型可再次调用继续等。队长随时可发消息拆掉等待，因此不会死锁。',
      {
        memberId: { type: 'string', description: '要等待的成员 id；省略则等待任意消息。' },
        taskId: { type: 'string', description: '要等待的任务 id（如 "t2"）；该任务 completed 时唤醒。' },
        timeoutSeconds: { type: 'number', description: '最长等待秒数（默认 600，上限 3600）。' },
      },
      async (args, exec) => {
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
          const finish = (payload) => {
            if (settled) return
            settled = true
            const idx = waiters.indexOf(entry)
            if (idx >= 0) waiters.splice(idx, 1)
            if (timeoutDispose !== null) { try { timeoutDispose() } catch (error) { /* best-effort */ } }
            resolve(jsonText(payload))
          }
          entry.finish = finish
          waiters.push(entry)
          timeoutDispose = timer.timeout(() => finish({ ok: true, wokenBy: 'timeout', afterSeconds: timeoutSec }), timeoutSec * 1000)
          const signal = exec !== undefined ? exec.signal : undefined
          if (signal !== undefined && typeof signal.addEventListener === 'function') {
            signal.addEventListener('abort', () => finish({ ok: false, error: 'wait aborted (turn cancelled)' }), { once: true })
          }
        })
      })

    registerTool('team_send_message',
      '给队长或另一成员发消息。在线接收方立即在收件箱收到并醒来；否则消息持久排队，在该会话下次启动时送达。发送方永远是调用会话（不可伪造）。何时该沟通见 agent-teamwork 技能。',
      {
        to: { type: 'string', required: true, description: '接收方：成员 id 或 "captain"。' },
        text: { type: 'string', required: true, description: '消息正文。' },
      },
      async (args, exec) => {
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
      })

    registerTool('team_status',
      '团队全貌：成员及其在线状态、带依赖和输出的任务板、以及排在你收件箱里的消息。轮询它以收集成员输出并决定下一步。完整工作流见 agent-teamwork 技能。',
      {},
      async (args, exec) => {
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
            if (record !== null && typeof record === 'object' && record.to === me) inbox.push(record)
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
      })

    registerTool('team_delete',
      '结束团队：尽力打断在线成员，然后归档团队记录（任务、依赖图和成员列表保留供回顾）。完整工作流见 agent-teamwork 技能。',
      {},
      async (args, exec) => {
        const captain = callerId(exec, agents)
        if (captain === undefined) return jsonText({ ok: false, error: 'cannot determine the calling session id' })
        const agent = exec !== undefined ? exec.agent : undefined
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
          const archived = { ...team, archivedAt: Date.now() }
          await teamsUnit.putRecord('archive', team.teamId, archived)
          await teamsUnit.deleteRecord('team', captain)
          return jsonText({ ok: true, archived: team.teamId, name: team.name, note: 'team archived; members stopped where possible' })
        })
      })
    ctx.on('agent/disposed', (payload) => {
      const agent = payload !== undefined && payload.agent !== undefined ? payload.agent : undefined
      if (agent === undefined || typeof agent.id !== 'string') return
      wakeWaiters((w) => w.sessionId === agent.id, { ok: false, error: 'wait aborted (member session disposed)' })
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

  },
}

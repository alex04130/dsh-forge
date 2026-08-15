import { defineTool } from '@deepseek-ai/dsh-tools'

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

    async function getTeam(captain) {
      const teamsUnit = await requireUnit()
      const snapshot = await teamsUnit.loadAll()
      const table = snapshot !== undefined && snapshot.tables !== undefined && snapshot.tables['team'] !== undefined ? snapshot.tables['team'] : {}
      const record = table[captain]
      if (record === null || typeof record !== 'object') return undefined
      return record
    }

    function memberOf(team, id) {
      return Array.isArray(team.members) && team.members.some((m) => m !== null && typeof m === 'object' && (m.id === id || m.sessionId === id))
    }

    registerTool('team_create',
      'Create an agent team with YOU (the calling session) as the captain (lead). One captain leads one team at a time. After creating, use team_add_member to pull role-based members, team_create_task to split work with dependencies, and team_send_message to talk to members. Load the agent-teamwork skill before orchestrating a team: it describes how to design an appropriate team and subagent workflow and when to communicate.',
      {
        name: { type: 'string', required: true, description: 'Short team name, e.g. "migration-squad".' },
        goal: { type: 'string', description: 'One-line team goal, delivered to members.' },
      },
      async (args, exec) => {
        const captain = callerId(exec, agents)
        if (captain === undefined) return jsonText({ ok: false, error: 'cannot determine the calling session id' })
        const name = String(args.name ?? '').trim()
        if (name.length === 0 || name.length > 64) return jsonText({ ok: false, error: 'team name must be 1-64 characters' })
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
          return record
        })
        return jsonText({ ok: true, team: created })
      })

    registerTool('team_add_member',
      'Add a team member: spawns a durable, continuable subagent session with the given role and mission prompt (the member inherits this session composition, including the team tools). The member id you choose becomes its address for team_send_message. Load the agent-teamwork skill for the full team workflow.',
      {
        memberId: { type: 'string', required: true, description: 'Short member id/name, e.g. "researcher" or "alice".' },
        role: { type: 'string', required: true, description: 'Role description, e.g. "frontend reviewer".' },
        prompt: { type: 'string', required: true, description: 'Initial mission for the member (delivered as its first message).' },
      },
      async (args, exec) => {
        const captain = callerId(exec, agents)
        if (captain === undefined) return jsonText({ ok: false, error: 'cannot determine the calling session id' })
        const agent = exec !== undefined ? exec.agent : undefined
        if (agent === undefined) return jsonText({ ok: false, error: 'no calling agent; team_add_member must run inside a session' })
        const memberId = cleanId(args.memberId)
        const role = String(args.role ?? '').trim()
        if (memberId.length === 0 || role.length === 0 || role.length > 120) return jsonText({ ok: false, error: 'memberId must match [0-9a-zA-Z._-] (<=48) and role must be 1-120 characters' })
        const teamsUnit = await requireUnit()
        return await enqueue(async () => {
          const team = await getTeam(captain)
          if (team === undefined) return jsonText({ ok: false, error: 'no team found; call team_create first' })
          if (memberOf(team, memberId)) return jsonText({ ok: false, error: 'member "' + memberId + '" already exists' })
          if (team.members.length >= 8) return jsonText({ ok: false, error: 'team member limit (8) reached' })
          const persona = 'You are member "' + memberId + '" (' + role + ') of agent team "' + team.name + '" led by captain session ' + captain + '. Team goal: ' + String(team.goal ?? '(none)') + '.\n\nWork protocol:\n- Claim and work only on tasks assigned to you (team_claim_task / team_update_task).\n- When a task is done, call team_update_task with status "completed" and put your result in output.\n- Talk to the captain or other members with team_send_message (their ids are in team_status).\n- Check team_status for your inbox and task state before acting.\n- Load the agent-teamwork skill for the full team protocol.\n\nYour mission from the captain:\n' + String(args.prompt ?? '')
          const started = await subagents.startContinuable({
            provider: 'spawn',
            label: memberId + ' (' + role + ')',
            request: {
              prompt: [{ type: 'text', text: persona }],
              parent: agent,
            },
            signal: exec !== undefined ? exec.signal : undefined,
          })
          team.members.push({ id: memberId, sessionId: started.childId, role, createdAt: Date.now() })
          await teamsUnit.putRecord('team', captain, team)
          return jsonText({ ok: true, member: { id: memberId, sessionId: started.childId, role } })
        })
      })

    registerTool('team_create_task',
      'Split team work into a task. Optionally declare dependencies (task ids that must be completed before this one) and an assignee (member id; unassigned tasks wait in the claimable pool). Load the agent-teamwork skill for the workflow.',
      {
        title: { type: 'string', required: true, description: 'Short task title.' },
        description: { type: 'string', description: 'What the task requires and its acceptance criteria.' },
        assignee: { type: 'string', description: 'Member id to assign, or omit for the claimable pool.' },
        dependencies: { type: 'array', description: 'Task ids that must be completed first.' },
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
      'Claim a pending task for a member (or unassign it back to pending). All dependencies must be completed first. The captain may claim for anyone; a member may claim only for itself or an unassigned task. Load the agent-teamwork skill for the workflow.',
      {
        taskId: { type: 'string', required: true, description: 'Task id, e.g. "t1".' },
        memberId: { type: 'string', description: 'Member claiming the task; omitted means the caller (captain or member).' },
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
      'Advance a task status (claimed -> in_progress -> completed | failed | cancelled) and optionally record its output. Members update their own tasks; the captain may update any task. Load the agent-teamwork skill for the workflow.',
      {
        taskId: { type: 'string', required: true, description: 'Task id, e.g. "t1".' },
        status: { type: 'string', required: true, description: 'New status: claimed | in_progress | completed | failed | cancelled.' },
        output: { type: 'string', description: 'Result text to store (put the deliverable or a summary here).' },
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
          return jsonText({ ok: true, taskId, status, teamName: team.name })
        })
      })

    registerTool('team_send_message',
      'Send a message to the captain or another member. If the recipient is live the message lands in its inbox immediately and wakes it; otherwise it is queued durably and delivered at its next session start. The sender is always the calling session (no spoofing). Check the agent-teamwork skill for when to communicate.',
      {
        to: { type: 'string', required: true, description: 'Recipient: a member id or "captain".' },
        text: { type: 'string', required: true, description: 'Message body.' },
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
          const wrapped = prefix + '\n\n' + text + '\n\n[/team message]'
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
          return jsonText({ ok: true, delivered: 'queued', to, messageId: message.id })
        })
      })

    registerTool('team_status',
      'Full team picture: members with live status, the task board with dependencies and outputs, and messages queued in YOUR inbox. Poll this to collect member output and decide the next step. Load the agent-teamwork skill for the workflow.',
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
      'End the team: best-effort interrupt live members, then archive the team record (tasks, dependency graph, and member list are kept for review). Load the agent-teamwork skill for the workflow.',
      {},
      async (args, exec) => {
        const captain = callerId(exec, agents)
        if (captain === undefined) return jsonText({ ok: false, error: 'cannot determine the calling session id' })
        const agent = exec !== undefined ? exec.agent : undefined
        const teamsUnit = await requireUnit()
        return await enqueue(async () => {
          const team = await getTeam(captain)
          if (team === undefined) return jsonText({ ok: false, error: 'no team found for this captain' })
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

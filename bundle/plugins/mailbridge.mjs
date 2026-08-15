// description: 跨会话消息桥：session_send / session_read / mailbox_check，让同一进程内的会话互相收发消息（带 begin/end 标记）。
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

const DSH_HOME = process.env.DSH_HOME || '/home/alex/.dsh'
const SESSIONS_ROOT = DSH_HOME + '/sessions'
const PROJCACHE_PATH = DSH_HOME + '/storages/session_projcache.json'

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
function flattenText(blocks) {
  if (!Array.isArray(blocks)) return ''
  let out = ''
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}
function callerId(exec, agents) {
  if (exec !== undefined && exec.agent !== undefined && typeof exec.agent.id === 'string') return exec.agent.id
  const initiator = agents.currentInitiator()
  if (initiator !== undefined && typeof initiator.id === 'string') return initiator.id
  return undefined
}
async function listSessionIds() {
  const ids = []
  try {
    const workspaces = await readdir(SESSIONS_ROOT, { withFileTypes: true })
    for (const ws of workspaces) {
      if (ws === null || typeof ws !== 'object' || !ws.isDirectory()) continue
      try {
        const entries = await readdir(join(SESSIONS_ROOT, ws.name), { withFileTypes: true })
        for (const e of entries) {
          if (e !== null && typeof e === 'object' && e.isDirectory()) ids.push({ id: e.name, workspace: ws.name })
        }
      } catch (error) { /* skip workspace */ }
    }
  } catch (error) { /* sessions root unavailable */ }
  return ids
}

async function readTitles() {
  const titles = {}
  try {
    const raw = await readFile(PROJCACHE_PATH, 'utf8')
    const data = JSON.parse(raw)
    const sessions = data !== null && typeof data === 'object' && data.tables !== null && typeof data.tables === 'object' ? data.tables.sessions : undefined
    if (sessions !== null && typeof sessions === 'object') {
      for (const id of Object.keys(sessions)) {
        const rec = sessions[id]
        const title = rec !== null && typeof rec === 'object' && rec.rows !== null && typeof rec.rows === 'object' && rec.rows.title !== null && typeof rec.rows.title === 'object' && typeof rec.rows.title.val === 'string' ? rec.rows.title.val : undefined
        if (title !== undefined && title.length > 0) titles[id] = title
      }
    }
  } catch (error) { /* best-effort */ }
  return titles
}

async function callerName(id) {
  if (id === undefined) return null
  try {
    const titles = await readTitles()
    const title = titles[id]
    if (typeof title === 'string' && title.length > 0) return title
  } catch (error) { /* best-effort */ }
  return null
}

export default {
  inject: ['tools', 'agents', 'sessions', 'sessionPersistence', 'storage'],
  apply(ctx) {
    const agents = ctx.agents
    const sessions = ctx.sessions
    const sessionPersistence = ctx.sessionPersistence
    const storage = ctx.storage
    const skills = ctx.get('skills')

    let unit = undefined
    let openError = undefined
    const opening = (async () => {
      const backend = storage.backend.get('json')
      if (backend === undefined || backend.kv === undefined) throw new Error('no "json" storage backend with a kv facet is mounted; the durable mailbox is unavailable')
      unit = await backend.kv.open({ name: 'agent_mailbox', version: 0, tables: ['msg'], hasGlobal: false })
    })()
    opening.catch((error) => { openError = errText(error) })
    async function requireUnit() {
      await opening
      if (unit === undefined) throw new Error('mailbox storage unit failed to open: ' + (openError ?? 'unknown error'))
      return unit
    }

    let chain = Promise.resolve()
    function enqueue(operation) {
      const next = chain.then(operation, operation)
      chain = next.then(() => undefined, () => undefined)
      return next
    }

    ctx.effect(() => () => {
      if (unit !== undefined) { try { unit.close() } catch (error) { /* already closed */ } }
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

    registerTool('session_list',
      'List sessions in this DSH process (live and persisted) with their ids, titles, and live status. Use it to find a target session id before `session_send`, or to see which sessions exist for cross-session coordination. See the `cross-session-mailbox` skill for the full workflow.',
      { limit: { type: 'number', description: 'Maximum sessions to return (default 50, cap 200).' } },
      async (args, exec) => {
        const cap = typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), 200) : 50
        const [ids, titles] = await Promise.all([listSessionIds(), readTitles()])
        const list = []
        for (const entry of ids.slice(0, cap)) {
          list.push({
            sessionId: entry.id,
            title: typeof titles[entry.id] === 'string' ? titles[entry.id] : null,
            live: sessions !== undefined ? sessions.get(entry.id) !== undefined : false,
            persisted: true,
            createdAt: null,
          })
        }
        return jsonText({ ok: true, count: list.length, sessions: list })
      })

    registerTool('session_read',
      'Read the recent message log of another session (exact reads only): user, assistant, and tool messages with their text, oldest first. Use it to understand what another session is doing before messaging it, or to collect its results. See the `cross-session-mailbox` skill for the full workflow.',
      {
        sessionId: { type: 'string', required: true, description: 'Target session id from session_list.' },
        maxEvents: { type: 'number', description: 'Maximum events returned (default 20, cap 500).' },
      },
      async (args, exec) => {
        const sessionId = String(args.sessionId)
        if (sessionPersistence === undefined) return jsonText({ ok: false, error: 'sessionPersistence service is not available in this deployment' })
        let snapshot
        try {
          snapshot = await sessionPersistence.inspect(sessionId)
        } catch (error) {
          return jsonText({ ok: false, error: 'failed to read session: ' + errText(error) })
        }
        const cap = typeof args.maxEvents === 'number' && args.maxEvents > 0 ? Math.min(Math.floor(args.maxEvents), 500) : 20
        const events = []
        for (const event of (Array.isArray(snapshot.events) ? snapshot.events : [])) {
          let entry = undefined
          if (event.type === 'user/message') {
            entry = { type: 'user', time: event.time, text: flattenText(event.data !== undefined ? event.data.content : undefined) }
          } else if (event.type === 'assistant/message') {
            const message = event.data !== undefined ? event.data.message : undefined
            entry = { type: 'assistant', time: event.time, text: flattenText(message !== undefined ? message.content : undefined) }
          } else if (event.type === 'tool/result') {
            const message = event.data !== undefined ? event.data.message : undefined
            const block = message !== undefined && Array.isArray(message.content) ? message.content[0] : undefined
            entry = { type: 'tool', time: event.time, text: block !== undefined && Array.isArray(block.content) ? flattenText(block.content) : '' }
          }
          if (entry !== undefined) {
            if (entry.text.length > 4000) entry.text = entry.text.slice(0, 4000) + ' ...(truncated)'
            events.push(entry)
          }
        }
        return jsonText({ ok: true, sessionId, count: events.length, events: events.slice(-cap) })
      })

    registerTool('session_send',
      'Send a message to another session in this DSH process. A live target receives it in its inbox immediately and wakes; otherwise the message is queued durably and delivered the next time that session starts. The recipient sees the text prefixed with `[cross-session message from <session name> (<sessionId>)]`. See the `cross-session-mailbox` skill for the full workflow.',
      {
        targetSessionId: { type: 'string', required: true, description: 'Target session id from session_list.' },
        text: { type: 'string', required: true, description: 'Message body for the target session.' },
      },
      async (args, exec) => {
        const targetId = String(args.targetSessionId)
        const body = String(args.text)
        if (body.length === 0) return jsonText({ ok: false, error: 'text must not be empty' })
        const from = callerId(exec, agents)
        const fromName = await callerName(from)
        const senderLabel = fromName !== null ? fromName + ' (' + from + ')' : (from ?? 'unknown')
        const prefix = '[cross-session message from ' + senderLabel + ']'
        // Strip any legacy end marker the sender may have copied into the body,
        // so the wrap never doubles up.
        const cleanBody = body.replace(/(\n*\s*(?:\[\/cross-session message\]|\[cross-session message end\])\s*)+$/, '')
        const wrapped = prefix + '\n\n' + cleanBody + '\n\n[cross-session message end]'
        const message = {
          id: makeId('m'),
          role: 'user',
          content: [{ type: 'text', text: wrapped }],
          source: from === undefined
            ? { kind: 'user', rpcId: makeId('rpc') }
            : { kind: 'user', rpcId: makeId('rpc'), senderSessionId: from },
        }
        const target = agents.get(targetId)
        if (target !== undefined) {
          try {
            if (typeof target.status === 'string' && target.status === 'running') target.steer(message)
            else target.followup(message)
            return jsonText({ ok: true, delivered: 'live', targetSessionId: targetId, messageId: message.id, from: from ?? null, fromName })
          } catch (error) { /* fall through to the durable queue */ }
        }
        try {
          const ids = await listSessionIds()
          const known = ids.some((entry) => entry.id === targetId)
          if (!known) return jsonText({ ok: false, error: 'unknown session id "' + targetId + '"; use session_list to see available sessions' })
        } catch (error) { /* best-effort existence check */ }
        const mailbox = await requireUnit()
        await enqueue(() => mailbox.putRecord('msg', message.id, {
          id: message.id,
          from: from ?? null,
          fromName,
          to: targetId,
          text: wrapped,
          ts: Date.now(),
        }))
        return jsonText({ ok: true, delivered: 'queued', targetSessionId: targetId, messageId: message.id, from: from ?? null, fromName })
      })

    registerTool('mailbox_check',
      'Check and consume cross-session messages queued for THIS session (messages sent while it was not live). Returns the messages and removes them from the durable queue; call it when the user asks whether other sessions sent anything. See the `cross-session-mailbox` skill for the full workflow.',
      {},
      async (args, exec) => {
        const me = callerId(exec, agents)
        if (me === undefined) return jsonText({ ok: false, error: 'cannot determine the calling session id' })
        const mailbox = await requireUnit()
        const messages = await enqueue(async () => {
          const snapshot = await mailbox.loadAll()
          const table = snapshot !== undefined && snapshot.tables !== undefined && snapshot.tables['msg'] !== undefined ? snapshot.tables['msg'] : {}
          const mine = []
          const keys = []
          for (const key of Object.keys(table)) {
            const record = table[key]
            if (record !== null && typeof record === 'object' && record.to === me) { mine.push(record); keys.push(key) }
          }
          for (const key of keys) await mailbox.deleteRecord('msg', key)
          return mine
        })
        return jsonText({ ok: true, sessionId: me, count: messages.length, messages })
      })

    ctx.on('agent/session-start', (payload) => {
      const agent = payload !== undefined && payload.agent !== undefined ? payload.agent : undefined
      if (agent === undefined || typeof agent.id !== 'string') return
      requireUnit().then((mailbox) => enqueue(async () => {
        const snapshot = await mailbox.loadAll()
        const table = snapshot !== undefined && snapshot.tables !== undefined && snapshot.tables['msg'] !== undefined ? snapshot.tables['msg'] : {}
        const pending = []
        for (const key of Object.keys(table)) {
          const record = table[key]
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
          await mailbox.deleteRecord('msg', item.key)
        }
      })).catch(() => { /* never throw from a listener */ })
    })

  },
}

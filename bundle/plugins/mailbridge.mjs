// description: 跨会话消息桥：session_send / session_read / mailbox_check，让同一进程内的会话互相收发消息（带 begin/end 标记）。
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
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

    // wake 守卫（P0-4，security review t7-H3）：冷启动任意离线会话会消耗
    // 目标会话的模型回合并按目标的高档路由计费——限制为仅主会话可用，
    // 并对每个目标会话限频（滑动窗口），封堵"被注入子代理循环唤醒烧预算"链。
    function isMainSession(exec) {
      if (exec === undefined || exec.agent === undefined) return false
      let header = undefined
      try { header = exec.agent.session !== undefined ? exec.agent.session.header : undefined } catch (error) { header = undefined }
      const origin = header !== undefined ? header.origin : undefined
      const parent = header !== undefined ? header.parentSession : undefined
      if (origin === 'subagent' || (typeof parent === 'string' && parent.length > 0)) return false
      return true
    }
    const WAKE_WINDOW_MS = 60000
    const WAKE_LIMIT = 3
    const wakeTimes = new Map()
    function checkWakeAllowed(exec, targetId) {
      if (!isMainSession(exec)) return { ok: false, error: 'wake is restricted to the main session (subagents cannot cold-start sessions)' }
      const now = Date.now()
      const kept = (wakeTimes.get(targetId) ?? []).filter((t) => now - t < WAKE_WINDOW_MS)
      if (kept.length >= WAKE_LIMIT) {
        wakeTimes.set(targetId, kept)
        return { ok: false, error: 'wake rate limit exceeded for this target (' + WAKE_LIMIT + ' per ' + Math.round(WAKE_WINDOW_MS / 1000) + 's); wait before waking again' }
      }
      kept.push(now)
      wakeTimes.set(targetId, kept)
      return { ok: true }
    }

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
      '列出本 DSH 进程中的会话（在线与已持久化），含 id、标题和在线状态。只要知道 id 或标题片段就优先用 `session_find`——大进程中完整名册很耗上下文；只有确实需要完整名册时才用 `session_list`。完整工作流见 `cross-session-mailbox` 技能。',
      { limit: { type: 'number', description: '最大返回会话数（默认 50，上限 200）。' } },
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
      '读取另一会话的近期消息日志（仅精确读取）：用户、助手和工具消息及其文本，按时间从旧到新。用于给某会话发消息前了解它在做什么，或收集它的结果。完整工作流见 `cross-session-mailbox` 技能。',
      {
        sessionId: { type: 'string', required: true, description: '目标会话 id（来自 session_list）。' },
        maxEvents: { type: 'number', description: '最大返回事件数（默认 20，上限 500）。' },
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
      '向本 DSH 进程中的另一会话发送消息。在线目标会立即在收件箱收到并醒来；否则消息持久排队，在该会话下次启动时送达。`wake: true` 时离线目标立即冷启动（加载其已持久化日志，会话重启并立刻处理该消息），而不是等它下次手动启动——用于强制睡眠中的会话现在就干活；会消耗目标会话的模型回合。wake 仅主会话可用（子代理被拒），同一目标 60 秒内最多 3 次。接收方看到的文本带 `[cross-session message from <session name> (<sessionId>)]` 前缀。完整工作流见 `cross-session-mailbox` 技能。',
      {
        targetSessionId: { type: 'string', required: true, description: '目标会话 id（来自 session_list）。' },
        text: { type: 'string', required: true, description: '目标会话的消息正文。' },
        wake: { type: 'boolean', description: '是否强制唤醒离线目标：从其已持久化日志冷启动并立即送达（默认 false = 持久排队）。会消耗目标会话的模型回合；仅主会话可用，同一目标 60 秒内最多 3 次。' },
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
        // Reply guidance rides every wrapped message so the receiving model
        // knows it must answer the SENDER SESSION (not just the local user)
        // when the body asks for a reply — cross-session requests are easy to
        // misread as local user input otherwise.
        const replyHint = from === undefined
          ? ''
          : '\n\n（这是一条跨会话协作消息。若它要求回复，处理后请用 session_send 把结论发回给发送方会话 ' + from + '，而不是只写在本地对话里。）'
        const wrapped = prefix + '\n\n' + cleanBody + replyHint + '\n\n[cross-session message end]'
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
        if (args.wake === true && typeof agents.resume === 'function') {
          const wakeCheck = checkWakeAllowed(exec, targetId)
          if (wakeCheck.ok === false) return jsonText({ ok: false, error: wakeCheck.error })
          try {
            // Reuse the session's last logged route so the waking turn bills
            // the same provider/model instead of the global default.
            let agentOptions
            try {
              const inspection = await sessionPersistence.inspect(targetId)
              const events = Array.isArray(inspection.events) ? inspection.events : []
              for (let i = events.length - 1; i >= 0; i -= 1) {
                const event = events[i]
                const header = event?.data?.header
                const cfg = header?.config
                if (event !== null && typeof event === 'object' && event.type === 'request/header' && cfg !== null && typeof cfg === 'object' && typeof cfg.provider === 'string' && typeof cfg.model === 'string') {
                  agentOptions = { provider: cfg.provider, model: cfg.model }
                  break
                }
              }
            } catch (error) { /* resume with defaults */ }
            await agents.resume({ resumeSessionId: targetId, ...(agentOptions !== undefined ? { agentOptions } : {}) })
            const resumed = agents.get(targetId)
            if (resumed !== undefined) {
              let delivered = false
              try {
                if (typeof resumed.status === 'string' && resumed.status === 'running') resumed.steer(message)
                else resumed.followup(message)
                delivered = true
              } catch (error) {
                // One retry through the ordinary followup path (steer may race
                // the waking turn); a second failure falls through to the
                // durable queue below instead of losing the message.
                try {
                  resumed.followup(message)
                  delivered = true
                } catch (retryError) { /* fall through to the durable queue */ }
              }
              if (delivered) {
                return jsonText({ ok: true, delivered: 'woken', targetSessionId: targetId, messageId: message.id, from: from ?? null, fromName, agentOptions: agentOptions ?? null })
              }
            }
            // resume succeeded but the agent did not register: fall through to
            // the durable queue below instead of losing the message (P0-2 fix —
            // every path must end in live delivery OR the persistent queue).
          } catch (error) {
            return jsonText({ ok: false, error: 'wake failed: ' + errText(error), targetSessionId: targetId })
          }
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
      '检查并消费排给本会话的跨会话消息（本会话不在线期间发来的消息）。返回消息并从持久队列中移除；用户问其他会话是否发过什么时调用。完整工作流见 `cross-session-mailbox` 技能。',
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

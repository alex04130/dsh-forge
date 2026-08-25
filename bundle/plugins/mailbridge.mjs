// description: 跨会话消息桥：session_send / session_read / mailbox_check，让同一进程内的会话互相收发消息（带 begin/end 标记）。
import { readdir, readFile, rm, writeFile, unlink, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { errText, jsonText, DSH_HOME } from './lib/forge-common.mjs'
import { registerTool } from './lib/forge-tools.mjs'

const SESSIONS_ROOT = DSH_HOME + '/sessions'
const PROJCACHE_PATH = DSH_HOME + '/storages/session_projcache.json'

let idCounter = 0
function makeId(prefix) {
  idCounter += 1
  return prefix + '-' + Date.now().toString(36) + '-' + idCounter.toString(36) + '-' + Math.floor(Math.random() * 1679615).toString(36)
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
    // 宿主侧服务键名是 workspaceRegistry（apiproxy 以 workspaces 别名暴露给 client）。
    // 该服务初始化晚于本插件，必须惰性获取（apply 时刻 ctx.get 拿不到）。
    const getWorkspaces = () => ctx.get('workspaceRegistry')
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

    // ================= 子会话归档/删除（sessionmgmt） =================
    // 规则（用户拍板 2026-08-17）：
    //   - session_archive/unarchive 只能处理子代理（下辖任意深度），绝不能归档主代理
    //   - 删除不提供模型工具：用户经 WebUI 弹窗确认 → 宿主 RPC（前端 sessmgr）→ svc.deleteSessions
    //   - 删除主代理递归删除其整个子树（parentSession 链传递闭包）
    //   - 归档真相 = 会话目录 meta.json；上游 archivedSessionIds 为镜像（官方 UI 隐藏一致）
    //   - session_export 递归导出整个子树为明文

    // 上游同款 encodeSegment（dsh-session-persistence-jsonl），用于定位目录
    function encodeSegment(raw) {
      if (raw.length === 0) throw new Error('cannot encode an empty path segment')
      if (raw === '.') return '~002E'
      if (raw === '..') return '~002E~002E'
      let out = ''
      for (let i = 0; i < raw.length; i++) {
        const code = raw.charCodeAt(i)
        const ch = String.fromCharCode(code)
        if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
        else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      }
      return out
    }

    // 一次扫描建「id → 会话目录绝对路径」索引（含编码形态）
    async function buildSessionDirIndex() {
      const map = new Map()
      try {
        const wss = await readdir(SESSIONS_ROOT, { withFileTypes: true })
        for (const ws of wss) {
          if (ws === null || typeof ws !== 'object' || !ws.isDirectory()) continue
          const base = join(SESSIONS_ROOT, ws.name)
          try {
            const entries = await readdir(base, { withFileTypes: true })
            for (const e of entries) {
              if (e !== null && typeof e === 'object' && e.isDirectory()) map.set(e.name, join(base, e.name))
            }
          } catch (error) { /* skip workspace */ }
        }
      } catch (error) { /* sessions root unavailable */ }
      return map
    }
    function dirForId(index, id) {
      const direct = index.get(id)
      if (direct !== undefined) return direct
      return index.get(encodeSegment(id))
    }
    async function readMetaAt(dir) {
      if (dir === undefined) return undefined
      try {
        const raw = await readFile(join(dir, 'meta.json'), 'utf8')
        const data = JSON.parse(raw)
        return data !== null && typeof data === 'object' ? data : undefined
      } catch (error) { return undefined }
    }

    function callerMasterId(exec) {
      const agent = exec !== undefined ? exec.agent : undefined
      if (agent === undefined) return undefined
      let header = undefined
      try { header = agent.session !== undefined ? agent.session.header : undefined } catch (error) { header = undefined }
      const origin = header !== undefined ? header.origin : undefined
      const parent = header !== undefined ? header.parentSession : undefined
      if (origin === 'subagent' || (typeof parent === 'string' && parent.length > 0)) return typeof parent === 'string' ? parent : undefined
      return typeof agent.id === 'string' ? agent.id : undefined
    }
    function isSubHeader(h) {
      if (h === null || typeof h !== 'object') return false
      return h.origin === 'subagent' || (typeof h.parentSession === 'string' && h.parentSession.length > 0)
    }
    function masterIdFromSessionId(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
      const agent = agents !== undefined ? agents.get(sessionId) : undefined
      if (agent === undefined) return undefined
      let header = undefined
      try { header = agent.session !== undefined ? agent.session.header : undefined } catch (error) { header = undefined }
      const origin = header !== undefined ? header.origin : undefined
      const parent = header !== undefined ? header.parentSession : undefined
      if (origin === 'subagent' || (typeof parent === 'string' && parent.length > 0)) return typeof parent === 'string' ? parent : undefined
      return sessionId
    }

    async function listSessionHeaders() {
      if (sessionPersistence === undefined || typeof sessionPersistence.list !== 'function') {
        throw new Error('sessionPersistence.list() is not available in this deployment')
      }
      const headers = await sessionPersistence.list()
      return Array.isArray(headers) ? headers : []
    }

    function upstreamArchivedSet() {
      try {
        const ws = getWorkspaces()
        const ids = ws !== undefined ? ws.archivedSessionIds : undefined
        return new Set(Array.isArray(ids) ? ids : [])
      } catch (error) { return new Set() }
    }
    // 上游无 unarchive API：setState/requireState/enqueueOperation 是 WorkspaceRegistry
    // 导出类公开方法（非声明服务接口，升级兼容面记录 ARCHITECTURE §5）。
    function mutateArchivedSet(change) {
      const ws = getWorkspaces()
      return ws.enqueueOperation(async () => {
        const state = ws.requireState()
        const current = Array.isArray(state.archivedSessionIds) ? state.archivedSessionIds : []
        const next = change(current)
        if (next.length === current.length && next.every((id, i) => id === current[i])) return current
        await ws.setState({ ...state, archivedSessionIds: next })
        return next
      })
    }

    // 归档判定：meta.json 存在 或 上游集合含该 id（任一为准防漂移）
    async function isArchivedAt(id, dirIndex) {
      const meta = await readMetaAt(dirForId(dirIndex, id))
      if (meta !== undefined) return true
      return upstreamArchivedSet().has(id)
    }

    // headers → { byId, childrenOf, descendantsOf }（任意深度）
    async function headerIndex() {
      const headers = await listSessionHeaders()
      const byId = new Map()
      const childrenOf = new Map()
      for (const h of headers) {
        if (h === null || typeof h !== 'object' || typeof h.id !== 'string') continue
        byId.set(h.id, h)
        if (typeof h.parentSession === 'string') {
          const list = childrenOf.get(h.parentSession) ?? []
          list.push(h.id)
          childrenOf.set(h.parentSession, list)
        }
      }
      function descendantsOf(rootId) {
        const out = new Set()
        const queue = [...(childrenOf.get(rootId) ?? [])]
        while (queue.length > 0) {
          const id = queue.shift()
          if (out.has(id)) continue
          out.add(id)
          for (const child of (childrenOf.get(id) ?? [])) queue.push(child)
        }
        return out
      }
      return { headers, byId, childrenOf, descendantsOf }
    }

    const svc = {
      async list({ limit = 50, workspace, includeArchived = false, masterId }) {
        const cap = Math.min(Math.max(1, Math.floor(limit)), 200)
        const { headers, descendantsOf } = await headerIndex()
        const dirIndex = await buildSessionDirIndex()
        const up = upstreamArchivedSet()
        const titles = await readTitles()
        const wsFilter = typeof workspace === 'string' && workspace.trim().length > 0 ? workspace.trim().toLowerCase() : undefined
        const own = masterId !== undefined ? descendantsOf(masterId) : new Set()
        const visible = []
        for (const h of headers) {
          const isSub = isSubHeader(h)
          const archived = up.has(h.id) || (await readMetaAt(dirForId(dirIndex, h.id))) !== undefined
          if (!includeArchived && archived) continue
          if (wsFilter !== undefined) {
            const cwd = typeof h.cwd === 'string' ? h.cwd.toLowerCase() : ''
            if (!cwd.includes(wsFilter)) continue
          }
          if (isSub) {
            if (!own.has(h.id)) continue // 只列自己主会话下辖（任意深度）
          }
          visible.push({ h, archived })
        }
        visible.sort((a, b) => (b.h.createdAt ?? 0) - (a.h.createdAt ?? 0))
        const list = []
        for (const { h, archived } of visible.slice(0, cap)) {
          list.push({
            sessionId: h.id,
            title: typeof titles[h.id] === 'string' ? titles[h.id] : null,
            live: sessions !== undefined ? sessions.get(h.id) !== undefined : false,
            persisted: true,
            workspace: typeof h.cwd === 'string' ? h.cwd : null,
            parentSession: typeof h.parentSession === 'string' ? h.parentSession : null,
            origin: h.origin === 'subagent' ? 'subagent' : 'main',
            archived,
            createdAt: typeof h.createdAt === 'number' ? h.createdAt : null,
          })
        }
        return { count: list.length, sessions: list }
      },

      async find({ query, limit = 20, workspace, includeArchived = false, masterId }) {
        const cap = Math.min(Math.max(1, Math.floor(limit)), 50)
        const q = String(query ?? '').toLowerCase()
        if (q.length === 0) throw new Error('query must not be empty')
        const { headers, descendantsOf } = await headerIndex()
        const dirIndex = await buildSessionDirIndex()
        const up = upstreamArchivedSet()
        const titles = await readTitles()
        const wsFilter = typeof workspace === 'string' && workspace.trim().length > 0 ? workspace.trim().toLowerCase() : undefined
        const own = masterId !== undefined ? descendantsOf(masterId) : new Set()
        const hits = []
        for (const h of headers) {
          const isSub = isSubHeader(h)
          const archived = up.has(h.id) || (await readMetaAt(dirForId(dirIndex, h.id))) !== undefined
          if (!includeArchived && archived) continue
          if (wsFilter !== undefined) {
            const cwd = typeof h.cwd === 'string' ? h.cwd.toLowerCase() : ''
            if (!cwd.includes(wsFilter)) continue
          }
          if (isSub) {
            if (!own.has(h.id)) continue
          }
          const title = typeof titles[h.id] === 'string' ? titles[h.id] : ''
          if (!h.id.toLowerCase().includes(q) && !title.toLowerCase().includes(q)) continue
          hits.push({
            sessionId: h.id,
            title: title.length > 0 ? title : null,
            live: sessions !== undefined ? sessions.get(h.id) !== undefined : false,
            workspace: typeof h.cwd === 'string' ? h.cwd : null,
            parentSession: typeof h.parentSession === 'string' ? h.parentSession : null,
            origin: h.origin === 'subagent' ? 'subagent' : 'main',
            archived,
          })
          if (hits.length >= cap) break
        }
        return { count: hits.length, sessions: hits }
      },

      async listArchived({ limit = 50, masterId }) {
        const cap = Math.min(Math.max(1, Math.floor(limit)), 200)
        const { headers, descendantsOf } = await headerIndex()
        const dirIndex = await buildSessionDirIndex()
        const up = upstreamArchivedSet()
        const titles = await readTitles()
        const own = masterId !== undefined ? descendantsOf(masterId) : new Set()
        const list = []
        for (const h of headers) {
          if (!isSubHeader(h)) continue
          if (!own.has(h.id)) continue
          const archived = up.has(h.id) || (await readMetaAt(dirForId(dirIndex, h.id))) !== undefined
          if (!archived) continue
          list.push({
            sessionId: h.id,
            title: typeof titles[h.id] === 'string' ? titles[h.id] : null,
            live: sessions !== undefined ? sessions.get(h.id) !== undefined : false,
            workspace: typeof h.cwd === 'string' ? h.cwd : null,
            createdAt: typeof h.createdAt === 'number' ? h.createdAt : null,
          })
          if (list.length >= cap) break
        }
        return { count: list.length, sessions: list }
      },

      // 归档：只允许子代理（下辖任意深度），结构性拒绝主代理
      async archive(sessionIds, masterId, callerLabel) {
        const { byId, descendantsOf } = await headerIndex()
        const dirIndex = await buildSessionDirIndex()
        const titles = await readTitles()
        const own = masterId !== undefined ? descendantsOf(masterId) : new Set()
        const results = []
        for (const id of sessionIds) {
          const h = byId.get(id)
          if (h === undefined) { results.push({ sessionId: id, ok: false, error: 'unknown session id; it is neither persisted nor live' }); continue }
          if (!isSubHeader(h) || !own.has(id)) { results.push({ sessionId: id, ok: false, error: 'only sub sessions (any depth) of your own master session can be archived; main sessions are never archived this way' }); continue }
          if (sessions !== undefined && sessions.get(id) !== undefined) { results.push({ sessionId: id, ok: false, error: 'session is live; wait for it to finish before archiving' }); continue }
          const dir = dirForId(dirIndex, id)
          if (dir === undefined) { results.push({ sessionId: id, ok: false, error: 'session log directory not found on disk' }); continue }
          const notes = []
          try {
            const meta = {
              archived: true,
              archivedAt: Date.now(),
              archivedBy: callerLabel ?? null,
              title: typeof titles[id] === 'string' ? titles[id] : null,
              parentSession: typeof h.parentSession === 'string' ? h.parentSession : null,
            }
            await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8')
            notes.push('meta.json-written')
          } catch (error) {
            results.push({ sessionId: id, ok: false, error: 'failed to write archive marker: ' + errText(error) })
            continue
          }
          try {
            const ws = getWorkspaces()
            if (ws !== undefined && typeof ws.archiveSession === 'function') {
              await ws.archiveSession(id)
              notes.push('workspace-archive-mirrored')
            } else {
              notes.push('workspace-archive-mirror-skipped: workspaces service unavailable')
            }
          } catch (error) {
            notes.push('workspace-archive-mirror-failed: ' + errText(error))
          }
          results.push({ sessionId: id, ok: true, archived: true, notes })
        }
        return { results }
      },

      // 解除归档。allowMain=true 走 UI 路径（主代理捞回）；工具路径只允许子代理。
      async unarchive(sessionIds, masterId, allowMain) {
        const { byId, descendantsOf } = await headerIndex()
        const dirIndex = await buildSessionDirIndex()
        const up = upstreamArchivedSet()
        const own = masterId !== undefined ? descendantsOf(masterId) : new Set()
        const targets = new Set()
        const results = []
        for (const id of sessionIds) {
          const h = byId.get(id)
          if (h === undefined) { results.push({ sessionId: id, ok: false, error: 'unknown session id' }); continue }
          const isSub = isSubHeader(h)
          if (isSub) {
            // UI 路径（allowMain=true）：用户经弹窗确认，可捞回任意已归档会话（含他主下辖的子会话）
            if (allowMain !== true && !own.has(id)) { results.push({ sessionId: id, ok: false, error: 'only sub sessions of your own master session can be unarchived here' }); continue }
          } else if (allowMain !== true) {
            results.push({ sessionId: id, ok: false, error: 'main sessions cannot be unarchived through this path; use the UI' })
            continue
          }
          const meta = await readMetaAt(dirForId(dirIndex, id))
          if (meta === undefined && !up.has(id)) { results.push({ sessionId: id, ok: false, error: 'session is not archived' }); continue }
          targets.add(id)
        }
        if (targets.size === 0) return { results }
        const failed = []
        for (const id of targets) {
          try {
            const dir = dirForId(dirIndex, id)
            if (dir !== undefined) {
              await unlink(join(dir, 'meta.json')).catch((error) => { if (error === null || typeof error !== 'object' || error.code !== 'ENOENT') throw error })
            }
          } catch (error) {
            failed.push({ sessionId: id, ok: false, error: 'failed to remove archive marker: ' + errText(error) })
          }
        }
        try {
          const ws = getWorkspaces()
          if (ws !== undefined && typeof ws.enqueueOperation === 'function') {
            await mutateArchivedSet((current) => current.filter((id) => !targets.has(id)))
          }
        } catch (error) {
          failed.push({ sessionId: 'workspace-mirror', ok: false, error: 'failed to update workspace archive set: ' + errText(error) })
        }
        for (const id of targets) {
          if (!failed.some((f) => f.sessionId === id)) results.push({ sessionId: id, ok: true, archived: false })
        }
        for (const f of failed) results.push(f)
        return { results }
      },

      // 删除（仅 UI RPC 路径，模型无工具）。主代理递归删除整个子树；live 检查；mailbox 清理；记账摘除。
      // R2 防复活（审计新发现）：刚结束会话的 write-behind 批次可能经 materialize() 重建目录——
      // 删后复查重试，另有 30s 冷静期（lastPromptAt 距现在过近直接拒绝）。
      async deleteSessions(sessionIds, callerId, confirm, uiPath) {
        if (confirm !== true) throw new Error('refusing to delete: confirm must be explicitly true. 删除是不可逆的——会话日志文件会被真正删除，删除后什么都不剩。')
        const { byId, descendantsOf } = await headerIndex()
        const dirIndex = await buildSessionDirIndex()
        // R7：删除仅限主会话（子代理页面不可发起）
        const callerH = byId.get(callerId)
        if (callerH !== undefined && isSubHeader(callerH)) throw new Error('deletion is restricted to main sessions (a subagent page cannot delete sessions)')
        const lastActive = {}
        try {
          const raw = await readFile(PROJCACHE_PATH, 'utf8')
          const data = JSON.parse(raw)
          const table = data !== null && typeof data === 'object' && data.tables !== null && typeof data.tables === 'object' ? data.tables.sessions : undefined
          if (table !== null && typeof table === 'object') {
            for (const sid of Object.keys(table)) {
              const rec = table[sid]
              const val = rec !== null && typeof rec === 'object' && rec.rows !== null && typeof rec.rows === 'object' && rec.rows.sessionListMetadata !== null && typeof rec.rows.sessionListMetadata === 'object' ? rec.rows.sessionListMetadata.val : undefined
              if (val !== null && typeof val === 'object' && typeof val.lastPromptAt === 'number') lastActive[sid] = val.lastPromptAt
            }
          }
        } catch (error) { /* best-effort */ }
        const results = []
        for (const id of sessionIds) {
          if (id === callerId) { results.push({ sessionId: id, ok: false, error: 'cannot delete the calling session itself' }); continue }
          const h = byId.get(id)
          if (h === undefined) { results.push({ sessionId: id, ok: false, error: 'unknown session id' }); continue }
          const isSub = isSubHeader(h)
          if (isSub) {
            // UI 路径（uiPath=true）：用户经弹窗确认，可删任意非自身会话（含他主下辖的子会话）
            if (uiPath !== true) {
              const callerRoot = typeof callerH !== 'undefined' && isSubHeader(callerH) ? (typeof callerH.parentSession === 'string' ? callerH.parentSession : undefined) : callerId
              const own = typeof callerRoot === 'string' ? descendantsOf(callerRoot) : new Set()
              if (!own.has(id)) { results.push({ sessionId: id, ok: false, error: 'only sub sessions of your own master session can be deleted' }); continue }
            }
          }
          const subtree = new Set([id, ...descendantsOf(id)])
          const liveIds = []
          for (const sid of subtree) {
            if (sessions !== undefined && sessions.get(sid) !== undefined) liveIds.push(sid)
          }
          if (liveIds.length > 0) { results.push({ sessionId: id, ok: false, error: 'refusing to delete: ' + liveIds.length + ' live session(s) in its subtree (' + liveIds.slice(0, 5).join(', ') + '); wait for them to finish' }); continue }
          // R2 冷静期：任一子树会话 30s 内还有活动 → 拒绝（防 write-behind 复活窗口）
          const cooldownIds = [...subtree].filter((sid) => typeof lastActive[sid] === 'number' && Date.now() - lastActive[sid] < 30000)
          if (cooldownIds.length > 0) { results.push({ sessionId: id, ok: false, error: 'session(s) finished too recently (' + cooldownIds.slice(0, 5).join(', ') + '); wait 30s for pending writes to flush before deleting' }); continue }
          const notes = []
          let failed = false
          for (const sid of subtree) {
            const dir = dirForId(dirIndex, sid)
            if (dir === undefined) { notes.push('missing-dir:' + sid); continue }
            try {
              await rm(dir, { recursive: true, force: true })
            } catch (error) {
              failed = true
              notes.push('rm-failed:' + sid + ' ' + errText(error))
            }
          }
          if (failed) { results.push({ sessionId: id, ok: false, error: 'some files could not be removed; nothing else was touched', notes }); continue }
          // R2 复查：等 1.2s 看目录是否被复活，最多再删两轮
          let resurrectRetries = 0
          for (let attempt = 0; attempt < 3; attempt += 1) {
            let alive = false
            for (const sid of subtree) {
              const dir2 = dirForId(dirIndex, sid)
              if (dir2 === undefined) continue
              try { if ((await stat(dir2)) !== undefined) { alive = true; break } } catch (error) { /* gone */ }
            }
            if (!alive) break
            if (attempt === 2) { failed = true; notes.push('dir-resurrected-after-3-attempts: deletion may be incomplete'); break }
            resurrectRetries += 1
            await new Promise((resolve) => setTimeout(resolve, 1200))
            for (const sid of subtree) {
              const dir2 = dirForId(dirIndex, sid)
              if (dir2 === undefined) continue
              try { await rm(dir2, { recursive: true, force: true }) } catch (error) { /* retry next pass */ }
            }
          }
          if (resurrectRetries > 0) notes.push('resurrect-retries:' + resurrectRetries)
          if (failed) { results.push({ sessionId: id, ok: false, error: 'deletion could not be made durable (directory keeps coming back)', notes }); continue }
          try {
            const mailbox = await requireUnit()
            const cleaned = await enqueue(async () => {
              const snapshot = await mailbox.loadAll()
              const table = snapshot !== undefined && snapshot.tables !== undefined && snapshot.tables['msg'] !== undefined ? snapshot.tables['msg'] : {}
              let n = 0
              for (const key of Object.keys(table)) {
                const record = table[key]
                if (record !== null && typeof record === 'object' && subtree.has(record.to)) { await mailbox.deleteRecord('msg', key); n += 1 }
              }
              return n
            })
            if (cleaned > 0) notes.push('mailbox-queue-cleaned:' + cleaned)
          } catch (error) { notes.push('mailbox-cleanup-skipped: ' + errText(error)) }
          try {
            const ws = getWorkspaces()
            if (ws !== undefined && typeof ws.list === 'function') {
              const wsList = await ws.list()
              for (const ws of Array.isArray(wsList) ? wsList : []) {
                if (ws === null || typeof ws !== 'object' || typeof ws.detachSession !== 'function') continue
                const record = ws.record
                if (record !== null && typeof record === 'object' && Array.isArray(record.sessionIds)) {
                  for (const sid of subtree) {
                    if (record.sessionIds.includes(sid)) {
                      try { await ws.detachSession(sid); notes.push('workspace-accounting-removed:' + sid) } catch (error) { notes.push('workspace-accounting-kept:' + sid) }
                    }
                  }
                }
              }
            }
          } catch (error) { notes.push('workspace-accounting-kept: ' + errText(error)) }
          try {
            const up = upstreamArchivedSet()
            const toRemove = [...subtree].filter((sid) => up.has(sid))
            const ws = getWorkspaces()
            if (toRemove.length > 0 && ws !== undefined && typeof ws.enqueueOperation === 'function') {
              await mutateArchivedSet((current) => current.filter((x) => !subtree.has(x)))
              notes.push('archive-mark-removed:' + toRemove.length)
            }
          } catch (error) { notes.push('archive-mark-kept: ' + errText(error)) }
          try {
            const teamsRaw = await readFile(DSH_HOME + '/storages/agent_teams.json', 'utf8')
            const referenced = [...subtree].filter((sid) => teamsRaw.includes('"' + sid + '"'))
            if (referenced.length > 0) notes.push('team-records-reference-deleted-ids: ' + referenced.join(', ') + ' (cleanup tracked in backlog P1-1)')
          } catch (error) { /* file missing = no teams */ }
          results.push({ sessionId: id, ok: true, deleted: true, subtreeSize: subtree.size, notes })
        }
        return { results }
      },

      // 删除预演（只读，供 UI 弹窗显示实数：subtreeSize/liveIds）
      async deletePreview(sessionIds, callerId, uiPath) {
        const { byId, descendantsOf } = await headerIndex()
        const callerH = byId.get(callerId)
        if (callerH !== undefined && isSubHeader(callerH)) throw new Error('deletion is restricted to main sessions (a subagent page cannot delete sessions)')
        const results = []
        for (const id of sessionIds) {
          if (id === callerId) { results.push({ sessionId: id, ok: false, error: 'cannot delete the calling session itself' }); continue }
          const h = byId.get(id)
          if (h === undefined) { results.push({ sessionId: id, ok: false, error: 'unknown session id' }); continue }
          const isSub = isSubHeader(h)
          if (isSub) {
            if (uiPath !== true) {
              const callerRoot = typeof callerH !== 'undefined' && isSubHeader(callerH) ? (typeof callerH.parentSession === 'string' ? callerH.parentSession : undefined) : callerId
              const own = typeof callerRoot === 'string' ? descendantsOf(callerRoot) : new Set()
              if (!own.has(id)) { results.push({ sessionId: id, ok: false, error: 'only sub sessions of your own master session can be deleted' }); continue }
            }
          }
          const subtree = new Set([id, ...descendantsOf(id)])
          const liveIds = []
          for (const sid of subtree) {
            if (sessions !== undefined && sessions.get(sid) !== undefined) liveIds.push(sid)
          }
          results.push({ sessionId: id, ok: liveIds.length === 0, subtreeSize: subtree.size, liveIds })
        }
        return { results }
      },

      // 递归导出：target 的整个子树（子代理消息一并导出）。输出明文，不回灌内容。
      async exportSession({ targetId, format = 'markdown', maxEventsPerSession = 5000 }) {
        if (typeof targetId !== 'string' || targetId.length === 0) throw new Error('targetId is required')
        if (sessionPersistence === undefined || typeof sessionPersistence.inspect !== 'function') throw new Error('sessionPersistence.inspect is not available in this deployment')
        const fmt = format === 'jsonl' ? 'jsonl' : 'markdown'
        const { byId, descendantsOf } = await headerIndex()
        if (!byId.has(targetId)) throw new Error('unknown session id: ' + targetId)
        const subtree = [targetId, ...descendantsOf(targetId)]
        const titles = await readTitles()
        const outDir = join(DSH_HOME, 'exports', encodeSegment(targetId))
        await mkdir(outDir, { recursive: true })
        const cap = typeof maxEventsPerSession === 'number' && maxEventsPerSession > 0 ? Math.floor(maxEventsPerSession) : 5000
        const files = []
        for (const sid of subtree) {
          let snapshot
          try {
            snapshot = await sessionPersistence.inspect(sid)
          } catch (error) {
            files.push({ sessionId: sid, ok: false, error: errText(error) })
            continue
          }
          const events = Array.isArray(snapshot.events) ? snapshot.events : []
          const truncated = events.length > cap
          const kept = events.slice(-cap)
          const title = typeof titles[sid] === 'string' ? titles[sid] : '(untitled)'
          const h = byId.get(sid)
          const headerLine = {
            sessionId: sid,
            title,
            parentSession: typeof h.parentSession === 'string' ? h.parentSession : null,
            origin: h.origin === 'subagent' ? 'subagent' : 'main',
            delegationDepth: typeof h.delegationDepth === 'number' ? h.delegationDepth : null,
            createdAt: typeof h.createdAt === 'number' ? h.createdAt : null,
            cwd: typeof h.cwd === 'string' ? h.cwd : null,
          }
          let body
          if (fmt === 'jsonl') {
            body = JSON.stringify(headerLine) + '\n'
            for (const event of kept) body += JSON.stringify(event) + '\n'
          } else {
            body = '# Session: ' + title + ' (' + sid + ')\n\n'
            body += 'parentSession: ' + (headerLine.parentSession ?? '-') + '\n'
            body += 'origin: ' + headerLine.origin + ' | depth: ' + headerLine.delegationDepth + '\n'
            body += 'createdAt: ' + (headerLine.createdAt !== null ? new Date(headerLine.createdAt).toISOString() : '-') + '\n'
            if (truncated) body += '\n> (truncated: ' + events.length + ' events, showing last ' + cap + ')\n'
            body += '\n'
            for (const event of kept) {
              if (event.type === 'user/message') {
                const text = flattenText(event.data !== undefined ? event.data.content : undefined)
                body += '### [user ' + (event.time !== undefined ? new Date(event.time).toISOString() : '') + ']\n\n' + (text.length > 0 ? text : '(empty)') + '\n\n'
              } else if (event.type === 'assistant/message') {
                const message = event.data !== undefined ? event.data.message : undefined
                const text = flattenText(message !== undefined ? message.content : undefined)
                body += '### [assistant ' + (event.time !== undefined ? new Date(event.time).toISOString() : '') + ']\n\n' + (text.length > 0 ? text : '(empty)') + '\n\n'
              } else if (event.type === 'tool/result') {
                const message = event.data !== undefined ? event.data.message : undefined
                const block = message !== undefined && Array.isArray(message.content) ? message.content[0] : undefined
                const text = block !== undefined && Array.isArray(block.content) ? flattenText(block.content) : ''
                body += '### [tool ' + (event.time !== undefined ? new Date(event.time).toISOString() : '') + ']\n\n' + (text.length > 0 ? text.slice(0, 4000) + (text.length > 4000 ? ' ...(truncated)' : '') : '(empty)') + '\n\n'
              }
            }
          }
          const filePath = join(outDir, (fmt === 'jsonl' ? sid + '.jsonl' : sid + '.md'))
          try {
            await writeFile(filePath, body, 'utf8')
            files.push({ sessionId: sid, ok: true, path: filePath, events: kept.length, truncated })
          } catch (error) {
            files.push({ sessionId: sid, ok: false, error: errText(error) })
          }
        }
        const index = { exportedAt: Date.now(), rootSessionId: targetId, format: fmt, sessions: files }
        const indexPath = join(outDir, 'index.json')
        await writeFile(indexPath, JSON.stringify(index, null, 2), 'utf8')
        return { ok: true, rootSessionId: targetId, format: fmt, outDir, indexPath, sessions: files }
      },
    }
    ctx.provide('sessionmgmt', svc)

    // R5 启动反向修复（审计建议）：meta.json 已归档但上游集合缺镜像（上次归档时
    // archiveSession 失败/进程重启中断）→ 补写镜像。只补子代理；主代理归档走 UI，不自动补。
    ctx.effect(() => {
      let cancelled = false
      ;(async () => {
        try {
          await new Promise((resolve) => setTimeout(resolve, 3000))
          if (cancelled) return
          const ws = getWorkspaces()
          if (ws === undefined || typeof ws.archiveSession !== 'function') return
          const { headers } = await headerIndex()
          const dirIndex = await buildSessionDirIndex()
          const up = upstreamArchivedSet()
          for (const h of headers) {
            if (cancelled) return
            if (!isSubHeader(h) || up.has(h.id)) continue
            const dir = dirForId(dirIndex, h.id)
            if (dir === undefined) continue
            const meta = await readMetaAt(dir)
            if (meta === undefined) continue
            try { await ws.archiveSession(h.id) } catch (error) { /* 下次启动再补 */ }
          }
        } catch (error) { /* best-effort */ }
      })()
      return () => { cancelled = true }
    })

    registerTool(ctx, 'session_list',
      '列出本 DSH 进程中的会话（在线与已持久化），含 id、标题、在线状态、工作区、主从关系与归档状态。默认只列未归档会话；能看到所有主会话与自己主会话下辖的全部子会话（含子子会话）。只要知道 id 或标题片段就优先用 `session_find`；只想看某个工作区（目录）下的会话时用 `workspace` 参数过滤。完整工作流见 `cross-session-mailbox` 技能。',
      {
        limit: { type: 'number', description: '最大返回会话数（默认 50，上限 200）。' },
        workspace: { type: 'string', description: '可选：只列该工作区（目录路径片段，如 "dsh-forge" 匹配某个 .../dsh-forge 目录）下的会话。' },
        includeArchived: { type: 'boolean', description: '是否包含已归档会话（默认 false=只列未归档；true 时归档会话带 archived:true 一并列出）。' },
      },
      async (args, exec) => {
        const out = await svc.list({
          limit: typeof args.limit === 'number' && args.limit > 0 ? args.limit : 50,
          workspace: args.workspace,
          includeArchived: args.includeArchived === true,
          masterId: callerMasterId(exec),
        })
        return jsonText({ ok: true, archivedHidden: args.includeArchived !== true, ...out })
      })

    registerTool(ctx, 'session_list_archived',
      '列出本主会话下辖的已归档子会话（含子子会话；这些会话已从 session_list/session_find 默认结果中隐藏，但文件仍在，可用 session_unarchive 捞出）。仅主会话可用；子代理调用会被拒绝。完整工作流见 `cross-session-mailbox` 技能。',
      { limit: { type: 'number', description: '最大返回数（默认 50，上限 200）。' } },
      async (args, exec) => {
        if (!isMainSession(exec)) return jsonText({ ok: false, error: 'session_list_archived is restricted to the main session' })
        const out = await svc.listArchived({
          limit: typeof args.limit === 'number' && args.limit > 0 ? args.limit : 50,
          masterId: callerMasterId(exec),
        })
        return jsonText({ ok: true, ...out })
      })

    registerTool(ctx, 'session_archive',
      '归档本主会话下辖的子会话（含子子会话；主代理不可被归档）：归档后这些会话不再出现在 session_list / session_find 的默认结果里，但文件保留，可随时用 session_list_archived 查看、用 session_unarchive 捞出。推荐在子会话完成且不需要再联系时归档，以保持会话列表清爽。仅主会话可用；不能归档运行中的会话。',
      {
        sessionIds: { type: 'array', items: { type: 'string' }, required: true, description: '要归档的子会话 id 数组（来自 session_list 中 parentSession 链指向本主会话的条目）。' },
      },
      async (args, exec) => {
        if (!isMainSession(exec)) return jsonText({ ok: false, error: 'session_archive is restricted to the main session' })
        const ids = Array.isArray(args.sessionIds) ? args.sessionIds.map((x) => String(x)) : []
        if (ids.length === 0) return jsonText({ ok: false, error: 'sessionIds must be a non-empty array' })
        const me = exec !== undefined && exec.agent !== undefined && typeof exec.agent.id === 'string' ? exec.agent.id : undefined
        const out = await svc.archive(ids, callerMasterId(exec), me)
        return jsonText({ ok: true, ...out })
      })

    registerTool(ctx, 'session_unarchive',
      '捞出（取消归档）本主会话下辖的已归档子会话（含子子会话；主代理的捞回在 WebUI 工作区进行）：恢复其在 session_list / session_find 中的可见性，文件位置与工作区记账不变。仅主会话可用。',
      {
        sessionIds: { type: 'array', items: { type: 'string' }, required: true, description: '要捞出的已归档子会话 id 数组（来自 session_list_archived）。' },
      },
      async (args, exec) => {
        if (!isMainSession(exec)) return jsonText({ ok: false, error: 'session_unarchive is restricted to the main session' })
        const ids = Array.isArray(args.sessionIds) ? args.sessionIds.map((x) => String(x)) : []
        if (ids.length === 0) return jsonText({ ok: false, error: 'sessionIds must be a non-empty array' })
        const out = await svc.unarchive(ids, callerMasterId(exec), false)
        return jsonText({ ok: true, ...out })
      })

    registerTool(ctx, 'session_export',
      '把会话（默认=调用方自己）递归导出为明文：连同其下辖全部子会话（含子子会话）的消息一并导出——子代理的对话也重要。输出到 ~/.dsh/exports/<sessionId>/（index.json + 每会话一个 .md 或 .jsonl），返回文件路径与事件计数，不回灌内容。用于用户自己翻看、迁移或留档。',
      {
        sessionId: { type: 'string', description: '要导出的根会话 id（默认=调用方当前会话）。导出包含其整个子树。' },
        format: { type: 'string', description: '输出格式：markdown（默认，人可读）或 jsonl（原始事件流）。' },
        maxEventsPerSession: { type: 'number', description: '每会话最多导出的事件数（默认 5000，防超大日志；超出部分截断并在文件头标注）。' },
      },
      async (args, exec) => {
        const targetId = typeof args.sessionId === 'string' && args.sessionId.length > 0 ? args.sessionId : callerMasterId(exec)
        try {
          const out = await svc.exportSession({
            targetId,
            format: typeof args.format === 'string' ? args.format : 'markdown',
            maxEventsPerSession: args.maxEventsPerSession,
          })
          return jsonText(out)
        } catch (error) {
          return jsonText({ ok: false, error: errText(error) })
        }
      })

    // 注意：删除不提供模型工具——删除只能由用户经 WebUI 弹窗确认后走宿主 RPC
    // （前端 sessmgr 插件 host.call('session.delete', ...)）→ svc.deleteSessions，
    // 传入 callerSessionId（页面当前会话）与 confirm:true。

    registerTool(ctx, 'session_read',
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

    registerTool(ctx, 'session_send',
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

    registerTool(ctx, 'mailbox_check',
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

// description: 跨会话消息桥：forge_mailbridge_send / forge_mailbridge_read / forge_mailbridge_check，让同一进程内的会话互相收发消息（带 begin/end 标记）。
import { readdir, readFile, rm, writeFile, unlink, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { errText, jsonText, DSH_HOME } from './lib/forge-common.mjs'
import { registerTool } from './lib/forge-tools.mjs'
import { loadProjects, projectOf } from './lib/projects.mjs'
import { talkRelation, bindTalkRuntime } from './lib/team-org.r2.mjs'
import { installConsoleGates } from './lib/console-gates.mjs'
import { installCompactionDistill } from './lib/compdist.mjs'

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
  // projcache 已升级（2026-09-01 dsh 改版）：旧 = session_projcache.json {tables.sessions}；
  // 新 = session_projcache/sessions/<id>.json {record.rows.title.val}（per-record 一文件）。双路径兜底。
  const NEW_DIR = DSH_HOME + '/storages/session_projcache/sessions'
  const readTitleFrom = (id, rec) => {
    const row = rec !== null && typeof rec === 'object' && rec.record !== null && typeof rec.record === 'object' && rec.record.rows !== null && typeof rec.record.rows === 'object' ? rec.record.rows.title : undefined
    const rowV2 = rec !== null && typeof rec === 'object' && rec.rows !== null && typeof rec.rows === 'object' ? rec.rows.title : undefined
    const r = row ?? rowV2
    return r !== null && typeof r === 'object' && typeof r.val === 'string' && r.val.length > 0 ? r.val : undefined
  }
  // 新格式：逐文件读（缺失=无缓存——标题可后续冷读写入或回退日志）
  try {
    const { readdir } = await import('node:fs/promises')
    const files = await readdir(NEW_DIR).catch(() => [])
    for (const f of files) {
      const id = f.replace(/\.json$/, '')
      try {
        const rec = JSON.parse(await readFile(join(NEW_DIR, f), 'utf8'))
        const title = readTitleFrom(id, rec)
        if (title !== undefined) titles[id] = title
      } catch (e) { /* skip unreadable */ }
    }
  } catch (error) { /* new-dir best-effort */ }
  // 【2026-09-01 兜底】projcache 读不到的会话——读 meta.json.title（归档会话 meta 几乎都有；快，不解压）
  // 注意双层目录：sessions/<workspace>/<sessionId>/meta.json（单层读不到任何归档标题）
  try {
    const { readdir } = await import('node:fs/promises')
    const workspaces = await readdir(DSH_HOME + '/sessions').catch(() => [])
    for (const ws of workspaces) {
      let ids = []
      try {
        ids = await readdir(join(DSH_HOME + '/sessions', ws))
      } catch (e) { /* skip workspace */ }
      for (const dir of ids) {
        const metaPath = join(DSH_HOME + '/sessions', ws, dir, 'meta.json')
        try {
          const meta = JSON.parse(await readFile(metaPath, 'utf8'))
          if (typeof meta.title === 'string' && meta.title.length > 0) {
            const id = typeof meta.id === 'string' ? meta.id : dir
            if (titles[id] === undefined) titles[id] = meta.title
          }
        } catch (e) { /* no meta / unreadable */ }
      }
    }
  } catch (error) { /* best-effort */ }

  // 旧格式回退（.bak 前形态——兼容）
  if (Object.keys(titles).length === 0) {
    try {
      const raw = await readFile(PROJCACHE_PATH, 'utf8')
      const data = JSON.parse(raw)
      const sessions = data !== null && typeof data === 'object' && data.tables !== null && typeof data.tables === 'object' ? data.tables.sessions : undefined
      if (sessions !== null && typeof sessions === 'object') {
        for (const id of Object.keys(sessions)) {
          const title = readTitleFrom(id, sessions[id])
          if (title !== undefined) titles[id] = title
        }
      }
    } catch (error) { /* best-effort */ }
  }
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
  inject: ['tools', 'agents', 'sessions', 'sessionController', 'sessionPersistence', 'storage'],
  apply(ctx) {
    const agents = ctx.agents
    const sessions = ctx.sessions
    // Official cold-delivery entry point: "Resolve or resume one ordinary
    // Session, deduplicating concurrent resumes."
    const sessionController = ctx.sessionController
    const sessionPersistence = ctx.sessionPersistence

    // ── 上游 0.1.5-rc.2 兼容层（R2，2026-09-11）────────────────────────────
    // rc.2 换掉了 sessionPersistence 的公开 API：
    //   旧：inspect(id) → { meta, events }          ；list() → 裸 header[]
    //   新：stat(id)    → { header, revision, … }（无 events）
    //       open(id, 'read') → handle.read(0, MAX) → { events } → handle.close()
    //       list()       → { header, … }[]（snapshot 包装）
    // 三条路径都做特性探测，让同一份插件在旧核（inspect）与新核（stat/open）上都能跑。
    function persistenceApi() {
      if (sessionPersistence === undefined || sessionPersistence === null) return 'none'
      if (typeof sessionPersistence.stat === 'function' && typeof sessionPersistence.open === 'function') return 'stat'
      if (typeof sessionPersistence.inspect === 'function') return 'inspect'
      return 'none'
    }
    // 读一个会话的元数据（新核 stat().header，旧核 inspect().meta）；不碰日志正文。
    async function readSessionMetaVia(id) {
      const api = persistenceApi()
      if (api === 'none') return undefined
      if (api === 'stat') {
        const snapshot = await sessionPersistence.stat(id)
        return snapshot !== null && typeof snapshot === 'object' ? snapshot.header : undefined
      }
      const inspection = await sessionPersistence.inspect(id)
      return inspection !== null && typeof inspection === 'object' ? inspection.meta : undefined
    }
    // 读一个会话的全部事件；返回 { events, meta } 或 undefined。
    async function readSessionVia(id) {
      const api = persistenceApi()
      if (api === 'none') return undefined
      if (api === 'inspect') {
        const inspection = await sessionPersistence.inspect(id)
        if (inspection === null || typeof inspection !== 'object') return undefined
        return { events: Array.isArray(inspection.events) ? inspection.events : [], meta: inspection.meta }
      }
      const snapshot = await sessionPersistence.stat(id)
      if (snapshot === undefined || snapshot === null) return undefined
      const meta = typeof snapshot === 'object' ? snapshot.header : undefined
      const handle = await sessionPersistence.open(id, 'read')
      try {
        const result = await handle.read(0, Number.MAX_SAFE_INTEGER)
        const events = result !== null && typeof result === 'object' && Array.isArray(result.events) ? result.events : []
        return { events, meta }
      } finally {
        try { await handle.close() } catch (error) { /* best-effort */ }
      }
    }
    const storage = ctx.storage
    bindTalkRuntime({ agents, sessionPersistence })
    installCompactionDistill(ctx, { agents, sessionPersistence })
    // 宿主侧服务键名是 workspaceRegistry（apiproxy 以 workspaces 别名暴露给 client）。
    // 该服务初始化晚于本插件，必须惰性获取（apply 时刻 ctx.get 拿不到）。
    const getWorkspaces = () => ctx.get('workspaceRegistry')
    const skills = ctx.get('skills')
    installConsoleGates(ctx)

    // wake 守卫（P0-4 + PDA P1）：冷启动消耗目标会话回合。
    // 同队：免批、无硬闸。同项目跨队 / 跨项目：进 console-inbox 等人批。
    // 预算闸只拦同队 wake 的极端刷屏（项目总量），跨队不再用预算代替审批。
    function headerOf(agent) {
      if (agent === undefined) return undefined
      try { return agent.session !== undefined ? agent.session.header : undefined } catch { return undefined }
    }
    function isMainSession(exec) {
      if (exec === undefined || exec.agent === undefined) return false
      const header = headerOf(exec.agent)
      const origin = header !== undefined ? header.origin : undefined
      const parent = header !== undefined ? header.parentSession : undefined
      if (origin === 'subagent' || (typeof parent === 'string' && parent.length > 0)) return false
      return true
    }
    function cwdOfAgent(agent) {
      const header = headerOf(agent)
      return header !== undefined && typeof header.cwd === 'string' ? header.cwd : ''
    }
    async function cwdOfSessionId(id) {
      const live = agents.get(id)
      if (live !== undefined) {
        const cwd = cwdOfAgent(live)
        if (cwd !== '') return cwd
      }
      try {
        const api = persistenceApi()
        if (api === 'stat') {
          const header = await readSessionMetaVia(id)
          if (header !== null && typeof header === 'object' && typeof header.cwd === 'string') return header.cwd
        } else if (api === 'inspect') {
          const inspection = await sessionPersistence.inspect(id)
          const meta = inspection !== null && typeof inspection === 'object' ? inspection.meta : undefined
          if (meta !== null && typeof meta === 'object' && typeof meta.cwd === 'string') return meta.cwd
          const events = Array.isArray(inspection.events) ? inspection.events : []
          for (const event of events) {
            if (event !== null && typeof event === 'object' && event.type === 'session' && typeof event.cwd === 'string') return event.cwd
          }
        }
      } catch { /* best-effort */ }
      return ''
    }
    // 互唤闸整体拆除（2026-10-02 拍板）：官方与我们都还是开发预览版，不为"模型互唤
    // 烧预算"这个滥用面兜底。拆掉的两道：① 跨队/跨项目进 console-inbox 待批；
    // ② 同队 wake 的速率闸（DEFAULT_WAKE 的 perTarget / projectTotal）。跨队直接放行。
    async function checkTalkAllowed(exec, targetId) {
      const from = callerId(exec, agents)
      const cfg = await loadProjects()
      const rel = talkRelation(cfg, from, targetId)
      return {
        ok: true,
        intra: rel.kind === 'same-team',
        relation: rel.kind,
        projectId: rel.project && rel.project.id ? rel.project.id : undefined,
      }
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
    //   - forge_mailbridge_archive/unarchive 只能处理子代理（下辖任意深度），绝不能归档主代理
    //   - 删除不提供模型工具：用户经 WebUI 弹窗确认 → 宿主 RPC（前端 sessmgr）→ svc.deleteSessions
    //   - 删除主代理递归删除其整个子树（parentSession 链传递闭包）
    //   - 归档真相 = 会话目录 meta.json；上游 archivedSessionIds 为镜像（官方 UI 隐藏一致）
    //   - forge_mailbridge_export 递归导出整个子树为明文

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
    // 归档放宽（2026-09-11 用户拍板）：项目蒸馏岗可归档**同项目**会话（含主会话；可捞回）。
    async function distillScopeOf(callerId) {
      if (typeof callerId !== 'string' || callerId === '') return undefined
      let cfg
      try { cfg = await loadProjects() } catch (error) { return undefined }
      const projects = cfg !== undefined && cfg !== null && Array.isArray(cfg.projects) ? cfg.projects : []
      for (const p of projects) {
        if (p !== null && typeof p === 'object' && p.distillSessionId === callerId) return p
      }
      return undefined
    }
    /** 显式记录优先于 cwd：项目 members/stale/ownedSessions 里点名的会话就是本项目的。 */
    function explicitProjectRecord(header, project) {
      const id = header !== null && typeof header === 'object' && typeof header.id === 'string' ? header.id : ''
      if (id === '' || project === undefined || project === null) return false
      // 2026-10-02 合并后，项目自己就带着 members / stale / ownedSessions，没有 teams[] 这一层。
      if (Array.isArray(project.members) && project.members.some((m) => m !== null && typeof m === 'object' && m.sessionId === id)) return true
      if (Array.isArray(project.stale) && project.stale.some((s) => s !== null && typeof s === 'object' && s.sessionId === id)) return true
      if (Array.isArray(project.ownedSessions) && project.ownedSessions.includes(id)) return true
      return false
    }
    function inProjectCwds(header, project) {
      if (explicitProjectRecord(header, project)) return true
      const cwds = project !== undefined && project !== null && Array.isArray(project.cwds) ? project.cwds : []
      const raw = header !== null && typeof header === 'object' && typeof header.cwd === 'string' ? header.cwd : ''
      const cwd = raw.replace(/\\/g, '/')
      if (cwd === '') return false
      return cwds.some((c) => typeof c === 'string' && c !== '' && cwd.indexOf(c.replace(/\\/g, '/')) === 0)
    }

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
      if (agent !== undefined) {
        let header = undefined
        try { header = agent.session !== undefined ? agent.session.header : undefined } catch (error) { header = undefined }
        const origin = header !== undefined ? header.origin : undefined
        const parent = header !== undefined ? header.parentSession : undefined
        if (origin === 'subagent' || (typeof parent === 'string' && parent.length > 0)) return typeof parent === 'string' ? parent : undefined
        return sessionId
      }
      // 离线会话（用户删除废弃会话场景）：内存无 agent → 回退读持久化头部判断归属。
      // 主会话（无 parentSession）返回自己；子会话返回其 parentSession；读不到（无持久化/无法解析）返回 undefined（fail-closed）。
      // 优先：events 里 type:session 首行（有 origin/parentSession；废弃会话常缺 meta.json 但日志必有 session 头行）。
      // 兜底：inspection.meta.parentSession。
      const api = persistenceApi()
      if (api === 'none') return undefined
      if (api === 'stat') {
        // rc.2：header 直接带 parentSession / origin，不必读全日志
        return sessionPersistence.stat(sessionId).then((snapshot) => {
          const header = snapshot !== null && typeof snapshot === 'object' ? snapshot.header : undefined
          if (header === null || typeof header !== 'object') return undefined
          const parent = typeof header.parentSession === 'string' ? header.parentSession : ''
          if (parent.length > 0) return parent
          return String(header.origin ?? '') === 'subagent' ? undefined : sessionId
        }).catch(() => undefined)
      }
      return sessionPersistence.inspect(sessionId).then((inspection) => {
        if (inspection !== null && typeof inspection === 'object') {
          const events = Array.isArray(inspection.events) ? inspection.events : []
          for (const event of events) {
            if (event === null || typeof event !== 'object') continue
            if (event.type !== 'session') continue
            const parent = typeof event.parentSession === 'string' ? event.parentSession : ''
            const origin = String(event.origin ?? '')
            if (origin === 'subagent' || parent.length > 0) return parent.length > 0 ? parent : undefined
            return sessionId
          }
          const meta = inspection.meta
          const metaParent = typeof meta?.parentSession === 'string' ? meta.parentSession : ''
          if (metaParent.length > 0) return metaParent
          // events 有非 session 元数据但无 session 头行；若 meta 也无 parent 且 events 非空，保守：无法判定 → 对无 meta 的"幽灵"会话（只有首行/无 parent）仍返回自己？
          // 谨慎：找不到 session 头行且无 meta parent → 返回 undefined（fail-closed，拒删）
        }
        return undefined
      }).catch(() => undefined)
    }

    async function listSessionHeaders() {
      if (sessionPersistence === undefined || typeof sessionPersistence.list !== 'function') {
        throw new Error('sessionPersistence.list() is not available in this deployment')
      }
      const listed = await sessionPersistence.list()
      if (!Array.isArray(listed)) return []
      // rc.2 起 list() 返回 snapshot 包装 { header, revision, … }；旧核直接是 header。
      return listed.map((entry) => (entry !== null && typeof entry === 'object' && entry.header !== null && typeof entry.header === 'object' ? entry.header : entry))
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
      // 挂载 masterIdFromSessionId（此前只定义了函数但没挂进 svc——删除守卫调用时 typeof 检查一直取不到 → 拒删）
      masterIdFromSessionId,
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

      async listProjects() {
        const cfg = await loadProjects()
        const { headers } = await headerIndex()
        const byId = new Map()
        for (const p of cfg.projects) {
          byId.set(p.id, { ...p, implicit: false, sessions: 0, lastActiveAt: null })
        }
        const implicit = new Map()
        for (const h of headers) {
          if (h === null || typeof h !== 'object') continue
          const cwd = typeof h.cwd === 'string' ? h.cwd : ''
          const hit = projectOf(cfg, { sessionId: h.id, cwd })
          let row = byId.get(hit.id)
          if (row === undefined) {
            row = implicit.get(hit.id)
            if (row === undefined) {
              row = { ...hit, sessions: 0, lastActiveAt: null }
              implicit.set(hit.id, row)
            }
          }
          row.sessions += 1
          if (typeof h.createdAt === 'number' && (row.lastActiveAt === null || h.createdAt > row.lastActiveAt)) row.lastActiveAt = h.createdAt
        }
        return { ok: true, projects: [...byId.values(), ...implicit.values()] }
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
      async archive(sessionIds, masterId, callerLabel, callerId, options) {
        const dryRun = options !== undefined && options !== null && options.dryRun === true
        const { byId, descendantsOf } = await headerIndex()
        const dirIndex = await buildSessionDirIndex()
        const titles = await readTitles()
        const own = masterId !== undefined ? descendantsOf(masterId) : new Set()
        const distillProject = await distillScopeOf(callerId)
        const results = []
        for (const id of sessionIds) {
          const h = byId.get(id)
          if (h === undefined) { results.push({ sessionId: id, ok: false, error: 'unknown session id; it is neither persisted nor live' }); continue }
          const ownSub = isSubHeader(h) && own.has(id)
          const viaDistill = distillProject !== undefined && inProjectCwds(h, distillProject)
          if (!ownSub && !viaDistill) { results.push({ sessionId: id, ok: false, error: 'only sub sessions (any depth) of your own master session can be archived; a project distill post may also archive sessions of its own project' }); continue }
          if (sessions !== undefined && sessions.get(id) !== undefined) { results.push({ sessionId: id, ok: false, error: 'session is live; wait for it to finish before archiving' }); continue }
          const dir = dirForId(dirIndex, id)
          if (dir === undefined) { results.push({ sessionId: id, ok: false, error: 'session log directory not found on disk' }); continue }
          if (dryRun) { results.push({ sessionId: id, ok: true, dryRun: true, wouldArchive: true, scope: ownSub ? 'own-sub' : 'distill-project' }); continue }
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
          if (liveIds.length > 0) { results.push({ sessionId: id, ok: false, error: 'refusing to delete: ' + liveIds.length + ' session(s) in its subtree are loaded in memory (' + liveIds.slice(0, 5).join(', ') + '); this version has no unload API — restart DSH, then delete' }); continue }
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
            const teamsRaw = await readFile(DSH_HOME + '/projects.json', 'utf8')
            const referenced = [...subtree].filter((sid) => teamsRaw.includes('"' + sid + '"'))
            if (referenced.length > 0) notes.push('team-records-reference-deleted-ids: ' + referenced.join(', ') + ' (projects.json; cleanup is console archive/remove-member)')
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
        if (persistenceApi() === 'none') throw new Error('session persistence is unavailable in this deployment: the sessionPersistence service exposes neither stat/open (0.1.5+) nor inspect (legacy)')
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
          let read
          try {
            read = await readSessionVia(sid)
          } catch (error) {
            files.push({ sessionId: sid, ok: false, error: errText(error) })
            continue
          }
          const events = read !== undefined && Array.isArray(read.events) ? read.events : []
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

    registerTool(ctx, 'forge_mailbridge_list',
      '列出本 DSH 进程中的会话（在线与已持久化），含 id、标题、在线状态、工作区、主从关系与归档状态。默认只列未归档会话；能看到所有主会话与自己主会话下辖的全部子会话（含子子会话）。给 query 时按 id/标题子串查找（等价于原 session_find）；只想看某个工作区（目录）下的会话时用 `workspace` 参数过滤。完整工作流见 `cross-session-mailbox` 技能。',
      {
        limit: { type: 'number', description: '最大返回会话数（默认 50，上限 200）。' },
        workspace: { type: 'string', description: '可选：只列该工作区（目录路径片段，如 "dsh-forge" 匹配某个 .../dsh-forge 目录）下的会话。' },
        includeArchived: { type: 'boolean', description: '是否包含已归档会话（默认 false=只列未归档；true 时归档会话带 archived:true 一并列出）。' },
        query: { type: 'string', description: '可选：按会话 id 或标题子串查找（合并了原 session_find）。给了 query 即走查找语义：返回 { ok, query, count, sessions }，不降序、无 createdAt、上限 50；空串视为未给（不再像原 session_find 那样报错）。' },
      },
      async (args, exec) => {
        const query = typeof args.query === 'string' ? args.query.trim() : ''
        if (query !== '') {
          // 合并原 session_find：过滤逻辑全在 svc.find 里，原样返回它的顶层形状。
          const found = await svc.find({
            query,
            limit: typeof args.limit === 'number' && args.limit > 0 ? args.limit : 20,
            workspace: args.workspace,
            includeArchived: args.includeArchived === true,
            masterId: callerMasterId(exec),
          })
          return jsonText({ ok: true, ...found })
        }
        const out = await svc.list({
          limit: typeof args.limit === 'number' && args.limit > 0 ? args.limit : 50,
          workspace: args.workspace,
          includeArchived: args.includeArchived === true,
          masterId: callerMasterId(exec),
        })
        return jsonText({ ok: true, archivedHidden: args.includeArchived !== true, ...out })
      })

    registerTool(ctx, 'forge_mailbridge_list_archived',
      '列出本主会话下辖的已归档子会话（含子子会话）。仅主会话可用；子代理拒绝。捞出用 `forge_mailbridge_archive({ sessionIds, undo: true })`。',
      { limit: { type: 'number', description: '最大返回数（默认 50，上限 200）。' } },
      async (args, exec) => {
        if (!isMainSession(exec)) return jsonText({ ok: false, error: 'forge_mailbridge_list_archived is restricted to the main session' })
        const out = await svc.listArchived({
          limit: typeof args.limit === 'number' && args.limit > 0 ? args.limit : 50,
          masterId: callerMasterId(exec),
        })
        return jsonText({ ok: true, ...out })
      })

    // R17：archive + unarchive 合成一个工具两个方向（undo:true 走捞出）。同名反向动作、参数相同、
    // 守卫同级——合并后省一个工具面。守卫（仅主会话）与 svc 调用参数逐字保留。
    registerTool(ctx, 'forge_mailbridge_archive',
      '归档或捞出会话。默认只能动本主会话下辖的子会话（含子子会话）；**项目蒸馏岗**还能归档**同项目**的任意会话（含主会话）。归档后不再出现在 forge_mailbridge_list 的默认结果里，但文件保留，可用 forge_mailbridge_list_archived 查看。仅主会话可用；不能归档运行中的会话。',
      {
        sessionIds: { type: 'array', items: { type: 'string' }, required: true, description: '会话 id 数组（自己的子会话；蒸馏岗可为同项目任意会话）。' },
        undo: { type: 'boolean', description: 'true = 捞出（取消归档）；省略或 false = 归档。' },
        dryRun: { type: 'boolean', description: '只在归档方向有效：预演，仅报告会被归档的会话与判定范围，不写任何标记。' },
      },
      async (args, exec) => {
        if (!isMainSession(exec)) return jsonText({ ok: false, error: 'forge_mailbridge_archive is restricted to the main session' })
        const ids = Array.isArray(args.sessionIds) ? args.sessionIds.map((x) => String(x)) : []
        if (ids.length === 0) return jsonText({ ok: false, error: 'sessionIds must be a non-empty array' })
        if (args.undo === true) {
          const out = await svc.unarchive(ids, callerMasterId(exec), false)
          return jsonText({ ok: true, undone: true, ...out })
        }
        const me = exec !== undefined && exec.agent !== undefined && typeof exec.agent.id === 'string' ? exec.agent.id : undefined
        const out = await svc.archive(ids, callerMasterId(exec), me, me, { dryRun: args.dryRun === true })
        return jsonText({ ok: true, ...out })
      })

    registerTool(ctx, 'forge_mailbridge_export',
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

    registerTool(ctx, 'forge_mailbridge_read',
      '读取另一会话的近期消息日志（仅精确读取）：用户、助手和工具消息及其文本，按时间从旧到新。用于给某会话发消息前了解它在做什么，或收集它的结果。完整工作流见 `cross-session-mailbox` 技能。',
      {
        sessionId: { type: 'string', required: true, description: '目标会话 id（来自 forge_mailbridge_list）。' },
        maxEvents: { type: 'number', description: '最大返回事件数（默认 20，上限 500）。' },
      },
      async (args, exec) => {
        const sessionId = String(args.sessionId)
        if (sessionPersistence === undefined) return jsonText({ ok: false, error: 'sessionPersistence service is not available in this deployment' })
        let read
        try {
          read = await readSessionVia(sessionId)
        } catch (error) {
          return jsonText({ ok: false, error: 'failed to read session: ' + errText(error) })
        }
        // stat() 对不存在的会话返回空值而不抛错；若不拦在这里，坏 id / 拼错的 id 会伪装成"会话存在但没有消息"。
        if (read === undefined) return jsonText({ ok: false, error: 'session "' + sessionId + '" not found' })
        const cap = typeof args.maxEvents === 'number' && args.maxEvents > 0 ? Math.min(Math.floor(args.maxEvents), 500) : 20
        const events = []
        for (const event of (read !== undefined && Array.isArray(read.events) ? read.events : [])) {
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

    registerTool(ctx, 'forge_mailbridge_send',
      '向本 DSH 进程中的另一会话发送消息。在线目标会立即在收件箱收到并醒来；否则消息持久排队，在该会话下次启动时送达。`wake: true` 时离线目标立即冷启动（resolveAgent 恢复其已持久化日志并去重并发恢复，随后 followup 唤醒，最后 flush 确保落盘），而不是等它下次手动启动——用于强制睡眠中的会话现在就干活；会消耗目标会话的模型回合。互唤无审批闸、无限流（2026-10-02 拍板）。接收方看到的文本带 `[cross-session message from <session name> (<sessionId>)]` 前缀，UI 上呈现为「来自会话 X」的投递卡片。完整工作流见 `cross-session-mailbox` 技能。',
      {
        targetSessionId: { type: 'string', required: true, description: '目标会话 id（来自 forge_mailbridge_list）。' },
        text: { type: 'string', required: true, description: '目标会话的消息正文。' },
        wake: { type: 'boolean', description: '是否强制唤醒离线目标：从其已持久化日志冷启动并立即送达（默认 false = 持久排队）。会消耗目标会话的模型回合。无审批、无限流。' },
      },
      async (args, exec) => {
        const targetId = String(args.targetSessionId)
        let body = String(args.text)
        if (body.length === 0) return jsonText({ ok: false, error: 'text must not be empty' })
        const talkCheck = await checkTalkAllowed(exec, targetId)
        if (talkCheck.ok === false) {
          return jsonText({ ok: false, error: talkCheck.error })
        }
        // P3 消息长度上限：防大 payload 撑爆目标会话上下文/落盘（超出截断并标记）
        const MAX_BODY = 200000
        if (body.length > MAX_BODY) body = body.slice(0, MAX_BODY) + '\n\n...(truncated: 原 ' + String(body.length) + ' 字符超上限)'
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
          : '\n\n（这是一条跨会话协作消息。若它要求回复，处理后请用 forge_mailbridge_send 把结论发回给发送方会话 ' + from + '，而不是只写在本地对话里。）'
        const wrapped = prefix + '\n\n' + cleanBody + replyHint + '\n\n[cross-session message end]'
        const message = {
          id: makeId('m'),
          role: 'user',
          content: [{ type: 'text', text: wrapped }],
        // Official producer-owned source shape. `kind` MUST NOT be 'user':
        // that is the single switch the client uses to decide between a human
        // bubble and an external-delivery card, and `rpcId` belongs to the
        // browser's optimistic-echo dedup — a third party filling it in
        // interferes with prompt settlement. `form: 'relay'` plus a non-empty
        // `senderSessionId` is what renders "来自会话 X".
        source: from === undefined
          ? { kind: 'mailbridge' }
          : { kind: 'mailbridge', form: 'relay', senderSessionId: from },
        }
        const target = agents.get(targetId)
        if (target !== undefined) {
          try {
            if (typeof target.status === 'string' && target.status === 'running') target.steer(message)
            else target.followup(message)
            return jsonText({ ok: true, delivered: 'live', targetSessionId: targetId, messageId: message.id, from: from ?? null, fromName })
          } catch (error) { /* fall through to the durable queue */ }
        }
        if (args.wake === true) {
          try {
            // Official cold-delivery path, modelled on the schedule plugin's
            // drive() (packages/schedule/schedule/src/runtime.ts):
            //   resolveAgent()  resolve or resume, deduplicating concurrent resumes
            //   steer/followup  wake the driver (followup makes the item the sole
            //                   ordinary message of its own turn)
            //   sessions.flush  durability barrier — without it a crash after the
            //                   inbox append can lose the message
            // The manual "reuse the last logged route" dance is gone: a resumed
            // agent restores its own route from the persisted log.
            if (sessionController !== undefined && typeof sessionController.resolveAgent === 'function') {
              try { await sessionController.resolveAgent(targetId) } catch (error) { /* fall back to a live lookup */ }
            }
            const target = agents.get(targetId)
            if (target !== undefined) {
              if (typeof target.status === 'string' && target.status === 'running') target.steer(message)
              else target.followup(message)
              let flushed = true
              try {
                if (sessions !== undefined && typeof sessions.flush === 'function') {
                  const ack = await sessions.flush(target.session)
                  flushed = ack !== false
                }
              } catch (error) { flushed = false }
              return jsonText({ ok: true, delivered: 'woken', targetSessionId: targetId, messageId: message.id, from: from ?? null, fromName, flushed })
            }
            // resolveAgent succeeded but the agent did not register: fall through
            // to the durable queue below instead of losing the message (P0-2 fix —
            // every path must end in live delivery OR the persistent queue).
          } catch (error) {
            return jsonText({ ok: false, error: 'wake failed: ' + errText(error), targetSessionId: targetId })
          }
        }
        try {
          const ids = await listSessionIds()
          const known = ids.some((entry) => entry.id === targetId)
          if (!known) return jsonText({ ok: false, error: 'unknown session id "' + targetId + '"; use forge_mailbridge_list to see available sessions' })
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

    registerTool(ctx, 'forge_mailbridge_check',
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

    // 0.2.0-rc.2: agent/session-start → the asynchronous, serial agent/created.
    // Fires before the agent's first model request, which is strictly better for
    // delivering offline mail than the old fire-and-forget event.
    ctx.on('agent/created', (payload) => {
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
            // Same official producer-owned source shape as the live path.
            source: typeof record.from === 'string'
              ? { kind: 'mailbridge', form: 'relay', senderSessionId: record.from }
              : { kind: 'mailbridge' },
          }
          try { agent.followup(message) } catch (error) { continue }
          await mailbox.deleteRecord('msg', item.key)
        }
      })).catch(() => { /* never throw from a listener */ })
    })

  },
}

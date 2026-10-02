// description: forge 项目数据面：在宿主自己的 HTTP 上开 /dsh-forge/projects，供浏览器半部读写 projects.json。
//
// 为什么不用官方 ctx.remote 命名空间（2026-10-02 定论，见 docs/ADAPTATION-0.2.0-rc.2.md §6.16）：
// 浏览器侧那份命名空间清单是**构建期生成的硬编码数组**
// （packages/api/remotes/src/client/index.ts apply() 里挂约 25 个 @deepseek-ai/*/remote 产物），
// 外部插件加不进去，除非改 app.asar 里的 @deepseek-ai/dsh-api-remotes 或把官方 typert generator
// 变成运行时依赖。所以 forge 走自己注册路由这条路 —— forgeboot2 早就这么干了。
//
// 三个必须自己处理的点：
//   1. **CORS**：桌面页面 origin 是 dsh-app://app，宿主 HTTP 在 127.0.0.1:<port>，是跨源。
//      实测官方 webServer 不给任何 Access-Control-Allow-Origin，所以必须自己发，
//      并且自己处理 OPTIONS 预检（默认落到处理器上会 405）。
//   2. **鉴权**：路由不带 token。靠自定义头 X-Forge-Client + Origin 校验挡掉
//      "网页被诱导访问 localhost" 这类现实威胁。这是**本地信任**，不是强鉴权，别当成后者。
//   3. **入参校验**：所有 op 都在这里做，不放任自由字符串进 projects.json。
import { errText } from './lib/forge-common.mjs'
import { loadProjects, saveProjects, projectsLoadError, PROJECTS_VERSION } from './lib/projects.mjs'
import { archiveTeam, addMember, removeMember, writeTask, listFreeSessions, talkSend } from './lib/team-org.r2.mjs'

const ROUTE = '/dsh-forge/projects'
const CLIENT_HEADER = 'x-forge-client'
const MAX_BODY = 256 * 1024

// Origin 白名单：桌面渲染进程 + 本地 http（浏览器里直接开 http://127.0.0.1:<port> 调试时）
function originAllowed(origin) {
  if (typeof origin !== 'string' || origin === '') return true   // 非浏览器（curl/PS）没有 Origin
  if (origin === 'dsh-app://app' || origin === 'dsh-app://-') return true
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return true
  return false
}

function cors(res, origin) {
  // 不用 cookie，所以回显具体 origin 即可（不用 *，留出以后加凭据的余地）
  if (typeof origin === 'string' && origin !== '') res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type,' + CLIENT_HEADER)
  res.setHeader('Access-Control-Max-Age', '600')
}

function send(res, status, payload) {
  const text = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) { reject(new Error('body too large (max ' + MAX_BODY + ' bytes)')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 项目记录 → 界面要的形状（不含内部字段，只给 UI 需要的）。 */
function projectView(p) {
  return {
    id: p.id,
    name: p.name,
    cwds: Array.isArray(p.cwds) ? p.cwds : [],
    memory: p.memory || '',
    dormant: typeof p.archivedAt === 'string' && p.archivedAt.length > 0,
    archivedAt: p.archivedAt || '',
    captain: p.captain || '',
    goal: p.goal || '',
    members: Array.isArray(p.members) ? p.members : [],
    tasks: Array.isArray(p.tasks) ? p.tasks : [],
    stale: Array.isArray(p.stale) ? p.stale : [],
    archived: Array.isArray(p.archived) ? p.archived.map((a) => ({ at: a.at || '', name: a.name || '', memberCount: Array.isArray(a.members) ? a.members.length : 0, taskCount: Array.isArray(a.tasks) ? a.tasks.length : 0 })) : [],
    wake: p.wake,
    crossTeam: p.crossTeam,
    implicit: p.id.startsWith('cwd:'),
  }
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** 一个 op 一张表：每个 op 自己校验入参，返回要回给浏览器的对象。 */
const OPS = {
  /** 全部项目（含归档的；UI 自己分组）。 */
  async list() {
    const cfg = await loadProjects()
    return {
      ok: true,
      version: PROJECTS_VERSION,
      // 文件坏了要说出去 —— 绝不静默当成"没有项目"（用户 2026-10-02 定的原则）
      problem: projectsLoadError(),
      projects: (cfg.projects || []).map(projectView),
    }
  },

  /** 新建项目。cwds 里第一项当工作目录。 */
  async create(args) {
    const name = str(args.name, 64)
    if (name === '') return { ok: false, error: '项目名不能为空' }
    const cwds = (Array.isArray(args.cwds) ? args.cwds : []).map((c) => str(c, 512)).filter((c) => c !== '')
    const cfg = await loadProjects()
    const base = name.replace(/^p-/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
    let id = 'p-' + (base === '' ? Date.now().toString(36) : base)
    if ((cfg.projects || []).some((p) => p && p.id === id)) id = id + '-' + Date.now().toString(36)
    cfg.projects = Array.isArray(cfg.projects) ? cfg.projects : []
    cfg.projects.push({
      id, name, cwds,
      memory: 'project-memory/' + id + '/README.md',
      wake: { windowMs: 60000, perTarget: 3, projectTotal: 8 },
      crossTeam: { windowMs: 60000, perTarget: 3, projectTotal: 8 },
      members: [], tasks: [], stale: [], archived: [],
    })
    const saved = await saveProjects(cfg)
    return { ok: true, project: projectView(saved.projects.find((p) => p.id === id)) }
  },

  /** 加/删目录。 */
  async addCwd(args) {
    const cwd = str(args.cwd, 512)
    if (cwd === '') return { ok: false, error: '目录不能为空' }
    const cfg = await loadProjects()
    const p = (cfg.projects || []).find((x) => x && x.id === str(args.projectId, 80))
    if (!p) return { ok: false, error: '没有这个项目' }
    if (!Array.isArray(p.cwds)) p.cwds = []
    const norm = (s) => String(s).replace(/\\/g, '/').replace(/\/+$/, '')
    if (!p.cwds.some((c) => norm(c) === norm(cwd))) p.cwds.push(cwd)
    const saved = await saveProjects(cfg)
    return { ok: true, project: projectView(saved.projects.find((x) => x.id === p.id)) }
  },

  async removeCwd(args) {
    const cwd = str(args.cwd, 512)
    const cfg = await loadProjects()
    const p = (cfg.projects || []).find((x) => x && x.id === str(args.projectId, 80))
    if (!p) return { ok: false, error: '没有这个项目' }
    p.cwds = (Array.isArray(p.cwds) ? p.cwds : []).filter((c) => c !== cwd)
    const saved = await saveProjects(cfg)
    return { ok: true, project: projectView(saved.projects.find((x) => x.id === p.id)) }
  },

  /** 归档整个项目（外层）/ 取消归档。 */
  async archiveProject(args) {
    const cfg = await loadProjects()
    const p = (cfg.projects || []).find((x) => x && x.id === str(args.projectId, 80))
    if (!p) return { ok: false, error: '没有这个项目' }
    p.archivedAt = new Date().toISOString()
    const saved = await saveProjects(cfg)
    return { ok: true, project: projectView(saved.projects.find((x) => x.id === p.id)) }
  },

  async unarchiveProject(args) {
    const cfg = await loadProjects()
    const p = (cfg.projects || []).find((x) => x && x.id === str(args.projectId, 80))
    if (!p) return { ok: false, error: '没有这个项目' }
    delete p.archivedAt
    const saved = await saveProjects(cfg)
    return { ok: true, project: projectView(saved.projects.find((x) => x.id === p.id)) }
  },

  /** 归档当前团队（内层）：压快照 + 清成员/看板/captain。 */
  async archiveRoster(args) {
    return archiveTeam(str(args.projectId, 80))
  },

  /** 成员：加 / 减。 */
  async memberAdd(args) {
    return addMember({
      teamId: str(args.projectId, 80),
      sessionId: str(args.sessionId, 120),
      memberId: str(args.memberId, 64),
      role: str(args.role, 64),
      preset: str(args.preset, 64) || 'forge-team',
      actor: 'ui',
    })
  },

  async memberRemove(args) {
    return removeMember({ teamId: str(args.projectId, 80), sessionId: str(args.sessionId, 120) })
  },

  /** 看板：写一条（新建或更新）。 */
  async taskWrite(args) {
    return writeTask({
      teamId: str(args.projectId, 80),
      id: str(args.id, 64),
      title: str(args.title, 160),
      status: str(args.status, 32),
      assignee: str(args.assignee, 64),
      description: str(args.description, 4000),
      output: str(args.output, 8000),
    })
  },

  /** 未被任何项目占用的会话（「从已有会话挑选」用）。 */
  async freeSessions() {
    return listFreeSessions()
  },

  /**
   * 页面替某个成员发一条消息。走 team-org 的 talkSend —— 它收的是纯字符串参数，
   * 不需要工具层上下文（talkRuntime 由 mailbridge 在加载时绑定）。
   * from 是发送方会话 id（页面取 SessionListState.byId 里 retainedBy.mainView > 0 的那个），to 是目标成员。
   */
  async memberMessage(args) {
    const from = str(args.from, 120)
    const to = str(args.to, 120)
    const text = str(args.text, 4000)
    if (from === '') return { ok: false, error: '客户端没给出当前会话（from 为空）—— 页面在非会话视图下打开时会出现' }
    if (to === '') return { ok: false, error: '没有收件人（to 为空）' }
    if (text === '') return { ok: false, error: '消息不能为空' }
    try {
      const sent = await talkSend({ from, to, text, wake: true })
      return { ok: true, sent: sent === undefined ? null : sent }
    } catch (error) {
      return { ok: false, error: errText(error) }
    }
  },
}

export default {
  inject: ['webServer'],
  apply(ctx) {
    const webServer = ctx.get('webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') {
      console.error('[projapi] webServer 不可用，项目数据面没挂上')
      return
    }
    const dispose = webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: async (req, res) => {
        const origin = req.headers !== undefined ? req.headers.origin : undefined
        cors(res, origin)
        // 预检：官方 webServer 不处理 OPTIONS，直接落到处理器上会 405
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
        if (!originAllowed(origin)) { send(res, 403, { ok: false, error: 'origin not allowed' }); return }
        // 自定义头：挡住"网页被诱导访问 localhost"这类现实威胁（本地信任，非强鉴权）
        if (req.headers === undefined || req.headers[CLIENT_HEADER] === undefined) {
          send(res, 403, { ok: false, error: 'missing ' + CLIENT_HEADER + ' header' })
          return
        }
        try {
          if (req.method === 'GET') { send(res, 200, await OPS.list({})); return }
          if (req.method !== 'POST') { send(res, 405, { ok: false, error: 'GET or POST only' }); return }
          const raw = await readBody(req)
          let body
          try { body = JSON.parse(raw === '' ? '{}' : raw) } catch { send(res, 400, { ok: false, error: 'body is not JSON' }); return }
          const op = str(body.op, 32)
          const fn = OPS[op]
          if (fn === undefined) { send(res, 400, { ok: false, error: 'unknown op "' + op + '"' }); return }
          send(res, 200, await fn(body))
        } catch (error) {
          send(res, 500, { ok: false, error: errText(error) })
        }
      },
    })
    ctx.effect(() => () => { try { dispose() } catch (error) { /* best-effort */ } })
    console.log('[projapi] ' + ROUTE + ' 已注册')
  },
}

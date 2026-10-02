// description: 集群控制端点（复用宿主 HTTP 服务挂 /forge-control）——自签 bearer token 鉴权 + verb 分发。
//
// 为什么长在**进程内**、而不是像 console 那样自起一个端口：
//   ① 桌面版那台实例是 Electron 独占管理的 profile，打包的 dsh CLI 拒绝操作它
//      （实测 `error: profile "desktop" is managed exclusively by the Electron application`），
//      所以跨机远程控制走不了 CLI，只能走进程内。
//   ② ctx.webServer 官方自述 "the server carries no TLS, authentication, or origin policy of
//      its own" —— 鉴权必须自带。官方先例是 @deepseek-ai/dsh-webhook-github：自注册路由 +
//      自验 HMAC（webhook 包自述 "provider authentication belongs to adapter packages"）。
//      这里用自签 bearer token：比 HMAC 简单、跨语言、且对"节点是启动者 / 不是启动者"两种
//      集群拓扑都成立。
//   ③ 顺带解决 console 硬编码 3081、与另一个实例撞端口的老问题（实测 EADDRINUSE）。
//
// 协议：
//   POST /forge-control            body {"op":"<verb>","args":{…}} → {"ok":true,"data":…}
//   GET  /forge-control/health     同上，但要 token；返回本节点身份
//   GET  /forge-control/verbs      列出本节点支持的 verb（要 token）
// 鉴权：`Authorization: Bearer <token>`，或 `X-Forge-Token: <token>`（某些 HTTP 客户端会
//       改写 Authorization）。**没有 localhost 旁路** —— 集群里请求本来就来自别的机器。
//
// 部署注意：本路由挂在宿主已配置的 host/port 上。默认 profile 绑 127.0.0.1，跨机访问不了；
// 集群要显式让节点监听对外地址（`dsh --profile X --host 0.0.0.0 …`），并相应配置
// connection.trustedHosts（那是浏览器 /api 围栏的事，与本端点无关）。
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { hostname, platform, arch } from 'node:os'
import { join } from 'node:path'
import { DSH_HOME, atomicWriteJson, errText } from './lib/forge-common.mjs'

const ROUTE_PATH = '/forge-control'
const TOKEN_FILE = join(DSH_HOME, 'forge-control.json')
const TOKEN_FILE_VERSION = 1
// 请求体上限。集群控制不只有小命令 —— 传文件是真实用例，所以默认给到 32 MiB，
// 并允许在 token 文件里用 `maxBodyBytes` 覆盖（见 loadOrCreateToken）。
//
// 注意：大体积**二进制不该塞进 base64 JSON** —— 那条路同时吃掉内存与 1.33 倍体积。
// 真正传文件应该另开一条流式路由（PUT 直写磁盘、不带 JSON 包装）。这里放宽只是让
// 「中等负载的 JSON」不必撞墙。
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024

/** verb 抛出的可编码错误：带稳定的 code，便于中心侧分支处理。 */
class ControlError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

// ── token ───────────────────────────────────────────────────────────────────

/** 读 token 文件；缺失或损坏则新建一个 32 字节随机 token 并落盘。返回 { token, created, maxBodyBytes }。 */
async function loadOrCreateToken() {
  try {
    const parsed = JSON.parse(await readFile(TOKEN_FILE, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.token === 'string' && parsed.token.length >= 32) {
      const limit = Number.isSafeInteger(parsed.maxBodyBytes) && parsed.maxBodyBytes > 0 ? parsed.maxBodyBytes : DEFAULT_MAX_BODY_BYTES
      return { token: parsed.token, created: false, maxBodyBytes: limit }
    }
  } catch (error) { /* 缺失或损坏 → 重建 */ }
  const token = randomBytes(32).toString('base64url')
  await atomicWriteJson(TOKEN_FILE, { version: TOKEN_FILE_VERSION, token, maxBodyBytes: DEFAULT_MAX_BODY_BYTES, createdAt: new Date().toISOString() })
  return { token, created: true, maxBodyBytes: DEFAULT_MAX_BODY_BYTES }
}

/** 定长常量时间比较，避免按字节比较泄漏 token 前缀。 */
function tokenMatches(presented, expected) {
  if (typeof presented !== 'string') return false
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** 从两种可接受的头部取 token。 */
function presentedToken(req) {
  const auth = req.headers['authorization']
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim()
  const alt = req.headers['x-forge-token']
  if (typeof alt === 'string') return alt.trim()
  return undefined
}

// ── HTTP 小工具 ──────────────────────────────────────────────────────────────

/** 读请求体，带上限；超限抛出可编码错误而不是无限缓冲。 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new ControlError('BODY_TOO_LARGE', 'request body exceeds ' + limit + ' bytes'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', (error) => reject(error))
  })
}

/** 统一 JSON 响应。控制面是机器对机器，不需要 CORS。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

// ── verb 表 ─────────────────────────────────────────────────────────────────
//
// 每个 verb 形如 async (args, ctx) => data，抛 ControlError 表达可编码失败。
// **只收已经对着 rc.2 原文核验过的方法** —— 宁可少，不可猜。

/** 本节点身份。中心靠它做节点发现与版本/能力对账。 */
function verbHealth(_args, ctx) {
  const pc = ctx.get('profileContext')
  // 节点自注册的必需字段，而 rc.2 **没有任何服务方法**返回它：webServer 只暴露
  // register*，profileContext 只有 4 个 readonly 字段（审计 §13 缺口 ④）。
  // 所以只能由插件自报 —— 读 webServer 的 host/port getter，取不到就算了。
  let address
  try {
    const ws = ctx.get('webServer')
    if (ws !== undefined && ws !== null) {
      address = { host: ws.host ?? undefined, port: ws.port ?? undefined }
    }
  } catch (error) { /* getter 不可用就算了，地址不是必需字段 */ }
  return {
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    pid: process.pid,
    node: process.version,
    dshHome: DSH_HOME,
    profile: pc !== undefined && pc !== null && typeof pc.name === 'string' ? pc.name : undefined,
    profileDir: pc !== undefined && pc !== null && typeof pc.dir === 'string' ? pc.dir : undefined,
    address,
    uptimeSeconds: Math.round(process.uptime()),
    now: new Date().toISOString(),
  }
}

/**
 * 本节点实际挂载了哪些宿主服务。中心据此判断"这个节点支不支持某个 verb"，
 * 而不是发过去撞一个 undefined。判据是 ctx.get 非空，不做任何调用。
 */
function verbCapabilities(_args, ctx) {
  const probe = [
    'agents', 'agentPresets', 'sessions', 'sessionController', 'sessionPersistence', 'sessionQuery',
    'workspaces', 'workspaceRegistry', 'jobs', 'skills', 'tools', 'settings', 'settingsController',
    'subagents', 'dynamicCordisRunner', 'webServer', 'templateRegistry',
  ]
  const present = []
  const absent = []
  for (const name of probe) {
    let value
    try { value = ctx.get(name) } catch (error) { value = undefined }
    if (value === undefined || value === null) absent.push(name)
    else present.push(name)
  }
  return { present, absent }
}

/** 设置面：与浏览器侧同一套 describe（remote 读取恒定 redactSecrets，secret 不会走出去）。 */
async function verbSettingsDescribe(_args, ctx) {
  const settings = ctx.get('settings')
  if (settings === undefined || settings === null || typeof settings.describe !== 'function') {
    throw new ControlError('SERVICE_UNAVAILABLE', 'settings service is not mounted')
  }
  return settings.describe()
}

/** profile 详情（profileContext 的公开部分）。 */
function verbProfile(_args, ctx) {
  const pc = ctx.get('profileContext')
  if (pc === undefined || pc === null) throw new ControlError('SERVICE_UNAVAILABLE', 'profileContext is not mounted')
  return {
    name: pc.name,
    dir: pc.dir,
    patchPath: pc.patchPath,
    cwd: pc.cwd,
    home: pc.home,
    startedBundles: pc.startedBundles,
  }
}

/** 取宿主服务；缺失明确报错，不静默返回空 —— 中心必须能区分"没有这个能力"和"返回了空"。 */
function service(ctx, name) {
  const value = ctx.get(name)
  if (value === undefined || value === null) throw new ControlError('SERVICE_UNAVAILABLE', name + ' is not mounted on this node')
  return value
}

/** 取服务的某个方法并绑定；方法缺失同样明确报错。 */
function method(ctx, name, fn) {
  const svc = service(ctx, name)
  if (typeof svc[fn] !== 'function') throw new ControlError('SERVICE_UNAVAILABLE', name + '.' + fn + ' is not available')
  return svc[fn].bind(svc)
}

/** 必填字符串参数。 */
function requireString(args, key) {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) throw new ControlError('BAD_REQUEST', key + ' must be a non-empty string')
  return value
}

/**
 * 必填对象参数。控制端点是**传输层**：请求形状由中心按目标节点的 API 提供，
 * 这里只校验"给了个对象"，不去猜字段名（猜错只会得到难查的 INTERNAL）。
 */
function requireObject(args, key) {
  const value = args[key]
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ControlError('BAD_REQUEST', key + ' must be an object')
  }
  return value
}

/**
 * 给宿主方法用的请求期 signal。控制面单次调用很短，不做主动取消，
 * 但服务实现常直接 `signal.addEventListener(...)`，传 undefined 会崩。
 */
function requestSignal() {
  return new AbortController().signal
}

// 流式 verb 的两道上限：帧数 + 墙钟。
// **两者都必须有**：有些"列表"其实是活订阅（如 jobController.list），没有帧到达时
// 帧上限永远不会触发，await 会永久挂住。所以每次 next() 都要和截止时间竞速。
const MAX_STREAM_FRAMES = 2000
const STREAM_BUDGET_MS = 2000

async function drain(iterable, limit = MAX_STREAM_FRAMES, budgetMs = STREAM_BUDGET_MS) {
  if (iterable === undefined || iterable === null || typeof iterable[Symbol.asyncIterator] !== 'function') return []
  const iterator = iterable[Symbol.asyncIterator]()
  const out = []
  const deadline = Date.now() + budgetMs
  let timer
  try {
    while (out.length < limit) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      let timedOut = false
      const next = await Promise.race([
        iterator.next(),
        new Promise((resolve) => {
          timer = setTimeout(() => { timedOut = true; resolve({ done: true, value: undefined }) }, remaining)
        }),
      ])
      if (timer !== undefined) { clearTimeout(timer); timer = undefined }
      if (timedOut || next.done === true) break
      out.push(next.value)
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    // break/超时都要关闭迭代器，否则会留下悬挂的订阅。
    // **close 本身也必须限时**：底层迭代器卡住时 `return()` 同样可能永不 settle，
    // 那样 finally 会把整个 verb 拖死（实测踩到过：19 个 verb 里有 1 个挂起）。
    try {
      if (typeof iterator.return === 'function') {
        await Promise.race([
          iterator.return(),
          new Promise((resolve) => { setTimeout(resolve, 500) }),
        ])
      }
    } catch (error) { /* best-effort */ }
  }
  return out
}

const VERBS = {
  health: verbHealth,
  'node.profile': verbProfile,
  capabilities: verbCapabilities,
  'settings.describe': verbSettingsDescribe,

  // ── A1 跨节点安全只读（全部 @Remote，但仍逐 verb 白名单，绝不 1:1 透传）──
  // 注意：@Remote 的**别名不是进程内方法名**（如 @Remote('read') 挂在 readDocument 上），
  // 所以这里一律按真实方法名调用。
  'presets.list': (args, ctx) => method(ctx, 'agentPresets', 'remoteExportList')(),
  'presets.read': (args, ctx) => method(ctx, 'agentPresets', 'readDocument')(requireString(args, 'preset')),
  'plugins.list': (_args, ctx) => method(ctx, 'pluginManager', 'listPlugins')(),
  'plugins.bundles': (_args, ctx) => method(ctx, 'pluginManager', 'listBundles')(),
  'plugins.registries': (_args, ctx) => method(ctx, 'pluginManager', 'registries')(),
  'plugins.exemptions': (_args, ctx) => method(ctx, 'pluginManager', 'listVersionExemptions')(),
  'models.providers': (_args, ctx) => method(ctx, 'llm', 'listProviders')(),
  'models.configurableProviders': (_args, ctx) => method(ctx, 'llm', 'listConfigurableProviders')(),
  'sessions.list': (args, ctx) => method(ctx, 'sessionController', 'list')(args.request ?? {}, requestSignal()),
  'sessions.projections': (args, ctx) => method(ctx, 'sessionController', 'projections')(requireObject(args, 'request'), requestSignal()),
  'sessions.modelCatalog': (_args, ctx) => method(ctx, 'sessionController', 'modelCatalog')(),
  // 这几个宿主方法是**流**（活订阅），不是有限列表 —— 给中心做有限窗口的快照：
  // 超过帧数或墙钟就收尾返回，并由 drain 关闭迭代器。
  'jobs.list': (args, ctx) => drain(method(ctx, 'jobController', 'list')(requireObject(args, 'request'), requestSignal())),
  'subagents.list': (_args, ctx) => method(ctx, 'subagents', 'list')(),
  'subagents.children': (args, ctx) => method(ctx, 'subagents', 'listChildren')(requireString(args, 'parentSessionId'), requestSignal()),
  'skills.list': (args, ctx) => method(ctx, 'sessionSkillCatalog', 'list')(requireObject(args, 'request'), requestSignal()),
}

// ── 插件 ────────────────────────────────────────────────────────────────────

function statusFor(code) {
  switch (code) {
    case 'UNAUTHORIZED': return 401
    case 'UNKNOWN_VERB': return 404
    case 'BODY_TOO_LARGE': return 413
    case 'BAD_REQUEST': return 400
    case 'SERVICE_UNAVAILABLE': return 503
    default: return 500
  }
}

export default {
  inject: ['webServer'],
  apply(ctx) {
    const webServer = ctx.webServer
    if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return

    let token = undefined
    let maxBodyBytes = DEFAULT_MAX_BODY_BYTES
    // token 落盘失败不该让整个插件挂掉：报错并把 verb 面关掉。
    const ready = loadOrCreateToken()
      .then((result) => {
        token = result.token
        maxBodyBytes = result.maxBodyBytes
        if (result.created) console.log('[control] generated cluster control token at ' + TOKEN_FILE)
        console.log('[control] listening on ' + ROUTE_PATH + ' (bearer token required; no localhost bypass; body limit ' + maxBodyBytes + ' bytes)')
      })
      .catch((error) => {
        console.error('[control] token unavailable, control endpoint refuses every request: ' + errText(error))
      })

    const handler = async (req, res) => {
      await ready
      try {
        if (token === undefined) throw new ControlError('SERVICE_UNAVAILABLE', 'control token is unavailable on this node')
        if (!tokenMatches(presentedToken(req), token)) throw new ControlError('UNAUTHORIZED', 'missing or invalid control token')

        const url = new URL(req.url ?? '/', 'http://localhost')
        const tail = url.pathname.slice(ROUTE_PATH.length).replace(/^\/+/, '')

        if (req.method === 'GET' && tail === 'health') return sendJson(res, 200, { ok: true, data: verbHealth(undefined, ctx) })
        if (req.method === 'GET' && tail === 'verbs') {
          return sendJson(res, 200, { ok: true, data: { verbs: Object.keys(VERBS).sort() } })
        }
        if (req.method !== 'POST' || tail !== '') {
          throw new ControlError('UNKNOWN_VERB', 'expected POST ' + ROUTE_PATH + ' or GET ' + ROUTE_PATH + '/health|/verbs')
        }

        let envelope
        try {
          envelope = JSON.parse(await readBody(req, maxBodyBytes))
        } catch (error) {
          if (error instanceof ControlError) throw error
          throw new ControlError('BAD_REQUEST', 'body must be JSON: ' + errText(error))
        }
        if (envelope === null || typeof envelope !== 'object' || typeof envelope.op !== 'string') {
          throw new ControlError('BAD_REQUEST', 'body must be {"op":"<verb>","args":{…}}')
        }
        const verb = VERBS[envelope.op]
        if (typeof verb !== 'function') throw new ControlError('UNKNOWN_VERB', 'unknown op: ' + envelope.op)
        const args = envelope.args !== null && typeof envelope.args === 'object' ? envelope.args : {}
        sendJson(res, 200, { ok: true, data: await verb(args, ctx) })
      } catch (error) {
        const code = error instanceof ControlError ? error.code : 'INTERNAL'
        // 未预期的异常记日志，但只把 message 回给调用方（不泄漏栈）。
        if (code === 'INTERNAL') console.error('[control] verb failed: ' + errText(error))
        sendJson(res, statusFor(code), { ok: false, error: { code, message: errText(error) } })
      }
    }

    ctx.effect(() => webServer.register({ kind: 'prefix', path: ROUTE_PATH, handler }), 'control: /forge-control route')
  },
}

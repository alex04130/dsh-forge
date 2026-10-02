// console：Web 控制台 host 数据面（2026-09-01，k3 设计 §5 契约）。
// 独立 HTTP 监听（默认 3081，console.json 配 host/port/trustToken），不骑 3080 webui 壳。
// 数据面：/api/projects（workspace 分组）/api/team（agent_teams kv 只读）/api/plasmids（registry）/api/scores（评分影子快照）。
// 动作：POST /api/action/unarchive + POST /api/action/team-delete（确认三模式）。
// 只读俯视 + 两动作（编辑/建队不进 v1）；信任：wg 网段 + URL token（底线）。
// 实现：单文件 host-only 插件。HTTP 用 Node 内置 http（无框架依赖）。
import { createServer } from 'node:http'
import { readFile, writeFile, rename, appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname, extname } from 'node:path'
import { projectCards, teamView, readProjectMemory, writeProjectMemory, deleteProjectMemory } from './lib/agent-teams-file.r1.mjs'
import {
  listFreeSessions, createTeam, renameTeam, archiveTeam, restoreTeam, addMember, removeMember,
  writeTask, boardRead, boardPost, talkSend, talkRead, inboxList, inboxDecide,
  distillStale, claimDistill, requestModelMutate, bindTalkRuntime,
} from './lib/team-org.r2.mjs'

const HOME = process.env.DSH_HOME || homedir() + '/.dsh'
const CONSOLE_JSON = join(HOME, 'console.json')
const CONSOLE_WEB = join(HOME, 'console-web')
const PLASMID_REG = join(HOME, 'plasmids', 'registry.json')
const SCORE_SNAP = join(HOME, 'docs', 'audits', 'scoring-shadow-2026-09-01.md')
const FEATURES_PATH = join(HOME, 'features.json')
const FEATSW_AUDIT = join(HOME, 'logs', 'featsw-audit.jsonl')
const FEATSW_CATALOG = [
  { id: 'console.web', group: 'console', label: 'Forge 控制台（独立 HTTP :3081/:3082）' },
  { id: 'plasmid.repair', group: 'plasmid', label: '修复质粒注入通道' },
  { id: 'plasmid.coordination', group: 'plasmid', label: '协作质粒注入通道' },
  { id: 'plasmid.inject.brief', group: 'plasmid', label: '开场 brief（A）' },
  { id: 'plasmid.nudge.error', group: 'plasmid', label: '报错轻推（T）' },
  { id: 'plasmid.broadcast.meta', group: 'plasmid', label: '元数据半径广播（默认关）' },
  { id: 'mailbridge.forge_mailbridge_send', group: 'mailbridge', label: '跨会话投递' },
  { id: 'teamhub.teams', group: 'teamhub', label: '团队工具' },
  { id: 'archive.archive_read_event', group: 'archive', label: '档案精确读取' },
  { id: 'verify.verify_claim', group: 'verify', label: '言行一致检查' },
]
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
}

async function serveStatic(res, pathname) {
  let rel = pathname === '/' ? 'index.html' : String(pathname).replace(/^\//, '')
  if (rel.includes('..') || rel.includes('\\') || rel.startsWith('/') || rel.includes('\0')) return false
  const file = join(CONSOLE_WEB, rel)
  if (!file.startsWith(CONSOLE_WEB + '/') && file !== CONSOLE_WEB) return false
  try {
    const buf = await readFile(file)
    const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' })
    res.end(buf)
    return true
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return false
    throw error
  }
}

async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch (e) { return fallback }
}

function json(res, code, data) {
  const body = JSON.stringify(data)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
  res.end(body)
}

function featswDefaults() {
  return {
    version: 1,
    enabled: true,
    activeProfile: 'full',
    profiles: {
      full: { surface: ['*'], gate: ['*'], off: ['plasmid.broadcast.meta'] },
    },
    overrides: {},
    pending: [],
  }
}

function featswMatch(list, feature) {
  if (!Array.isArray(list)) return false
  if (list.includes('*')) return true
  if (list.includes(feature)) return true
  const dot = feature.indexOf('.')
  return dot > 0 && list.includes(feature.slice(0, dot + 1) + '*')
}

function featswSnapshot(cfg) {
  const data = cfg !== null && typeof cfg === 'object' ? cfg : featswDefaults()
  const profiles = data.profiles !== null && typeof data.profiles === 'object' ? data.profiles : featswDefaults().profiles
  const active = typeof data.activeProfile === 'string' && profiles[data.activeProfile] !== undefined ? data.activeProfile : 'full'
  const profile = profiles[active] ?? featswDefaults().profiles.full
  const off = Array.isArray(profile.off) ? profile.off : []
  const features = FEATSW_CATALOG.map((row) => ({
    id: row.id,
    group: row.group,
    label: row.label,
    gate: !off.includes(row.id) && featswMatch(profile.gate, row.id),
    surface: !off.includes(row.id) && featswMatch(profile.surface, row.id),
  }))
  return {
    enabled: data.enabled !== false,
    activeProfile: active,
    profiles: Object.keys(profiles),
    profile: { surface: profile.surface ?? ['*'], gate: profile.gate ?? ['*'], off },
    features,
    pending: Array.isArray(data.pending) ? data.pending.slice(-20) : [],
  }
}

async function featswLoad() {
  const data = await readJson(FEATURES_PATH, null)
  if (data === null || typeof data !== 'object') return featswDefaults()
  if (data.profiles === null || typeof data.profiles !== 'object') data.profiles = featswDefaults().profiles
  if (data.profiles.full === undefined) data.profiles.full = featswDefaults().profiles.full
  if (!Array.isArray(data.pending)) data.pending = []
  return data
}

async function featswSave(cfg, actor, feature, oldVal, nextVal) {
  const tmp = FEATURES_PATH + '.tmp'
  await writeFile(tmp, JSON.stringify(cfg, null, 2), 'utf8')
  await rename(tmp, FEATURES_PATH)
  try {
    await mkdir(dirname(FEATSW_AUDIT), { recursive: true })
    await appendFile(FEATSW_AUDIT, JSON.stringify({ ts: new Date().toISOString(), actor, feature, old: oldVal, new: nextVal, scope: 'global' }) + '\n', 'utf8')
  } catch (error) { /* audit best-effort */ }
}

// POST body 解析：收流 → JSON（失败返 null）
function readJsonFromReq(req) {
  return new Promise((resolve) => {
    let chunks = []
    req.on('data', (c) => { chunks.push(c); if (chunks.length > 10000) { chunks = []; req.destroy() } })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch (e) { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

export default {
  inject: ['agents', 'sessionPersistence'],
  apply(ctx) {
    bindTalkRuntime({
      agents: ctx.agents,
      sessionPersistence: ctx.sessionPersistence,
    })
    const cfgPromise = readJson(CONSOLE_JSON, {})
    const consoleEnabled = () => {
      const featsw = ctx.get('featsw')
      if (featsw !== undefined && typeof featsw.isGateOpen === 'function') {
        try { return featsw.isGateOpen('console.web') !== false } catch { return true }
      }
      return true
    }
    const server = createServer(async (req, res) => {
      if (consoleEnabled() === false) {
        return json(res, 403, { ok: false, error: 'feature_disabled', feature: 'console.web', hint: '在官方 WebUI 设置 → 功能开关 中打开 console.web' })
      }
      const cfg = await cfgPromise
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === '/api/health') {
        return json(res, 200, { ok: true, service: 'forge-console', ts: Date.now() })
      }
      if (!url.pathname.startsWith('/api/')) {
        const hit = await serveStatic(res, url.pathname)
        if (hit) return
      }
      // URL token 底线（trustToken；可空=本机/内网直连场景，但建议配）
      if (typeof cfg.trustToken === 'string' && cfg.trustToken.length > 0 && url.searchParams.get('token') !== cfg.trustToken) {
        return json(res, 401, { ok: false, error: 'unauthorized (missing/invalid token)' })
      }
      const path = url.pathname
      try {
        if (path === '/api/projects') {
          return json(res, 200, await projectCards())
        }
        if (path === '/api/team') {
          const want = url.searchParams.get('team') || url.searchParams.get('project') || ''
          return json(res, 200, await teamView(want))
        }
        if (path === '/api/memory' && req.method === 'GET') {
          return json(res, 200, await readProjectMemory(url.searchParams.get('project') ?? '', url.searchParams.get('file') ?? ''))
        }
        if (path === '/api/memory' && req.method === 'POST') {
          const body = await readJsonFromReq(req)
          if (body && body.delete === true) {
            const out = await deleteProjectMemory(body.projectId, body.file)
            return json(res, out?.ok === true ? 200 : 400, out)
          }
          const out = await writeProjectMemory(body?.projectId, body?.text, body?.file)
          return json(res, out?.ok === true ? 200 : 400, out)
        }
        if (path === '/api/archived') {
          return json(res, 200, { ok: true, archived: [], note: '归档列表尚未接 sessionmgmt；此页诚实空态' })
        }
        if (path === '/api/plasmids') {
          const reg = await readJson(PLASMID_REG, {})
          const entries = Array.isArray(reg.entries) ? reg.entries : []
          return json(res, 200, { ok: true, plasmids: entries.map((e) => ({ id: e.id, status: e.status, when: e.when ?? '', fitness: e.fitness ?? null })) })
        }
        if (path === '/api/scores') {
          const snap = await readFile(SCORE_SNAP).then((b) => b.toString()).catch(() => '')
          // 简版：markdown 原文返回（评分看板 v1 前端渲染；结构化后续）
          return json(res, 200, { ok: true, snapshot: snap, note: '评分影子快照（markdown；结构化后续）' })
        }
        if (path === '/api/featsw' && req.method === 'GET') {
          const cfg = await featswLoad()
          return json(res, 200, { ok: true, ...featswSnapshot(cfg) })
        }
        if (path === '/api/featsw/profile' && req.method === 'POST') {
          const body = await readJsonFromReq(req)
          const name = typeof body?.name === 'string' ? body.name : ''
          if (name === '') return json(res, 400, { ok: false, error: 'name required' })
          const cfg = await featswLoad()
          if (cfg.profiles[name] === undefined) return json(res, 400, { ok: false, error: 'unknown profile: ' + name })
          const old = cfg.activeProfile
          cfg.activeProfile = name
          await featswSave(cfg, 'ui', 'activeProfile', old, name)
          return json(res, 200, { ok: true, ...featswSnapshot(cfg) })
        }
        if (path === '/api/featsw/gate' && req.method === 'POST') {
          const body = await readJsonFromReq(req)
          const feature = typeof body?.feature === 'string' ? body.feature : ''
          if (feature === '') return json(res, 400, { ok: false, error: 'feature required' })
          const open = body?.open !== false
          const cfg = await featswLoad()
          const profile = cfg.profiles[cfg.activeProfile] ?? cfg.profiles.full
          if (!Array.isArray(profile.off)) profile.off = []
          const old = profile.off.slice()
          profile.off = open ? profile.off.filter((f) => f !== feature) : (profile.off.includes(feature) ? profile.off : [...profile.off, feature])
          await featswSave(cfg, 'ui', feature, old, profile.off)
          return json(res, 200, { ok: true, ...featswSnapshot(cfg) })
        }
        if (path === '/api/featsw/decide' && req.method === 'POST') {
          const body = await readJsonFromReq(req)
          const id = typeof body?.id === 'string' ? body.id : ''
          if (id === '') return json(res, 400, { ok: false, error: 'id required' })
          const cfg = await featswLoad()
          const pending = Array.isArray(cfg.pending) ? cfg.pending : []
          const item = pending.find((p) => p !== null && typeof p === 'object' && p.id === id)
          if (item === undefined) return json(res, 404, { ok: false, error: 'pending not found' })
          const allow = body?.allow === true
          item.status = allow ? 'allowed' : 'denied'
          item.decidedAt = new Date().toISOString()
          if (allow === true) {
            if (item.action === 'profile' && cfg.profiles[item.feature] !== undefined) cfg.activeProfile = item.feature
            else {
              const profile = cfg.profiles[cfg.activeProfile] ?? cfg.profiles.full
              if (!Array.isArray(profile.off)) profile.off = []
              if (item.action === 'open') profile.off = profile.off.filter((f) => f !== item.feature)
              if (item.action === 'close' && !profile.off.includes(item.feature)) profile.off = [...profile.off, item.feature]
            }
          }
          await featswSave(cfg, 'ui', item.feature, 'pending', item.status)
          return json(res, 200, { ok: true, ...featswSnapshot(cfg) })
        }
        if (path === '/api/sessions/free' && req.method === 'GET') {
          return json(res, 200, await listFreeSessions())
        }
        if (path === '/api/board' && req.method === 'GET') {
          const out = await boardRead(url.searchParams.get('team') || '', url.searchParams.get('since') || '')
          return json(res, out?.ok === true ? 200 : 400, out)
        }
        if (path === '/api/board' && req.method === 'POST') {
          const body = await readJsonFromReq(req)
          const out = await boardPost(body || {})
          return json(res, out?.ok === true ? 200 : 400, out)
        }
        if (path === '/api/talk' && req.method === 'GET') {
          return json(res, 200, await talkRead(url.searchParams.get('from') || '', url.searchParams.get('to') || ''))
        }
        if (path === '/api/talk' && req.method === 'POST') {
          const body = await readJsonFromReq(req)
          const out = await talkSend(body || {})
          return json(res, out?.ok === true ? 200 : 400, out)
        }
        if (path === '/api/inbox' && req.method === 'GET') {
          return json(res, 200, await inboxList(url.searchParams.get('project') || ''))
        }
        if (path === '/api/inbox' && req.method === 'POST') {
          const body = await readJsonFromReq(req)
          const out = await inboxDecide(body || {})
          return json(res, out?.ok === true ? 200 : 400, out)
        }
        if (path === '/api/action/team-create' && req.method === 'POST') {
          const body = await readJsonFromReq(req)
          const out = await createTeam(body || {})
          return json(res, out?.ok === true ? 200 : 400, out)
        }
        if (path === '/api/action/team-rename' && req.method === 'POST') {
          const body = await readJsonFromReq(req)
          const out = await renameTeam(body?.teamId, body?.name)
          return json(res, out?.ok === true ? 200 : 400, out)
        }
        if (path === '/api/action/team-restore' && req.method === 'POST') {
          const body = await readJsonFromReq(req)
          const out = await restoreTeam(body?.teamId)
          return json(res, out?.ok === true ? 200 : 400, out)
        }
        if (path === '/api/action/member-add' && req.method === 'POST') {
          const body = await readJsonFromReq(req)
          const out = await addMember(body || {})
          return json(res, out?.ok === true ? 200 : 400, out)
        }
        if (path === '/api/action/member-remove' && req.method === 'POST') {
          const body = await readJsonFromReq(req)
          const out = await removeMember(body || {})
          return json(res, out?.ok === true ? 200 : 400, out)
        }
        if (path === '/api/action/task' && req.method === 'POST') {
          const body = await readJsonFromReq(req)
          const out = await writeTask(body || {})
          return json(res, out?.ok === true ? 200 : 400, out)
        }
        if (path === '/api/action/distill' && req.method === 'POST') {
          const body = await readJsonFromReq(req)
          const out = await distillStale(body || {})
          return json(res, out && (out.ok === true || out.needPost === true) ? 200 : 400, out)
        }
        if (path === '/api/action/distill-claim' && req.method === 'POST') {
          const body = await readJsonFromReq(req)
          const out = await claimDistill(body || {})
          return json(res, out?.ok === true ? 200 : 400, out)
        }
        if (path === '/api/action/model-mutate' && req.method === 'POST') {
          const body = await readJsonFromReq(req)
          const row = await requestModelMutate(body?.kind, body?.payload, body?.from)
          return json(res, 200, { ok: true, queued: true, item: row })
        }
        if (path === '/api/action/unarchive' && req.method === 'POST') {
          // 接真：sessionmgmt.unarchive（归档捞回——v1 只读俯视的动作之一）
          const body = await readJsonFromReq(req)
          const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
          if (sessionId === '') return json(res, 400, { ok: false, error: 'sessionId required' })
          const svc = ctx.get('sessionmgmt')
          if (svc === undefined || typeof svc.unarchive !== 'function') return json(res, 501, { ok: false, error: 'sessionmgmt unavailable' })
          const out = await svc.unarchive([sessionId], body?.masterId ?? ctx.get('agents')?.currentInitiator?.()?.id, 'console')
          return json(res, 200, out)
        }
        if (path === '/api/action/team-archive' && req.method === 'POST') {
          const body = await readJsonFromReq(req)
          const out = await archiveTeam(body?.teamId)
          return json(res, out?.ok === true ? 200 : 400, out)
        }
        if (path === '/api/action/team-delete' && req.method === 'POST') {
          // 接真：teamhub teamDeleteApi（cleanup 三模式；delete 需 confirm=DELETE + 人操作）
          const body = await readJsonFromReq(req)
          const api = ctx.get('teamDeleteApi')
          if (api === undefined || typeof api.delete !== 'function') return json(res, 501, { ok: false, error: 'teamDeleteApi unavailable' })
          const out = await api.delete({
            captainId: String(body?.captainId ?? ''),
            cleanup: String(body?.cleanup ?? 'archive'),
            cleanupConfirm: String(body?.cleanupConfirm ?? ''),
          })
          return json(res, out?.ok === true ? 200 : 400, out)
        }
        return json(res, 404, { ok: false, error: 'not found' })
      } catch (err) {
        return json(res, 500, { ok: false, error: String(err?.message ?? err).slice(0, 300) })
      }
    })

    const boot = async () => {
      const cfg = await cfgPromise
      const host = typeof cfg.host === 'string' && cfg.host.length > 0 ? cfg.host : '127.0.0.1'
      const port = typeof cfg.port === 'number' && cfg.port > 0 ? cfg.port : 3081
      const listen = (tries) => {
        server.once('error', (error) => {
          if (error !== null && typeof error === 'object' && error.code === 'EADDRINUSE' && tries > 0) {
            setTimeout(() => listen(tries - 1), 200)
            return
          }
          console.error('[console] listen failed:', String(error && error.message ? error.message : error))
        })
        server.listen(port, host, () => {
          console.log('[console] forge 控制台: http://' + host + ':' + port + ' (SPA ' + CONSOLE_WEB + ')' + (cfg.trustToken ? ' token 已配' : ' 无 token——仅内网/本机'))
        })
      }
      listen(8)
    }
    boot().catch((e) => console.error('[console] boot failed:', String(e?.message ?? e)))
    ctx.effect(() => () => { try { server.close() } catch (e) { /* noop */ } })
  },
}

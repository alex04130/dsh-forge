// console：Web 控制台 host 数据面（2026-09-01，k3 设计 §5 契约）。
// 独立 HTTP 监听（默认 3081，console.json 配 host/port/trustToken），不骑 3080 webui 壳。
// 数据面：/api/projects（workspace 分组）/api/team（agent_teams kv 只读）/api/plasmids（registry）/api/scores（评分影子快照）。
// 动作：POST /api/action/unarchive + POST /api/action/team-delete（确认三模式）。
// 只读俯视 + 两动作（编辑/建队不进 v1）；信任：wg 网段 + URL token（底线）。
// 实现：单文件 host-only 插件。HTTP 用 Node 内置 http（无框架依赖）。
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

const HOME = process.env.DSH_HOME || homedir() + '/.dsh'
const CONSOLE_JSON = join(HOME, 'console.json')
const TEAM_STORE = join(HOME, 'storages', 'agent_teams.json')
const PLASMID_REG = join(HOME, 'plasmids', 'registry.json')
const SCORE_SNAP = join(HOME, 'docs', 'audits', 'scoring-shadow-2026-09-01.md')

async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch (e) { return fallback }
}

function json(res, code, data) {
  const body = JSON.stringify(data)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
  res.end(body)
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
  apply(ctx) {
    const cfgPromise = readJson(CONSOLE_JSON, {})
    const server = createServer(async (req, res) => {
      const cfg = await cfgPromise
      const url = new URL(req.url ?? '/', 'http://localhost')
      // 根路径：引导页（公开——健康/说明，无敏感数据）
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html><html><head><meta charset="utf-8"><title>forge 控制台</title></head><body style="font-family:system-ui;padding:40px"><h1>forge 控制台</h1><p>数据面运行中（API：<code>/api/projects</code> <code>/api/team</code> <code>/api/plasmids</code> <code>/api/scores</code>）。</p><p>UI 待 k3 挂载（console-web SPA）。token 底线：<code>?token=...</code></p></body></html>`)
        return
      }
      if (url.pathname === '/api/health') {
        return json(res, 200, { ok: true, service: 'forge-console', ts: Date.now() })
      }
      // URL token 底线（trustToken；可空=本机/内网直连场景，但建议配）
      if (typeof cfg.trustToken === 'string' && cfg.trustToken.length > 0 && url.searchParams.get('token') !== cfg.trustToken) {
        return json(res, 401, { ok: false, error: 'unauthorized (missing/invalid token)' })
      }
      const path = url.pathname
      try {
        if (path === '/api/projects') {
          // workspace 分组：优先 sessionPersistence.list（异步），兜底 sessions.list（同步）
          let list = []
          try {
            const sp = ctx.get('sessionPersistence')
            if (sp !== undefined && typeof sp.list === 'function') list = await sp.list()
            else {
              const sessions = ctx.get('sessions')
              if (sessions !== undefined && typeof sessions.list === 'function') list = sessions.list()
            }
          } catch (e) { list = [] }
          return json(res, 200, { ok: true, projects: Array.isArray(list) ? list.map((s) => ({ id: s.id, path: s.workspace ?? '', name: s.title ?? s.id, activeTeams: 0, sessions: 1, plasmids: 0, lastActiveAt: s.createdAt ?? null })) : [] })
        }
        if (path === '/api/team') {
          const teamStore = await readJson(TEAM_STORE, {})
          const tables = teamStore.tables ?? {}
          const teams = tables.team ?? {}
          const teamId = url.searchParams.get('project') ?? ''
          // 简版：全量 team 返回（前端选）；项目过滤 v1 简化
          const out = Object.values(teams).map((t, idx) => ({
            teamId: typeof t.teamId === 'string' ? t.teamId : ('team-' + idx),
            name: t.name ?? '',
            members: Array.isArray(t.members) ? t.members.map((m) => ({ memberId: m.id, role: m.role, sessionId: m.sessionId, status: 'offline' })) : [],
            tasks: Array.isArray(t.tasks) ? t.tasks : [],
            inbox: [],
          }))
          return json(res, 200, { ok: true, team: teamId !== '' ? (out.find((t) => t.teamId === teamId) ?? null) : out[0] ?? null, teams: out })
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
      server.listen(port, host, () => {
        console.log('[console] forge 控制台数据面: http://' + host + ':' + port + (cfg.trustToken ? ' (token 已配)' : ' (无 token——仅内网/本机)'))
      })
    }
    boot().catch((e) => console.error('[console] boot failed:', String(e?.message ?? e)))
    ctx.effect(() => () => { try { server.close() } catch (e) { /* noop */ } })
  },
}

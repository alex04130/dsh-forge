// featsw：功能开关（dsh-forge §7 / 附录 C FR-1..12）。
// 开关做在调用面上（C1），不做在插件生命周期上。
// 本轮落地：FR-1 双层 + FR-2 热载原子写 + FR-4 profile + FR-8 模型两工具 + FR-9 gate-off 结构化拒 + FR-10 审计 + plasmid.* 通道 + FR-12 零配置。
// FR-3 粒度 / FR-5 session 覆盖 / FR-6 surface 排队 / FR-7 面板：官方 WebUI 设置 → 功能开关（featui）；控制台 #switches 为镜像。session 覆盖读 overrides 但不自动派生。
import { readFile, writeFile, rename, appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { registerTool } from './lib/forge-tools.mjs'
import { jsonText } from './lib/forge-common.mjs'

const HOME = process.env.DSH_HOME || homedir() + '/.dsh'
const FEATURES_PATH = join(HOME, 'features.json')
const AUDIT_PATH = join(HOME, 'logs', 'featsw-audit.jsonl')

const CATALOG = [
  { id: 'console.web', group: 'console', label: '控制台' },
  { id: 'plasmid.repair', group: 'plasmid', label: '修复质粒' },
  { id: 'plasmid.coordination', group: 'plasmid', label: '协作质粒' },
  { id: 'plasmid.inject.brief', group: 'plasmid', label: '开场 brief' },
  { id: 'plasmid.nudge.error', group: 'plasmid', label: '报错轻推' },
  { id: 'plasmid.broadcast.meta', group: 'plasmid', label: '元数据广播' },
  { id: 'mailbridge.forge_mailbridge_send', group: 'mailbridge', label: '跨会话投递' },
  { id: 'teamhub.teams', group: 'teamhub', label: '团队' },
  { id: 'archive.archive_read_event', group: 'archive', label: '档案读取' },
  { id: 'verify.verify_claim', group: 'verify', label: '言行检查' },
]

export const CATALOG_PATH = join(HOME, 'features-catalog.json')

/**
 * 把活目录落盘，供跨动态插件边界读取。
 * 2026-09-11 实测：服务代理会把 CATALOG 行的 label 丢掉、listState() 在动态插件作用域里可能取空，
 * 于是 featui 面板静默退化成写死的 10 行。文件是单向、可核对、能就地看的。
 */
export async function writeCatalogFile() {
  try {
    await writeFile(CATALOG_PATH, JSON.stringify({ version: 1, updatedAt: Date.now(), features: CATALOG }, null, 2) + '\n', 'utf8')
    return { ok: true, count: CATALOG.length }
  } catch (error) { return { ok: false, error: errTextSafe(error) } }
}

/** 运行时追加目录行（注入包等动态能力在 apply 时登记）。去重；登记后通知监听者并落盘。 */
export function declareFeatures(rows) {
  let added = 0
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row === null || typeof row !== 'object' || typeof row.id !== 'string' || row.id === '') continue
    if (CATALOG.some((r) => r.id === row.id)) continue
    CATALOG.push({
      id: row.id,
      group: typeof row.group === 'string' && row.group !== '' ? row.group : 'inject',
      label: typeof row.label === 'string' && row.label !== '' ? row.label : row.id,
    })
    added += 1
  }
  if (added > 0) {
    notify()
    writeCatalogFile().catch(() => {})
  }
  return { ok: true, added }
}

let state = null
let listeners = new Set()
let watcher = null

function defaults() {
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

function normalized() {
  if (state === null) return defaults()
  if (state.profiles === null || typeof state.profiles !== 'object') return defaults()
  if (state.profiles.full === undefined) state.profiles.full = defaults().profiles.full
  if (!Array.isArray(state.pending)) state.pending = []
  if (state.overrides === null || typeof state.overrides !== 'object') state.overrides = {}
  return state
}

function profileOf(cfg, sessionId) {
  const overrides = cfg.overrides ?? {}
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    const key = 'session:' + sessionId
    const over = overrides[key]
    if (over !== null && typeof over === 'object' && typeof over.profile === 'string' && cfg.profiles[over.profile] !== undefined) {
      return cfg.profiles[over.profile]
    }
  }
  return cfg.profiles[cfg.activeProfile] ?? cfg.profiles.full ?? defaults().profiles.full
}

function matchList(list, feature) {
  if (!Array.isArray(list)) return false
  if (list.includes('*')) return true
  if (list.includes(feature)) return true
  const dot = feature.indexOf('.')
  if (dot > 0 && list.includes(feature.slice(0, dot + 1) + '*')) return true
  return false
}

export function isEnabled() {
  const cfg = normalized()
  return cfg.enabled !== false
}

export function isGateOpen(feature, sessionId) {
  if (isEnabled() === false) return false
  const cfg = normalized()
  const profile = profileOf(cfg, sessionId)
  const off = Array.isArray(profile.off) ? profile.off : []
  if (off.includes(feature)) return false
  return matchList(profile.gate, feature)
}

export function isSurfaceOpen(feature, sessionId) {
  if (isEnabled() === false) return false
  const cfg = normalized()
  const profile = profileOf(cfg, sessionId)
  const off = Array.isArray(profile.off) ? profile.off : []
  if (off.includes(feature)) return false
  return matchList(profile.surface, feature)
}

function snapshot(sessionId) {
  const cfg = normalized()
  const profile = profileOf(cfg, sessionId)
  const features = CATALOG.map((row) => ({
    id: row.id,
    group: row.group,
    label: row.label,
    gate: isGateOpen(row.id, sessionId),
    surface: isSurfaceOpen(row.id, sessionId),
  }))
  return {
    enabled: cfg.enabled !== false,
    activeProfile: cfg.activeProfile ?? 'full',
    profiles: Object.keys(cfg.profiles),
    profile: {
      surface: profile.surface ?? ['*'],
      gate: profile.gate ?? ['*'],
      off: profile.off ?? [],
    },
    features,
    pending: Array.isArray(cfg.pending) ? cfg.pending.slice(-20) : [],
  }
}

export function listState(sessionId) {
  return snapshot(sessionId)
}

function notify() {
  for (const fn of [...listeners]) { try { fn() } catch (e) { /* noop */ } }
}

export function onChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

async function audit(actor, feature, oldVal, nextVal, extra) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    actor,
    feature,
    old: oldVal,
    new: nextVal,
    scope: 'global',
    sessionId: extra && extra.sessionId ? extra.sessionId : null,
    ...(extra && extra.note ? { note: extra.note } : {}),
  }) + '\n'
  try {
    await mkdir(dirname(AUDIT_PATH), { recursive: true })
    await appendFile(AUDIT_PATH, line, 'utf8')
  } catch (error) { /* 审计失败不挡主路径 */ }
}

function errTextSafe(error) {
  try { return String(error && error.message ? error.message : error) } catch (e2) { return 'unknown error' }
}

async function persist(cfg, actor, feature, oldVal, nextVal, extra) {
  const body = JSON.stringify(cfg, null, 2) + '\n'
  try {
    const tmp = FEATURES_PATH + '.tmp'
    await writeFile(tmp, body, 'utf8')
    await rename(tmp, FEATURES_PATH)
  } catch (error) {
    // 2026-09-11：本部署 tmp+rename 会 ENOENT（写被重定向），原来会抛穿到 setEnabled
    // 触发 `dsh: fatal load failure`。退化成直接写，不再把整个进程拖死。
    console.warn('[featsw] atomic write failed, falling back to direct write:', errTextSafe(error))
    await writeFile(FEATURES_PATH, body, 'utf8')
  }
  state = cfg
  await audit(actor, feature, oldVal, nextVal, extra)
  notify()
}

async function load() {
  try {
    const raw = await readFile(FEATURES_PATH, 'utf8')
    const data = JSON.parse(raw)
    if (data === null || typeof data !== 'object' || typeof data.version !== 'number') throw new Error('bad shape')
    state = data
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
      const cfg = defaults()
      try {
        await writeFile(FEATURES_PATH, JSON.stringify(cfg, null, 2), 'utf8')
      } catch (writeErr) { /* 首次写失败仍走内存默认 */ }
      state = cfg
    } else if (state === null) {
      state = defaults()
    }
  }
  notify()
}

async function setEnabled(open, actor) {
  const cfg = structuredClone(normalized())
  const old = cfg.enabled !== false
  cfg.enabled = open !== false
  await persist(cfg, actor, 'enabled', old, cfg.enabled, {})
  return snapshot()
}

async function replaceState(next, actor) {
  const cfg = structuredClone(normalized())
  const old = { enabled: cfg.enabled !== false, activeProfile: cfg.activeProfile, off: (cfg.profiles[cfg.activeProfile] ?? cfg.profiles.full).off }
  if (typeof next.enabled === 'boolean') cfg.enabled = next.enabled
  if (typeof next.activeProfile === 'string' && cfg.profiles[next.activeProfile] !== undefined) cfg.activeProfile = next.activeProfile
  if (Array.isArray(next.off)) {
    const profile = cfg.profiles[cfg.activeProfile] ?? cfg.profiles.full
    profile.off = next.off.filter((id) => typeof id === 'string')
  }
  await persist(cfg, actor, 'featsw.save', old, { enabled: cfg.enabled !== false, activeProfile: cfg.activeProfile, off: (cfg.profiles[cfg.activeProfile] ?? {}).off }, {})
  return snapshot()
}

async function setActiveProfile(name, actor) {
  const cfg = structuredClone(normalized())
  if (cfg.profiles[name] === undefined) throw new Error('unknown profile: ' + name)
  const old = cfg.activeProfile
  cfg.activeProfile = name
  await persist(cfg, actor, 'activeProfile', old, name, {})
  return snapshot()
}

async function setFeatureOff(feature, open, actor) {
  const cfg = structuredClone(normalized())
  const profile = cfg.profiles[cfg.activeProfile] ?? cfg.profiles.full
  if (!Array.isArray(profile.off)) profile.off = []
  const old = profile.off.slice()
  if (open) profile.off = profile.off.filter((f) => f !== feature)
  else if (!profile.off.includes(feature)) profile.off = [...profile.off, feature]
  await persist(cfg, actor, feature, old, profile.off, {})
  return snapshot()
}

async function decidePending(id, allow, actor) {
  const cfg = structuredClone(normalized())
  const pending = Array.isArray(cfg.pending) ? cfg.pending : []
  const item = pending.find((p) => p !== null && typeof p === 'object' && p.id === id)
  if (item === undefined) throw new Error('pending request not found: ' + id)
  item.status = allow ? 'allowed' : 'denied'
  item.decidedAt = new Date().toISOString()
  await persist(cfg, actor, item.feature, 'pending', item.status, { note: item.action })
  if (allow === true) {
    if (item.action === 'profile') return await setActiveProfile(item.feature, actor)
    if (item.action === 'open') return await setFeatureOff(item.feature, true, actor)
    if (item.action === 'close') return await setFeatureOff(item.feature, false, actor)
  }
  return snapshot()
}

export default {
  inject: ['tools'],
  apply(ctx) {
    load().then(() => {})
    import('node:fs').then((m) => {
      try {
        watcher = m.watch(dirname(FEATURES_PATH), (_event, fname) => {
          if (String(fname ?? '') !== 'features.json') return
          load().catch(() => {})
        })
      } catch (e) { /* watch 失败不致命 */ }
    }).catch(() => {})
    ctx.effect(() => () => { try { if (watcher !== null) watcher.close() } catch (e) { /* noop */ } })

    const api = {
      isEnabled,
      isGateOpen,
      isSurfaceOpen,
      listState,
      onChange,
      catalog: CATALOG,
      declareFeatures,
      setEnabled: (open) => setEnabled(open, 'ui'),
      setProfile: (name) => setActiveProfile(name, 'ui'),
      setGate: (feature, open) => setFeatureOff(feature, open, 'ui'),
      replaceState: (next) => replaceState(next, 'ui'),
      decide: (id, allow) => decidePending(id, allow, 'ui'),
    }
    ctx.provide('featsw', api)
    writeCatalogFile().catch(() => {})

    registerTool(ctx, 'forge_feature_list',
      '只读：列出 featsw 当前 profile、surface/gate 状态与 plasmid.* 通道。不改变任何开关。',
      {},
      async () => jsonText({ ok: true, ...snapshot() }),
    )

    registerTool(ctx, 'forge_feature_request',
      '申请变更 featsw（开/关某 feature 或切换 profile）。本工具只生成待审批单，绝不直接写开关。人在官方 WebUI 设置 → 功能开关 批准后才翻转。',
      {
        feature: { type: 'string', description: 'feature id（如 plasmid.nudge.error）或 profile 名（full）' },
        action: { type: 'string', description: 'open | close | profile' },
        layer: { type: 'string', description: 'gate 或 surface；切 profile 时可省略' },
        reason: { type: 'string', description: '申请理由' },
      },
      async (args, exec) => {
        const feature = String(args.feature ?? '').trim()
        const action = String(args.action ?? '').trim()
        if (feature === '' || action === '') return jsonText({ ok: false, error: 'feature and action required' })
        const cfg = structuredClone(normalized())
        const item = {
          id: 'req-' + Date.now().toString(36),
          ts: new Date().toISOString(),
          feature,
          action,
          layer: String(args.layer ?? 'gate'),
          reason: String(args.reason ?? ''),
          sessionId: exec !== undefined && exec.agent !== undefined ? exec.agent.id : null,
          status: 'pending',
        }
        cfg.pending = [...(cfg.pending ?? []), item].slice(-50)
        await persist(cfg, 'model-request', feature, null, item, { sessionId: item.sessionId, note: action })
        return jsonText({ ok: true, pending: item, note: '已入待批；人在官方 WebUI 设置 → 功能开关 批准后生效（控制台 #switches 为镜像）' })
      },
    )
  },
}

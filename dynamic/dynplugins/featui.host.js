const CATALOG = [
  'console.web',
  'plasmid.repair',
  'plasmid.coordination',
  'plasmid.inject.brief',
  'plasmid.nudge.error',
  'plasmid.broadcast.meta',
  'mailbridge.forge_mailbridge_send',
  'teamhub.teams',
  'archive.archive_read_event',
  'verify.verify_claim',
]
const FEATURES_PATH = '/home/alex/.dsh/features.json'

function errText(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}

/**
 * 活目录（含注入包通道）：优先读 featsw 落盘的 features-catalog.json，
 * 其次问 featsw 服务，最后返回空数组（不再静默假装"只有内置 10 条"——那是 2026-09-11 的坑）。
 */
async function liveCatalogOf(ctx) {
  try {
    const fs = ctx !== undefined && ctx.get ? ctx.get('fs') : undefined
    if (fs !== undefined && typeof fs.resolve === 'function') {
      const target = await fs.resolve('/home/alex/.dsh/features-catalog.json')
      const data = JSON.parse(await fs.readText(target))
      if (data !== null && typeof data === 'object' && Array.isArray(data.features) && data.features.length > 0) return data.features
    }
  } catch (error) { /* fall through */ }
  try {
    const f = ctx !== undefined && ctx.get ? ctx.get('featsw') : undefined
    if (f !== undefined) {
      if (typeof f.listState === 'function') {
        const st = f.listState()
        if (st !== null && typeof st === 'object' && Array.isArray(st.features) && st.features.length > 0) return st.features
      }
      if (Array.isArray(f.catalog)) return f.catalog
    }
  } catch (error) { /* fall through */ }
  return []
}
function leafSnap(cfg, liveCatalog) {
  const active = typeof cfg.activeProfile === 'string' ? cfg.activeProfile : 'full'
  const profiles = cfg.profiles !== null && typeof cfg.profiles === 'object' ? cfg.profiles : {}
  const profile = profiles[active] || profiles.full || { off: [] }
  const off = Array.isArray(profile.off) ? profile.off.filter((x) => typeof x === 'string') : []
  const pendingSrc = Array.isArray(cfg.pending) ? cfg.pending : []
  return {
    enabled: cfg.enabled !== false,
    features: (Array.isArray(liveCatalog) && liveCatalog.length > 0 ? liveCatalog : CATALOG.map((id) => ({ id }))).map((row) => {
      const id = typeof row === 'string' ? row : String(row && row.id !== undefined ? row.id : '')
      const label = row !== null && typeof row === 'object' && typeof row.label === 'string' ? row.label : ''
      // 注意：handler 返回值必须是无损 JSON —— 不能带 undefined 键（会报 "must be lossless JSON data"）。
      return label === '' ? { id } : { id, label }
    }),
    profile: { off: off.slice() },
    pending: pendingSrc.filter((p) => p !== null && typeof p === 'object').map((p) => ({
      id: String(p.id || ''),
      feature: String(p.feature || ''),
      status: String(p.status || ''),
    })),
  }
}

async function readCfg(ctx) {
  const fs = ctx.get('fs')
  if (fs === undefined) throw new Error('无法读取功能开关')
  const target = await fs.resolve(FEATURES_PATH)
  const text = await fs.readText(target)
  const cfg = JSON.parse(text)
  if (cfg === null || typeof cfg !== 'object') throw new Error('功能开关损坏')
  return { cfg, target, fs }
}

return {
  apply(ctx) {
    const guard = (fn) => async (args) => {
      try { return await fn(args !== null && typeof args === 'object' ? args : {}) }
      catch (error) { return { ok: false, error: errText(error) } }
    }

    harness.handle('featsw/state', guard(async () => {
      const { cfg } = await readCfg(ctx)
      return { ok: true, ...leafSnap(cfg, await liveCatalogOf(ctx)) }
    }))

    harness.handle('featsw/save', guard(async (args) => {
      const enabled = args.enabled !== false
      const off = Array.isArray(args.off) ? args.off.filter((id) => typeof id === 'string') : []
      const { cfg, target, fs } = await readCfg(ctx)
      cfg.enabled = enabled
      const active = typeof cfg.activeProfile === 'string' ? cfg.activeProfile : 'full'
      if (cfg.profiles === null || typeof cfg.profiles !== 'object') cfg.profiles = {}
      if (cfg.profiles[active] === undefined) cfg.profiles[active] = { surface: ['*'], gate: ['*'], off: [] }
      cfg.profiles[active].off = off.slice()
      await fs.writeText(target, JSON.stringify(cfg, null, 2) + '\n', undefined, undefined, {
        mode: 'danger-full-access',
        workspaceRoot: '/home/alex/.dsh',
      })
      const verify = JSON.parse(await fs.readText(target))
      const snap = leafSnap(verify, await liveCatalogOf(ctx))
      if (snap.enabled !== enabled) throw new Error('总闸未写入')
      const got = (snap.profile.off || []).slice().sort().join('|')
      const want = off.slice().sort().join('|')
      if (got !== want) throw new Error('未写入: ' + want + ' / 实际: ' + got)
      return { ok: true, ...snap }
    }))

    harness.handle('featsw/decide', guard(async (args) => {
      const { cfg, target, fs } = await readCfg(ctx)
      const pending = Array.isArray(cfg.pending) ? cfg.pending : []
      const item = pending.find((p) => p !== null && typeof p === 'object' && String(p.id || '') === String(args.id ?? ''))
      if (item === undefined) throw new Error('没有待批')
      item.status = args.allow === true ? 'allowed' : 'denied'
      if (args.allow === true) {
        const active = typeof cfg.activeProfile === 'string' ? cfg.activeProfile : 'full'
        const profile = cfg.profiles[active] || cfg.profiles.full
        if (!Array.isArray(profile.off)) profile.off = []
        if (item.action === 'open') profile.off = profile.off.filter((f) => f !== item.feature)
        if (item.action === 'close' && !profile.off.includes(item.feature)) profile.off.push(item.feature)
      }
      await fs.writeText(target, JSON.stringify(cfg, null, 2) + '\n', undefined, undefined, {
        mode: 'danger-full-access',
        workspaceRoot: '/home/alex/.dsh',
      })
      return { ok: true, ...leafSnap(cfg, await liveCatalogOf(ctx)) }
    }))
  },
}

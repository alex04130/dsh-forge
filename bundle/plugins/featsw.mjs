// featsw v1 核心（2026-09-01）：功能开关系统——FR-1/2/6/11/12（gate 拦截 + features.json + 原子写 + fs.watch 热载 + 零配置兼容）。
// FR-7/8/10（UI/模型接口/审计）后置；FR-5（作用域继承）v1 简化为 global。
// 双层：surface（schema 可见性，v1 仅门禁 API 查询——schema 管道接入后置）+ gate（执行拦截，v1 落）。
// 设计：开关做在调用面上（C1）——gate 检查点由各调用方（forge-tools 等）问 isGateOpen；服务本身不 disabled。
import { readFile, writeFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

const HOME = process.env.DSH_HOME || homedir() + '/.dsh'
const FEATURES_PATH = join(HOME, 'features.json')

let state = null // 当前生效配置（null = 未加载 → 全开，零配置兼容）
let listeners = new Set()
let watcher = null

function defaults() {
  return { version: 1, activeProfile: 'full', profiles: { full: { surface: ['*'], gate: ['*'] } }, overrides: {} }
}

function normalized() {
  // features.json 不存在 / 解析失败 → 全开（零配置兼容 + last-known-good fail-safe）
  if (state === null) return defaults()
  return state
}

export function isGateOpen(feature) {
  const cfg = normalized()
  const profile = cfg.profiles[cfg.activeProfile] ?? cfg.profiles['full'] ?? defaults().profiles['full']
  const gate = Array.isArray(profile.gate) ? profile.gate : ['*']
  if (gate.includes('*')) return true
  if (gate.includes(feature)) return true
  // plugin.* 通配：feature 形如 <plugin>.<capability>，gate 里 <plugin>.* 覆盖
  const dot = feature.indexOf('.')
  if (dot > 0 && gate.includes(feature.slice(0, dot + 1) + '*')) return true
  return false
}

export function isSurfaceOpen(feature) {
  const cfg = normalized()
  const profile = cfg.profiles[cfg.activeProfile] ?? cfg.profiles['full'] ?? defaults().profiles['full']
  const surface = Array.isArray(profile.surface) ? profile.surface : ['*']
  if (surface.includes('*')) return true
  if (surface.includes(feature)) return true
  const dot = feature.indexOf('.')
  if (dot > 0 && surface.includes(feature.slice(0, dot + 1) + '*')) return true
  return false
}

export function listState() {
  const cfg = normalized()
  return {
    activeProfile: cfg.activeProfile ?? 'full',
    profiles: Object.keys(cfg.profiles ?? {}),
    gateOpen: Object.keys(cfg.profiles ?? {}).reduce((acc, name) => { acc[name] = isGateOpen(name + '.*'); return acc }, {}),
  }
}

function notify() {
  for (const fn of [...listeners]) { try { fn() } catch (e) { /* noop */ } }
}

export function onChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

async function load() {
  try {
    const raw = await readFile(FEATURES_PATH, 'utf8')
    const data = JSON.parse(raw)
    if (data === null || typeof data !== 'object' || typeof data.version !== 'number') throw new Error('bad shape')
    state = data
  } catch (error) {
    // 文件不存在 = 零配置；解析失败 = last-known-good（保留现 state，不回退）
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') state = defaults()
    // 其他错误：若从未 load 过则全开，否则保留旧 state
    if (state === null) state = defaults()
  }
  notify()
}

export default {
  apply(ctx) {
    // 启动即读（FR-11：首轮前 ready）
    load().then(() => {})
    // fs.watch 热载（FR-2：外部编辑 500ms 生效；chokidar 依赖可选——用原生 fs.watch 免依赖）
    const fs = ctx.get('fs')
    if (fs !== undefined && typeof fs.watch === 'function') {
      try {
        watcher = fs.watch(dirname(FEATURES_PATH), () => { load().catch(() => {}) })
      } catch (e) { /* watch 失败不致命 */ }
    } else {
      // 原生 fs.watch（Node 内置）
      import('node:fs').then((m) => {
        try {
          watcher = m.watch(dirname(FEATURES_PATH), () => { load().catch(() => {}) })
        } catch (e) { /* best-effort */ }
      }).catch(() => {})
    }
    ctx.effect(() => () => { try { if (watcher !== null) watcher.close() } catch (e) { /* noop */ } })
    ctx.provide('featsw', {
      isGateOpen,
      isSurfaceOpen,
      listState,
      onChange,
      setGate: async (feature, open) => {
        // FR-2 原子写：读 features.json → 改 activeProfile 的 gate 数组 → tmp+rename
        const cfg = normalized()
        const profile = cfg.profiles[cfg.activeProfile] ?? cfg.profiles['full']
        const arr = profile.gate ?? []
        const next = open ? [...new Set([...arr, feature])] : arr.filter((f) => f !== feature)
        profile.gate = next
        const tmp = FEATURES_PATH + '.tmp'
        await writeFile(tmp, JSON.stringify(cfg, null, 2), 'utf8')
        await rename(tmp, FEATURES_PATH)
        await load()
        return { ok: true, feature, open }
      },
    })
  },
}

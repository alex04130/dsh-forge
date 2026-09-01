#!/usr/bin/env node
// gen-compat-manifest: 从插件源码提取我们依赖的上游 Cordis 服务面（L1 服务 + L2 方法），
// 输出 docs/compat-manifest.json 供 check.mjs --compat 断言。
// 范围：bundle/plugins/*.mjs + lib/*.mjs + dynamic/dynplugins/*.js（仓库镜像=运行时权威）。
// 手工基线：自编辑 P2-1 初始清单中未入仓库的（如 web.searchProviders 来自运行时注入器 dev-plugins）。
// 运行：node scripts/gen-compat-manifest.mjs [--out <path>]
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const outIdx = process.argv.indexOf('--out')
const OUT = outIdx !== -1 && typeof process.argv[outIdx + 1] === 'string'
  ? process.argv[outIdx + 1]
  : join(ROOT, 'docs/compat-manifest.json')

// 我们插件 inject/调用过的上游服务 id（白名单，防止把对象方法误当服务）
const SVC = new Set([
  'sessionPersistence', 'sessionmgmt', 'sessions', 'agents', 'subagents',
  'llm', 'tools', 'web', 'sessionQuery', 'loader', 'skills', 'systemPrompt',
  'attachments', 'storage', 'dynamicCordisRunner', 'webServer',
])

// 手工基线（自编辑 P2-1 初始清单补充；来源不在仓库镜像内，升级后按冒烟清单人工核）
const MANUAL = [
  { id: 'web', methods: ['searchProviders', 'searchProviderId'], sources: ['runtime injector: web-search-kimi-live / web-search-provider-selector（dev-plugins，未入仓库）'], note: '初始清单手工基线（P2-1）' },
  { id: 'sessionmgmt', methods: ['deleteSessions', 'masterIdFromSessionId'], sources: ['dynamic/dynplugins/sesmgr.host.js（注入服务经 svc. 别名调用，静态提取无法归名）', 'bundle/plugins/mailbridge.mjs（deleteSessions 守卫语义）'], note: '初始清单手工基线（P2-1）' },
]

async function files(dir, suffix) {
  try {
    const names = await readdir(dir)
    return names.filter((n) => n.endsWith(suffix)).map((n) => join(dir, n))
  } catch { return [] }
}

const scan = []
for (const dir of ['bundle/plugins', 'bundle/plugins/lib']) {
  for (const f of await files(join(ROOT, dir), '.mjs')) scan.push([f, await readFile(f, 'utf8')])
}
for (const f of await files(join(ROOT, 'dynamic/dynplugins'), '.js')) scan.push([f, await readFile(f, 'utf8')])

const bySvc = new Map() // id -> {methods:Set, sources:Set}
function touch(id, method, source) {
  if (!SVC.has(id)) return
  let e = bySvc.get(id)
  if (!e) { e = { methods: new Set(), sources: new Set() }; bySvc.set(id, e) }
  if (method) e.methods.add(method)
  if (source) e.sources.add(source)
}

for (const [file, code] of scan) {
  const rel = file.slice(ROOT.length + 1)
  // inject: ['a', 'b'] 数组形态（对象形态是配置，不算服务面）
  for (const m of code.matchAll(/inject\s*:\s*\[([^\]]*)\]/g)) {
    for (const s of m[1].matchAll(/'([\w-]+)'/g)) touch(s[1], '', rel)
  }
  // 调用形态：ctx.<svc>.<method>( 或 svc.<method>( 或 svc?.<method>（含防御式 typeof 用法）；
  // 前视 (?<![\\w]) 防止 subagents.* 误粘为 agents.*
  for (const id of SVC) {
    for (const m of code.matchAll(new RegExp(`(?<![\\w])${id}\\s*\\.\\s*([\\w$]+)\\s*\\(`, 'g'))) {
      touch(id, m[1], rel)
    }
  }
  // 只读到服务名（typeof x === 'function' 守卫）：无方法调用，记为面
  for (const m of code.matchAll(new RegExp(`\\b(${[...SVC].join('|')})\\b`, 'g'))) {
    touch(m[1], '', rel)
  }
}

const services = [...bySvc.entries()]
  .map(([id, e]) => ({ id, methods: [...e.methods].sort(), sources: [...e.sources].sort() }))
  .sort((a, b) => (SVC.has(a.id) === SVC.has(b.id) ? a.id.localeCompare(b.id) : 0))

const manifest = {
  $schema: './compat-manifest.schema.md',
  version: 1,
  updated: '2026-09-01',
  generatedBy: 'scripts/gen-compat-manifest.mjs',
  services,
  manual: MANUAL,
}

const json = JSON.stringify(manifest, null, 2) + '\n'
await writeFile(OUT, json, 'utf8')
const nMethods = services.reduce((s, x) => s + x.methods.length, 0) + MANUAL.reduce((s, x) => s + x.methods.length, 0)
console.log(`[gen-compat] ${services.length} 服务 / ${nMethods} 方法（含手工 ${MANUAL.reduce((s, x) => s + x.methods.length, 0)}）→ ${OUT}`)
for (const s of services) console.log(`  ${s.id}: ${s.methods.join(' / ') || '(面仅)'} [${s.sources.length} 源]`)

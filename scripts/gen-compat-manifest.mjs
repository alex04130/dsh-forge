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

// 上游 DSH 服务 id 白名单（防止把对象方法误当服务）。
// 2026-10-02 重建：基线换成部署代码后，按源码实际 inject / ctx.get / ctx.<name> 提取结果校准。
// 刻意**排除**的几类：
//   - forge 自建服务（我们自己的插件 provide 的，不是上游面，不该对着 DSH 断言）→ 见 INTERNAL
//   - Cordis 框架面而非 DSH 服务：loader / logger / effect / on / provide / get
//   - ctx 上的 timer 混入：timeout / setInterval / setInterval
const SVC = new Set([
  // host 平面
  'agents', 'agentPresets', 'agentDefaultModel', 'approval', 'attachments', 'authorization',
  'credentials', 'cordisInspect', 'dynamicCordisRunner', 'fs', 'llm', 'sandboxPolicy',
  'sessionController', 'sessionPersistence', 'sessionQuery', 'sessions', 'settings', 'shell',
  'skills', 'storage', 'subagents', 'systemPrompt', 'timer', 'tools', 'web', 'webServer',
  'workspaceRegistry',
  // client 平面
  'locale', 'slots', 'workspaces',
])

// forge 自建服务：只做"提供方是否还在"的自检，不对上游断言。
// 2026-10-02：`forgeShell` 移出 —— 它的提供方是动态客户端半部 forge-ui.client.js，
// 该文件在 UI 大改中整批删除（面板全部下线，UI 迁到静态包 @local/dsh-forge-ui）。
// 留着它会让 L0「自建服务有提供方」永远红着，而红的原因恰恰是正确的。
const INTERNAL = ['sessionmgmt', 'skillRegistry', 'featsw', 'teamDeleteApi']

// 手工基线（来源不在扫描范围内、静态提取抓不到的；升级后按冒烟清单人工核）。
// 2026-10-02 清空：旧条目 web.searchProviderId 在 0.2.0-rc.2 已不存在（ctx.web 只剩
// registerSearchProvider / registerFetchProvider / search / fetch，提供方由 searchProvider
// 配置解析），来源 dev-plugins 也从未入仓。
const MANUAL = []

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

// 正则产物的已知噪声：按服务分别剔除同名但不同物的方法（每条注理由）。
// 这是本清单可信度的已知上限——它是 canary，不是 API 契约证明。
const NOISE = {
  // Node 的 node:fs（forge-ui.host 的 require("fs") 字符串、各处 readFileSync…），
  // DSH 的 fs 服务没有 Sync 家族。
  fs: ['cpSync', 'mkdirSync', 'readFileSync', 'readdirSync', 'renameSync', 'rmSync', 'statSync', 'symlinkSync', 'writeFileSync', 'appendFileSync', 'existsSync'],
  // `skills` 在代码里常是个数组/Map 变量。
  skills: ['filter', 'find', 'map', 'push', 'some', 'forEach', 'reduce', 'slice', 'includes', 'join'],
  // `tools` 常是 Map/Object。
  tools: ['entries', 'keys', 'values', 'has', 'size'],
  // `shell` 这个局部名常绑定为 ctx.get('forgeShell') —— 那是自建服务，不是 DSH 的 shell。
  shell: ['registerFeature'],
  // `sessions` 的 client 面（uiWorkspace/workspaces 服务）与 host 面同名方法易混；
  // 保守保留，仅剔除明显是 Array/Map 的。
  sessions: ['map', 'filter', 'find', 'push'],
}

const services = [...bySvc.entries()]
  .map(([id, e]) => {
    const noise = NOISE[id] || []
    return {
      id,
      methods: [...e.methods].filter((m) => !noise.includes(m)).sort(),
      dropped: [...e.methods].filter((m) => noise.includes(m)).sort(),
      sources: [...e.sources].sort(),
    }
  })
  .sort((a, b) => (SVC.has(a.id) === SVC.has(b.id) ? a.id.localeCompare(b.id) : 0))

const manifest = {
  $schema: './compat-manifest.schema.md',
  version: 1,
  updated: '2026-10-02',
  dshBaseline: '0.2.0-rc.2',
  generatedBy: 'scripts/gen-compat-manifest.mjs',
  services,
  internal: INTERNAL,
  manual: MANUAL,
}

const json = JSON.stringify(manifest, null, 2) + '\n'
await writeFile(OUT, json, 'utf8')
const nMethods = services.reduce((s, x) => s + x.methods.length, 0) + MANUAL.reduce((s, x) => s + x.methods.length, 0)
console.log(`[gen-compat] ${services.length} 服务 / ${nMethods} 方法（含手工 ${MANUAL.reduce((s, x) => s + x.methods.length, 0)}）→ ${OUT}`)
for (const s of services) console.log(`  ${s.id}: ${s.methods.join(' / ') || '(面仅)'} [${s.sources.length} 源]`)

#!/usr/bin/env node
// dsh-forge checker: syntax-check every host/client artifact in the repo.
// Run: node scripts/check.mjs
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { execFileSync, spawnSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0

function checkScript(filename, code) {
  try {
    new vm.Script(code, { filename })
    console.log('  ✓ ' + filename)
  } catch (e) {
    failed += 1
    console.log('  ✗ ' + filename + ': ' + e.message)
  }
}

function checkFile(path) {
  try {
    execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' })
    console.log('  ✓ ' + path)
  } catch (e) {
    failed += 1
    console.log('  ✗ ' + path + ': ' + String(e.stderr || e.message).split('\n')[0])
  }
}

console.log('[check] host 插件 (bundle/plugins)')
for (const name of await readdir(join(ROOT, 'bundle/plugins'))) {
  if (name.endsWith('.mjs')) checkFile(join(ROOT, 'bundle/plugins', name))
}
try {
  for (const name of await readdir(join(ROOT, 'bundle/plugins/lib'))) {
    if (name.endsWith('.mjs')) checkFile(join(ROOT, 'bundle/plugins/lib', name))
  }
} catch { /* no lib dir */ }

console.log('[check] preset (presets/router-standard)')
for (const name of await readdir(join(ROOT, 'presets/router-standard'))) {
  if (name.endsWith('.mjs')) checkFile(join(ROOT, 'presets/router-standard', name))
}

console.log('[check] 客户端包 (bundle/packages)')
for (const pkg of ['dsh-plugmgr', 'dsh-dynrestore']) {
  for (const file of ['lib/index.js', 'lib/client.js']) {
    const path = join(ROOT, 'bundle/packages', pkg, file)
    try {
      await readFile(path)
      checkFile(path)
    } catch { /* optional file */ }
  }
}

console.log('[check] 动态插件内联代码 (dynamic/auto-plugins.json)')
const dynamic = JSON.parse(await readFile(join(ROOT, 'dynamic/auto-plugins.json'), 'utf8'))
for (const plugin of dynamic.plugins || []) {
  for (const half of ['hostCode', 'clientCode']) {
    const code = plugin[half]
    if (typeof code !== 'string') continue
    checkScript(plugin.idPrefix + '.' + half, '(async () => {\n' + code + '\n})()')
  }
}

// —— 同步清单编号连续性 ——
// 台账即 git 历史：relay 落地每个同步项时在 commit message 标注 #N（或 #a-#b 范围）。
// 规则：#77 起强制连续（豁免 64-69/72 等历史缺口，见 0b4154f 范围补记与重启批次直落项；#78 grok README 历史 commit 未带号，存在性以 commit body/台账为准）。
// 提取时排除 6 位 hex 色值（如 #3b82f6/#2563eb），并对 >500 的大数免疫（GitHub issue 引用）。
console.log('[check] 同步清单编号连续性 (git log)')
{
  const ENFORCE_FROM = 77
  // 历史缺号豁免（仅 ENFORCE_FROM 下调时生效：64-69/72 在 #77 基线以下不参与，见 0b4154f 与重启批次直落项）：
  // #78 已由勘误 commit 标号（docs 编号勘误，db0892d），不再需豁免。
  const EXEMPT = new Set([64, 65, 66, 67, 68, 69, 72])
  const subjects = execFileSync('git', ['-C', ROOT, 'log', '--all', '--pretty=%s'], { encoding: 'utf8' }).split('\n')
  const nums = new Set()
  for (const s of subjects) {
    const cleaned = s.replace(/#[0-9a-fA-F]{6}\b/g, '')
    for (const m of cleaned.matchAll(/#(\d+)-#(\d+)\b/g)) {
      const a = Number(m[1]), b = Number(m[2])
      if (b > a && b - a < 200) for (let i = a; i <= b; i++) nums.add(i)
    }
    for (const m of cleaned.matchAll(/#(\d+)\b/g)) {
      const n = Number(m[1])
      if (n >= 1 && n <= 500) nums.add(n)
    }
  }
  const present = [...nums].filter((n) => n >= ENFORCE_FROM).sort((a, b) => a - b)
  if (present.length === 0) {
    console.log('  · 尚无 ≥#' + ENFORCE_FROM + ' 的同步号（基线前状态，跳过）')
  } else {
    const max = present[present.length - 1]
    const missing = []
    for (let n = ENFORCE_FROM; n <= max; n++) if (!nums.has(n) && !EXEMPT.has(n)) missing.push('#' + n)
    if (missing.length === 0) console.log('  ✓ #' + ENFORCE_FROM + '–#' + max + ' 连续无缺口')
    else {
      failed += 1
      console.log('  ✗ 同步号缺口: ' + missing.join(' ') + '（≥#' + ENFORCE_FROM + ' 强制连续——commit message 缺号或同步项漏落地）')
    }
  }
}

// —— 仓库 ↔ 运行时 auto-plugins 一致性（提示，不阻断）——
// 漂移=运行时已改而仓库未落（重启批次直落项常见）。提示用于提醒补同步清单，不作失败。
console.log('[check] 仓库 ↔ 运行时 auto-plugins 一致性（提示）')
{
  const rtPath = '/home/alex/.dsh/auto-plugins.json'
  try {
    const repoRaw = await readFile(join(ROOT, 'dynamic/auto-plugins.json'), 'utf8')
    const rtRaw = await readFile(rtPath, 'utf8')
    if (repoRaw === rtRaw) console.log('  ✓ 仓库与运行时 auto-plugins.json 逐字节一致')
    else {
      const count = (raw) => { try { const d = JSON.parse(raw); const arr = d.plugins ?? (Array.isArray(d) ? d : []); return String(arr.length) } catch { return '?' } }
      console.log('  ⚠ 两份 auto-plugins.json 有 diff（仓库 ' + count(repoRaw) + ' 行 vs 运行时 ' + count(rtRaw) + ' 行）——若有未落地同步项请补清单；纯实验差异可忽略')
    }
  } catch {
    console.log('  · 运行时 auto-plugins.json 不在本机（CI/他机环境），跳过')
  }
}


// —— COMPAT 断言（仅在 --compat 时运行）——
// 升级（如 rc.2 → alpha.3）前后跑：node scripts/check.mjs --compat
// 断言我们插件依赖的上游 API 面（L1 服务在册 / L2 方法签名），
// L1/L2 为静态源码级断言；运行时真值尝试 dsh --dump-config（不可用时 SKIP 不阻断）。
// L3 行为语义走探针（tmp-verify 系列），本段只输出冒烟清单。
if (process.argv.includes('--compat')) {
  console.log('[check] COMPAT 断言 (--compat)')
  const manifestPath = join(ROOT, 'docs/compat-manifest.json')
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (e) {
    failed += 1
    console.log('  ✗ compat-manifest.json 读取失败: ' + manifestPath + '（先跑 node scripts/gen-compat-manifest.mjs）')
    manifest = null
  }
  if (manifest) {
    // 扫当前源码（与生成器同范围）：manifest 条目若在源码里找不到调用/声明 → 提示
    const scanFiles = []
    for (const dir of ['bundle/plugins', 'bundle/plugins/lib']) {
      try { for (const n of await readdir(join(ROOT, dir))) if (n.endsWith('.mjs')) scanFiles.push(join(ROOT, dir, n)) } catch { }
    }
    try { for (const n of await readdir(join(ROOT, 'dynamic/dynplugins'))) if (n.endsWith('.js')) scanFiles.push(join(ROOT, 'dynamic/dynplugins', n)) } catch { }
    const codes = new Map()
    for (const f of scanFiles) codes.set(f.slice(ROOT.length + 1), await readFile(f, 'utf8'))
    const all = [...codes.values()].join('\n')

    for (const svc of manifest.services || []) {
      // L1：服务名在源码中被提及（inject 声明或调用）
      const l1 = new RegExp('\\b' + svc.id + '\\b').test(all)
      console.log((l1 ? '  ✓ ' : '  ✗ ') + 'L1 服务在册: ' + svc.id + (l1 ? '' : '（源码中已无引用——上游可能移除或清单过期）'))
      if (!l1) failed += 1
      // L2：方法作为 <svc>.<method>( 被调用（防御式写法含 typeof 守卫亦如此）
      for (const m of svc.methods || []) {
        const re = new RegExp('\\b' + svc.id + '\\s*\\.\\s*' + m + '\\s*\\(')
        const hit = re.test(all)
        console.log((hit ? '  ✓ ' : '  ⚠ ') + 'L2 方法签名: ' + svc.id + '.' + m + (hit ? '' : '（源码未见调用——签名或依赖面已消失，升级前人工核）'))
      }
    }
    for (const m of manifest.manual || []) {
      console.log('  · 手工基线: ' + m.id + '.' + (m.methods || []).join(' .') + '【' + (m.note || '') + '】→ 人工核 [' + (m.sources || []).join('; ') + ']')
    }

    // 运行时探测：dsh --profile web --dump-config（只读组合树；本沙箱/他机可能不可用，SKIP 不阻断）
    try {
      const out = spawnSync('dsh', ['--profile', process.env.DSH_PROFILE || 'web', '--dump-config'], { encoding: 'utf8', timeout: 20000 })
      if (out.status === 0 && out.stdout.length > 0) {
        const head = out.stdout.slice(0, 400).replace(/\s+/g, ' ')
        console.log('  · 运行时 dump-config 可取（' + out.stdout.length + ' 字节），L1 真值可按组合树人工对（原文首段: ' + head + '…）')
      } else {
        console.log('  · 跳过运行时探测：dsh --dump-config 不可用（' + String((out.stderr || 'exit ' + out.status).split('\n')[0]).slice(0, 160) + '）——静态断言 + L3 冒烟为准')
      }
    } catch (e) {
      console.log('  · 跳过运行时探测：' + String(e.message).slice(0, 160))
    }

    console.log('  · L3 冒烟清单（升级后人工核，见 docs/COMPAT.md）：')
    for (const item of ['sessionPersistence.inspect（离线会话读 meta/events）', 'sessionmgmt.deleteSessions（删除守卫 masterIdFromSessionId）', 'llm.listProviders/listModels（模型目录）', 'agents.get（在线会话归属）', 'tools entries（工具表）', '12 动态插件 dynboot 恢复']) {
      console.log('    - ' + item)
    }
  }
}

console.log(failed === 0 ? '[check] 全部通过' : '[check] 失败 ' + failed + ' 项')
process.exit(failed === 0 ? 0 : 1)

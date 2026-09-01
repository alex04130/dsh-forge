#!/usr/bin/env node
// dsh-forge checker: syntax-check every host/client artifact in the repo.
// Run: node scripts/check.mjs
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { execFileSync } from 'node:child_process'

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
// 规则：#77 起强制连续（豁免 64-69/72 等历史缺口，见 0b4154f 范围补记与重启批次直落项）。
// 提取时排除 6 位 hex 色值（如 #3b82f6/#2563eb），并对 >500 的大数免疫（GitHub issue 引用）。
console.log('[check] 同步清单编号连续性 (git log)')
{
  const ENFORCE_FROM = 77
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
    for (let n = ENFORCE_FROM; n <= max; n++) if (!nums.has(n)) missing.push('#' + n)
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


console.log(failed === 0 ? '[check] 全部通过' : '[check] 失败 ' + failed + ' 项')
process.exit(failed === 0 ? 0 : 1)

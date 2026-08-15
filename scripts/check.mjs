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

console.log(failed === 0 ? '[check] 全部通过' : '[check] 失败 ' + failed + ' 项')
process.exit(failed === 0 ? 0 : 1)

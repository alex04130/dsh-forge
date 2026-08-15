#!/usr/bin/env node
// dsh-suite installer: copy the suite into $DSH_HOME (default ~/.dsh) with
// backups and idempotent merges. Run: node scripts/install.mjs
import { mkdir, copyFile, readFile, writeFile, rename, symlink, rm, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh')
const PROFILE = 'web'
const MARK_START = '# dsh-suite:start'
const MARK_END = '# dsh-suite:end'

const log = (m) => console.log('  ' + m)
const step = (m) => console.log('[dsh-suite] ' + m)

async function backup(file) {
  try {
    await access(file, constants.F_OK)
  } catch {
    return
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = file + '.bak-' + stamp
  await copyFile(file, target)
  log('backup: ' + file + ' -> ' + target)
}

async function copyTree(src, dst) {
  await mkdir(dst, { recursive: true })
  await copyFile(src, join(dst, src.split('/').pop()))
}

async function installPlugins() {
  step('1/5 host 插件 → ' + DSH_HOME + '/profiles/' + PROFILE + '/plugins/')
  const srcDir = join(ROOT, 'bundle/plugins')
  const dstDir = join(DSH_HOME, 'profiles', PROFILE, 'plugins')
  await mkdir(dstDir, { recursive: true })
  const { readdir } = await import('node:fs/promises')
  for (const name of await readdir(srcDir)) {
    if (!name.endsWith('.mjs')) continue
    const dst = join(dstDir, name)
    await backup(dst)
    await copyFile(join(srcDir, name), dst)
    log(name)
  }
}

async function installPackages() {
  step('2/5 @local 客户端包 → profiles/' + PROFILE + '/packages/ + node_modules/@local/')
  const dstPackages = join(DSH_HOME, 'profiles', PROFILE, 'packages')
  await mkdir(dstPackages, { recursive: true })
  for (const pkgName of ['dsh-plugmgr', 'dsh-dynrestore']) {
    const srcPkg = join(ROOT, 'bundle/packages', pkgName)
    const dstPkg = join(dstPackages, pkgName)
    const pkgJson = JSON.parse(await readFile(join(srcPkg, 'package.json'), 'utf8'))
    const fullName = pkgJson.name || '@local/' + pkgName
    for (const file of ['package.json', 'lib/index.js', 'lib/client.js']) {
      const src = join(srcPkg, file)
      const dst = join(dstPkg, file)
      try {
        await access(src, constants.F_OK)
      } catch {
        continue
      }
      await mkdir(dirname(dst), { recursive: true })
      await backup(dst)
      await copyFile(src, dst)
    }
    // @local symlink (same resolution path pnpm uses for workspace packages)
    const scope = fullName.startsWith('@') ? fullName.split('/')[0] : '@local'
    const linkDir = join(DSH_HOME, 'profiles', 'node_modules', scope)
    await mkdir(linkDir, { recursive: true })
    const link = join(linkDir, fullName.split('/').pop())
    try {
      await rm(link, { recursive: true, force: true })
    } catch { /* absent */ }
    try {
      await symlink(resolve(dstPkg), link, process.platform === 'win32' ? 'junction' : 'dir')
      log(fullName + ' -> ' + dstPkg)
    } catch (e) {
      log(fullName + ' symlink failed (non-fatal): ' + e.message)
    }
  }
}

async function mergePatch() {
  step('3/5 cordis.patch.yml 合并（标记包裹，幂等）')
  const patchPath = join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml')
  const srcPatch = await readFile(join(ROOT, 'bundle/cordis.patch.yml'), 'utf8')
  const srcInsert = srcPatch.split('\n').filter((l) => !l.startsWith('#')).join('\n').trim()
  let existing = ''
  try {
    existing = await readFile(patchPath, 'utf8')
  } catch { /* fresh profile */ }

  const startIdx = existing.indexOf(MARK_START)
  if (startIdx !== -1) {
    const endIdx = existing.indexOf(MARK_END)
    existing = (existing.slice(0, startIdx) + existing.slice(endIdx === -1 ? existing.length : endIdx + MARK_END.length)).trimEnd()
  }
  await backup(patchPath)
  const block = '\n' + MARK_START + '\n' + srcInsert + '\n' + MARK_END + '\n'
  const merged = existing.trimEnd() + block
  await mkdir(dirname(patchPath), { recursive: true })
  await writeFile(patchPath, merged, 'utf8')
  log(patchPath)
}

async function mergeDynamic() {
  step('4/5 auto-plugins.json 合并（按 idPrefix 去重）')
  const src = JSON.parse(await readFile(join(ROOT, 'dynamic/auto-plugins.json'), 'utf8'))
  const dstPath = join(DSH_HOME, 'auto-plugins.json')
  let data = { version: 1, plugins: [] }
  try {
    data = JSON.parse(await readFile(dstPath, 'utf8'))
  } catch { /* fresh */ }
  await backup(dstPath)
  const have = new Set((data.plugins || []).map((p) => p.idPrefix))
  for (const plugin of src.plugins || []) {
    if (have.has(plugin.idPrefix)) continue
    data.plugins.push(plugin)
    have.add(plugin.idPrefix)
    log(plugin.idPrefix + (plugin.disabled === true ? ' (disabled)' : ''))
  }
  await writeFile(dstPath, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

async function installPreset() {
  step('5/5 router-standard 预设 → ' + DSH_HOME + '/.agent-presets/router-standard/')
  const srcDir = join(ROOT, 'presets/router-standard')
  const dstDir = join(DSH_HOME, '.agent-presets', 'router-standard')
  await mkdir(dstDir, { recursive: true })
  const { readdir } = await import('node:fs/promises')
  for (const name of await readdir(srcDir)) {
    const dst = join(dstDir, name)
    await backup(dst)
    await copyFile(join(srcDir, name), dst)
    log(name)
  }
}

try {
  await installPlugins()
  await installPackages()
  await mergePatch()
  await mergeDynamic()
  await installPreset()
  step('完成。重启 DSH（dsh web）后生效；preset 需在会话里选择 router-standard。')
} catch (e) {
  console.error('[dsh-suite] 安装失败:', e && e.message ? e.message : e)
  process.exit(1)
}

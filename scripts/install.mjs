#!/usr/bin/env node
// dsh-forge installer: copy the suite into $DSH_HOME (default ~/.dsh) with
// backups and idempotent merges. Run: node scripts/install.mjs
import { mkdir, copyFile, readFile, writeFile, rename, symlink, rm, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
// Honor the desktop/web profile the caller actually runs; the historical
// default stays 'web' so existing installs keep merging into the same place.
const PROFILE = process.env.DSH_PROFILE || 'web'
// Marker values keep the old "dsh-suite" spelling on purpose: profiles
// installed before the rename already contain blocks wrapped by these
// markers; changing them would break the idempotent merge.
const MARK_START = '# dsh-suite:start'
const MARK_END = '# dsh-suite:end'

const log = (m) => console.log('  ' + m)
const step = (m) => console.log('[dsh-forge] ' + m)

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
    // Top-level .mjs are host plugins; a stray .js would be a loose helper.
    // Directories are skipped here and handled below (lib/ is recursive).
    if (!name.endsWith('.mjs') && !name.endsWith('.js')) continue
    const dst = join(dstDir, name)
    await backup(dst)
    await copyFile(join(srcDir, name), dst)
    log(name)
  }
  // lib/ holds the modules every host plugin imports (./lib/forge-common.mjs,
  // ./lib/forge-tools.mjs, ./lib/subagent-policy.mjs, …). The extension-filtered
  // loop above skips DIRECTORIES, so the old installer never copied it and every
  // plugin failed to import at boot with "failed to import".
  const srcLib = join(srcDir, 'lib')
  for (const rel of await listFiles(srcLib)) {
    const dst = join(dstDir, 'lib', rel)
    await mkdir(dirname(dst), { recursive: true })
    await backup(dst)
    await copyFile(join(srcLib, rel), dst)
    log('lib/' + rel)
  }
}

async function installPackages() {
  step('2/5 @local 客户端包 → profiles/' + PROFILE + '/packages/ + node_modules/@local/')
  const dstPackages = join(DSH_HOME, 'profiles', PROFILE, 'packages')
  await mkdir(dstPackages, { recursive: true })
  // 扫描发现，不写死清单 —— 新增一个 @local 包不该还要改这里。
  // 「写死清单静默漏掉新东西」这个坑，本安装器已经在 lib/ 与 dynamic/dynplugins/ 上各踩过一次。
  const { readdir } = await import('node:fs/promises')
  const srcRoot = join(ROOT, 'bundle/packages')
  for (const entry of await readdir(srcRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const pkgName = entry.name
    const srcPkg = join(srcRoot, pkgName)
    const dstPkg = join(dstPackages, pkgName)
    const pkgJson = JSON.parse(await readFile(join(srcPkg, 'package.json'), 'utf8'))
    const fullName = pkgJson.name || '@local/' + pkgName
    // 整包递归复制：以前只拷 package.json / lib/index.js / lib/client.js，
    // 包里多出任何文件（样式、子模块、locale 表）都会被静默丢掉。
    for (const rel of await listFiles(srcPkg)) {
      const dst = join(dstPkg, rel)
      await mkdir(dirname(dst), { recursive: true })
      await backup(dst)
      await copyFile(join(srcPkg, rel), dst)
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

async function installDynplugins() {
  step('3/6 dynamic 插件 → ' + DSH_HOME + '/dynplugins/')
  // auto-plugins.json lists its code as paths relative to DSH_HOME
  // ("dynplugins/modpk.host.js"), so the files have to live there. The old
  // installer merged the manifest but never copied the code, leaving every
  // dynamic plugin unresolvable — no forge UI, no mode picker, no steer.
  const srcDir = join(ROOT, 'dynamic/dynplugins')
  const dstDir = join(DSH_HOME, 'dynplugins')
  await mkdir(dstDir, { recursive: true })
  for (const rel of await listFiles(srcDir)) {
    const dst = join(dstDir, rel)
    await mkdir(dirname(dst), { recursive: true })
    await backup(dst)
    await copyFile(join(srcDir, rel), dst)
    log(rel)
  }
}

async function mergePatch() {
  step('4/6 cordis.patch.yml 合并（标记包裹，幂等）')
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

// 安装器**曾经**写进这台机器的 idPrefix。只在没有 `_managed` 记账的旧安装上用到 ——
// 用来把「仓库早就不声明、但机器上还留着」的行捡出来淘汰掉。
// 新装一律靠 `_managed`，这个列表不用再维护。
const RETIRED_PREFIXES = ['forge']

async function mergeDynamic() {
  step('5/6 auto-plugins.json 合并（_managed 记账：新增 / 就地更新 / 淘汰）')
  const src = JSON.parse(await readFile(join(ROOT, 'dynamic/auto-plugins.json'), 'utf8'))
  const dstPath = join(DSH_HOME, 'auto-plugins.json')
  let data = { version: 1, plugins: [] }
  try {
    data = JSON.parse(await readFile(dstPath, 'utf8'))
  } catch { /* fresh */ }
  await backup(dstPath)

  // 只增不删的旧合并有个真坑（2026-10-02 撞上）：仓库里删掉一行之后，
  // 机器上那一行永远留着，于是旧 `forge` 行和新 `forgetools` 行会同时在场。
  // 同理，仓库里**改了**一个已存在 prefix 的内容也永远不落地。
  // 现在按 prefix 记账：仓库是权威 → 就地覆盖；我们管过而仓库不再声明的 → 淘汰；
  // 安装器不认识的行（用户自己塞的）→ 原样保留。
  const repoRows = Array.isArray(src.plugins) ? src.plugins : []
  const repoPrefixes = repoRows.map((p) => p.idPrefix)
  const previouslyManaged = Array.isArray(data._managed)
    ? data._managed
    : repoPrefixes.concat(RETIRED_PREFIXES)
  const plugins = Array.isArray(data.plugins) ? data.plugins : []

  const kept = []
  for (const row of plugins) {
    if (row === null || typeof row !== 'object') { kept.push(row); continue }
    const prefix = row.idPrefix
    if (previouslyManaged.includes(prefix) && !repoPrefixes.includes(prefix)) {
      log(prefix + ' → 淘汰（仓库已不再声明）')
      continue
    }
    const declared = repoRows.find((p) => p.idPrefix === prefix)
    if (declared === undefined) { kept.push(row); continue }
    kept.push(declared)
    log(prefix + (declared.disabled === true ? ' (disabled)' : '') + ' → 更新')
  }
  const present = new Set(kept.map((r) => (r !== null && typeof r === 'object' ? r.idPrefix : undefined)))
  for (const plugin of repoRows) {
    if (present.has(plugin.idPrefix)) continue
    kept.push(plugin)
    log(plugin.idPrefix + (plugin.disabled === true ? ' (disabled)' : '') + ' → 新增')
  }
  data.plugins = kept
  data._managed = repoPrefixes
  await writeFile(dstPath, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

async function listFiles(dir, prefix = '') {
  const { readdir } = await import('node:fs/promises')
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : prefix + '/' + entry.name
    if (entry.isDirectory()) out.push(...await listFiles(join(dir, entry.name), rel))
    else out.push(rel)
  }
  return out
}

async function ensureProfileManifest() {
  step('profile 根 manifest 保证 name + version')
  // 官方 plugin-package-inventory-deepseek 在每条 deepseek-official 请求前枚举活跃 Loader 条目：
  // 松散模块（plugins/*.mjs）向上找**最近的** package.json 时会命中 profile 根 manifest。
  // 官方要求每个条目声明**非空的 name 与 version**，缺 version 会让请求在 HTTP 之前就硬失败 ——
  // 表现为 REQUEST_EXTENSION，整条 deepseek 路由全灭（2026-10-02 在 desktop profile 上实测踩到）。
  // profile 根 manifest 由启动器生成，常常有 name 没有 version，所以这里补齐。
  const file = join(DSH_HOME, 'profiles', PROFILE, 'package.json')
  let manifest = {}
  try { manifest = JSON.parse(await readFile(file, 'utf8')) } catch { /* 新建 */ }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) manifest = {}
  let changed = false
  if (typeof manifest.name !== 'string' || manifest.name === '') {
    manifest.name = 'dsh-profile-' + PROFILE
    changed = true
  }
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    manifest.version = '0.0.0'
    changed = true
  }
  if (!changed) {
    log('已具备非空 name/version，无需改动')
    return
  }
  await backup(file)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  log('补齐后: name=' + manifest.name + ' version=' + manifest.version)
}

// agent preset 自 0.2.0-rc.2 起是**普通 declaration row**，由 bundle 的 patch 承载。
// 旧的 `$DSH_HOME/.agent-presets/<id>/`（preset.yml + agent.cordis.yml）**已经没有任何东西在读**
// ——官方 SKILL `editing-cordis-compositions` 逐字："Nothing reads that directory any more."
// 所以这里不再往那儿拷，改成两件事：① 由 `presets/*` 生成 bundle 的 patch；
// ② 检查这个 bundle 有没有装进当前 profile（装它要走官方 `plugin_manager install_bundle`，
//    官方明确说"do not reproduce those steps with shell commands"）。
async function syncPresetBundle() {
  step('6/7 agent presets → bundle/forge-presets/cordis.patch.yml（rc.2 declaration rows）')
  const { readdir, writeFile } = await import('node:fs/promises')
  const srcRoot = join(ROOT, 'presets')
  const bundleDir = join(ROOT, 'bundle/forge-presets')

  const readMeta = (text) => {
    const get = (k) => {
      const m = text.replace(/\r\n/g, '\n').match(new RegExp('^' + k + ':\\s*(.*)$', 'm'))
      return m === null ? '' : m[1].trim()
    }
    return { name: get('name'), description: get('description') }
  }
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'"

  const ids = []
  for (const entry of await readdir(srcRoot, { withFileTypes: true })) if (entry.isDirectory()) ids.push(entry.name)
  ids.sort()

  let out = '- insert:\n'
  for (const id of ids) {
    const meta = readMeta(await readFile(join(srcRoot, id, 'preset.yml'), 'utf8'))
    // plugins 逐字取自 agent.cordis.yml —— 官方要求 verbatim；整体缩进 10 格。
    const body = (await readFile(join(srcRoot, id, 'agent.cordis.yml'), 'utf8'))
      .replace(/\r\n/g, '\n').replace(/\n+$/, '')
    out += '    # forge preset「' + meta.name + '」\n'
    out += '    - id: preset-' + id + '\n'
    out += "      name: '@deepseek-ai/dsh-agent-preset'\n"
    out += '      config:\n'
    out += '        id: ' + id + '\n'
    out += '        name: ' + q(meta.name) + '\n'
    out += '        description: ' + q(meta.description) + '\n'
    out += '        plugins:\n'
    out += body.split('\n').map((l) => (l.trim() === '' ? '' : '          ' + l)).join('\n') + '\n'
    log('preset-' + id + '  ← presets/' + id)
  }
  await mkdir(bundleDir, { recursive: true })
  await writeFile(join(bundleDir, 'cordis.patch.yml'), out, 'utf8')

  // 装没装：看 profile 的 package.json 有没有把这个 bundle 链进来
  let linked = false
  try {
    const pkg = JSON.parse(await readFile(join(DSH_HOME, 'profiles', PROFILE, 'package.json'), 'utf8'))
    const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies)
    linked = deps['@local/dsh-forge-presets'] !== undefined
  } catch { /* 读不到就当没装 */ }
  if (linked) log('bundle @local/dsh-forge-presets 已在 profiles/' + PROFILE + ' 中')
  else {
    console.log('  ! 这个 bundle 还没装进 profile。装它请用官方工具（不要用 shell 复刻）：')
    console.log("      plugin_manager  action: install_bundle")
    console.log('      target: ' + bundleDir)
    console.log('    它是 link 进 profile 的，所以之后改 presets/* 只要重跑本步 + 重新 install_bundle。')
  }
  const legacyDir = join(DSH_HOME, '.agent-presets')
  const legacyThere = await access(legacyDir).then(() => true).catch(() => false)
  if (legacyThere) {
    console.log('  ! 还存在已废弃的 ' + legacyDir + ' —— rc.2 不读它了，可以删掉。')
  }
}

try {
  await installPlugins()
  await installPackages()
  await installDynplugins()
  await mergePatch()
  await mergeDynamic()
  await syncPresetBundle()
  await ensureProfileManifest()
  step('完成。重启 DSH（dsh web）后生效；preset 需在会话里选择 forge-team / forge-team-creative / forge-team-distill。')
} catch (e) {
  console.error('[dsh-forge] 安装失败:', e && e.message ? e.message : e)
  process.exit(1)
}

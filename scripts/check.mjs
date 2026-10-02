#!/usr/bin/env node
// dsh-forge checker: syntax-check every host/client artifact in the repo.
// Run: node scripts/check.mjs
import { readFile, readdir } from 'node:fs/promises'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync } from 'node:fs'
import { join, dirname, isAbsolute } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { execFileSync, spawnSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// Deployment-agnostic: honor DSH_HOME like every host plugin does, instead of
// pinning the maintainer's Linux home. Falls back to ~/.dsh.
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
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

function fail(message) {
  failed += 1
  console.log('  ✗ ' + message)
}

// 子进程的 stdout/stderr 落到**文件**而不是管道。
//
// 为什么：受限沙箱下进程**不能开命名管道**，所以 Node 用默认 `stdio: 'pipe'` 抓子进程输出会
// 直接 EPERM（实测：workspace-write 下 `check.mjs` 45 项全报 `spawnSync … EPERM`）。
// 语法检查本来就只需要退出码，用文件句柄接住 stderr 既能跑通、又留得住报错原文。
const CHECK_LOG_DIR = mkdtempSync(join(tmpdir(), 'dsh-forge-check-'))
let checkLogSeq = 0

function checkFile(path) {
  const logPath = join(CHECK_LOG_DIR, 'check-' + (checkLogSeq++) + '.err')
  let fd
  try {
    fd = openSync(logPath, 'w')
    execFileSync(process.execPath, ['--check', path], { stdio: ['ignore', fd, fd] })
    console.log('  ✓ ' + path)
  } catch (e) {
    failed += 1
    let detail = ''
    try { detail = readFileSync(logPath, 'utf8') } catch { /* 读不到就退回 e.message */ }
    const first = String(detail || e.message).split('\n').find((l) => l.trim() !== '') || e.message
    console.log('  ✗ ' + path + ': ' + String(first).trim())
  } finally {
    if (fd !== undefined) closeSync(fd)
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

// Every preset directory is checked, recursively: a preset may nest support
// files (forge-team-creative ships skills/<name>/SKILL.md).
async function listFiles(dir, prefix = '') {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : prefix + '/' + entry.name
    if (entry.isDirectory()) out.push(...await listFiles(join(dir, entry.name), rel))
    else out.push(rel)
  }
  return out
}

console.log('[check] presets (presets/*)')
for (const entry of await readdir(join(ROOT, 'presets'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const files = await listFiles(join(ROOT, 'presets', entry.name))
  for (const required of ['preset.yml', 'agent.cordis.yml']) {
    if (!files.includes(required)) {
      failed += 1
      console.log('  ✗ presets/' + entry.name + ': missing ' + required)
    }
  }
  for (const rel of files) {
    if (rel.endsWith('.mjs')) checkFile(join(ROOT, 'presets', entry.name, rel))
  }
  console.log('  · presets/' + entry.name + ' (' + files.length + ' files)')
}

console.log('[check] 客户端包 (bundle/packages)')
// 扫描发现，不写死清单：新增 @local 包时自动纳入语法检查。
// （写死清单会静默漏掉新包 —— 与 lib/ 和 dynplugins/ 当初的问题同类。）
{
  const { readdir } = await import('node:fs/promises')
  let pkgs = []
  try {
    pkgs = (await readdir(join(ROOT, 'bundle/packages'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch { /* no packages dir */ }
  for (const pkg of pkgs) {
    for (const file of ['lib/index.js', 'lib/client.js']) {
      const path = join(ROOT, 'bundle/packages', pkg, file)
      try {
        await readFile(path)
        checkFile(path)
      } catch { /* optional file */ }
    }
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

// —— 动态插件代码路径可解析（2026-10-02 回归门）——
// hostFile/clientFile 是相对 DSH_HOME 的路径（运行时读 $DSH_HOME/dynplugins/x）；
// 仓库里同一批文件放在 dynamic/ 下，由 install.mjs 第 3 步搬过去，所以这里
// 解析的是 join(ROOT, 'dynamic', rel)。运行时拼 DSH_HOME 由 dynboot/forgeboot2
// 的 resolveDynPath 负责。
// 反面教材：曾把 readFile(entry.hostFile) 原样交给进程 CWD（= profile 目录），
// 四个动态件全部 ENOENT，动态插件在 Windows 上从未挂载过。
console.log('[check] 动态插件代码路径 (hostFile/clientFile)')
for (const plugin of dynamic.plugins || []) {
  for (const half of ['hostFile', 'clientFile']) {
    const rel = plugin[half]
    if (typeof rel !== 'string' || rel.length === 0) continue
    if (isAbsolute(rel)) { console.log('  ⚠ ' + plugin.idPrefix + '.' + half + ' 是绝对路径（换机即失效）：' + rel); continue }
    const abs = join(ROOT, 'dynamic', rel)
    if (!existsSync(abs)) fail('动态插件代码缺失: ' + plugin.idPrefix + '.' + half + ' → dynamic/' + rel)
    else console.log('  ✓ ' + plugin.idPrefix + '.' + half + ' → dynamic/' + rel)
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
  // git 会因环境原因拒绝服务（2026-10-02 实际撞到 Windows 的 "detected dubious ownership"：
  // 仓库属主是 BUILTIN\Administrators 而当前用户是另一个 SID）。这是台账的辅助检查，
  // **不该让整个门禁以未捕获异常崩掉** —— 报出来、跳过；subjects 为空时下面自然走"跳过"分支。
  let subjects = []
  try {
    subjects = execFileSync('git', ['-C', ROOT, 'log', '--all', '--pretty=%s'], { encoding: 'utf8' }).split('\n')
  } catch (error) {
    console.log('  · 跳过：git 不可用 — ' + String(error.stderr || error.message).split('\n')[0])
    console.log('    Windows 上常见原因是仓库属主与当前用户不一致，加豁免即可：')
    console.log('    git config --global --add safe.directory ' + ROOT.replace(/\\/g, '/'))
  }
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
  const rtPath = join(DSH_HOME, 'auto-plugins.json')
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
    console.log('  · 目标 DSH 基线: ' + (manifest.dshBaseline || '未标注') + '（清单更新于 ' + (manifest.updated || '?') + '）')
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
    // forge 自建服务：断言"提供方还在"。这是我们自己的面，不对上游断言——
    // 但少了 provider 时消费者会静默拿不到服务（ctx.get 返回 undefined），是最难查的一类。
    for (const id of manifest.internal || []) {
      const provided = new RegExp("provide\\(\\s*['\"]" + id + "['\"]").test(all)
      console.log((provided ? '  ✓ ' : '  ✗ ') + 'L0 自建服务有提供方: ' + id + (provided ? '' : '（没有任何插件 provide 它——消费者会静默拿到 undefined）'))
      if (!provided) failed += 1
    }
    for (const m of manifest.manual || []) {
      console.log('  · 手工基线: ' + m.id + '.' + (m.methods || []).join(' .') + '【' + (m.note || '') + '】→ 人工核 [' + (m.sources || []).join('; ') + ']')
    }

    // 运行时探测：dsh --profile web --dump-config（只读组合树；本沙箱/他机可能不可用，SKIP 不阻断）
    try {
      // `dsh` is not necessarily on PATH: the Windows desktop app ships its own CLI
      // (resources/runtime/cli/bin/dsh.cmd) and never installs it globally. Point
      // DSH_CLI at it to enable the runtime half of this probe.
      const dshBin = process.env.DSH_CLI || 'dsh'
      // Windows cannot exec a .cmd/.bat through spawnSync without a shell; the
      // desktop's packaged CLI is exactly that, so opt into shell mode for it.
      const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(dshBin)
      // Shell mode hands the string to cmd.exe, which splits on spaces — quote it.
      const spawnTarget = needsShell ? '"' + dshBin + '"' : dshBin
      const out = spawnSync(spawnTarget, ['--profile', process.env.DSH_PROFILE || 'web', '--dump-config'], { encoding: 'utf8', timeout: 45000, shell: needsShell })
      if (out.status === 0 && out.stdout.length > 0) {
        const head = out.stdout.slice(0, 400).replace(/\s+/g, ' ')
        console.log('  · 运行时 dump-config 可取（' + out.stdout.length + ' 字节），L1 真值可按组合树人工对（原文首段: ' + head + '…）')
      } else {
        const why = String(out.stderr || out.stdout || 'exit ' + out.status).split('\n')[0].slice(0, 200)
        if (/managed exclusively by the Electron application/i.test(why)) {
          console.log('  · 跳过运行时探测：profile "' + (process.env.DSH_PROFILE || 'web') + '" 由 Electron 应用独占管理，打包的 dsh 按设计拒绝操作它。把 DSH_PROFILE 指向一个独立 profile（如第 8 步的测试 profile）即可启用运行时半边。（' + why + '）')
        } else {
          console.log('  · 跳过运行时探测：' + dshBin + ' --dump-config 不可用（' + why + '）——静态断言 + L3 冒烟为准。设 DSH_CLI 指向打包的 dsh 即可启用（桌面版：resources/runtime/cli/bin/dsh.cmd）')
        }
      }
    } catch (e) {
      console.log('  · 跳过运行时探测：' + String(e.message).slice(0, 160))
    }

    console.log('  · L3 冒烟清单（升级后人工核，见 docs/COMPAT.md）：')
    for (const item of [
      'sessionQuery.readSession（离线会话读 meta/events；sessionPersistence.inspect 已于 0.2.0-rc.2 移除）',
      'sessionmgmt.deleteSessions（forge 自建服务的删除守卫 masterIdFromSessionId）',
      'llm.listProviders/listModels（模型目录）',
      'agents.get（在线会话归属；agents.resume 现返回 AgentHandle，裸 Agent 仍走 agents.get）',
      'tools entries（工具表；register 现运行时强制 output { schema, render }）',
      '4 动态插件 dynboot 恢复（modpk / fshell / plsm / capm）',
      'ctx.agentPresets.select 在会话开过 turn 后抛 agent-preset/locked —— modeswitch 必须继续走自研 recompose',
      'dynamicCordisRunner 存在性：Service provider 的静态目录不收录它，须查 Config.listConfigs 的 cordis-host-runner 条目',
    ]) {
      console.log('    - ' + item)
    }
  }
}

console.log(failed === 0 ? '[check] 全部通过' : '[check] 失败 ' + failed + ' 项')
process.exit(failed === 0 ? 0 : 1)

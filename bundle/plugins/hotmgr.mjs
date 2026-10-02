// description: hotmgr「全热」看门狗（2026-09-01）：dynplugins 代码改动→自动 redefine 对应 prefix（无需重启）；
// client bundle 源码（packages/*/lib/client.js）改动→自动追加 patch 重扫标记（新 rev，刷新生效）；
// 静态插件（profiles/web/plugins/*.mjs）改动→自动版本化换名重载（新 URL 无模块缓存，include 重载即生效）；
// HTTP 状态/手动重载路由 /dsh-forge/hotmgr*。
import { watch, readdirSync, existsSync } from 'node:fs'
import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { DSH_HOME } from './lib/forge-common.mjs'

const DYN_DIR = DSH_HOME + '/dynplugins'
const SELF_FILE = 'hotmgr.mjs' // 自身变化不触发（避免自陷）
const DEBOUNCE_MS = 600

// 在 apply() 里按**当前 profile**解析。此前硬编码 `profiles/web`，于是在任何其它
// profile 下静态插件与 client bundle 两条 watch 都以 ENOENT 失败 —— 看门狗静默失效。
let PLUGINS_DIR = ''
let PATCH_PATH = ''
let CLIENT_BUNDLES = []

function resolveProfilePaths(ctx) {
  const pc = ctx.get('profileContext')
  const dir = pc !== undefined && pc !== null && typeof pc.dir === 'string' && pc.dir !== ''
    ? pc.dir
    : DSH_HOME + '/profiles/web'
  PLUGINS_DIR = dir + '/plugins'
  PATCH_PATH = dir + '/cordis.patch.yml'
  // client 双面包：扫出来而不是写死（原先只列了 dynrestore）。
  CLIENT_BUNDLES = []
  try {
    for (const name of readdirSync(dir + '/packages')) {
      const client = dir + '/packages/' + name + '/lib/client.js'
      if (existsSync(client)) CLIENT_BUNDLES.push(client)
    }
  } catch (error) { /* 该 profile 还没有 packages 目录 */ }
}

let runner = undefined
let agentsSvc = undefined
let debounce = undefined
let pending = new Map() // key -> { kind: 'reload'|'bundle'|'static', prefix?, file? }

function pickAgent(agents) {
  if (agents === undefined) return undefined
  try {
    if (typeof agents.currentInitiator === 'function') {
      const initiator = agents.currentInitiator()
      if (initiator !== undefined && typeof initiator.id === 'string' && initiator.id.length > 0) return initiator
    }
    if (typeof agents.list === 'function') {
      const list = agents.list()
      const first = Array.isArray(list) && list.length > 0 ? list[0] : undefined
      if (first !== undefined && typeof first.id === 'string' && first.id.length > 0) return first
    }
  } catch (error) { /* ignore */ }
  return undefined
}

// 清单里 hostFile/clientFile 尾部匹配文件名 → idPrefix（forge-ui.host.js → forge）
async function prefixForFile(fname) {
  try {
    const manifest = JSON.parse(await readFile(DSH_HOME + '/auto-plugins.json', 'utf8'))
    const plugins = Array.isArray(manifest.plugins) ? manifest.plugins : []
    for (const entry of plugins) {
      if (entry === null || typeof entry !== 'object') continue
      const hostFile = typeof entry.hostFile === 'string' ? entry.hostFile : ''
      const clientFile = typeof entry.clientFile === 'string' ? entry.clientFile : ''
      if (hostFile.endsWith(fname) || clientFile.endsWith(fname)) return String(entry.idPrefix ?? '')
    }
  } catch (error) { /* manifest unavailable */ }
  const base = fname.split('.')[0]
  return base === 'forge-ui' ? 'forge' : base
}

// 重定义一个 prefix：undefine 现有匹配实例（inventory 前缀匹配）→ define 新包 → runHostHalf
async function reloadPrefix(prefix) {
  if (runner === undefined) return { ok: false, error: 'runner unavailable' }
  const agent = pickAgent(agentsSvc)
  if (agent === undefined) return { ok: false, error: 'no agent available' }
  const inv = await runner.inventory()
  const rows = Array.isArray(inv) ? inv
    : (inv !== null && typeof inv === 'object' && Array.isArray(inv.rows) ? inv.rows
      : (inv !== null && typeof inv === 'object' && inv.ok === true && Array.isArray(inv.value) ? inv.value : []))
  const matched = rows.filter((row) => row !== null && typeof row === 'object' && typeof row.pluginId === 'string'
    && String(row.pluginId).replace(/-[0-9]+$/, '') === prefix)
  // 找清单 entry 重定义（先 define 校验+启动成功，才删旧实例——失败保旧版）
  const manifest = JSON.parse(await readFile(DSH_HOME + '/auto-plugins.json', 'utf8'))
  const plugins = Array.isArray(manifest.plugins) ? manifest.plugins : []
  const entry = plugins.find((e) => e !== null && typeof e === 'object' && String(e.idPrefix ?? '') === prefix)
  if (entry === undefined || entry.disabled === true) return { ok: true, removed: matched.map((r) => r.pluginId), note: 'entry disabled or absent' }
  const readText = async (file) => {
    try { return await readFile(file, 'utf8') } catch (error) { return '' }
  }
  const libHost = await readText(DSH_HOME + '/dynplugins/_lib.host.js')
  const libClient = await readText(DSH_HOME + '/dynplugins/_lib.client.js')
  const hostCode = typeof entry.hostFile === 'string' && entry.hostFile.length > 0 ? await readText(entry.hostFile)
    : (typeof entry.hostCode === 'string' ? entry.hostCode : '')
  const clientCode = typeof entry.clientFile === 'string' && entry.clientFile.length > 0 ? await readText(entry.clientFile)
    : (typeof entry.clientCode === 'string' ? entry.clientCode : '')
  const hostFinal = libHost !== '' && hostCode !== '' ? libHost + '\n' + hostCode : hostCode
  const clientFinal = libClient !== '' && clientCode !== '' ? libClient + '\n' + clientCode : clientCode
  const receipt = runner.define({
    plugin: { kind: 'new', idPrefix: prefix },
    name: String(entry.name ?? ''),
    purpose: String(entry.purpose ?? ''),
    code: {
      ...(hostFinal.length > 0 ? { host: hostFinal } : {}),
      ...(clientFinal.length > 0 ? { client: clientFinal } : {}),
    },
    sessionId: agent.id,
  })
  const started = await runner.runHostHalf(agent, receipt.pluginId, receipt.packageId, 'run', null, false)
  if (!(started && started.ok)) {
    // 新版启动失败：保留旧实例（保旧版策略），删新孤儿
    try { await runner.undefine(agent, receipt.pluginId) } catch (error) { /* best-effort */ }
    return { ok: false, pluginId: receipt.pluginId, error: 'new host half failed to start', started }
  }
  // 新版成功 → 删旧
  for (const row of matched) {
    try { await runner.undefine(agent, row.pluginId) } catch (error) { console.error('[hotmgr] undefine failed', row.pluginId, String(error && error.message ? error.message : error)) }
  }
  return { ok: true, removed: matched.map((r) => r.pluginId), pluginId: receipt.pluginId, started: true }
}

// client bundle 改动 → patch.yml 追加重扫标记（HMR watch 内容变化 → include 重建 → 新 rev）
async function touchClientBundles() {
  try {
    const text = await readFile(PATCH_PATH, 'utf8')
    const m = /hotmgr-rev (\d+)/.exec(text)
    const n = m === null ? 0 : Number(m[1])
    await writeFile(PATCH_PATH, text + `# hotmgr-rev ${n + 1} ${new Date().toISOString().slice(0, 19)}\n`)
  } catch (error) {
    console.error('[hotmgr] patch marker write failed:', String(error && error.message ? error.message : error))
  }
}

// 版本化换名重载一个静态插件：复制为 <base>.r<N>.mjs（新 URL）→ patch 行 name 改指新文件 → include 重建自动发生（Node 模块缓存按 URL，新文件名 = 无缓存）
async function reloadStaticPlugin(fname) {
  const base = String(fname).replace(/\.mjs$/, '')
  if (base.length === 0 || base === 'hotmgr' || /\.r\d+$/.test(base)) return { ok: false, error: 'skip' }
  const srcPath = PLUGINS_DIR + '/' + fname
  const text = await readFile(PATCH_PATH, 'utf8')
  const revMatch = new RegExp(base + '\\.r(\\d+)\\.mjs').exec(text)
  const nextRev = (revMatch === null ? 0 : Number(revMatch[1])) + 1
  const newName = './plugins/' + base + '.r' + nextRev + '.mjs'
  await copyFile(srcPath, PLUGINS_DIR + '/' + base + '.r' + nextRev + '.mjs')
  const re = new RegExp('name:\\s*\\./plugins/' + base + '\\.(?:r\\d+\\.)?mjs')
  if (!re.test(text)) return { ok: false, error: 'patch row not found for ' + base }
  const newText = text.replace(re, 'name: ' + newName)
  await writeFile(PATCH_PATH, newText)
  console.log('[hotmgr] static reloaded:', JSON.stringify({ from: fname, to: newName, rev: nextRev }))
  return { ok: true, to: newName }
}

function schedule(kind, prefix) {
  const key = kind === 'reload' ? 'r:' + prefix : kind === 'static' ? 's:' + prefix : 'b'
  pending.set(key, kind === 'reload' ? { kind, prefix } : kind === 'static' ? { kind, prefix } : { kind })
  if (debounce !== undefined) clearTimeout(debounce)
  debounce = setTimeout(async () => {
    const batch = [...pending.values()]
    pending.clear()
    debounce = undefined
    for (const item of batch) {
      try {
        if (item.kind === 'reload') {
          const result = await reloadPrefix(item.prefix)
          console.log('[hotmgr] reloaded prefix', JSON.stringify({ prefix: item.prefix, result }))
        } else if (item.kind === 'static') {
          const result = await reloadStaticPlugin(item.prefix)
          console.log('[hotmgr] static action', JSON.stringify({ file: item.prefix, result }))
        } else {
          await touchClientBundles()
          console.log('[hotmgr] client bundle marker appended')
        }
      } catch (error) {
        console.error('[hotmgr] action failed:', JSON.stringify(item), String(error && error.message ? error.message : error))
      }
    }
  }, DEBOUNCE_MS)
}

function startWatchers() {
  try {
    watch(DYN_DIR, (eventType, fname) => {
      const fn = String(fname ?? '')
      if (!/\.(host|client)\.js$/.test(fn)) return
      prefixForFile(fn).then((prefix) => schedule('reload', prefix)).catch(() => {})
    })
    console.log('[hotmgr] watching dynplugins:', DYN_DIR)
  } catch (error) {
    console.error('[hotmgr] dynplugins watch failed:', String(error && error.message ? error.message : error))
  }
  try {
    watch(PLUGINS_DIR, (eventType, fname) => {
      const fn = String(fname ?? '')
      if (!/\.mjs$/.test(fn) || fn === SELF_FILE || /\.r\d+\.mjs$/.test(fn)) return
      schedule('static', fn)
    })
    console.log('[hotmgr] watching static plugins:', PLUGINS_DIR)
  } catch (error) {
    console.error('[hotmgr] static watch failed:', String(error && error.message ? error.message : error))
  }
  for (const file of CLIENT_BUNDLES) {
    try {
      watch(file, () => schedule('bundle'))
      console.log('[hotmgr] watching client bundle:', file)
    } catch (error) {
      console.error('[hotmgr] bundle watch failed:', file, String(error && error.message ? error.message : error))
    }
  }
}

export default {
  inject: ['dynamicCordisRunner', 'agents', 'webServer'],
  apply(ctx) {
    resolveProfilePaths(ctx)
    runner = ctx.dynamicCordisRunner
    agentsSvc = ctx.get('agents')
    const webServer = ctx.get('webServer')
    if (webServer !== undefined && typeof webServer.register === 'function') {
      try {
        const dispose = webServer.register({
          kind: 'exact',
          path: '/dsh-forge/hotmgr',
          handler: async (req, res) => {
            if (req.method !== 'GET' && req.method !== 'POST') {
              res.writeHead(405)
              res.end()
              return
            }
            try {
              const url = new URL(req.url ?? '/', 'http://localhost')
              const prefix = url.searchParams.get('prefix') ?? ''
              const direct = url.searchParams.get('reload') === '1'
              if (direct && prefix !== '') {
                const result = await reloadPrefix(prefix)
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ ok: true, prefix, ...result }))
                return
              }
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: true, watching: { dynplugins: DYN_DIR, bundles: CLIENT_BUNDLES }, pending: [...pending.values()] }))
            } catch (error) {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) }))
            }
          },
        })
        ctx.effect(() => () => { try { dispose() } catch (error) { /* best-effort */ } })
        console.log('[hotmgr] route /dsh-forge/hotmgr registered')
      } catch (error) {
        console.error('[hotmgr] route registration failed:', String(error && error.message ? error.message : error))
      }
    } else {
      console.error('[hotmgr] webServer unavailable')
    }
    startWatchers()
  },
}

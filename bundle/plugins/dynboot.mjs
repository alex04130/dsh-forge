// description: 动态插件启动器：把 auto-plugins.json 的条目 define 成动态插件（重启自动恢复）。
// v3（2026-09-01）：指纹化增量恢复——清单变化才重跑恢复；已恢复的同 prefix 条目跳过（不重复 define）；
// 触发点 = agent/created（重启后首个进入的 agent）+ agent/status(running)（热生效：清单改完下一个 turn 自动恢复，无需重启）。
// 0.2.0-rc.2：agent/session-start 已不存在（改名为异步串行的 agent/created）。
import { readFile } from 'node:fs/promises'
import { DSH_HOME, resolveDynPath } from './lib/forge-common.mjs'

const MANIFEST_PATH = DSH_HOME + '/auto-plugins.json'

let lastFingerprint = null
let restoring = false

function fingerprintOf(plugins) {
  return plugins
    .filter((entry) => entry !== null && typeof entry === 'object')
    .map((entry) => [
      String(entry.idPrefix ?? ''),
      entry.disabled === true ? '1' : '0',
      String(entry.hostFile ?? ''),
      String(entry.clientFile ?? ''),
      String(entry.name ?? ''),
    ].join('|'))
    .join('\n')
}

// Host runner inventory 返回三种形态（数组 / {rows} / {ok,value}），统一为数组。
async function rowsOf(runner) {
  try {
    const inv = await runner.inventory()
    return Array.isArray(inv) ? inv
      : (inv !== null && typeof inv === 'object' && Array.isArray(inv.rows) ? inv.rows
        : (inv !== null && typeof inv === 'object' && inv.ok === true && Array.isArray(inv.value) ? inv.value : []))
  } catch (error) {
    return []
  }
}

async function restoreAll(runner, agent) {
  let manifest
  try {
    const file = await readFile(MANIFEST_PATH, 'utf8')
    manifest = JSON.parse(file)
  } catch (error) {
    console.error('[dynboot] auto-plugins.json unavailable:', String(error && error.message ? error.message : error))
    return
  }
  const plugins = Array.isArray(manifest.plugins) ? manifest.plugins : []
  const fingerprint = fingerprintOf(plugins)
  if (lastFingerprint !== null && lastFingerprint === fingerprint) return // 清单无变化：静默（每 turn 触发无噪音）

  // 4b 薄桥 prelude：_lib.host.js/_lib.client.js 原样前置拼接到每行代码（文件缺席=空前缀，向后兼容）
  const readLib = async (name) => {
    try { return await readFile(DSH_HOME + '/dynplugins/' + name, 'utf8') } catch (error) { return '' }
  }
  const libHost = await readLib('_lib.host.js')
  const libClient = await readLib('_lib.client.js')

  // 增量：已恢复的 prefix（running/stopped 都算在场）不重复 define，避免清单热更后双份
  const liveByPrefix = new Set()
  for (const row of await rowsOf(runner)) {
    if (row === null || typeof row !== 'object' || typeof row.pluginId !== 'string') continue
    const prefix = String(row.pluginId).replace(/-[0-9]+$/, '')
    if (prefix.length > 0) liveByPrefix.add(prefix)
  }

  const results = []
  for (const entry of plugins) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.disabled === true) continue // opt-out entries stay dormant by default
    const prefix = String(entry.idPrefix ?? '')
    if (liveByPrefix.has(prefix)) {
      results.push({ idPrefix: prefix, already: true })
      continue
    }
    try {
      // 4a 路径引用：hostFile/clientFile 优先（代码回真文件），hostCode/clientCode 内联字符串向后兼容
      // 相对路径一律相对 DSH_HOME（进程 CWD 是 profile 目录，原样读必然 ENOENT —— 见 resolveDynPath）
      const hostCode = typeof entry.hostFile === 'string' && entry.hostFile.length > 0
        ? await readFile(resolveDynPath(entry.hostFile), 'utf8')
        : (typeof entry.hostCode === 'string' ? entry.hostCode : '')
      const clientCode = typeof entry.clientFile === 'string' && entry.clientFile.length > 0
        ? await readFile(resolveDynPath(entry.clientFile), 'utf8')
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
      results.push({ idPrefix: prefix, pluginId: receipt.pluginId, started: !!(started && started.ok) })
    } catch (error) {
      results.push({ idPrefix: prefix, ok: false, error: String(error && error.message ? error.message : error) })
      console.error('[dynboot] failed to restore plugin', prefix, ':', String(error && error.message ? error.message : error))
    }
  }
  lastFingerprint = fingerprint
  console.log('[dynboot] restore finished:', JSON.stringify(results))
}

export default {
  inject: ['dynamicCordisRunner'],
  apply(ctx) {
    const runner = ctx.dynamicCordisRunner
    const bootstrap = (payload) => {
      if (restoring) return
      const agent = payload !== undefined && payload.agent !== undefined ? payload.agent : undefined
      if (agent === undefined || typeof agent.id !== 'string') return
      restoring = true
      restoreAll(runner, agent).catch((error) => {
        console.error('[dynboot] restore crashed:', String(error && error.message ? error.message : error))
      }).finally(() => {
        restoring = false
      })
    }
    // 0.2.0-rc.2: agent/session-start → the asynchronous, serial agent/created.
    // restoreAll needs a live agent for define({sessionId}) + runHostHalf, so
    // this is the correct anchor (unlike the process-scoped restores).
    ctx.on('agent/created', bootstrap)
    // 热生效：每个会话 turn 开始时会触发一次 running；比对快且清单不变时静默返回
    ctx.on('agent/status', (payload) => {
      if (payload === null || typeof payload !== 'object' || payload.status !== 'running') return
      bootstrap(payload)
    })
  },
}

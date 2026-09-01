// description: 动态插件启动器：启动时把 auto-plugins.json 的条目 define 成动态插件（重启自动恢复）。
import { readFile } from 'node:fs/promises'
import { DSH_HOME } from './lib/forge-common.mjs'

const MANIFEST_PATH = DSH_HOME + '/auto-plugins.json'

let restored = false
let restoring = false

async function restoreAll(runner, agent) {
  let manifest
  try {
    const file = await readFile(MANIFEST_PATH, 'utf8')
    manifest = JSON.parse(file)
  } catch (error) {
    console.error('[dynboot] auto-plugins.json unavailable:', String(error && error.message ? error.message : error))
    restored = true
    return
  }
  const plugins = Array.isArray(manifest.plugins) ? manifest.plugins : []
  // 4b 薄桥 prelude：_lib.host.js/_lib.client.js 原样前置拼接到每行代码（文件缺席=空前缀，向后兼容）
  const readLib = async (name) => {
    try { return await readFile(DSH_HOME + '/dynplugins/' + name, 'utf8') } catch (error) { return '' }
  }
  const libHost = await readLib('_lib.host.js')
  const libClient = await readLib('_lib.client.js')
  const results = []
  for (const entry of plugins) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.disabled === true) continue // opt-out entries stay dormant by default
    const prefix = String(entry.idPrefix ?? '')
    try {
      // 4a 路径引用：hostFile/clientFile 优先（代码回真文件），hostCode/clientCode 内联字符串向后兼容
      const hostCode = typeof entry.hostFile === 'string' && entry.hostFile.length > 0
        ? await readFile(entry.hostFile, 'utf8')
        : (typeof entry.hostCode === 'string' ? entry.hostCode : '')
      const clientCode = typeof entry.clientFile === 'string' && entry.clientFile.length > 0
        ? await readFile(entry.clientFile, 'utf8')
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
  restored = true
  console.log('[dynboot] restore finished:', JSON.stringify(results))
}

export default {
  inject: ['dynamicCordisRunner'],
  apply(ctx) {
    const runner = ctx.dynamicCordisRunner
    ctx.on('agent/session-start', (payload) => {
      if (restored || restoring) return
      const agent = payload !== undefined && payload.agent !== undefined ? payload.agent : undefined
      if (agent === undefined || typeof agent.id !== 'string') return
      restoring = true
      restoreAll(runner, agent).catch((error) => {
        console.error('[dynboot] restore crashed:', String(error && error.message ? error.message : error))
      }).finally(() => {
        restoring = false
      })
    })
  },
}

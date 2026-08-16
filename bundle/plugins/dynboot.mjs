// description: 动态插件启动器：启动时把 auto-plugins.json 的条目 define 成动态插件（重启自动恢复）。
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
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
  const results = []
  for (const entry of plugins) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.disabled === true) continue // opt-out entries stay dormant by default
    const prefix = String(entry.idPrefix ?? '')
    try {
      const receipt = runner.define({
        plugin: { kind: 'new', idPrefix: prefix },
        name: String(entry.name ?? ''),
        purpose: String(entry.purpose ?? ''),
        code: {
          ...(typeof entry.hostCode === 'string' && entry.hostCode.length > 0 ? { host: entry.hostCode } : {}),
          ...(typeof entry.clientCode === 'string' && entry.clientCode.length > 0 ? { client: entry.clientCode } : {}),
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

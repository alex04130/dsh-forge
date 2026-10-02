// description: forge-ui 热恢复器 v2：apply 即跑 + POST /dsh-forge/forgeboot 路由双触发。
// 对 auto-plugins.json 清单里尚未 define 的 prefix 补 define + runHostHalf（无重启热生效）。
import { readFile } from 'node:fs/promises'
import { DSH_HOME, resolveDynPath } from './lib/forge-common.mjs'

const MANIFEST_PATH = DSH_HOME + '/auto-plugins.json'

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
  } catch (error) {
    console.error('[forgeboot2] pickAgent failed:', String(error && error.message ? error.message : error))
  }
  return undefined
}

async function restore(runner, agents) {
  const agent = pickAgent(agents)
  if (agent === undefined) return { ok: false, error: 'no agent available' }
  let manifest
  try {
    manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
  } catch (error) {
    return { ok: false, error: 'manifest unavailable: ' + String(error && error.message ? error.message : error) }
  }
  const plugins = Array.isArray(manifest.plugins) ? manifest.plugins : []
  let inv = []
  try {
    const raw = await runner.inventory()
    inv = Array.isArray(raw) ? raw
      : (raw !== null && typeof raw === 'object' && Array.isArray(raw.rows) ? raw.rows
        : (raw !== null && typeof raw === 'object' && raw.ok === true && Array.isArray(raw.value) ? raw.value : []))
  } catch (error) {
    console.error('[forgeboot2] inventory failed:', String(error && error.message ? error.message : error))
  }
  const liveByPrefix = new Set(inv
    .filter((row) => row !== null && typeof row === 'object' && typeof row.pluginId === 'string')
    .map((row) => String(row.pluginId).replace(/-[0-9]+$/, '')))
  const readLib = async (name) => {
    try { return await readFile(DSH_HOME + '/dynplugins/' + name, 'utf8') } catch (error) { return '' }
  }
  const libHost = await readLib('_lib.host.js')
  const libClient = await readLib('_lib.client.js')
  const results = []
  for (const entry of plugins) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.disabled === true) continue
    const prefix = String(entry.idPrefix ?? '')
    if (liveByPrefix.has(prefix)) {
      results.push({ idPrefix: prefix, already: true })
      continue
    }
    try {
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
      console.error('[forgeboot2] failed to restore plugin', prefix, ':', String(error && error.message ? error.message : error))
    }
  }
  return { ok: true, agent: agent.id, hmrProbe: '静态热-已生效', results }
}

export default {
  inject: ['dynamicCordisRunner', 'agents', 'webServer'],
  apply(ctx) {
    const runner = ctx.dynamicCordisRunner
    const agents = ctx.get('agents')
    const webServer = ctx.get('webServer')
    if (webServer !== undefined && typeof webServer.register === 'function') {
      try {
        const dispose = webServer.register({
          kind: 'exact',
          path: '/dsh-forge/forgeboot',
          handler: async (req, res) => {
            if (req.method !== 'GET' && req.method !== 'POST') {
              res.writeHead(405)
              res.end()
              return
            }
            try {
              const result = await restore(runner, agents)
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify(result))
            } catch (error) {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) }))
            }
          },
        })
        ctx.effect(() => () => { try { dispose() } catch (error) { /* best-effort */ } })
        console.log('[forgeboot2] route /dsh-forge/forgeboot registered')
      } catch (error) {
        console.error('[forgeboot2] route registration failed:', String(error && error.message ? error.message : error))
      }
    } else {
      console.error('[forgeboot2] webServer unavailable')
    }
    restore(runner, agents).then((result) => {
      console.log('[forgeboot2] initial:', JSON.stringify(result))
    }).catch((error) => {
      console.error('[forgeboot2] initial failed:', String(error && error.message ? error.message : error))
    })
  },
}

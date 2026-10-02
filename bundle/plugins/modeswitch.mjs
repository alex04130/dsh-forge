// description: 会话中途切换模式（switch_mode）；目标模式新增能力时先弹审批，同级或降级直接切。
import { defineTool } from '@deepseek-ai/dsh-tools'
import { collectPresetEscalations } from './lib/subagent-policy.mjs'
import { errText, jsonText } from './lib/forge-common.mjs'

export default {
  inject: ['tools'],
  apply(ctx) {
    const presets = ctx.get('agentPresets')
    const approval = ctx.get('approval')
    const agents = ctx.get('agents')
    const persistence = ctx.get('sessionPersistence')
    // ── 上游 0.1.5-rc.2 兼容层（R5）──────────────────────────────────────────
    // rc.2 删掉了 inspect(id)：新面是 stat(id) → { header }（无 events）
    // 与 open(id,'read') → handle.read() → { events }。特性探测，旧核回退。
    async function readEventsVia(id) {
      if (persistence === undefined || persistence === null) return undefined
      if (typeof persistence.stat === 'function' && typeof persistence.open === 'function') {
        const snapshot = await persistence.stat(id)
        if (snapshot === undefined || snapshot === null) return undefined
        const handle = await persistence.open(id, 'read')
        try {
          const result = await handle.read(0, Number.MAX_SAFE_INTEGER)
          return result !== null && typeof result === 'object' && Array.isArray(result.events) ? result.events : []
        } finally {
          try { await handle.close() } catch (error) { /* best-effort */ }
        }
      }
      if (typeof persistence.inspect === 'function') {
        const inspection = await inspectCompat(persistence, id)
        return inspection !== null && typeof inspection === 'object' && Array.isArray(inspection.events) ? inspection.events : []
      }
      return undefined
    }
    if (presets === undefined) return

    const modeTool = defineTool({
      name: 'forge_session_mode',
      description: '显示某会话当前运行的模式（agent preset）。在线会话从自身上下文读取组合后的模式；已持久化的离线会话从其日志读取最近一次 agent-preset/selected 事件。用于确认本会话、某个子代理或任何其他会话当前处于什么模式。',
      parameters: {
        sessionId: { type: 'string', description: '目标会话 id。省略则查询调用方会话。' },
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: typeof value === 'string' ? value : String(value) }] },
      },
      async execute(args, exec) {
        try {
          const agent = exec !== undefined ? exec.agent : undefined
          const targetId = typeof args.sessionId === 'string' && args.sessionId.trim() !== '' ? args.sessionId.trim() : (agent !== undefined ? agent.id : '')
          if (targetId === '') return jsonText({ ok: false, error: 'no session id and no calling agent context' })
          const live = agents !== undefined && typeof agents.get === 'function' ? agents.get(targetId) : undefined
          if (live !== undefined) {
            const current = presets.composedPreset(live.ctx)
            return jsonText({ ok: true, sessionId: targetId, live: true, preset: current ?? null })
          }
          const events = await readEventsVia(targetId)
          if (events !== undefined) {
            let last = null
            for (const event of events) {
              if (event !== null && typeof event === 'object' && event.type === 'agent-preset/selected' && event.data !== null && typeof event.data === 'object' && typeof event.data.agentPreset === 'string') last = event.data.agentPreset
            }
            return jsonText({ ok: true, sessionId: targetId, live: false, preset: last })
          }
          return jsonText({ ok: false, error: 'session not found (or no persistence to inspect): ' + targetId })
        } catch (error) {
          return jsonText({ ok: false, error: errText(error) })
        }
      },
    })
    const modeDispose = ctx.tools.register(modeTool)
    ctx.effect(() => () => { try { modeDispose() } catch (error) { /* best-effort */ } })

    const tool = defineTool({
      name: 'switch_mode',
      description: '会话中途把本会话切换到另一个模式（agent preset）；切换从下一步生效，届时新模式提供工具目录和提示词。切换到授予当前模式所缺能力（权限增加）的模式会请求用户确认，未获允许则取消；能力相同或更少则直接执行，无需询问。目标模式必须存在且能干净挂载，否则调用失败且一切不变。注意事项：此前记录的工具调用只有在新模式定义了相同工具时才保持可读；计划模式状态不会延续。本工具挂在主机组合中，切换后依然可用。',
      parameters: {
        presetId: { type: 'string', required: true, description: '要切换到的模式 id，如 "cordis"、"code"、"standard" 或用户自建的模式 id。' },
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: typeof value === 'string' ? value : String(value) }] },
      },
      async execute(args, exec) {
        try {
          const agent = exec !== undefined ? exec.agent : undefined
          if (agent === undefined) return jsonText({ ok: false, error: 'no calling agent context; switch_mode must run inside a session' })
          const presetId = String(args.presetId)
          const current = presets.composedPreset(agent.ctx)
          if (current === presetId) return jsonText({ ok: true, switchedTo: presetId, unchanged: true })
          let added = []
          if (current !== undefined && current !== null) {
            added = await collectPresetEscalations({ parentPreset: current, targetPreset: presetId, presets })
          }
          if (added.length > 0) {
            if (approval === undefined) {
              return jsonText({ ok: false, error: 'the target preset adds capabilities the current one lacks (' + added.slice(0, 8).join(', ') + '), but no approval service is mounted to confirm the switch' })
            }
            const outcome = await approval.request({
              agent,
              toolName: 'switch_mode',
              reason: 'switching agent preset from "' + String(current) + '" to "' + presetId + '" adds these capabilities: ' + added.slice(0, 12).join(', ') + (added.length > 12 ? ' …' : ''),
              signal: exec !== undefined ? exec.signal : undefined,
            })
            if (outcome !== 'allowed-once') {
              return jsonText({ ok: false, cancelled: true, reason: 'the user did not allow this preset switch (approval outcome "' + String(outcome) + '"); nothing changed' })
            }
          }
          let preset
          try {
            preset = await presets.recompose(agent.ctx, presetId)
          } catch (error) {
            return jsonText({ ok: false, error: 'recompose failed: ' + errText(error) })
          }
          try {
            agent.session.append('agent-preset/selected', { agentPreset: preset.id })
          } catch (error) { /* the re-link already happened; the durable record is best-effort */ }
          return jsonText({ ok: true, switchedTo: preset.id, added, note: 'Takes effect from the next step: tool catalog and prompt now come from the new preset. Prior logged tool calls stay readable only if the new preset defines the same tools. Plan-mode state belonged to the old preset and does not carry over.' })
        } catch (error) {
          return jsonText({ ok: false, error: errText(error) })
        }
      },
    })
    const dispose = ctx.tools.register(tool)
    ctx.effect(() => () => { try { dispose() } catch (error) { /* best-effort */ } })
  },
}


// ── 0.1.5 兼容：旧 inspect(id) → { meta, events } ─────────────────────────────
// B4 同类：rc.2 删了 sessionPersistence.inspect，新面是 stat(id)+open(id,'read')。
// 形状差异：新 stat 给 header（无 events），所以要自己拼回旧形状。
async function inspectCompat(persistence, id) {
  if (persistence !== undefined && typeof persistence.stat === 'function' && typeof persistence.open === 'function') {
    const stat = await persistence.stat(id)
    const header = stat !== null && typeof stat === 'object' && stat.header !== null && typeof stat.header === 'object' ? stat.header : {}
    let events = []
    try {
      const handle = await persistence.open(id, 'read')
      try {
        const chunk = await handle.read(0, Number.MAX_SAFE_INTEGER)
        if (chunk !== null && typeof chunk === 'object' && Array.isArray(chunk.events)) events = chunk.events
      } finally { try { await handle.close() } catch (error) { /* best-effort */ } }
    } catch (error) { /* events 读不到就只给 meta */ }
    return { meta: header, events }
  }
  return await persistence.inspect(id)
}

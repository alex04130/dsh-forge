// description: 会话中途切换模式（switch_mode）；目标模式新增能力时先弹审批，同级或降级直接切。
import { defineTool } from '@deepseek-ai/dsh-tools'
import { collectPresetEscalations } from './lib/subagent-policy.mjs'

function errText(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}
function jsonText(value) {
  return JSON.stringify(value, null, 2)
}

export default {
  inject: ['tools'],
  apply(ctx) {
    const presets = ctx.get('agentPresets')
    const approval = ctx.get('approval')
    const agents = ctx.get('agents')
    const persistence = ctx.get('sessionPersistence')
    if (presets === undefined) return

    const modeTool = defineTool({
      name: 'session_mode',
      description: 'Show which agent preset (mode) a session currently runs. Live sessions read the composed preset from their context; persisted offline sessions read the last agent-preset/selected event from their log. Use it to confirm what mode THIS session, a subagent, or any other session is running.',
      parameters: {
        sessionId: { type: 'string', description: 'Target session id. Omit to query the calling session.' },
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
          if (persistence !== undefined && typeof persistence.inspect === 'function') {
            const inspection = await persistence.inspect(targetId)
            let last = null
            for (const event of (Array.isArray(inspection.events) ? inspection.events : [])) {
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
      description: 'Switch THIS session to another agent preset (mode) mid-session; the switch applies from the next step, when the new preset supplies the tool catalog and prompt. Switching to a preset that grants capabilities the current one lacks (a permission increase) asks the user for confirmation and cancels unless allowed; equal-or-fewer capabilities proceed without asking. The target preset must exist and mount cleanly, otherwise the call fails and nothing changes. Caveats: prior logged tool calls stay readable only if the new preset defines the same tools; plan-mode state does not carry over. This tool is mounted in the host composition and stays available after the switch.',
      parameters: {
        presetId: { type: 'string', required: true, description: 'Preset id to switch to, e.g. "cordis", "code", "standard", or a user-authored preset id.' },
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

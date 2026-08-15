// description: 会话中途切换模式（switch_mode）；目标模式新增能力时先弹审批，同级或降级直接切。
import yaml from 'js-yaml'
import { defineTool } from '@deepseek-ai/dsh-tools'

function errText(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}
function jsonText(value) {
  return JSON.stringify(value, null, 2)
}

/** Collect every plugin row name from one preset composition. */
function pluginNames(compositionText) {
  try {
    const doc = yaml.load(compositionText)
    const names = []
    const walk = (node) => {
      if (Array.isArray(node)) { for (const item of node) walk(item); return }
      if (node === null || typeof node !== 'object') return
      if (typeof node.name === 'string' && node.name.length > 0) names.push(node.name)
      for (const value of Object.values(node)) walk(value)
    }
    walk(doc)
    return [...new Set(names)]
  } catch (error) {
    return []
  }
}

/** Plugin rows the target preset adds over the current one. */
function addedNames(currentNames, targetNames) {
  const have = new Set(currentNames)
  return targetNames.filter((name) => !have.has(name))
}

export default {
  inject: ['tools'],
  apply(ctx) {
    const presets = ctx.get('agentPresets')
    const approval = ctx.get('approval')
    if (presets === undefined) return

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
            try {
              const currentNames = pluginNames(await presets.read(current))
              const targetNames = pluginNames(await presets.read(presetId))
              added = addedNames(currentNames, targetNames)
            } catch (error) { /* comparison is best-effort; recompose still validates the target */ }
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

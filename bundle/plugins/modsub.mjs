// description: 子代理派发（spawn_model_subagent）：可选 provider/model/effort/模式，默认全继承父代理，提权自动问用户。
import { defineTool } from '@deepseek-ai/dsh-tools'
import { collectModelEscalations, collectPresetEscalations, installChildPolicy } from './lib/subagent-policy.mjs'

function errText(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}
function jsonText(value) {
  return JSON.stringify(value, null, 2)
}

// ── spawn_model_subagent v2 ──────────────────────────────────────────────
// Subagent spawning with explicit mode / reasoning-effort / provider / model
// controls. Defaults INHERIT the parent (same provider, same model, same
// effort, same preset) so billing and capability never silently change:
//   - provider: only an EXPLICIT provider argument may switch the provider
//     (explicit model alone keeps the parent's provider — billing safety).
//   - model: explicit model wins; otherwise the parent's live route model.
//   - reasoningEffort: explicit value, else the parent's CURRENT effort
//     (snapshot at spawn; applies to every turn of the child).
//   - mode (agent preset): explicit preset id re-composes the child before
//     its first prompt assembly; otherwise the child inherits the parent's
//     composition as usual.
// Escalation policy (shared library, also used by switch_mode and
// team_add_member): any upgrade — a higher model tier in the same series, a
// cross-series model change, or a target preset whose plugin-row capability
// face is not a subset of the parent's — asks the user through the approval
// service (allowed-once). Equal or lower tiers / equal or fewer capabilities
// proceed without asking. No hard-coded preset ladders.
export default {
  inject: ['tools', 'subagents'],
  apply(ctx) {
    const subagents = ctx.subagents
    const presets = ctx.get('agentPresets')
    const approval = ctx.get('approval')

    const policy = installChildPolicy(ctx, presets)

    const tool = defineTool({
      name: 'spawn_model_subagent',
      description: 'Spawn a durable, continuable subagent session that inherits this session\'s composition (same tools, same workspace) and, by default, the parent\'s `provider`/`model`/`reasoningEffort`/`mode` (agent preset), so billing never silently changes. Passing any of these explicitly overrides only that axis: an explicit `model` alone keeps the parent\'s provider. Escalation — a higher model tier in the same series, a cross-series model change, or a target preset whose plugin-row capability face is not a subset of the parent\'s — asks the user for approval and cancels unless allowed; equal-or-lower tiers and equal-or-fewer capabilities proceed without asking. See `model_list` for available provider/model pairs. The returned childId is the child session id: the user can open it in the GUI and send screenshots/text to it, and the child reports its final answer back to this session.',
      parameters: {
        prompt: { type: 'string', required: true, description: 'The complete mission for the child agent (it sees nothing from this conversation).' },
        label: { type: 'string', description: 'Short display label for the child session.' },
        provider: { type: 'string', description: 'Optional explicit provider route for the child; omit to inherit the parent\'s provider (recommended — billing stays on the same route). See `model_list` for route ids.' },
        model: { type: 'string', description: 'Optional explicit model id for the child; omit to inherit the parent\'s current model. See `model_list` for available models.' },
        reasoningEffort: { type: 'string', description: 'Optional explicit reasoning effort for the child (provider-specific id, e.g. "low"/"medium"/"high"); omit to inherit the parent\'s current effort.' },
        mode: { type: 'string', description: 'Optional agent preset id for the child (e.g. "router-standard", "cordis"); omit to inherit the parent\'s composition.' },
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: typeof value === 'string' ? value : String(value) }] },
      },
      async execute(args, exec) {
        try {
          const agent = exec !== undefined ? exec.agent : undefined
          if (agent === undefined) return jsonText({ ok: false, error: 'no calling agent; spawn_model_subagent must run inside a session' })
          const prompt = String(args.prompt ?? '')
          if (prompt.length === 0) return jsonText({ ok: false, error: 'prompt must not be empty' })
          const label = String(args.label ?? '').trim()
          const explicitProvider = typeof args.provider === 'string' && args.provider.trim() !== '' ? args.provider.trim() : undefined
          const explicitModel = typeof args.model === 'string' && args.model.trim() !== '' ? args.model.trim() : undefined
          const explicitEffort = typeof args.reasoningEffort === 'string' && args.reasoningEffort.trim() !== '' ? args.reasoningEffort.trim() : undefined
          const modeId = typeof args.mode === 'string' && args.mode.trim() !== '' ? args.mode.trim() : undefined

          const route = policy.liveRoute(agent)
          const parentHeader = agent.session?.requestHeader?.()
          const parentPreset = presets !== undefined ? presets.composedPreset(agent.ctx) : undefined
          const parentModel = route.model ?? parentHeader?.config?.model
          const childModel = explicitModel ?? parentModel
          const childProvider = explicitProvider ?? route.provider
          const effort = explicitEffort ?? parentHeader?.config?.reasoningEffort

          const escalations = [
            ...collectModelEscalations(parentModel, childModel),
            ...(await collectPresetEscalations({ parentPreset, targetPreset: modeId, presets })),
          ]

          if (escalations.length > 0) {
            if (approval === undefined) {
              return jsonText({ ok: false, error: 'this spawn escalates (' + escalations.join('; ') + ') but no approval service is mounted to confirm it' })
            }
            const outcome = await approval.request({
              agent,
              toolName: 'spawn_model_subagent',
              reason: 'subagent escalation: ' + escalations.join('; '),
              signal: exec !== undefined ? exec.signal : undefined,
            })
            if (outcome !== 'allowed-once') {
              return jsonText({ ok: false, cancelled: true, reason: 'the user did not allow this subagent escalation (approval outcome "' + String(outcome) + '"); nothing was spawned', escalations })
            }
          }

          const agentOptions = {}
          if (explicitProvider !== undefined) agentOptions.provider = explicitProvider
          if (explicitModel !== undefined) agentOptions.model = explicitModel

          const started = await subagents.startContinuable({
            provider: 'spawn',
            label: label.length > 0 ? label : (childModel + ' 子代理'),
            request: {
              prompt: [{ type: 'text', text: prompt }],
              parent: agent,
              ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
            },
            signal: exec !== undefined ? exec.signal : undefined,
          })

          policy.register(started.childId, {
            ...(modeId !== undefined ? { mode: modeId } : {}),
            ...(effort !== undefined && typeof effort === 'string' ? { effort } : {}),
          })

          return jsonText({
            ok: true,
            childId: started.childId,
            messageId: started.messageId,
            route: { provider: childProvider, model: childModel, reasoningEffort: effort ?? null },
            ...(modeId !== undefined ? { mode: modeId } : {}),
            ...(escalations.length > 0 ? { approvedEscalations: escalations } : {}),
            note: 'the child session inherits this session composition (same tools, same workspace); send it follow-up input by opening its session in the GUI',
          })
        } catch (error) {
          return jsonText({ ok: false, error: errText(error) })
        }
      },
    })
    const dispose = ctx.tools.register(tool)
    ctx.effect(() => () => { try { dispose() } catch (error) { /* best-effort */ } })
  },
}

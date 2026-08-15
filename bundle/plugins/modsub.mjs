// description: 子代理派发（spawn_model_subagent）：可选 provider/model/effort/模式，默认全继承父代理，提权自动问用户。
import yaml from 'js-yaml'
import { defineTool } from '@deepseek-ai/dsh-tools'

function errText(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}
function jsonText(value) {
  return JSON.stringify(value, null, 2)
}

// ── model taxonomy (kept in sync with modelroute.mjs) ────────────────────
const DEFAULT_SERIES = {
  deepseek: { match: /^deepseek/i, tiers: ['flash', 'lite', 'pro', 'max'] },
  claude: { match: /^(claude|anthropic)/i, tiers: ['haiku', 'sonnet', 'opus'] },
  chatgpt: { match: /^(gpt|chatgpt|o1|o3|openai)/i, tiers: ['mini', 'lite', 'pro', 'max'] },
  qwen: { match: /^qwen/i, tiers: ['flash', 'lite', 'plus', 'max'] },
}

function matchSeries(spec, id) {
  if (spec !== null && typeof spec === 'object' && spec.match instanceof RegExp) {
    const re = new RegExp(spec.match.source, spec.match.flags.replace(/[gy]/g, ''))
    return re.test(id)
  }
  return id.toLowerCase().includes(String(spec?.match ?? '').toLowerCase())
}

function seriesOf(modelId) {
  const id = String(modelId ?? '')
  for (const [name, spec] of Object.entries(DEFAULT_SERIES)) {
    if (matchSeries(spec, id)) return name
  }
  return null
}

function tierOf(seriesName, modelId) {
  const spec = DEFAULT_SERIES[seriesName]
  if (spec === undefined || !Array.isArray(spec.tiers)) return -1
  const id = String(modelId ?? '').toLowerCase()
  for (let i = 0; i < spec.tiers.length; i += 1) {
    if (id.includes(String(spec.tiers[i]).toLowerCase())) return i
  }
  return -1
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

// ── spawn_model_subagent v2 ──────────────────────────────────────────────
// Subagent spawning with explicit mode / reasoning-effort / provider / model
// controls. Defaults INHERIT the parent (same provider, same model, same
// effort, same preset) so billing and capability never silently change:
//   - provider: only an EXPLICIT provider argument may switch the provider
//     (explicit model alone keeps the parent\'s provider — billing safety).
//   - model: explicit model wins; otherwise the parent's live route model.
//   - reasoningEffort: explicit value, else the parent's CURRENT effort
//     (snapshot at spawn; applies to every turn of the child).
//   - mode (agent preset): explicit preset id re-composes the child before
//     its first prompt assembly; otherwise the child inherits the parent's
//     composition as usual.
// Escalation policy: any upgrade — a higher model tier in the same series, a
// cross-series model change, or a target preset that adds capabilities —
// asks the user through the approval service (allowed-once). Equal or lower
// tiers / equal or fewer capabilities proceed without asking.
export default {
  inject: ['tools', 'subagents'],
  apply(ctx) {
    const subagents = ctx.subagents
    const agents = ctx.get('agents')
    const presets = ctx.get('agentPresets')
    const approval = ctx.get('approval')

    const effortByChild = new Map() // childSessionId -> reasoningEffort (explicit or parent snapshot)
    const modeByChild = new Map() // childSessionId -> presetId to re-compose
    const disposers = new Map() // agentId -> agent/request disposer

    function liveRoute(parent) {
      const header = parent.session?.requestHeader?.()
      const cfg = header?.config
      if (cfg !== undefined && cfg.provider && cfg.model) {
        return { provider: cfg.provider, model: cfg.model, reasoningEffort: cfg.reasoningEffort }
      }
      return { provider: parent.options?.provider, model: parent.options?.model, reasoningEffort: undefined }
    }

    // Re-compose freshly created children to an explicit preset, and inject
    // the child's reasoning effort on every model request. Runs at
    // `agent/created` (publication), before the first prompt assembly.
    ctx.on('agent/created', ({ agent }) => {
      if (agent === undefined || agent.ctx === undefined) return
      const sid = agent.session?.id
      if (sid === undefined) return

      const modeId = modeByChild.get(sid)
      if (modeId !== undefined && presets !== undefined) {
        modeByChild.delete(sid)
        presets.recompose(agent.ctx, modeId).then((preset) => {
          try { agent.session.append('agent-preset/selected', { agentPreset: preset.id }) } catch (error) { /* durable record is best-effort */ }
        }).catch((error) => console.error('[modsub] child preset recompose failed for', sid, ':', errText(error)))
      }

      const effort = effortByChild.get(sid)
      if (effort !== undefined) effortByChild.delete(sid)

      try {
        const off = agent.ctx.on('agent/request', async (_payload, next) => {
          const resolved = await next()
          if (effort === undefined || resolved.reasoningEffort === effort) return resolved
          try {
            return { ...resolved, reasoningEffort: effort }
          } catch (error) {
            return resolved
          }
        }, { prepend: true })
        disposers.set(agent.id, off)
      } catch (error) {
        console.error('[modsub] failed to install effort injection for', sid, ':', errText(error))
      }
    })
    ctx.on('agent/disposed', ({ agent }) => {
      const off = disposers.get(agent?.id)
      if (off !== undefined) {
        try { off() } catch (error) { /* best-effort */ }
        disposers.delete(agent.id)
      }
    })

    const tool = defineTool({
      name: 'spawn_model_subagent',
      description: 'Spawn a durable, continuable subagent session that inherits this session\'s composition (same tools, same workspace) and, by default, the parent\'s `provider`/`model`/`reasoningEffort`/`mode` (agent preset), so billing never silently changes. Passing any of these explicitly overrides only that axis: an explicit `model` alone keeps the parent\'s provider. Escalation — a higher model tier in the same series, a cross-series model change, or a target preset that adds capabilities — asks the user for approval and cancels unless allowed; equal-or-lower tiers and equal-or-fewer capabilities proceed without asking. See `model_list` for available provider/model pairs. The returned childId is the child session id: the user can open it in the GUI and send screenshots/text to it, and the child reports its final answer back to this session.',
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

          const route = liveRoute(agent)
          const parentHeader = agent.session?.requestHeader?.()
          const parentPreset = presets !== undefined ? presets.composedPreset(agent.ctx) : undefined
          const parentModel = route.model ?? parentHeader?.config?.model
          const childModel = explicitModel ?? parentModel
          const childProvider = explicitProvider ?? route.provider
          const effort = explicitEffort ?? parentHeader?.config?.reasoningEffort

          // ── escalation detection ─────────────────────────────────────────
          const escalations = []

          // model tier / series
          if (explicitModel !== undefined && parentModel !== undefined && childModel !== parentModel) {
            const ps = seriesOf(parentModel)
            const cs = seriesOf(childModel)
            if (ps !== null && cs !== null && ps === cs) {
              const pt = tierOf(ps, parentModel)
              const ct = tierOf(cs, childModel)
              if (ct > pt) escalations.push('model tier upgrade: ' + parentModel + ' (tier ' + pt + ') -> ' + childModel + ' (tier ' + ct + ')')
            } else if (ps !== cs) {
              escalations.push('model series change: ' + parentModel + ' -> ' + childModel + ' (different vendor family; billing semantics unknown)')
            }
          }

          // preset capability increase
          let added = []
          if (modeId !== undefined && parentPreset !== undefined && modeId !== parentPreset && presets !== undefined) {
            try {
              const currentNames = pluginNames(await presets.read(parentPreset))
              const targetNames = pluginNames(await presets.read(modeId))
              added = addedNames(currentNames, targetNames)
              if (added.length > 0) escalations.push('preset upgrade: "' + parentPreset + '" -> "' + modeId + '" adds capabilities: ' + added.slice(0, 8).join(', '))
            } catch (error) { /* comparison is best-effort; spawning still validates the target */ }
          }

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

          if (effort !== undefined && typeof effort === 'string') effortByChild.set(started.childId, effort)
          if (modeId !== undefined) modeByChild.set(started.childId, modeId)

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

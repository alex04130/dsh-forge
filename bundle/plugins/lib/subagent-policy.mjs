import yaml from 'js-yaml'

// ── dsh-forge shared subagent policy ────────────────────────────────────────
// One implementation for every delegation surface (spawn_model_subagent,
// switch_mode, team_add_member): preset capability-face comparison, model
// series/tier taxonomy, escalation collection, and the child-side mode /
// effort injection (re-compose on the first pre-step, effort on every
// request). No hard-coded permission ladders: the capability face IS the
// plugin-row set of the preset composition, with cordis:group rows expanded
// recursively — the official `!!js` YAML tag is accepted (we only need row
// names, so the expression is kept as text instead of evaluated).

// !!js tag: official compositions carry `disabled: !!js <expression>`.
const JsTag = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: () => true,
  construct: (data) => String(data),
})
const SCHEMA = yaml.DEFAULT_SCHEMA.extend([JsTag])

/**
 * Collect every plugin row name of one composition, expanding `cordis:group`
 * rows (group: true) into their nested rows. Returns null when the text
 * cannot be parsed — callers treat that as an unknown capability face.
 */
export function rowNamesOf(compositionText) {
  try {
    const doc = yaml.load(compositionText, { schema: SCHEMA })
    const names = []
    const walk = (node) => {
      if (Array.isArray(node)) { for (const item of node) walk(item); return }
      if (node === null || typeof node !== 'object') return
      if (node.group === true) {
        if (Array.isArray(node.config)) { for (const item of node.config) walk(item) }
        return
      }
      if (typeof node.name === 'string' && node.name.length > 0) names.push(node.name)
      for (const value of Object.values(node)) walk(value)
    }
    walk(doc)
    return [...new Set(names)]
  } catch (error) {
    return null
  }
}

/** Rows the target preset adds over the current one; null = face unknown. */
export function addedRows(currentNames, targetNames) {
  if (currentNames === null || targetNames === null) return null
  const have = new Set(currentNames)
  return targetNames.filter((name) => !have.has(name))
}

/** Escalation strings for a preset switch; [] = same or fewer capabilities. */
export async function collectPresetEscalations({ parentPreset, targetPreset, presets }) {
  if (parentPreset === undefined || targetPreset === undefined || presets === undefined) return []
  if (parentPreset === targetPreset) return []
  let currentNames = null
  let targetNames = null
  try { currentNames = rowNamesOf(await presets.read(parentPreset)) } catch (error) { currentNames = null }
  try { targetNames = rowNamesOf(await presets.read(targetPreset)) } catch (error) { targetNames = null }
  const added = addedRows(currentNames, targetNames)
  if (added === null) {
    return ['preset capability face unknown (a composition could not be parsed); treated as an upgrade']
  }
  if (added.length > 0) {
    return ['preset upgrade: "' + parentPreset + '" -> "' + targetPreset + '" adds capabilities: ' + added.slice(0, 8).join(', ') + (added.length > 8 ? ' …' : '')]
  }
  return []
}

// ── model series taxonomy (kept in sync with modelroute.mjs) ──────────────
export const DEFAULT_SERIES = {
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

export function seriesOf(modelId) {
  const id = String(modelId ?? '')
  for (const [name, spec] of Object.entries(DEFAULT_SERIES)) {
    if (matchSeries(spec, id)) return name
  }
  return null
}

export function tierOf(seriesName, modelId) {
  const spec = DEFAULT_SERIES[seriesName]
  if (spec === undefined || !Array.isArray(spec.tiers)) return -1
  const id = String(modelId ?? '').toLowerCase()
  for (let i = 0; i < spec.tiers.length; i += 1) {
    if (id.includes(String(spec.tiers[i]).toLowerCase())) return i
  }
  return -1
}

/** Model escalation strings for an explicit child model vs the parent model. */
export function collectModelEscalations(parentModel, childModel) {
  if (parentModel === undefined || childModel === undefined || childModel === parentModel) return []
  const ps = seriesOf(parentModel)
  const cs = seriesOf(childModel)
  if (ps !== null && cs !== null && ps === cs) {
    const pt = tierOf(ps, parentModel)
    const ct = tierOf(cs, childModel)
    if (ct > pt) return ['model tier upgrade: ' + parentModel + ' (tier ' + pt + ') -> ' + childModel + ' (tier ' + ct + ')']
    return []
  }
  if (ps !== cs) {
    return ['model series change: ' + parentModel + ' -> ' + childModel + ' (different vendor family; billing semantics unknown)']
  }
  return []
}

// ── child-side mode / effort injection ─────────────────────────────────────
// Applies an explicit preset to a freshly created child BEFORE its first
// prompt assembly (first agent/pre-step, prepend) and pins its reasoning
// effort on every model request. Shared by spawn_model_subagent and
// team_add_member so both delegation surfaces behave identically.
export function installChildPolicy(ctx, presets) {
  const agents = ctx.get('agents')
  const modeByChild = new Map()
  const effortByChild = new Map()
  const disposers = new Map()
  const preStepDisposers = new Map()

  ctx.on('agent/created', ({ agent }) => {
    if (agent === undefined || agent.ctx === undefined) return
    const sid = agent.session?.id
    if (sid === undefined) return

    const modeId = modeByChild.get(sid)
    if (modeId !== undefined && presets !== undefined) {
      modeByChild.delete(sid)
      try {
        const preStepOff = agent.ctx.on('agent/pre-step', async (_payload, next) => {
          try { preStepOff() } catch (error) { /* best-effort */ }
          try {
            const preset = await presets.recompose(agent.ctx, modeId)
            try { agent.session.append('agent-preset/selected', { agentPreset: preset.id }) } catch (error) { /* durable record is best-effort */ }
          } catch (error) {
            console.error('[subagent-policy] child preset recompose failed for', sid, ':', String(error && error.message ? error.message : error))
          }
          return next()
        }, { prepend: true })
        preStepDisposers.set(agent.id, preStepOff)
      } catch (error) {
        console.error('[subagent-policy] failed to install preset re-composition for', sid, ':', String(error && error.message ? error.message : error))
      }
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
      console.error('[subagent-policy] failed to install effort injection for', sid, ':', String(error && error.message ? error.message : error))
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const off = disposers.get(agent?.id)
    if (off !== undefined) {
      try { off() } catch (error) { /* best-effort */ }
      disposers.delete(agent.id)
    }
    const pso = preStepDisposers.get(agent?.id)
    if (pso !== undefined) {
      try { pso() } catch (error) { /* best-effort */ }
      preStepDisposers.delete(agent.id)
    }
  })

  return {
    register(childId, options = {}) {
      if (options.mode !== undefined) modeByChild.set(childId, options.mode)
      if (options.effort !== undefined) effortByChild.set(childId, options.effort)
    },
    liveRoute(parent) {
      const header = parent.session?.requestHeader?.()
      const cfg = header?.config
      if (cfg !== undefined && cfg.provider && cfg.model) {
        return { provider: cfg.provider, model: cfg.model, reasoningEffort: cfg.reasoningEffort }
      }
      return { provider: parent.options?.provider, model: parent.options?.model, reasoningEffort: undefined }
    },
  }
}

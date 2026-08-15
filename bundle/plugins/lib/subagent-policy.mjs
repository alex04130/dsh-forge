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
//
// Timing contract: `startContinuable` dispatches `agent/created` SYNCHRONOUSLY
// before it resolves, so a map written after the await is always too late.
// Callers therefore PREPARE the options before starting the spawn; the
// agent/created listener consumes the pending slot and attaches the
// pre-step/request hooks while the child is still unpublished.
export function installChildPolicy(ctx, presets) {
  const agents = ctx.get('agents')
  const sessionPersistence = ctx.get('sessionPersistence')
  const modeByChild = new Map()
  const effortByChild = new Map()
  // Staged options keyed by the PARENT session id (FIFO per parent): written
  // before startContinuable, consumed by the synchronously-dispatched
  // agent/created. Keying by parent keeps concurrent spawns from different
  // parents from stealing each other's options.
  const stagedByParent = new Map()
  const disposers = new Map()
  const preStepDisposers = new Map()

  function attachMode(agent, modeId) {
    if (presets === undefined) return
    try {
      const preStepOff = agent.ctx.on('agent/pre-step', async (_payload, next) => {
        try { preStepOff() } catch (error) { /* best-effort */ }
        try {
          const preset = await presets.recompose(agent.ctx, modeId)
          try { agent.session.append('agent-preset/selected', { agentPreset: preset.id }) } catch (error) { /* durable record is best-effort */ }
        } catch (error) {
          console.error('[subagent-policy] child preset recompose failed for', agent.id, ':', String(error && error.message ? error.message : error))
        }
        return next()
      }, { prepend: true })
      preStepDisposers.set(agent.id, preStepOff)
    } catch (error) {
      console.error('[subagent-policy] failed to install preset re-composition for', agent.id, ':', String(error && error.message ? error.message : error))
    }
  }

  function attachEffort(agent, effort) {
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
      console.error('[subagent-policy] failed to install effort injection for', agent.id, ':', String(error && error.message ? error.message : error))
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    if (agent === undefined || agent.ctx === undefined) return
    const sid = agent.session?.id

    // 1) consume the staged options prepared before spawn (FIFO per parent)
    let modeId = undefined
    let effort = undefined
    let parentId = undefined
    try { parentId = agent.session !== undefined && agent.session.header !== undefined ? agent.session.header.parentSession : undefined } catch (error) { parentId = undefined }
    if (typeof parentId === 'string' && parentId.length > 0) {
      const q = stagedByParent.get(parentId)
      if (q !== undefined && q.length > 0) {
        const staged = q.shift()
        if (q.length === 0) stagedByParent.delete(parentId)
        modeId = staged.mode
        effort = staged.effort
      }
    }
    // 2) fall back to the by-child maps (register-after-spawn compat path)
    if (sid !== undefined) {
      if (modeId === undefined) modeId = modeByChild.get(sid)
      if (effort === undefined) effort = effortByChild.get(sid)
      if (modeId !== undefined) modeByChild.delete(sid)
      if (effort !== undefined) effortByChild.delete(sid)
    }

    if (modeId !== undefined) attachMode(agent, modeId)
    if (effort !== undefined) attachEffort(agent, effort)

    // 3) log correction: a resumed child whose session log records a preset
    // selection (deferred UI switch while offline, or a prior switch_mode)
    // must come back on THAT preset, not on the parent's current composition.
    // The in-process followup path (coldResume → composeFrom(parent)) ignores
    // the log, which silently reverted deferred switches to the parent preset.
    // The hook is attached unconditionally and the inspect runs INSIDE the
    // first pre-step so the timing guarantee matches the staged path.
    if (modeId === undefined && sid !== undefined && presets !== undefined && sessionPersistence !== undefined && typeof sessionPersistence.inspect === 'function') {
      try {
        const preStepOff = agent.ctx.on('agent/pre-step', async (_payload, next) => {
          try { preStepOff() } catch (error) { /* best-effort */ }
          try {
            const inspection = await sessionPersistence.inspect(sid)
            let logged = undefined
            for (const event of (Array.isArray(inspection.events) ? inspection.events : [])) {
              if (event !== null && typeof event === 'object' && event.type === 'agent-preset/selected' && event.data !== null && typeof event.data === 'object' && typeof event.data.agentPreset === 'string') logged = event.data.agentPreset
            }
            if (logged !== undefined) {
              let current = undefined
              try { current = presets.composedPreset(agent.ctx) } catch (error) { current = undefined }
              if (current !== logged) {
                await presets.recompose(agent.ctx, logged)
                try { agent.session.append('agent-preset/selected', { agentPreset: logged }) } catch (error) { /* durable record is best-effort */ }
              }
            }
          } catch (error) {
            console.error('[subagent-policy] log-correction recompose failed for', agent.id, ':', String(error && error.message ? error.message : error))
          }
          return next()
        }, { prepend: true })
        preStepDisposers.set(agent.id, preStepOff)
      } catch (error) {
        console.error('[subagent-policy] failed to install log correction for', agent.id, ':', String(error && error.message ? error.message : error))
      }
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
    /** Stage options for the next child of one parent; call BEFORE startContinuable. */
    prepare(options = {}) {
      if (options.mode === undefined && options.effort === undefined) return { cancel() {} }
      const parentId = String(options.parentId ?? '')
      if (parentId === '') return { cancel() {} }
      const entry = { mode: options.mode, effort: options.effort }
      const q = stagedByParent.get(parentId)
      if (q === undefined) stagedByParent.set(parentId, [entry])
      else q.push(entry)
      return {
        cancel() {
          const list = stagedByParent.get(parentId)
          if (list === undefined) return
          const idx = list.indexOf(entry)
          if (idx >= 0) list.splice(idx, 1)
          if (list.length === 0) stagedByParent.delete(parentId)
        },
      }
    },
    /** Compat entry: apply to an already-created child, or stage by id. */
    register(childId, options = {}) {
      const agent = typeof childId === 'string' && childId.length > 0 ? agents.get(childId) : undefined
      if (agent !== undefined && agent.ctx !== undefined) {
        if (options.mode !== undefined) attachMode(agent, options.mode)
        if (options.effort !== undefined) attachEffort(agent, options.effort)
      } else {
        if (options.mode !== undefined) modeByChild.set(childId, options.mode)
        if (options.effort !== undefined) effortByChild.set(childId, options.effort)
      }
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

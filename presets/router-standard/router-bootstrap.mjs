/**
 * router-bootstrap: task-aware reasoning-mode router with a continuous
 * react↔spec axis (adapted from dsh-router-standard, MIT — see NOTICE).
 *
 * Reads the session's first user message, classifies the task into a
 * continuous mode in [0,1] (0 = spec plan-first, 1 = react doer), and on the
 * first model request injects the matching persona and first-turn core tool
 * set. After the first durable tool/call the full preset catalog is exposed
 * and nothing is touched again. `sessionMode` reads the first durable
 * `user/message`, or — on the very first turn, before the claimed message is
 * appended — the first user-sourced `agent/inbox/spliced` event, so reload
 * keeps the same classification.
 *
 * OUR ADDITION (anchored-standard refinement): the first turn is a MINIMAL
 * anchor — only the routed persona (+ the plan-mode boundary when active) in
 * the prompt, the core tool set, and no injected baseline. The
 * workspace-instructions baseline (AGENTS.md / CLAUDE.md,
 * source.kind === "agent-instructions") and the skill catalog/content
 * (source.kind === "skill-catalog" | "skill-invocation") are SUPPRESSED on the
 * first turn and restored after the first durable tool/call; a large
 * repo-guide or skill persona in the first request dilutes the anchor and
 * routes into the ambiguous/mixed band. The suppression is a `prepend` handler
 * on `agent/pre-step`, so it wraps those injections.
 *
 * Zero external imports on purpose: relative preset rows resolve bare
 * specifiers from the user home, where `@deepseek-ai/*` is not installed.
 */

import {
  applyPersona, bandFor, bandOf, coreFor, parseMode, personaFor, sessionMode, testinessFor, clamp01,
  isComplexTask, extractText,
} from './router-core.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'router-bootstrap'

/** Prompt assembly, the tools registry, and the LLM route must exist. */
export const inject = ['systemPrompt', 'tools', 'llm']

/** Minimal spec → JSON Schema compiler (subset of defineTool's work). */
function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, meta] of Object.entries(spec || {})) {
    const prop = { type: meta.type }
    if (Array.isArray(meta.enum)) prop.enum = meta.enum
    if (meta.description) prop.description = meta.description
    properties[key] = prop
    if (meta.required) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

export function apply(ctx, config) {
  const overrides = new Map() // session id -> explicit mode (number 0..1 or 'weak')
  const agents = new Map() // session id -> Agent (live handle, in-process only)

  // ── anchor applicability ────────────────────────────────────────────────
  // The minimal first-turn anchor (persona routing + core tool set + baseline
  // suppression) is a mitigation for deepseek-v4's overfitting / RL-alignment
  // drift. It must NOT apply to other model series — they were never measured
  // against the react↔spec bands and need no anchoring, so they get the full
  // assembled prompt and the full tool catalog from the first request.
  // Configurable: config.anchorModels (regex or array of model ids);
  // default = model ids starting with "deepseek".
  const ANCHOR_DEFAULT = /^deepseek/i
  const anchorSpec = config.anchorModels ?? ANCHOR_DEFAULT
  function anchorApplies(agent) {
    const model = String(agent?.options?.model ?? '')
    if (model === '') return true // unknown model: keep the conservative anchor
    if (anchorSpec instanceof RegExp) {
      const re = new RegExp(anchorSpec.source, anchorSpec.flags.replace(/[gy]/g, ''))
      return re.test(model)
    }
    if (Array.isArray(anchorSpec)) return anchorSpec.some((m) => String(m) === model)
    return ANCHOR_DEFAULT.test(model)
  }

  // Explicit override wins; otherwise the durable-event classification
  // (sessionMode reads the first user/message or, on the first turn, the
  // first user-sourced inbox splice).
  function modeFor(session) {
    return overrides.get(session.id) ?? sessionMode(session)
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const agent = context.agent
    if (agent === undefined) return assembled
    const session = agent.session
    agents.set(session.id, agent)

    // Non-anchored models: leave the assembly untouched (full boilerplate +
    // full catalog + no persona swap) for the whole session.
    if (!anchorApplies(agent)) return assembled

    const mode = modeFor(session)
    const modelId = agent.options?.model
    const persona = personaFor(mode, modelId)

    // The persona stays constant for the whole session (mode is fixed); only
    // the surface changes once, after the first durable tool/call.
    const sections = applyPersona(assembled.sections, persona)
    const promoted = session.events.some((event) => event.type === 'tool/call')

    if (promoted) {
      return { ...assembled, sections, contexts: [] } // promoted: full catalog + full sections
    }

    // First turn: minimal anchor — the persona plus the plan-mode boundary
    // (when active); drop the Web orientation, tool guidance, delegation
    // guidance and runtime context that would dilute the first-turn anchor.
    const personaSection = sections.find((section) => section.name === 'router-persona')
    const planSection = sections.find((section) => section.name === 'plan:policy')
    const activePlan = planSection !== undefined && (planSection.text ?? '').trim() !== '' ? [planSection] : []
    const minimalSections = [personaSection, ...activePlan].filter(Boolean)

    const core = new Set(coreFor(mode))
    const available = new Set(assembled.tools.map((tool) => tool.name))
    const shell = available.has('pwsh') ? 'pwsh' : available.has('bash') ? 'bash' : null
    if (shell === null) {
      throw new Error(`${name}: no platform shell in catalog`)
    }
    core.add(shell)

    return {
      ...assembled,
      sections: minimalSections,
      contexts: [],
      tools: assembled.tools.filter((tool) => core.has(tool.name)),
    }
  })

  // ── OUR ADDITION: suppress the first-turn injections that dilute the minimal
  //    anchor — the workspace-instructions baseline (AGENTS.md / CLAUDE.md,
  //    source.kind === "agent-instructions" && baseline) and the skill catalog /
  //    skill content (source.kind === "skill-catalog" | "skill-invocation").
  //    `prepend` makes this handler OUTERMOST, so its `next()` already includes
  //    the inner injections that we then filter out; everything is restored
  //    after the first durable tool/call. ─────────────────────────────────────
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    const agent = payload.agent
    if (agent === undefined || agent.session === undefined) return decision
    if (!anchorApplies(agent)) return decision // non-anchored models keep all injections
    if (agent.session.events.some((event) => event.type === 'tool/call')) return decision
    const isFirstTurnSuppressed = (m) => {
      if (m === null || typeof m !== 'object') return false
      const src = m.source
      if (src === null || typeof src !== 'object') return false
      if (src.kind === 'agent-instructions') return src.baseline === true
      return src.kind === 'skill-catalog' || src.kind === 'skill-invocation'
    }
    const messages = Array.isArray(decision.messages)
      ? decision.messages.filter((m) => !isFirstTurnSuppressed(m))
      : decision.messages
    return { ...decision, messages }
  }, { prepend: true })

  // ── near-field routing guidance for weak mode ─────────────────────────────
  const GUIDE_WEAK =
    '\nRouter: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first. Think deeply first, then commit and act.'
  const GUIDE_DEEP =
    '\nRouter: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first. Think deeply about the architecture, edge cases, and integration points. Do not spend reasoning on the environment or tooling. Produce when your information is complete. End each reasoning block with a decision or an information need.'

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message') return
    const data = event.data ?? {}
    if (data.source?.kind !== 'user') return // only real user messages
    const agent = ctx.get('agent')
    const target = agent !== undefined && agent.session === session ? agent : [...agents.values()].find((a) => a.session === session)
    if (target === undefined || target.inbox === undefined) return
    if (!anchorApplies(target)) return // no near-field guidance for other series
    const mode = modeFor(session)
    if (bandOf(mode) !== 'weak') return // strong modes need no guidance
    const text = extractText(data)
    if (!text.trim()) return
    const guide = isComplexTask(text) ? GUIDE_DEEP : GUIDE_WEAK
    try {
      target.inbox.append('next-step', {
        id: `router-guide-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        source: { kind: 'plugin', plugin: 'router-bootstrap' },
        content: [{ type: 'text', text: guide }],
      })
    } catch { /* duplicate/ordering races: skip */ }
  })

  // ── router visibility & tuning (agent self-optimization) ────────────────
  const registerTool = (tool) => {
    ctx.effect(() => ctx.tools.register({
      ...tool,
      parameters: toJsonSchema(tool.parameters),
    }))
  }

  const modeSpec = {
    mode: {
      type: 'string',
      required: true,
      description: 'band name (spec / weak / mixed / react), a 0-100 number, a 0.0-1.0 number, or auto to clear the override',
    },
  }

  function fmtMode(mode) {
    return typeof mode === 'string' ? mode : mode.toFixed(2)
  }

  function currentSession() {
    const agent = ctx.get('agent')
    if (agent !== undefined && agent.session !== undefined) return agent.session
    const last = [...agents.values()].at(-1)
    return last?.session
  }

  function currentAgent() {
    const session = currentSession()
    return session === undefined ? undefined : [...agents.values()].find((a) => a.session === session)
  }

  registerTool({
    name: 'dev_router_status',
    description: "Show this session's reasoning-mode routing: mode, band, persona, first-turn core tools, test-suppression, and whether an override is active.",
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute() {
      const session = currentSession()
      if (session === undefined) return 'no agent session'
      const agent = currentAgent()
      if (agent !== undefined && !anchorApplies(agent)) {
        return [
          'router BYPASSED: model "' + String(agent.options?.model ?? 'unknown') + '" is not in the anchor series (first-turn anchor / tool narrowing / baseline suppression all off — full catalog from the first request)',
          'anchorSpec=' + String(anchorSpec),
        ].join('\n')
      }
      const mode = modeFor(session)
      const modelId = currentAgent()?.options?.model
      return [
        `mode=${fmtMode(mode)} (band=${bandFor(mode)})`,
        `persona=${personaFor(mode, modelId).replace(/\n/g, ' / ')}`,
        `core=[${coreFor(mode).join(', ')}]`,
        `testiness=${testinessFor(mode)}`,
        `override=${overrides.has(session.id) ? 'yes' : 'no'}`,
      ].join('\n')
    },
  })

  registerTool({
    name: 'dev_router_mode',
    description: "Set this session's reasoning mode: spec (plan-first) / weak (internal routing, model decides per task) / mixed (transition, trap) / react (doer). Accepts band names, 0-100, or 0.0-1.0; use auto to return to task classification. The next request applies it.",
    parameters: modeSpec,
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute(args) {
      const parsed = parseMode(args.mode)
      if (parsed === null) return `invalid mode "${args.mode}": use spec/weak/mixed/react, 0-100, 0.0-1.0, or auto`
      const session = currentSession()
      if (session === undefined) return 'no agent session'
      if (parsed === 'auto') overrides.delete(session.id)
      else overrides.set(session.id, parsed === 'weak' ? 'weak' : clamp01(parsed))
      const current = modeFor(session)
      return `mode=${fmtMode(current)} (band=${bandFor(current)}) — next request applies`
    },
  })

  registerTool({
    name: 'dev_mode_subagent',
    description: 'Run one task in a DIFFERENT reasoning mode than this session, in a fresh isolated context (own system prompt). The current session trajectory is untouched. Mode: spec (plan-first) / weak (internal routing) / react (doer) / balanced. Returns the subagent\'s answer text.',
    parameters: {
      mode: { type: 'string', required: true, description: 'spec / weak / react / balanced (or 0-100)' },
      task: { type: 'string', required: true, description: 'the task to hand to the mode-isolated subagent' },
      maxTokens: { type: 'number', description: 'output cap (default 1024)' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      const parsed = parseMode(args.mode)
      if (parsed === null || parsed === 'auto') return `invalid mode "${args.mode}"`
      const session = currentSession()
      const agent = session === undefined ? undefined : [...agents.values()].find((a) => a.session === session)
      if (agent === undefined || agent.options === undefined) return 'no agent route available'
      const { provider, model } = agent.options
      if (!provider || !model) return 'agent route missing provider/model'

      const persona = personaFor(parsed, model)
      const maxTokens = Number(args.maxTokens || 1024)
      let text = ''
      let reasoningChars = 0
      try {
        const stream = ctx.llm.stream({
          provider,
          model,
          system: persona,
          messages: [{ role: 'user', content: [{ type: 'text', text: String(args.task) }] }],
          maxTokens,
        })
        for await (const chunk of stream) {
          if (chunk.type === 'text-delta') text += chunk.text
          else if (chunk.type === 'reasoning-delta') reasoningChars += chunk.text.length
        }
      } catch (error) {
        return `subagent error: ${error && error.message ? error.message : String(error)}`
      }
      const head = text.slice(0, 3000)
      return `[mode-subagent ${bandFor(parsed)} | reasoning ${reasoningChars} chars]\n${head}${text.length > 3000 ? '\n…(truncated)' : ''}`
    },
  })
}

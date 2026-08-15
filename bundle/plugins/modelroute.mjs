// description: 子代理模型路由策略：子代理默认继承父的 live 路由（绝不静默升级），显式指定才用别的；plan 计费重写。
import { defineTool } from '@deepseek-ai/dsh-tools'

// dsh-modelroute: subagent model-inheritance policy + model-series taxonomy +
// plan-aware provider routing.
//
// Problem 1 (subagent silently upgrades): resolveChildAgentOptions inherits the
// parent's CREATION options, but dsh-host-apiproxy's per-agent model-selection
// rewrites a fresh child's agent/request to the GLOBAL default model (e.g.
// deepseek-v4-pro) — the parent's LIVE route is never consulted. A flash
// parent therefore spawns a pro child. Fix: an agent-scoped agent/request
// listener that, for subagent-origin children, honors an EXPLICIT provider/
// model request verbatim (higher or cross-vendor models are the user's choice),
// and only for IMPLICIT inheritance falls back to the parent's live route
// (never upgrades).
//
// Problem 2 (plan billing): model ids like deepseek-v4-flash/pro exist under
// MANY provider routes (deepseek-official, opencode-go, qwen-token-plan, …).
// When `config.plan` is set, we rewrite the provider to the plan's route for
// that model series so the plan gateway (and its key) is billed instead of the
// user's own official key.
//
// Taxonomy is config-extensible. An id matching no series is "unknown"; the
// policy then never dispatches a different model than the parent's main model.

const DEFAULT_SERIES = {
  deepseek: { match: /^deepseek/i, tiers: ['flash', 'lite', 'pro', 'max'] },
  claude: { match: /^(claude|anthropic)/i, tiers: ['haiku', 'sonnet', 'opus'] },
  chatgpt: { match: /^(gpt|chatgpt|o1|o3|openai)/i, tiers: ['mini', 'lite', 'pro', 'max'] },
  qwen: { match: /^qwen/i, tiers: ['flash', 'lite', 'plus', 'max'] },
}

function errText(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}
function jsonText(value) {
  return JSON.stringify(value, null, 2)
}

export default {
  inject: ['agents', 'tools'],
  apply(ctx, config = {}) {
    const series = { ...DEFAULT_SERIES, ...(config.series ?? {}) }
    const plan = config.plan ? String(config.plan) : null
    const planProvider = { ...(config.planProvider ?? {}) }

    const defined = (value) => value !== undefined && value !== ''

    function matchSeries(spec, id) {
      if (spec !== null && typeof spec === 'object' && spec.match instanceof RegExp) {
        // strip stateful g/y flags so repeated tests never advance lastIndex
        const re = new RegExp(spec.match.source, spec.match.flags.replace(/[gy]/g, ''))
        return re.test(id)
      }
      return id.toLowerCase().includes(String(spec?.match ?? '').toLowerCase())
    }

    function seriesOf(modelId) {
      const id = String(modelId ?? '')
      for (const [name, spec] of Object.entries(series)) {
        if (matchSeries(spec, id)) return name
      }
      return null
    }

    function tierOf(seriesName, modelId) {
      const spec = series[seriesName]
      if (spec === undefined || !Array.isArray(spec.tiers)) return -1
      const id = String(modelId ?? '').toLowerCase()
      for (let i = 0; i < spec.tiers.length; i += 1) {
        if (id.includes(String(spec.tiers[i]).toLowerCase())) return i
      }
      return -1
    }

    function liveRoute(parent) {
      const header = parent.session?.requestHeader?.()
      const cfg = header?.config
      if (cfg !== undefined && cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model }
      return { provider: parent.options?.provider, model: parent.options?.model }
    }

    function resolveSubagentRoute(agent, resolved) {
      const origin = agent.session?.header?.origin
      if (origin !== 'subagent') return resolved
      const parentId = agent.session?.header?.parentSession
      const parent = parentId === undefined ? undefined : ctx.agents.get(parentId)
      if (parent === undefined) return resolved
      const parentOptions = { provider: parent.options?.provider, model: parent.options?.model }
      const childOptions = { provider: agent.options?.provider, model: agent.options?.model }
      const childModel = defined(childOptions.model) ? childOptions.model : undefined
      const childProvider = defined(childOptions.provider) ? childOptions.provider : undefined
      // Explicit = the child was created with a provider/model that differs from
      // what it would silently inherit from the parent (its creation options).
      // Honor it VERBATIM — a user who explicitly asks for a higher or different
      // model must win over the never-upgrade policy.
      const explicitModel = childModel !== undefined && childModel !== parentOptions.model
      const explicitProvider = childProvider !== undefined && childProvider !== parentOptions.provider
      const parentRoute = liveRoute(parent)

      let model = resolved.model
      let provider = resolved.provider

      if (explicitModel) {
        model = childModel // user explicitly requested a model
      } else if (parentRoute.model) {
        // Implicit inheritance: never upgrade — use the parent's LIVE model.
        model = parentRoute.model
      }

      if (explicitProvider) {
        provider = childProvider // user explicitly requested a provider; no plan rewrite
      } else if (!explicitModel) {
        if (parentRoute.provider) provider = parentRoute.provider
      }
      // Explicit model without an explicit provider keeps the provider the
      // model-selection layer already resolved for it (never force the parent's).
      // Plan-aware billing still redirects when the provider was not explicit.
      if (!explicitProvider && plan !== null && model) {
        const s = seriesOf(model)
        if (s !== null && defined(planProvider[s])) {
          provider = String(planProvider[s])
        }
      }

      // Implicit effort inheritance: a subagent child without an explicitly
      // injected effort (see modsub's spawn_model_subagent) inherits the
      // parent's CURRENT reasoning effort instead of the provider default.
      let result = { ...resolved, provider, model }
      if (!defined(result.reasoningEffort)) {
        const parentHeader = parent.session?.requestHeader?.()
        const parentEffort = parentHeader?.config?.reasoningEffort
        if (defined(parentEffort)) result = { ...result, reasoningEffort: parentEffort }
      }
      return result
    }

    function applyPlanRoute(resolved) {
      if (plan === null) return resolved
      const model = resolved.model
      if (!model) return resolved
      const s = seriesOf(model)
      if (s === null) return resolved // unknown series: leave the route untouched
      const target = planProvider[s]
      if (!defined(target)) return resolved
      return { ...resolved, provider: String(target) }
    }

    // Per-agent agent/request policy. `prepend` makes this handler OUTERMOST so
    // its next() already includes dsh-host-apiproxy's model-selection rewrite
    // (which is what overwrites the inherited route with the global default).
    const disposers = new Map()
    ctx.on('agent/created', ({ agent }) => {
      if (agent === undefined || agent.ctx === undefined) return
      try {
        const off = agent.ctx.on('agent/request', async (_payload, next) => {
          const resolved = await next()
          try {
            const origin = agent.session?.header?.origin
            return origin === 'subagent'
              ? resolveSubagentRoute(agent, resolved)
              : applyPlanRoute(resolved)
          } catch (error) {
            console.error('[modelroute] policy failed, passing through:', errText(error))
            return resolved
          }
        }, { prepend: true })
        disposers.set(agent.id, off)
      } catch (error) {
        console.error('[modelroute] failed to install policy for', agent.id, ':', errText(error))
      }
    })
    ctx.on('agent/disposed', ({ agent }) => {
      const off = disposers.get(agent?.id)
      if (off !== undefined) {
        try { off() } catch (error) { /* best-effort */ }
        disposers.delete(agent.id)
      }
    })

    function registerTool(name, description, parameters, execute) {
      const tool = defineTool({
        name,
        description,
        parameters,
        output: {
          schema: { type: 'string' },
          render(_args, value) { return [{ type: 'text', text: typeof value === 'string' ? value : String(value) }] },
        },
        async execute(args, exec) {
          try { return await execute(args, exec) } catch (error) { return jsonText({ ok: false, error: errText(error) }) }
        },
      })
      const dispose = ctx.tools.register(tool)
      ctx.effect(() => () => { try { dispose() } catch (error) { /* best-effort */ } })
    }

    registerTool('model_taxonomy',
      'Show the model-series taxonomy (series, tier keywords) and classify one model id.',
      { model: { type: 'string', description: 'Optional model id to classify into a series and tier.' } },
      async (args) => {
        const summary = Object.entries(series).map(([name, spec]) => ({
          series: name,
          tiers: spec.tiers ?? [],
        }))
        const out = { ok: true, plan: plan, planProvider, series: summary }
        const model = String(args.model ?? '').trim()
        if (model !== '') {
          out.classify = { model, series: seriesOf(model), tier: seriesOf(model) === null ? null : tierOf(seriesOf(model), model) }
        }
        return jsonText(out)
      })

    registerTool('model_route_status',
      'Show the current agent route and, for subagents, the parent live route it is clamped to.',
      {},
      async (_args, exec) => {
        const agent = exec.agent
        if (agent === undefined) return jsonText({ ok: false, error: 'no agent context' })
        const route = liveRoute(agent)
        const origin = agent.session?.header?.origin
        const parentId = agent.session?.header?.parentSession
        const parent = parentId === undefined ? undefined : ctx.agents.get(parentId)
        return jsonText({
          ok: true,
          id: agent.id,
          origin: origin ?? 'top-level',
          route,
          ...(parent !== undefined ? { parentRoute: liveRoute(parent), clampedToParent: true } : {}),
        })
      })
  },
}

// description: 模型委派：model_list / model_call，把文本任务交给任意已配置的 provider/model 并取回完整结果。
import { defineTool } from '@deepseek-ai/dsh-tools'

let idCounter = 0
function makeId(prefix) {
  idCounter += 1
  return prefix + '-' + Date.now().toString(36) + '-' + idCounter.toString(36) + '-' + Math.floor(Math.random() * 1679615).toString(36)
}
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
    const llm = ctx.get('llm')
    const skills = ctx.get('skills')
    if (llm === undefined) return

    function registerTool(name, description, parameters, execute, timeoutMs) {
      const tool = defineTool({
        name,
        description,
        parameters,
        output: {
          schema: { type: 'string' },
          render(_args, value) { return [{ type: 'text', text: typeof value === 'string' ? value : String(value) }] },
        },
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        async execute(args, exec) {
          try {
            return await execute(args, exec)
          } catch (error) {
            return jsonText({ ok: false, error: errText(error) })
          }
        },
      })
      const dispose = ctx.tools.register(tool)
      ctx.effect(() => () => { try { dispose() } catch (error) { /* best-effort */ } })
    }

    registerTool('model_list',
      'List every LLM provider route registered in this DSH process and the models each route advertises, plus a reverse index (byModel: which providers serve each model id). Use it to pick a `provider`/`model` pair for `model_call` or `spawn_model_subagent`, or to check whether a vendor or model is configured. Providers are configured via the llm-pi-ai settings section (baseURL/api/apiKeyEnv/models); API keys resolve from the credential store per request.',
      {},
      async () => {
        const providers = llm.listProviders().map((p) => ({ id: p.id, name: p.name }))
        const models = {}
        for (const provider of providers) {
          try {
            const list = await llm.listModels(provider.id)
            models[provider.id] = list.map((m) => ({ id: m.id, name: m.name, description: typeof m.description === 'string' ? m.description : null }))
          } catch (error) {
            models[provider.id] = { error: errText(error) }
          }
        }
        const byModel = {}
        for (const [providerId, list] of Object.entries(models)) {
          if (!Array.isArray(list)) continue
          for (const m of list) {
            if (m === null || typeof m !== 'object' || typeof m.id !== 'string') continue
            if (byModel[m.id] === undefined) byModel[m.id] = []
            byModel[m.id].push(providerId)
          }
        }
        return jsonText({ ok: true, providers, models, byModel })
      })

    registerTool('model_call',
      'Call a model from another provider (or the same one) as a one-shot, text-only completion and return its complete reply as this tool call\'s result. This is NOT task delegation and NOT a subagent: the delegate model gets one turn, cannot call tools, and only returns text; the main model stays in control and digests the reply. Use it for a bounded text task (translate, summarize, classify, second opinion). Pick `provider`/`model` via `model_list`. Nested tool calling is unsupported: give the delegate everything it needs in the prompt and system text.',
      {
        provider: { type: 'string', required: true, description: 'Provider route id, e.g. "deepseek-official" or "kimi-coding" (see model_list).' },
        model: { type: 'string', required: true, description: 'Model id on that provider, e.g. "k3".' },
        prompt: { type: 'string', required: true, description: 'The task text for the delegate model.' },
        system: { type: 'string', description: 'Optional system instruction.' },
        history: { type: 'array', description: 'Optional prior turns as [{role:"user"|"assistant", text}].' },
        maxTokens: { type: 'number', description: 'Optional output token cap.' },
        reasoningEffort: { type: 'string', description: 'Optional provider-specific effort id.' },
      },
      async (args, exec) => {
        const provider = String(args.provider)
        const model = String(args.model)
        const prompt = String(args.prompt)
        if (provider.length === 0 || model.length === 0 || prompt.length === 0) return jsonText({ ok: false, error: 'provider, model, and prompt are required' })
        const known = llm.listProviders().map((p) => p.id)
        if (!known.includes(provider)) return jsonText({ ok: false, error: 'no adapter registered for provider "' + provider + '". Available: ' + known.join(', ') + '. See model_list.' })
        const messages = []
        if (Array.isArray(args.history)) {
          for (const item of args.history) {
            if (item === null || typeof item !== 'object') continue
            const role = item.role === 'assistant' ? 'assistant' : 'user'
            const text = typeof item.text === 'string' ? item.text : ''
            if (text.length === 0) continue
            messages.push(role === 'assistant'
              ? { id: makeId('h'), role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider, model } }
              : { id: makeId('h'), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
          }
        }
        messages.push({ id: makeId('u'), role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })
        const options = { provider, model, messages }
        if (typeof args.system === 'string' && args.system.length > 0) options.system = args.system
        if (typeof args.maxTokens === 'number' && args.maxTokens > 0) options.maxTokens = Math.floor(args.maxTokens)
        if (typeof args.reasoningEffort === 'string' && args.reasoningEffort.length > 0) options.reasoningEffort = args.reasoningEffort
        if (exec !== undefined && exec.signal !== undefined) options.signal = exec.signal
        let text = ''
        let reasoning = ''
        let usage = null
        let finish = 'unknown'
        let failure = null
        try {
          for await (const chunk of llm.stream(options)) {
            if (chunk === null || typeof chunk !== 'object') continue
            if (chunk.type === 'text-delta') text += chunk.text
            else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
            else if (chunk.type === 'usage' && chunk.usage !== null && typeof chunk.usage === 'object') {
              usage = {
                inputTokens: chunk.usage.inputTokens,
                outputTokens: chunk.usage.outputTokens,
                cacheReadTokens: chunk.usage.cacheReadTokens ?? null,
                cacheWriteTokens: chunk.usage.cacheWriteTokens ?? null,
                reasoningTokens: chunk.usage.reasoningTokens ?? null,
              }
            } else if (chunk.type === 'finish') {
              const reason = chunk.reason
              if (reason !== null && typeof reason === 'object' && (reason.kind === 'error' || reason.kind === 'aborted')) {
                finish = reason.kind
                const f = reason.failure
                failure = f !== null && typeof f === 'object'
                  ? { code: typeof f.code === 'string' ? f.code : null, message: typeof f.message === 'string' ? f.message : errText(f) }
                  : { code: null, message: 'unknown failure' }
              } else if (typeof reason === 'string') {
                finish = reason
              } else if (reason !== null && typeof reason === 'object' && typeof reason.kind === 'string') {
                finish = reason.kind
              } else {
                finish = String(reason ?? 'done')
              }
            }
          }
        } catch (error) {
          failure = { code: 'stream-failed', message: errText(error) }
          finish = 'stream-failed'
        }
        if (finish === 'error' || finish === 'aborted' || finish === 'stream-failed') {
          return jsonText({ ok: false, provider, model, finish, failure, partialText: text.length > 0 ? text : null })
        }
        return jsonText({ ok: true, provider, model, finish, text, reasoning: reasoning.length > 0 ? reasoning : null, usage })
      },
      600000)

  },
}

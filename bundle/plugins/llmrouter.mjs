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
      'List every LLM provider route registered in this DSH process and the models each route advertises. Use it before model_call to pick a provider/model pair, or to check whether a vendor is configured. Providers are activated through the llm-pi-ai settings section (baseURL/api/apiKeyEnv/models); API keys resolve from the credential store per request.',
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
        return jsonText({ ok: true, providers, models })
      })

    registerTool('model_call',
      'Call a model from another provider (or the same one) as a text-only one-shot and return its complete reply. The main model stays in control: this is delegation, not replacement. Use model_list first to pick provider/model. Nested tool calling is not supported: give the delegate model everything it needs inside the prompt and system text.',
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

    if (skills !== undefined) {
      let disposeSkill = undefined
      try {
        disposeSkill = skills.register({
          name: 'model-delegation',
          description: 'Delegate a text task to another provider or model with model_call, and inspect available routes with model_list.',
          whenToUse: 'When the user asks to use a different vendor or model for a task, to cross-check an answer with another model, or when a cheaper or faster model suffices for a bounded sub-task like translation, summarization, or a second opinion.',
          content: [
            '# Model delegation (llmrouter)',
            '',
            '`model_call` routes ONE text-only task to any provider/model registered in this DSH process. You remain in control: it returns the complete reply and you decide how to use it.',
            '',
            '## When to use',
            '- Call `model_list` first when you do not know which provider/model ids are available.',
            '- Use `model_call` when the user names another vendor or model, asks for a second opinion, or when a bounded sub-task (translate, summarize, classify) can go to a cheaper model.',
            '- Pass everything the delegate needs inside `prompt` (plus `system`): there is no nested tool calling on the delegate side.',
            '- Do NOT use `model_call` for the current conversation turn itself; the main model drives the session.',
            '',
            '## Rules',
            '- `provider` and `model` must come from `model_list`; unknown routes fail fast with the available list.',
            '- Report the delegate result faithfully, including its `finish` and `usage`, and say which provider/model produced it.',
            '- On `ok: false`, read `failure` and either retry with a corrected route or explain the failure to the user; do not loop more than twice on the same route.',
            '- Providers are activated in settings (`llm-pi-ai.providers`): adding a profile is zero-code; API keys resolve from the credential store.',
          ].join('\n'),
        })
      } catch (error) { /* skill registration is best-effort */ }
      if (disposeSkill !== undefined) ctx.effect(() => () => { try { disposeSkill() } catch (error) { /* best-effort */ } })
    }
  },
}

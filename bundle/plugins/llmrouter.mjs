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
      '列出本 DSH 进程中注册的每条 LLM 供应商路由及其提供的模型，外加一个反向索引（byModel：每个模型 id 由哪些供应商提供）。用于为 `model_call` 或 `spawn_model_subagent` 挑选 `provider`/`model` 组合，或检查某供应商/模型是否已配置。供应商通过 llm-pi-ai 设置项配置（baseURL/api/apiKeyEnv/models）；API 密钥按请求从凭据存储解析。用法规则见 `model-delegation` 技能。',
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
      '以一次性、纯文本补全的方式调用另一供应商（或同一供应商）的模型，并把它的完整回复作为本次工具调用的结果返回。这不是任务委派，也不是子代理：被借调模型只得到一个回合，不能调用工具，只返回文本；主模型始终掌控并消化回复。用于有边界的文本任务（翻译、摘要、分类、第二意见）。通过 `model_list` 挑选 `provider`/`model`。不支持嵌套工具调用：把被借调模型需要的一切都放进 prompt 和 system 文本里。用法规则见 `model-delegation` 技能。',
      {
        provider: { type: 'string', required: true, description: '供应商路由 id，如 "deepseek-official" 或 "kimi-coding"（见 model_list）。' },
        model: { type: 'string', required: true, description: '该供应商上的模型 id，如 "k3"。' },
        prompt: { type: 'string', required: true, description: '给被借调模型的任务文本。' },
        system: { type: 'string', description: '可选系统指令。' },
        history: { type: 'array', description: '可选先前回合，形如 [{role:"user"|"assistant", text}]。' },
        maxTokens: { type: 'number', description: '可选输出 token 上限。' },
        reasoningEffort: { type: 'string', description: '可选的供应商专属 effort id（思考强度）。' },
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

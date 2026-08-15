import { defineTool } from '@deepseek-ai/dsh-tools'

function errText(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}
function jsonText(value) {
  return JSON.stringify(value, null, 2)
}

export default {
  inject: ['tools', 'subagents'],
  apply(ctx) {
    const subagents = ctx.subagents

    const tool = defineTool({
      name: 'spawn_model_subagent',
      description: 'Spawn a durable, continuable subagent session that RUNS ON A CHOSEN provider/model (default kimi-coding/k3-256k) instead of inheriting the main session model. The child inherits this session composition (same tools, same workspace), so it can read files and images itself; its turns are billed to the chosen model and do NOT consume the main session context. Use it when a task needs a different model (e.g. vision-capable kimi) or when offloading work to avoid burning main-context tokens. The returned childId is the child session id: the user can open that session in the GUI and send screenshots/text to it, and the child reports its final answer back to this session.',
      parameters: {
        prompt: { type: 'string', required: true, description: 'The complete mission for the child agent (it sees nothing from this conversation).' },
        label: { type: 'string', description: 'Short display label for the child session.' },
        provider: { type: 'string', description: 'Provider route the child runs on; default "kimi-coding".' },
        model: { type: 'string', description: 'Model id for the child; default "k3-256k".' },
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: typeof value === 'string' ? value : String(value) }] },
      },
      async execute(args, exec) {
        try {
          const agent = exec !== undefined ? exec.agent : undefined
          if (agent === undefined) return jsonText({ ok: false, error: 'no calling agent; spawn_model_subagent must run inside a session' })
          const provider = String(args.provider ?? 'kimi-coding')
          const model = String(args.model ?? 'k3-256k')
          const label = String(args.label ?? '').trim()
          const prompt = String(args.prompt ?? '')
          if (prompt.length === 0) return jsonText({ ok: false, error: 'prompt must not be empty' })
          const started = await subagents.startContinuable({
            provider: 'spawn',
            label: label.length > 0 ? label : model + ' 子代理',
            request: {
              prompt: [{ type: 'text', text: prompt }],
              parent: agent,
              agentOptions: { provider, model },
            },
            signal: exec !== undefined ? exec.signal : undefined,
          })
          return jsonText({ ok: true, childId: started.childId, messageId: started.messageId, provider, model, note: 'the child session runs on ' + provider + '/' + model + ' and shares this workspace; send it follow-up input by opening its session in the GUI' })
        } catch (error) {
          return jsonText({ ok: false, error: errText(error) })
        }
      },
    })
    const dispose = ctx.tools.register(tool)
    ctx.effect(() => () => { try { dispose() } catch (error) { /* best-effort */ } })
  },
}

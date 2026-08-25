// forge-tools：registerTool 定版（带 timeoutMs；消灭两代分裂——llmrouter/mailbridge/teamhub 旧版有，
// archive/injector/modelroute/plasmid/verify 旧版无，现统一为一个实现，timeoutMs 缺席时行为与旧无参版逐字等价）。
import { defineTool } from '@deepseek-ai/dsh-tools'
import { errText, jsonText } from './forge-common.mjs'

// 注册一个文本输出工具：defineTool + ctx.tools.register + ctx.effect 回收。
// execute 抛错统一包 { ok: false, error } JSON 文本（原各插件本地实现的同一行为）。
export function registerTool(ctx, name, description, parameters, execute, timeoutMs) {
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

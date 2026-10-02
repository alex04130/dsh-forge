// description: 子代理派发（B 层全局名 forge_model_spawn；正式名由 preset face 注册）。
import { createSpawnModelSubagentTool } from './lib/spawn-model-subagent.mjs'

export default {
  inject: ['tools', 'subagents'],
  apply(ctx) {
    const tool = createSpawnModelSubagentTool(ctx, 'forge_model_spawn')
    const dispose = ctx.tools.register(tool)
    ctx.effect(() => () => { try { dispose() } catch (error) { /* best-effort */ } })
  },
}

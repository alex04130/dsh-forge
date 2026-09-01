// forge 薄桥 host 公共库（4b prelude）：dynboot 在每个行动态 host 代码前原样拼接本文件。
// 只放 5-15 行纯函数；行侧用 const 别名接管通用名（如 const errText = libErrText），调用点不动。
// 改本文件 = 改全部行的行为；保持极小、无依赖（不读 ctx/服务，参数全显式传）。

/** 错误对象 → 单行文本。 */
function libErrText(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}

/** 值 → 漂亮 JSON 文本（工具输出/RPC 回显通用）。 */
function libJsonText(value) {
  return JSON.stringify(value, null, 2)
}

/** shell 收集器 → 文本（非此形状给空串）。 */
function libTextOf(collected) {
  if (collected !== null && typeof collected === 'object' && typeof collected.text === 'string') return collected.text
  return ''
}

/**
 * 带 P-005 撞名守卫的工具注册：同名工具已被运行中实例注册时同义跳过（过渡期双跑不炸）；
 * 注册成功挂 ctx.effect 归还 dispose。返回是否真正注册上。
 */
function libRegisterGuarded(harness, ctx, tool) {
  let dispose = undefined
  try { dispose = harness.registerTool(ctx, tool) } catch (error) { /* P-005 撞名守卫：同义跳过 */ }
  if (dispose !== undefined) ctx.effect(() => () => { try { dispose() } catch (error) { /* best-effort */ } })
  return dispose !== undefined
}

/**
 * 定义 + 守卫注册一个「字符串输出 JSON」模型工具（capm/gitdk 同款 helper 的归一版）。
 * execute 抛错时返回 { ok: false, error } 文本而不是炸调用方。
 */
function libDefineJsonTool(harness, ctx, name, description, parameters, execute, timeoutMs) {
  const tool = harness.defineTool({
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
        return libJsonText({ ok: false, error: libErrText(error) })
      }
    },
  })
  return libRegisterGuarded(harness, ctx, tool)
}

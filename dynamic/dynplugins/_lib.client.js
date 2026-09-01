// forge 薄桥 client 公共库（4b prelude）：dynboot 在每个行动态 client 代码前原样拼接本文件。
// 只放无 React 依赖的纯函数；hook（useZh）留在 forgeShell.helpers（要壳状态订阅，prelude 给不了）。
// 行侧用 const 别名接管通用名（如 const isZh = () => libIsZh(ctx)），调用点不动。

/** 当前界面是否中文：每次调用实时读 locale 服务，服务缺席/异常一律 false。 */
function libIsZh(ctx) {
  try {
    const loc = ctx.get('locale')
    if (loc === undefined) return false
    const snap = typeof loc.getSnapshot === 'function' ? loc.getSnapshot()
      : (typeof loc.getLocale === 'function' ? loc.getLocale() : undefined)
    const id = typeof snap === 'string' ? snap : (snap !== null && typeof snap === 'object' ? String(snap.active ?? '') : '')
    return id !== '' && id.toLowerCase().startsWith('zh')
  } catch (error) { return false }
}

// cordisinspect-shim：让 cordisInspect.register 对重复 manifest id 幂等（首个生效）。
//
// 背景（2026-09-11）：上游 dsh-cordis-host-runner 的 inspect 注册表是进程全局单例，
// 撞名直接 throw（lib/index.js:730  `if (this.providers.has(manifest.id)) throw`）。
// 而 preset 是「一个 preset 一个 standing mount，且共享且永久」
// （dsh-agent-presets/lib/index.js:1086-1097 / :1674-1685），
// 于是进程里第二个挂 `dsh-tool-cordis` 的 preset 必然撞名、挂不上（缺陷 B2；DECISIONS.md 2026-09-01 条已记）。
// dsh-tool-cordis:9113 正是 `ctx.cordisInspect.register(provider)` —— 拦这一点即可让多个 cordis 系 preset 共存。
//
// 语义：**首个生效**（first-wins）。重复注册返回 no-op disposer，不再抛。
// 可回滚：ctx.effect 卸载时删掉自有属性遮蔽，恢复原型方法。
// 探针：动态插件 dupprb-8 的 dup_probe_result（装载前 threw / 装载后 no-throw）。
export default {
  inject: ['cordisInspect'],
  apply(ctx) {
    const svc = ctx.cordisInspect
    if (svc === undefined || svc === null) return
    const original = svc.register
    if (typeof original !== 'function') return
    let ignored = 0
    const patched = function (registration) {
      try {
        return original.call(this, registration)
      } catch (error) {
        const message = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error)
        if (!message.includes('is already registered')) throw error
        ignored += 1
        return () => {}
      }
    }
    svc.register = patched
    ctx.effect(() => () => {
      try {
        if (svc.register === patched) delete svc.register
        else svc.register = original
      } catch (error) { /* best-effort */ }
    }, 'cordisinspect-shim.restore')
    try { ctx.logger.info('[cordisinspect-shim] active: duplicate inspect-provider registrations are tolerated (first-wins)') } catch (error) { /* noop */ }
  },
}

// forge-shell 客户端半部 v0.1.1（评审版）：徽章/面板族统一壳。v0.1.1：弹窗补 Esc 关窗。
// 主权：独占 sidebar.footer.action 一个坑位渲染整条徽章轨——顺序/分组间距/宽轨契约壳内闭环，
// 5+2 跨插件 CSS 耦合（order 平局 + 组尾 margin 接管）清零。
// 契约：provide('forgeShell', { registerFeature(spec), helpers })。
//   spec = { id, order?, badge: { icon 组件, label() 纯函数, count()?() }, title?(), panel 组件, foot?() }
//   registerFeature 返回 { dispose, refresh }：refresh() 在 badge/title 依赖的闭包状态变化后调用（如异步计数到达）。
// 隔离：每个功能的徽章/面板各包 ErrorBoundary，单功能崩溃只摘自己（等价 slot 逐注册项 abdicate）。
// 热更新：registry 是可订阅 store（version + useSyncExternalStore），功能 update/unload → dispose → 壳即时重渲染。
// 弹窗骨架统一：backdrop/头(标题+关闭)/体(功能 panel)/可选脚注；标题与脚注 thunk 每次壳渲染重读。
// 注意：label/count/title/foot 必须是纯函数（壳渲染期同步调用，禁 hook）；icon/panel 是组件（可含 hook）。
return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    const h = React.createElement

    // ---------- i18n helpers（定版：useSyncExternalStore 一代；UI-LESSONS §6-8） ----------
    const localeSvc = ctx.get('locale')
    const EMPTY_SNAPSHOT = {}
    function isZhNow() {
      try {
        if (localeSvc === undefined || typeof localeSvc.getLocale !== 'function') return false
        const snap = localeSvc.getLocale()
        const id = typeof snap === 'string' ? snap : (snap !== null && typeof snap === 'object' ? String(snap.active ?? '') : '')
        return id.toLowerCase().startsWith('zh')
      } catch (error) { return false }
    }
    function useZh() {
      const subscribe = React.useCallback(
        (fn) => (localeSvc !== undefined && typeof localeSvc.subscribe === 'function' ? localeSvc.subscribe(fn) : () => {}),
        [])
      const getSnap = React.useCallback(
        () => (localeSvc !== undefined && typeof localeSvc.getSnapshot === 'function' ? localeSvc.getSnapshot() : EMPTY_SNAPSHOT),
        [])
      if (typeof React.useSyncExternalStore === 'function') {
        try { React.useSyncExternalStore(subscribe, getSnap) } catch (error) { /* noop */ }
      }
      return isZhNow()
    }
    const helpers = { useZh, isZhNow }

    // ---------- registry：可订阅 store ----------
    const features = new Map()
    const listeners = new Set()
    let version = 0
    const bump = () => {
      version++
      for (const fn of [...listeners]) { try { fn() } catch (error) { /* noop */ } }
    }
    function registerFeature(spec) {
      if (spec === null || typeof spec !== 'object') throw new Error('forgeShell.registerFeature: spec must be an object')
      if (typeof spec.id !== 'string' || spec.id.length === 0) throw new Error('forgeShell.registerFeature: spec.id must be a non-empty string')
      if (spec.badge === null || typeof spec.badge !== 'object' || typeof spec.badge.label !== 'function') {
        throw new Error('forgeShell.registerFeature(' + spec.id + '): badge.label thunk required (纯函数)')
      }
      if (typeof spec.panel !== 'function') throw new Error('forgeShell.registerFeature(' + spec.id + '): panel component required')
      features.set(spec.id, spec)
      bump()
      let alive = true
      return {
        dispose() { if (!alive) return; alive = false; features.delete(spec.id); bump() },
        refresh() { if (alive) bump() },
      }
    }
    ctx.effect(() => ctx.provide('forgeShell', { registerFeature, helpers }))

    // ---------- ErrorBoundary（无 React.Component 时降级直通，隔离缺席不阻断） ----------
    let FeatureBoundary = function Passthrough(props) { return h(React.Fragment, null, props.children) }
    if (typeof React.Component === 'function') {
      FeatureBoundary = class FeatureBoundary extends React.Component {
        constructor(props) { super(props); this.state = { err: null } }
        static getDerivedStateFromError(err) { return { err } }
        componentDidCatch(err) { try { console.error('forge-shell: feature crashed: ' + String(err && err.message !== undefined ? err.message : err)) } catch (e) { /* noop */ } }
        render() {
          if (this.state.err !== null) return this.props.fallback !== undefined ? this.props.fallback : null
          return this.props.children
        }
      }
    }

    // ---------- 壳组件 ----------
    function useFeatureList() {
      const subscribe = React.useCallback((fn) => { listeners.add(fn); return () => { listeners.delete(fn) } }, [])
      const getSnap = React.useCallback(() => version, [])
      React.useSyncExternalStore(subscribe, getSnap)
      return [...features.values()].sort((a, b) => ((a.order ?? 0) - (b.order ?? 0)) || String(a.id).localeCompare(String(b.id)))
    }

    function FeatureBadge(props) {
      const spec = props.spec
      let label = spec.id
      try { label = String(spec.badge.label()) } catch (error) { /* noop */ }
      let count
      if (typeof spec.badge.count === 'function') { try { count = spec.badge.count() } catch (error) { /* noop */ } }
      return h('button', { type: 'button', className: 'fsh-badge', 'data-feature': spec.id, onClick: props.onOpen, title: label },
        typeof spec.badge.icon === 'function' ? h(spec.badge.icon) : null,
        props.wide === true ? h('span', { className: 'fsh-badge-label' }, label) : null,
        props.wide === true && typeof count === 'number' && count > 0 ? h('span', { className: 'fsh-count' }, String(count)) : null)
    }

    function ShellModal(props) {
      const spec = props.spec
      const zh = useZh()
      // Esc 关窗（sesmgr/steer 同款 document keydown；动态 client 有 document 无 fetch/window 依赖）
      React.useEffect(() => {
        const esc = (event) => { if (event && event.key === 'Escape') props.onClose() }
        document.addEventListener('keydown', esc)
        return () => document.removeEventListener('keydown', esc)
      }, [])
      let title = spec.id
      try { if (typeof spec.title === 'function') title = String(spec.title()) } catch (error) { /* noop */ }
      let foot
      try { if (typeof spec.foot === 'function') foot = spec.foot() } catch (error) { /* noop */ }
      return h('div', { className: 'fsh-overlay' },
        h('div', { className: 'fsh-backdrop', onClick: props.onClose }),
        h('div', { className: 'fsh-panel' },
          h('div', { className: 'fsh-head' },
            h('div', { className: 'fsh-title' }, title),
            h('button', { type: 'button', className: 'fsh-close', onClick: props.onClose, 'aria-label': zh ? '关闭' : 'Close' }, '✕')),
          h('div', { className: 'fsh-body' },
            h(FeatureBoundary, {
              fallback: h('div', { className: 'fsh-crashed' },
                zh ? '该功能面板崩溃了，其余功能不受影响。' : 'This feature panel crashed; other features are unaffected.'),
            }, h(spec.panel, { close: props.onClose, helpers }))),
          foot !== undefined && foot !== null && foot !== '' ? h('div', { className: 'fsh-foot' }, String(foot)) : null))
    }

    function ShellEntry(props) {
      const list = useFeatureList()
      const [openId, setOpenId] = React.useState(undefined)
      const openSpec = openId !== undefined ? features.get(openId) : undefined
      return h('div', { className: 'fsh-entry' },
        list.map((spec) => h(FeatureBoundary, { key: spec.id },
          h(FeatureBadge, { spec, wide: props.wide === true, onOpen: () => setOpenId(spec.id) }))),
        openSpec !== undefined ? h(ShellModal, { spec: openSpec, onClose: () => setOpenId(undefined) }) : null)
    }

    // ---------- 壳样式（徽章 49px 壳规格与弹窗骨架沿用 UI-LESSONS 定版；内容样式归各功能） ----------
    styles.insert(`
.fsh-entry { width: 100%; order: -1; margin-bottom: 8px; }
/* PoC 期接管组尾间距：壳（含质粒）是五徽章组最后一个，sessmgr 的组尾 margin 归零（原 plsm CSS 平移） */
.sessmgr-arch-entry { margin-bottom: 0 !important; }
.fsh-badge { box-sizing: border-box; width: 100%; height: 49px; display: flex; align-items: center; gap: 8px; padding: 0 8px 0 6px; border: 0; border-radius: 12px; cursor: pointer; font-size: 14px; font-family: inherit; color: var(--dsw-alias-label-primary, inherit); background: transparent; }
.fsh-badge:hover { background: var(--dsw-alias-bg-hover, rgba(128,128,128,.08)); }
.fsh-badge-label { text-overflow: ellipsis; white-space: nowrap; min-width: 0; overflow: hidden; }
.fsh-count { margin-left: auto; font-weight: 500; font-size: 11px; color: var(--dsw-alias-label-tertiary, #9aa0aa); }
.fsh-overlay { position: fixed; inset: 0; z-index: 1000; display: flex; justify-content: center; align-items: center; }
.fsh-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.42); backdrop-filter: blur(2px); }
.fsh-panel { position: relative; z-index: 1; width: 640px; max-width: calc(100vw - 48px); max-height: min(680px, calc(100vh - 48px)); display: flex; flex-direction: column; overflow: hidden; border-radius: 20px; border: 1px solid var(--dsw-alias-border-strong, rgba(128,128,128,.25)); background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-primary, inherit); box-shadow: 0 18px 48px rgba(0,0,0,.28); font-family: inherit; }
.fsh-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 20px 24px 12px; border-bottom: 1px solid rgba(128,128,128,.14); flex: none; }
.fsh-title { font-size: 17px; font-weight: 650; line-height: 24px; }
.fsh-close { width: 30px; height: 30px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 10px; cursor: pointer; background: transparent; color: var(--dsw-alias-label-secondary, inherit); font-size: 14px; flex: none; }
.fsh-close:hover { background: var(--dsw-alias-bg-hover, rgba(128,128,128,.1)); }
.fsh-body { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }
.fsh-foot { flex: none; padding: 10px 24px 14px; border-top: 1px solid rgba(128,128,128,.14); font-size: 11px; color: var(--dsw-alias-label-tertiary, #9aa0aa); }
.fsh-crashed { padding: 34px 24px; text-align: center; font-size: 13px; color: var(--dsw-alias-state-error-primary, #dc2626); }
`)

    slots.inject('sidebar.footer.action', () => slots.register(
      { name: 'sidebar.footer.action', id: 'forge-shell', order: 6, label: () => (isZhNow() ? '功能壳' : 'Shell') },
      (props) => h(ShellEntry, props),
    ))
  },
}

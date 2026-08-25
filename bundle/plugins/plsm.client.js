// plsm 客户端半部 v0.1.1：最薄质粒面板（只读）。
// v0.1.1：兼容 gap 类型（G-xxx）——status 映射放宽（open/adopted 绿、rejected 灰、未知回退原串）、
// fitness/confidence 缺席不渲染、outlet 跟在 type 后展示；无 gap 专用交互（任务书原话）。
// 数据面：包私有 RPC（plasmid.list/plasmid.detail）→ host 半部经 fs 服务直读 registry.json（动态 client 禁用 fetch）。
// 徽章模式遵循 UI-LESSONS：15px 固定盒 SVG（lucide flask-conical）+ 独立 label span + wide 契约 + label thunk。
// 视觉分组：排在「已归档」之后（order -1 DOM 平局居末），接管组尾 margin-bottom:8px（覆盖 sessmgr 的），
// 形成 市场/技能/插件/已归档/质粒 [gap] Cordis/设置 的 5+2。
// 只读纪律：无删除/编辑入口（删除键只在人手里）。
// 扩展性预留（v0.2+ 写面）：行/详情各挂 data-plsm-actions 空槽位（现隐藏）；status 流转（active/idea、open/adopted/rejected、
// 未来 locked）由 StatusDot + status 字典+原串回退承接，新状态只需加样式与文案，不改结构。
return {
  inject: ['timer'],
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    const h = React.createElement

    // ---------- i18n（UI-LESSONS §6-8：无条件 hook + useCallback 稳定订阅 + snapshot.active + 缺席回退英文） ----------
    const localeSvc = ctx.get('locale')
    const EMPTY_SNAPSHOT = {}
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
    function isZhNow() {
      try {
        if (localeSvc === undefined || typeof localeSvc.getLocale !== 'function') return false
        const snap = localeSvc.getLocale()
        const id = typeof snap === 'string' ? snap : (snap !== null && typeof snap === 'object' ? String(snap.active ?? '') : '')
        return id.toLowerCase().startsWith('zh')
      } catch (error) { return false }
    }
    function copy(zh) {
      return zh ? {
        badge: '质粒', panelTitle: '质粒注册表', close: '关闭', back: '返回',
        searchPlaceholder: '搜索质粒（回车）…', loading: '加载中…', loadFailed: '加载失败：',
        empty: '还没有质粒', emptySearch: '没有匹配的质粒',
        when: 'WHEN · 什么时候遇到', worked: 'WORKED · 怎么做成了', failed: 'FAILED · 怎么做败了', why: 'WHY · 为什么',
        evidence: '证据坐标', fitness: '适用度', seen: '引用', workedN: '管用', failedN: '误导',
        confidence: { low: '低置信', medium: '中置信', high: '高置信' },
        status: { active: '生效中', idea: '想法（有争议）' },
        scope: '作用域', version: '版本', source: '来源会话', created: '提交于', updated: '更新于',
        count: (n) => String(n) + ' 条', readonly: '只读面板 · 增删改走 plasmid 工具或人工',
      } : {
        badge: 'Plasmids', panelTitle: 'Plasmid Registry', close: 'Close', back: 'Back',
        searchPlaceholder: 'Search plasmids (Enter)…', loading: 'Loading…', loadFailed: 'Load failed: ',
        empty: 'No plasmids yet', emptySearch: 'No matching plasmids',
        when: 'WHEN · trigger conditions', worked: 'WORKED · what worked', failed: 'FAILED · what failed', why: 'WHY · mechanism',
        evidence: 'Evidence coordinates', fitness: 'Fitness', seen: 'seen', workedN: 'worked', failedN: 'failed',
        confidence: { low: 'low conf', medium: 'med conf', high: 'high conf' },
        status: { active: 'active', idea: 'idea (contested)' },
        scope: 'Scope', version: 'Version', source: 'Source session', created: 'Created', updated: 'Updated',
        count: (n) => String(n) + ' entries', readonly: 'Read-only panel · mutations via plasmid tools or human hands',
      }
    }

    // ---------- 数据（动态 client 禁用 fetch，走包私有 RPC → host 半部直读注册表） ----------
    function fetchList(q) {
      const has = q !== undefined && q !== null && q.trim().length > 0
      return host.call('plasmid.list', has ? { query: q.trim() } : {}).then((res) => {
        if (res === null || typeof res !== 'object' || res.ok !== true) {
          throw new Error(res !== null && typeof res === 'object' && typeof res.error === 'string' ? res.error : 'bad response')
        }
        return Array.isArray(res.entries) ? res.entries : (Array.isArray(res.results) ? res.results : [])
      })
    }
    function fetchDetail(id) {
      return host.call('plasmid.detail', { id }).then((res) => {
        if (res === null || typeof res !== 'object' || res.ok !== true || res.entry === undefined) {
          throw new Error(res !== null && typeof res === 'object' && typeof res.error === 'string' ? res.error : 'not found')
        }
        return res.entry
      })
    }

    // ---------- 图标与小组件 ----------
    function FlaskIcon() {
      // lucide flask-conical（ISC）：15px 固定盒，与市场/技能/插件/已归档徽章同规格
      return h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true', style: { flex: 'none' } },
        h('path', { d: 'M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M8.5 2h7', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }),
        h('path', { d: 'M7 16h10', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }))
    }
    function StatusDot(props) {
      // fix: active 绿 / idea 琥珀；gap: open·adopted 绿 / rejected 灰；未知状态回退原串
      const st = typeof props.status === 'string' ? props.status : ''
      const cls = st === 'idea' ? 'plsm-dot-idea' : (st === 'rejected' ? 'plsm-dot-rejected' : 'plsm-dot-active')
      return h('span', { className: 'plsm-dot ' + cls, title: props.title !== undefined ? props.title : st })
    }
    function FitnessBar(props) {
      const score = typeof props.score === 'number' ? Math.max(0, Math.min(1, props.score)) : 0
      const cls = score >= 0.5 ? 'plsm-fit-good' : (score >= 0.3 ? 'plsm-fit-mid' : 'plsm-fit-bad')
      return h('span', { className: 'plsm-fit', title: 'fitness ' + score.toFixed(2) },
        h('span', { className: 'plsm-fit-fill ' + cls, style: { width: Math.round(score * 100) + '%' } }))
    }

    // ---------- 列表行 ----------
    function PlasmidRow(props) {
      const e = props.entry
      const conf = typeof e.confidence === 'string' ? e.confidence : undefined
      const status = typeof e.status === 'string' ? e.status : 'active'
      const hasFit = e.fitness !== null && typeof e.fitness === 'object' && typeof e.fitness.score === 'number'
      const typeText = (typeof e.type === 'string' ? e.type : '') + (typeof e.outlet === 'string' ? ' → ' + e.outlet : '')
      return h('div', { className: 'plsm-row', role: 'button', onClick: () => props.onOpen(e.id) },
        h('div', { className: 'plsm-row-top' },
          h(StatusDot, { status, title: props.t.status[status] ?? status }),
          h('span', { className: 'plsm-id' }, e.id),
          h('span', { className: 'plsm-type' }, typeText),
          hasFit ? h(FitnessBar, { score: e.fitness.score }) : null,
          conf !== undefined ? h('span', { className: 'plsm-conf plsm-conf-' + conf }, props.t.confidence[conf] ?? conf) : null,
          h('span', { className: 'plsm-scope' }, typeof e.scope === 'string' ? e.scope : ''),
          // 预留：行操作区（v0.2+ 编辑/锁定/删除按钮挂这里，宿主写面到位后填充；只走人操作，不做模型工具）
          h('span', { className: 'plsm-row-actions', 'data-plsm-actions': String(e.id) })),
        h('div', { className: 'plsm-row-when' }, typeof e.when === 'string' ? e.when : ''))
    }

    // ---------- 详情视图 ----------
    function DetailView(props) {
      const e = props.entry
      const t = props.t
      const fit = e.fitness !== null && typeof e.fitness === 'object' ? e.fitness : {}
      const status = typeof e.status === 'string' ? e.status : 'active'
      const block = (label, text, cls) => h('div', { className: 'plsm-block' },
        h('div', { className: 'plsm-block-label' }, label),
        h('div', { className: 'plsm-block-text ' + (cls ?? '') }, typeof text === 'string' && text.length > 0 ? text : '—'))
      return h('div', { className: 'plsm-detail' },
        h('div', { className: 'plsm-detail-head' },
          h('button', { type: 'button', className: 'plsm-btn', onClick: props.onBack }, '← ' + t.back),
          h(StatusDot, { status, title: t.status[status] ?? status }),
          h('span', { className: 'plsm-id plsm-id-big' }, e.id),
          h('span', { className: 'plsm-type' }, (typeof e.type === 'string' ? e.type : '') + (typeof e.outlet === 'string' ? ' → ' + e.outlet : '')),
          h('span', { className: 'plsm-hint' }, t.status[status] ?? status),
          // 预留：详情操作区（同上，编辑文本/改状态/人工锁定/删除）
          h('span', { className: 'plsm-row-actions', 'data-plsm-actions': String(e.id) })),
        h('div', { className: 'plsm-detail-body' },
          block(t.when, e.when),
          block(t.worked, e.worked),
          block(t.failed, e.failed, 'plsm-failed-text'),
          block(t.why, e.why),
          e.fitness !== null && typeof e.fitness === 'object' ? h('div', { className: 'plsm-block' },
            h('div', { className: 'plsm-block-label' }, t.fitness),
            h('div', { className: 'plsm-fit-line' },
              h(FitnessBar, { score: fit.score }),
              h('span', { className: 'plsm-fit-num' }, typeof fit.score === 'number' ? fit.score.toFixed(2) : '—'),
              h('span', { className: 'plsm-hint' },
                t.seen + ' ' + String(fit.seen ?? 0) + ' · ' + t.workedN + ' ' + String(fit.worked ?? 0) + ' · ' + t.failedN + ' ' + String(fit.failed ?? 0)))) : null,
          Array.isArray(e.evidence) && e.evidence.length > 0 ? h('div', { className: 'plsm-block' },
            h('div', { className: 'plsm-block-label' }, t.evidence + ' (' + String(e.evidence.length) + ')'),
            h('div', { className: 'plsm-evi' }, e.evidence.map((ev) => h('div', { key: String(ev), className: 'plsm-evi-item' }, String(ev))))) : null,
          h('div', { className: 'plsm-meta' },
            t.scope + ' ' + String(e.scope ?? '—') + ' · ' + t.version + ' ' + String(e.version ?? '—') + ' · ' + t.created + ' ' + String(typeof e.createdAt === 'string' ? e.createdAt.slice(0, 10) : '—')),
          h('div', { className: 'plsm-meta' }, t.source + ' ' + String(e.source ?? '—'))))
    }

    // ---------- 面板 ----------
    function Panel(props) {
      const zh = useZh()
      const t = copy(zh)
      const [list, setList] = React.useState(undefined)
      const [error, setError] = React.useState(undefined)
      const [query, setQuery] = React.useState('')
      const [detail, setDetail] = React.useState(undefined) // {loading} | {entry} | {error}
      const seqRef = React.useRef(0)

      const load = React.useCallback((q) => {
        const seq = ++seqRef.current
        setError(undefined)
        fetchList(q)
          .then((entries) => { if (seqRef.current === seq) setList(entries) })
          .catch((e) => { if (seqRef.current === seq) { setError(String(e && e.message !== undefined ? e.message : e)); setList([]) } })
      }, [])
      React.useEffect(() => { load(undefined) }, [])

      // 搜索防抖（ctx.timeout 随 fiber 回收）
      const debRef = React.useRef(undefined)
      const onQuery = (value) => {
        setQuery(value)
        if (typeof debRef.current === 'function') debRef.current()
        debRef.current = ctx.timeout(() => load(value), 300)
      }

      const openDetail = (id) => {
        setDetail({ loading: true })
        fetchDetail(id)
          .then((entry) => setDetail((cur) => (cur !== null && typeof cur === 'object' && cur.loading === true ? { entry } : cur)))
          .catch((e) => setDetail({ error: String(e && e.message !== undefined ? e.message : e) }))
      }

      const searching = query.trim().length > 0
      return h('div', { className: 'plsm-overlay' },
        h('div', { className: 'plsm-backdrop', onClick: props.onClose }),
        h('div', { className: 'plsm-panel' },
          h('div', { className: 'plsm-head' },
            h('div', { className: 'plsm-title' },
              detail === undefined ? t.panelTitle + (Array.isArray(list) ? ' · ' + t.count(list.length) : '') : (detail.entry !== undefined ? detail.entry.id : t.panelTitle)),
            h('button', { type: 'button', className: 'plsm-close', onClick: props.onClose, 'aria-label': t.close }, '✕')),
          detail === undefined ? h('div', { className: 'plsm-search-row' },
            h('input', {
              className: 'plsm-search', value: query, placeholder: t.searchPlaceholder,
              onChange: (ev) => onQuery(String(ev && ev.target !== null ? ev.target.value : '')),
            })) : null,
          h('div', { className: 'plsm-body' },
            detail !== undefined
              ? (detail.loading === true
                  ? h('div', { className: 'plsm-empty' }, t.loading)
                  : detail.error !== undefined
                    ? h('div', { className: 'plsm-empty' }, t.loadFailed + detail.error)
                    : h(DetailView, { entry: detail.entry, t, onBack: () => setDetail(undefined) }))
              : (error !== undefined
                  ? h('div', { className: 'plsm-empty' }, t.loadFailed + error)
                  : !Array.isArray(list)
                    ? h('div', { className: 'plsm-empty' }, t.loading)
                    : list.length === 0
                      ? h('div', { className: 'plsm-empty' }, searching ? t.emptySearch : t.empty)
                      : list.map((e) => h(PlasmidRow, { key: String(e.id), entry: e, t, onOpen: openDetail })))),
          h('div', { className: 'plsm-foot' }, t.readonly)))
    }

    // ---------- 侧栏入口 ----------
    function PlasmidEntry(props) {
      const zh = useZh()
      const t = copy(zh)
      const [open, setOpen] = React.useState(false)
      const [count, setCount] = React.useState(undefined)
      React.useEffect(() => {
        fetchList(undefined).then((entries) => setCount(entries.length)).catch(() => {})
      }, [])
      return h('div', { className: 'plsm-entry' },
        h('button', { type: 'button', className: 'plsm-badge', onClick: () => setOpen(!open), title: t.panelTitle },
          h(FlaskIcon, null),
          props.wide === true
            ? h('span', { style: { textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, overflow: 'hidden' } }, t.badge)
            : null,
          props.wide === true && typeof count === 'number' && count > 0 ? h('span', { className: 'plsm-count' }, String(count)) : null),
        open ? h(Panel, { onClose: () => setOpen(false) }) : null)
    }

    // ---------- 样式（token 与 sklui/sessmgr 同款） ----------
    styles.insert(`
.plsm-entry { width: 100%; order: -1; margin-bottom: 8px; }
/* 接管组尾间距：质粒是五徽章组最后一个（order:-1 DOM 平局居末），sessmgr 的组尾 margin 归零 */
.sessmgr-arch-entry { margin-bottom: 0 !important; }
.plsm-badge { box-sizing: border-box; width: 100%; height: 49px; display: flex; align-items: center; gap: 8px; padding: 0 8px 0 6px; border: 0; border-radius: 12px; cursor: pointer; font-size: 14px; font-family: inherit; color: var(--dsw-alias-label-primary, inherit); background: transparent; }
.plsm-badge:hover { background: var(--dsw-alias-bg-hover, rgba(128,128,128,.08)); }
.plsm-count { margin-left: auto; font-weight: 500; font-size: 11px; color: var(--dsw-alias-label-tertiary, #9aa0aa); }
.plsm-overlay { position: fixed; inset: 0; z-index: 1000; display: flex; justify-content: center; align-items: center; }
.plsm-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.42); backdrop-filter: blur(2px); }
.plsm-panel { position: relative; z-index: 1; width: 640px; max-width: calc(100vw - 48px); max-height: min(680px, calc(100vh - 48px)); display: flex; flex-direction: column; overflow: hidden; border-radius: 20px; border: 1px solid var(--dsw-alias-border-strong, rgba(128,128,128,.25)); background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-primary, inherit); box-shadow: 0 18px 48px rgba(0,0,0,.28); font-family: inherit; }
.plsm-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 20px 24px 12px; border-bottom: 1px solid rgba(128,128,128,.14); flex: none; }
.plsm-title { font-size: 17px; font-weight: 650; line-height: 24px; }
.plsm-close { width: 30px; height: 30px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 10px; cursor: pointer; background: transparent; color: var(--dsw-alias-label-secondary, inherit); font-size: 14px; flex: none; }
.plsm-close:hover { background: var(--dsw-alias-bg-hover, rgba(128,128,128,.1)); }
.plsm-search-row { padding: 10px 24px 4px; flex: none; }
.plsm-search { box-sizing: border-box; width: 100%; height: 32px; padding: 0 12px; border-radius: 8px; border: 1px solid rgba(128,128,128,.28); background: transparent; color: inherit; font-size: 13px; font-family: inherit; outline: none; }
.plsm-search:focus { border-color: var(--dsw-alias-accent, #4f7cff); }
.plsm-body { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 16px 12px; display: flex; flex-direction: column; }
.plsm-row { box-sizing: border-box; width: 100%; border-radius: 8px; padding: 8px 10px; cursor: pointer; display: flex; flex-direction: column; gap: 4px; }
.plsm-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.1)); }
.plsm-row-top { display: flex; align-items: center; gap: 8px; font-size: 12px; line-height: 18px; }
.plsm-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.plsm-dot-active { background: var(--dsw-alias-state-success-primary, #16a34a); }
.plsm-dot-idea { background: var(--dsw-alias-state-warn-primary, #b45309); }
.plsm-dot-rejected { background: var(--dsw-alias-border-l2, #d4d4da); }
.plsm-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 650; font-size: 12px; }
.plsm-id-big { font-size: 14px; }
.plsm-type { color: var(--dsw-alias-label-tertiary, #6b7280); }
.plsm-fit { display: inline-flex; width: 48px; height: 5px; border-radius: 3px; background: var(--dsw-alias-border-l2, rgba(128,128,128,.2)); overflow: hidden; flex: none; }
.plsm-fit-fill { display: block; height: 100%; border-radius: 3px; }
.plsm-fit-good { background: var(--dsw-alias-state-success-primary, #16a34a); }
.plsm-fit-mid { background: var(--dsw-alias-state-warn-primary, #b45309); }
.plsm-fit-bad { background: var(--dsw-alias-state-error-primary, #dc2626); }
.plsm-fit-num { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.plsm-fit-line { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.plsm-conf { border: 1px solid rgba(128,128,128,.28); border-radius: 8px; height: 20px; padding: 0 8px; display: inline-flex; align-items: center; font-size: 11px; color: var(--dsw-alias-label-secondary, inherit); flex: none; }
.plsm-conf-high { color: var(--dsw-alias-state-success-primary, #16a34a); border-color: rgba(22,163,74,.35); }
.plsm-conf-low { color: var(--dsw-alias-label-tertiary, #9aa0aa); }
.plsm-scope { margin-left: auto; color: var(--dsw-alias-label-tertiary, #9aa0aa); font-size: 11px; flex: none; }
.plsm-row-when { font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-secondary, inherit); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plsm-row-actions { display: none; flex: none; gap: 4px; }
.plsm-empty { padding: 34px 0; text-align: center; font-size: 13px; color: var(--dsw-alias-label-tertiary, #6b7280); }
.plsm-detail { display: flex; flex-direction: column; }
.plsm-detail-head { display: flex; align-items: center; gap: 8px; padding: 2px 8px 10px; }
.plsm-detail-body { display: flex; flex-direction: column; gap: 12px; padding: 0 8px 4px; }
.plsm-btn { border: 1px solid rgba(128,128,128,.28); background: transparent; color: var(--dsw-alias-label-secondary, inherit); border-radius: 8px; height: 26px; padding: 0 12px; cursor: pointer; font-size: 12px; font-family: inherit; }
.plsm-btn:hover { background: var(--dsw-alias-bg-hover, rgba(128,128,128,.08)); }
.plsm-block-label { font-size: 11px; line-height: 16px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary, #6b7280); margin-bottom: 4px; }
.plsm-block-text { font-size: 13px; line-height: 1.65; white-space: pre-wrap; word-break: break-word; }
.plsm-failed-text { color: var(--dsw-alias-state-error-primary, #dc2626); }
.plsm-evi { display: flex; flex-direction: column; gap: 2px; }
.plsm-evi-item { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--dsw-alias-label-tertiary, #6b7280); word-break: break-all; }
.plsm-meta { font-size: 11px; color: var(--dsw-alias-label-tertiary, #9aa0aa); word-break: break-all; }
.plsm-hint { font-size: 12px; color: var(--dsw-alias-label-tertiary, #6b7280); }
.plsm-foot { flex: none; padding: 10px 24px 14px; border-top: 1px solid rgba(128,128,128,.14); font-size: 11px; color: var(--dsw-alias-label-tertiary, #9aa0aa); }
`)

    slots.inject('sidebar.footer.action', () => slots.register(
      { name: 'sidebar.footer.action', id: 'plasmid-panel', order: 6, label: () => copy(isZhNow()).badge },
      (props) => h(PlasmidEntry, props),
    ))
  },
}

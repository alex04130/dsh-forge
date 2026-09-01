// plsm 客户端半部 v0.2.0-shell（PoC 首迁）：徽章/弹窗骨架上交 forge-shell，本插件只剩声明式注册 + 面板业务。
// 对比 v0.1.3（pkg-15）砍掉：slots 注册、徽章渲染、overlay chrome、i18n 助手（改用 shell.helpers.useZh 定版）。
// 保留：copy 字典、RPC 数据面、徽章图标(v2 套件质粒 glyph 替换烧瓶)、StatusDot/FitnessBar、列表/详情/搜索业务、内容 CSS。
// 契约：inject:['forgeShell']（硬依赖，壳缺席时本插件等待而非报错）；spec 的 thunk 全部纯函数；
// badge.count/title 依赖的闭包状态变化后调 handle.refresh() 让壳重渲染（异步计数、详情进出）。
// 写面预留不变：行/详情 data-plsm-actions 槽位；status 字典+原串回退承接未来 locked。
return {
  inject: ['timer', 'forgeShell'],
  apply(ctx) {
    const shell = ctx.forgeShell
    const h = React.createElement
    const { useZh, isZhNow } = shell.helpers

    // ---------- 文案字典（归功能所有；壳只调 thunk） ----------
    function copy(zh) {
      return zh ? {
        badge: '质粒', panelTitle: '质粒注册表', back: '返回',
        searchPlaceholder: '搜索质粒（回车）…', loading: '加载中…', loadFailed: '加载失败：',
        empty: '还没有质粒', emptySearch: '没有匹配的质粒',
        when: 'WHEN · 什么时候遇到', worked: 'WORKED · 怎么做成了', failed: 'FAILED · 怎么做败了', why: 'WHY · 为什么',
        evidence: '证据坐标', fitness: '适用度', seen: '引用', workedN: '管用', failedN: '误导',
        confidence: { low: '低置信', medium: '中置信', high: '高置信' },
        status: { active: '生效中', idea: '想法（有争议）' },
        scope: '作用域', version: '版本', source: '来源会话', created: '提交于', updated: '更新于',
        count: (n) => String(n) + ' 条', readonly: '只读面板 · 增删改走 plasmid 工具或人工',
      } : {
        badge: 'Plasmids', panelTitle: 'Plasmid Registry', back: 'Back',
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

    // ---------- 数据（包私有 RPC → host 半部直读注册表） ----------
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

    // ---------- 徽章图标（lucide flask-conical，15px 固定盒） ----------
    // 徽章图标 v2（图标套件定稿 SPEC：vb24/stroke2/双色 accent 恰一处）——环形 DNA：圆环 r7 + 四向辐条 + accent 经验核
    function PlasmidIcon() {
      return h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.75, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', style: { flex: 'none' } },
        h('circle', { cx: 12, cy: 12, r: 7 }),
        h('path', { d: 'M12 2.5 v3.5 M12 18 v3.5 M2.5 12 h3.5 M18 12 h3.5' }),
        h('circle', { cx: 12, cy: 12, r: 2.5, fill: 'var(--dsw-alias-accent, #4f7cff)', stroke: 'none' }))
    }
    function StatusDot(props) {
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
          // 预留：行操作区（v0.2+ 编辑/锁定/删除按钮挂这里；只走人操作，不做模型工具）
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
          // 预留：详情操作区（编辑文本/改状态/人工锁定/删除）
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

    // ---------- 壳可读的闭包状态（badge count / 标题后缀；变化后 handle.refresh()） ----------
    const shared = { count: undefined, detailId: undefined }
    let handle = undefined
    const notify = () => { if (handle !== undefined) handle.refresh() }

    // ---------- 面板体（壳提供 chrome；props.close 关窗） ----------
    function PlsmPanel(props) {
      const zh = useZh()
      const t = copy(zh)
      const [list, setList] = React.useState(undefined)
      const [error, setError] = React.useState(undefined)
      const [query, setQuery] = React.useState('')
      const [detail, setDetail] = React.useState(undefined)
      const seqRef = React.useRef(0)

      const load = React.useCallback((q) => {
        const seq = ++seqRef.current
        setError(undefined)
        fetchList(q)
          .then((entries) => {
            if (seqRef.current !== seq) return
            setList(entries)
            if (q === undefined || q === null || String(q).trim() === '') { shared.count = entries.length; notify() }
          })
          .catch((e) => { if (seqRef.current === seq) { setError(String(e && e.message !== undefined ? e.message : e)); setList([]) } })
      }, [])
      React.useEffect(() => { load(undefined) }, [])

      const debRef = React.useRef(undefined)
      const onQuery = (value) => {
        setQuery(value)
        if (typeof debRef.current === 'function') debRef.current()
        debRef.current = ctx.timeout(() => load(value), 300)
      }

      const openDetail = (id) => {
        setDetail({ loading: true })
        shared.detailId = id; notify()
        fetchDetail(id)
          .then((entry) => setDetail((cur) => (cur !== null && typeof cur === 'object' && cur.loading === true ? { entry } : cur)))
          .catch((e) => setDetail({ error: String(e && e.message !== undefined ? e.message : e) }))
      }
      const closeDetail = () => { setDetail(undefined); shared.detailId = undefined; notify() }

      const searching = query.trim().length > 0
      return h('div', { className: 'plsm-content' },
        detail === undefined ? h('div', { className: 'plsm-search-row' },
          h('input', {
            className: 'plsm-search', value: query, placeholder: t.searchPlaceholder,
            onChange: (ev) => onQuery(String(ev && ev.target !== null ? ev.target.value : '')),
          })) : null,
        h('div', { className: 'plsm-scroll' },
          detail !== undefined
            ? (detail.loading === true
                ? h('div', { className: 'plsm-empty' }, t.loading)
                : detail.error !== undefined
                  ? h('div', { className: 'plsm-empty' }, t.loadFailed + detail.error)
                  : h(DetailView, { entry: detail.entry, t, onBack: closeDetail }))
            : (error !== undefined
                ? h('div', { className: 'plsm-empty' }, t.loadFailed + error)
                : !Array.isArray(list)
                  ? h('div', { className: 'plsm-empty' }, t.loading)
                  : list.length === 0
                    ? h('div', { className: 'plsm-empty' }, searching ? t.emptySearch : t.empty)
                    : list.map((e) => h(PlasmidRow, { key: String(e.id), entry: e, t, onOpen: openDetail })))))
    }

    // ---------- 内容样式（chrome 归壳；内容归功能） ----------
    styles.insert(`
.plsm-content { display: flex; flex-direction: column; min-height: 0; }
.plsm-search-row { padding: 10px 24px 4px; flex: none; }
.plsm-search { box-sizing: border-box; width: 100%; height: 32px; padding: 0 12px; border-radius: 8px; border: 1px solid rgba(128,128,128,.28); background: transparent; color: inherit; font-size: 13px; font-family: inherit; outline: none; }
.plsm-search:focus { border-color: var(--dsw-alias-accent, #4f7cff); }
.plsm-scroll { padding: 10px 16px 12px; display: flex; flex-direction: column; }
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
.plsm-row-actions { display: none; flex: none; gap: 4px; }
.plsm-row-when { font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-secondary, inherit); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
`)

    // ---------- 徽章计数预取（apply 级：不开面板就有角标；pkg-17 回归修——计数曾只在面板 mount 时拉） ----------
    fetchList(undefined).then((entries) => { shared.count = entries.length; notify() }).catch(() => {})

    // ---------- 声明式注册进壳（fiber 回收时 dispose） ----------
    ctx.effect(() => {
      handle = shell.registerFeature({
        id: 'plsm',
        order: 50,
        badge: { icon: PlasmidIcon, label: () => copy(isZhNow()).badge, count: () => shared.count },
        title: () => {
          const t = copy(isZhNow())
          if (shared.detailId !== undefined) return shared.detailId
          return t.panelTitle + (typeof shared.count === 'number' ? ' · ' + t.count(shared.count) : '')
        },
        panel: PlsmPanel,
        foot: () => copy(isZhNow()).readonly,
      })
      return () => { const hd = handle; handle = undefined; if (hd !== undefined) hd.dispose() }
    })
  },
}

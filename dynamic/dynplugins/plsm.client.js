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

    // ---------- 徽章图标（2026-09-01 用户拍板：DNA vb60 24px 专项优化版，24px-17px 统一档） ----------
    // 替换原环形 DNA（vb24 圆环 r7 + 四向辐条）。CSS 由 fshell .fsh-badge svg 统一强制 24px。
    const DNA_BADGE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><g stroke-width="5.0"><path d="M 45.0 5.0 L 44.9 5.7 L 44.9 6.5 L 44.8 7.3 L 44.8 8.1 L 44.6 8.9 L 44.5 9.6 L 44.3 10.4 L 44.1 11.2 L 43.9 12.0 L 43.7 12.8 L 43.4 13.5 L 43.1 14.3 L 42.8 15.1 L 42.5 15.9 L 42.1 16.7 L 41.7 17.5 L 41.3 18.2 L 40.9 19.0 L 40.4 19.8 L 39.9 20.6 L 39.4 21.4 L 38.8 22.1 L 38.2 22.9 L 37.6 23.7 L 37.0 24.5 L 36.3 25.3 L 35.5 26.0 L 34.7 26.8 L 33.9 27.6 L 32.9 28.4 L 31.8 29.2 L 30.0 30.0 L 28.1 30.7 L 27.0 31.5 L 26.0 32.3 L 25.2 33.1 L 24.4 33.9 L 23.6 34.6 L 23.0 35.4 L 22.3 36.2 L 21.7 37.0 L 21.1 37.8 L 20.5 38.5 L 20.0 39.3 L 19.5 40.1 L 19.0 40.9 L 18.6 41.7 L 18.2 42.5 L 17.8 43.2 L 17.4 44.0 L 17.1 44.8 L 16.8 45.6 L 16.5 46.4 L 16.2 47.1 L 16.0 47.9 L 15.8 48.7 L 15.6 49.5 L 15.4 50.3 L 15.3 51.0 L 15.2 51.8 L 15.1 52.6 L 15.0 53.4 L 15.0 54.2 L 15.0 55.0"/><path d="M 15.0 5.0 L 15.0 5.7 L 15.0 6.5 L 15.1 7.3 L 15.2 8.1 L 15.3 8.9 L 15.4 9.6 L 15.6 10.4 L 15.8 11.2 L 16.0 12.0 L 16.2 12.8 L 16.5 13.5 L 16.8 14.3 L 17.1 15.1 L 17.4 15.9 L 17.8 16.7 L 18.2 17.5 L 18.6 18.2 L 19.0 19.0 L 19.5 19.8 L 20.0 20.6 L 20.5 21.4 L 21.1 22.1 L 21.7 22.9 L 22.3 23.7 L 23.0 24.5 L 23.6 25.3 L 24.4 26.0 L 25.2 26.8 L 26.0 27.6 L 27.0 28.4 L 28.1 29.2 L 30.0 30.0 L 31.8 30.7 L 32.9 31.5 L 33.9 32.3 L 34.7 33.1 L 35.5 33.9 L 36.3 34.6 L 37.0 35.4 L 37.6 36.2 L 38.2 37.0 L 38.8 37.8 L 39.4 38.5 L 39.9 39.3 L 40.4 40.1 L 40.9 40.9 L 41.3 41.7 L 41.7 42.5 L 42.1 43.2 L 42.5 44.0 L 42.8 44.8 L 43.1 45.6 L 43.4 46.4 L 43.7 47.1 L 43.9 47.9 L 44.1 48.7 L 44.3 49.5 L 44.5 50.3 L 44.6 51.0 L 44.8 51.8 L 44.8 52.6 L 44.9 53.4 L 44.9 54.2 L 45.0 55.0"/></g><g stroke-width="3.7"><line x1="16.1" y1="10" x2="43.8" y2="10"/><line x1="20.2" y1="20" x2="30" y2="20" stroke="var(--dsw-alias-accent, #4f7cff)" stroke-width="5.0"/><line x1="30" y1="20" x2="39.7" y2="20" stroke="#ec4899" stroke-width="5.0"/><line x1="20.2" y1="40" x2="30" y2="40" stroke="#ec4899" stroke-width="5.0"/><line x1="30" y1="40" x2="39.7" y2="40" stroke="var(--dsw-alias-accent, #4f7cff)" stroke-width="5.0"/><line x1="16.1" y1="50" x2="43.8" y2="50"/></g></svg>`
    function PlasmidIcon() {
      return h('span', { className: 'plsm-badge-icon', 'aria-hidden': 'true',
        dangerouslySetInnerHTML: { __html: DNA_BADGE } })
    }

    // ---------- 60px 质粒徽记（用户 2026-09-01 拍板留存 web 端；12 辐条双层环，vb64） ----------
    // 原样内嵌用户提供 SVG（stroke=currentColor，容器色决定颜色），hero 位 60px 展示。
    const PLASMID_ART = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
  <g stroke-width="2.6"><path d="M 32.0 12.2 L 32.6 11.1 L 33.4 10.4 L 34.1 9.7 L 34.9 9.3 L 35.8 8.9 L 36.6 8.6 L 37.4 8.4 L 38.3 8.3 L 39.1 8.3 L 40.0 8.3 L 40.8 8.4 L 41.6 8.6 L 42.4 8.8 L 43.2 9.1 L 44.0 9.4 L 44.7 9.8 L 45.4 10.3 L 46.1 10.8 L 46.7 11.3 L 47.3 11.9 L 47.9 12.5 L 48.4 13.2 L 48.9 13.9 L 49.2 14.7 L 49.6 15.5 L 49.8 16.3 L 50.0 17.1 L 50.1 18.0 L 50.1 19.0 L 50.0 19.9 L 49.6 21.0 L 49.1 22.1 L 50.3 22.1 L 51.4 22.4 L 52.3 22.7 L 53.1 23.2 L 53.8 23.7 L 54.5 24.3 L 55.1 24.9 L 55.6 25.6 L 56.0 26.3 L 56.4 27.1 L 56.7 27.9 L 57.0 28.7 L 57.2 29.5 L 57.4 30.3 L 57.5 31.1 L 57.5 32.0 L 57.5 32.8 L 57.4 33.6 L 57.2 34.4 L 57.0 35.3 L 56.7 36.0 L 56.4 36.8 L 56.0 37.6 L 55.6 38.3 L 55.1 39.0 L 54.5 39.6 L 53.8 40.2 L 53.1 40.7 L 52.3 41.2 L 51.4 41.5 L 50.3 41.8 L 49.1 41.8 L 49.6 43.0 L 50.0 44.0 L 50.1 45.0 L 50.1 45.9 L 50.0 46.8 L 49.8 47.6 L 49.6 48.5 L 49.2 49.2 L 48.9 50.0 L 48.4 50.7 L 47.9 51.4 L 47.3 52.0 L 46.7 52.6 L 46.1 53.1 L 45.4 53.6 L 44.7 54.1 L 44.0 54.5 L 43.2 54.8 L 42.4 55.1 L 41.6 55.3 L 40.8 55.5 L 40.0 55.6 L 39.1 55.6 L 38.3 55.6 L 37.4 55.5 L 36.6 55.3 L 35.8 55.0 L 34.9 54.6 L 34.1 54.2 L 33.4 53.6 L 32.6 52.8 L 32.0 51.7 L 31.3 52.8 L 30.5 53.6 L 29.8 54.2 L 29.0 54.6 L 28.1 55.0 L 27.3 55.3 L 26.5 55.5 L 25.6 55.6 L 24.8 55.6 L 23.9 55.6 L 23.1 55.5 L 22.3 55.3 L 21.5 55.1 L 20.7 54.8 L 19.9 54.5 L 19.2 54.1 L 18.5 53.6 L 17.8 53.1 L 17.2 52.6 L 16.6 52.0 L 16.0 51.4 L 15.5 50.7 L 15.1 50.0 L 14.7 49.2 L 14.3 48.5 L 14.1 47.6 L 13.9 46.8 L 13.8 45.9 L 13.8 45.0 L 14.0 44.0 L 14.3 43.0 L 14.8 41.8 L 13.6 41.8 L 12.5 41.5 L 11.6 41.2 L 10.8 40.7 L 10.1 40.2 L 9.4 39.6 L 8.9 39.0 L 8.3 38.3 L 7.9 37.6 L 7.5 36.8 L 7.2 36.0 L 6.9 35.3 L 6.7 34.4 L 6.5 33.6 L 6.4 32.8 L 6.4 32.0 L 6.4 31.1 L 6.5 30.3 L 6.7 29.5 L 6.9 28.7 L 7.2 27.9 L 7.5 27.1 L 7.9 26.3 L 8.3 25.6 L 8.9 24.9 L 9.4 24.3 L 10.1 23.7 L 10.8 23.2 L 11.6 22.7 L 12.5 22.4 L 13.6 22.1 L 14.8 22.1 L 14.3 21.0 L 14.0 19.9 L 13.8 19.0 L 13.8 18.0 L 13.9 17.1 L 14.1 16.3 L 14.3 15.5 L 14.7 14.7 L 15.1 13.9 L 15.5 13.2 L 16.0 12.5 L 16.6 11.9 L 17.2 11.3 L 17.8 10.8 L 18.5 10.3 L 19.2 9.8 L 19.9 9.4 L 20.7 9.1 L 21.5 8.8 L 22.3 8.6 L 23.1 8.4 L 23.9 8.3 L 24.8 8.3 L 25.6 8.3 L 26.5 8.4 L 27.3 8.6 L 28.1 8.9 L 29.0 9.3 L 29.8 9.7 L 30.5 10.4 L 31.3 11.1 L 32.0 12.2 Z"/><path d="M 32.0 13.7 L 32.5 14.8 L 33.0 15.6 L 33.5 16.3 L 33.9 17.0 L 34.3 17.5 L 34.7 18.0 L 35.1 18.5 L 35.5 18.9 L 35.8 19.2 L 36.2 19.6 L 36.5 19.9 L 36.8 20.2 L 37.2 20.5 L 37.5 20.7 L 37.8 21.0 L 38.2 21.2 L 38.5 21.4 L 38.9 21.5 L 39.3 21.7 L 39.7 21.9 L 40.1 22.0 L 40.6 22.1 L 41.0 22.3 L 41.5 22.4 L 42.1 22.5 L 42.7 22.6 L 43.3 22.7 L 44.0 22.7 L 44.7 22.8 L 45.6 22.9 L 46.5 22.9 L 47.7 22.8 L 47.1 23.9 L 46.6 24.7 L 46.2 25.5 L 45.9 26.2 L 45.7 26.8 L 45.4 27.4 L 45.2 27.9 L 45.0 28.4 L 44.9 28.9 L 44.8 29.4 L 44.7 29.9 L 44.6 30.3 L 44.5 30.7 L 44.4 31.1 L 44.4 31.5 L 44.4 32.0 L 44.4 32.4 L 44.4 32.8 L 44.5 33.2 L 44.6 33.6 L 44.7 34.1 L 44.8 34.5 L 44.9 35.0 L 45.0 35.5 L 45.2 36.0 L 45.4 36.5 L 45.7 37.1 L 45.9 37.7 L 46.2 38.4 L 46.6 39.2 L 47.1 40.1 L 47.7 41.1 L 46.5 41.0 L 45.6 41.0 L 44.7 41.1 L 44.0 41.2 L 43.3 41.2 L 42.7 41.3 L 42.1 41.4 L 41.5 41.5 L 41.0 41.7 L 40.6 41.8 L 40.1 41.9 L 39.7 42.0 L 39.3 42.2 L 38.9 42.4 L 38.5 42.5 L 38.2 42.7 L 37.8 43.0 L 37.5 43.2 L 37.2 43.4 L 36.8 43.7 L 36.5 44.0 L 36.2 44.3 L 35.8 44.7 L 35.5 45.0 L 35.1 45.5 L 34.7 45.9 L 34.3 46.4 L 33.9 46.9 L 33.5 47.6 L 33.0 48.3 L 32.5 49.1 L 32.0 50.2 L 31.4 49.1 L 30.9 48.3 L 30.4 47.6 L 30.0 46.9 L 29.6 46.4 L 29.2 45.9 L 28.8 45.5 L 28.4 45.0 L 28.1 44.7 L 27.8 44.3 L 27.4 44.0 L 27.1 43.7 L 26.8 43.4 L 26.4 43.2 L 26.1 43.0 L 25.7 42.7 L 25.4 42.5 L 25.0 42.4 L 24.6 42.2 L 24.2 42.0 L 23.8 41.9 L 23.3 41.8 L 22.9 41.7 L 22.4 41.5 L 21.8 41.4 L 21.3 41.3 L 20.6 41.2 L 20.0 41.2 L 19.2 41.1 L 18.4 41.0 L 17.4 41.0 L 16.2 41.1 L 16.8 40.1 L 17.3 39.2 L 17.7 38.4 L 18.0 37.7 L 18.3 37.1 L 18.5 36.5 L 18.7 36.0 L 18.9 35.5 L 19.0 35.0 L 19.1 34.5 L 19.3 34.1 L 19.3 33.6 L 19.4 33.2 L 19.5 32.8 L 19.5 32.4 L 19.5 32.0 L 19.5 31.5 L 19.5 31.1 L 19.4 30.7 L 19.3 30.3 L 19.3 29.9 L 19.1 29.4 L 19.0 28.9 L 18.9 28.4 L 18.7 27.9 L 18.5 27.4 L 18.3 26.8 L 18.0 26.2 L 17.7 25.5 L 17.3 24.7 L 16.8 23.9 L 16.2 22.8 L 17.4 22.9 L 18.4 22.9 L 19.2 22.8 L 20.0 22.7 L 20.6 22.7 L 21.3 22.6 L 21.8 22.5 L 22.4 22.4 L 22.9 22.3 L 23.3 22.1 L 23.8 22.0 L 24.2 21.9 L 24.6 21.7 L 25.0 21.5 L 25.4 21.4 L 25.7 21.2 L 26.1 21.0 L 26.4 20.7 L 26.8 20.5 L 27.1 20.2 L 27.4 19.9 L 27.8 19.6 L 28.1 19.2 L 28.4 18.9 L 28.8 18.5 L 29.2 18.0 L 29.6 17.5 L 30.0 17.0 L 30.4 16.3 L 30.9 15.6 L 31.4 14.8 L 32.0 13.7 Z"/></g>
  <g stroke-width="2.5"><line x1="40.0" y1="9.8" x2="36.9" y2="18.4"/><line x1="47.1" y1="13.9" x2="41.2" y2="20.9"/><line x1="55.2" y1="27.9" x2="46.2" y2="29.4"/><line x1="55.2" y1="36.0" x2="46.2" y2="34.5"/><line x1="47.1" y1="50.0" x2="41.2" y2="43.0"/><line x1="40.0" y1="54.1" x2="36.9" y2="45.5"/><line x1="23.9" y1="54.1" x2="27.0" y2="45.5"/><line x1="16.8" y1="50.0" x2="22.7" y2="43.0"/><line x1="8.7" y1="36.0" x2="17.7" y2="34.5"/><line x1="8.7" y1="27.9" x2="17.7" y2="29.4"/><line x1="16.8" y1="13.9" x2="22.7" y2="20.9"/><line x1="23.9" y1="9.8" x2="27.0" y2="18.4"/></g>
</svg>`

    function PlasmArt(props) {
      return h('div', { className: 'plsm-art', title: 'Plasmid 徽记',
        dangerouslySetInnerHTML: { __html: PLASMID_ART } })
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
        h('div', { className: 'plsm-art-row' }, h(PlasmArt)),
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
.plsm-art-row { display: flex; justify-content: center; padding: 2px 0 8px; color: var(--dsw-alias-accent, #4f7cff); }
.plsm-art { width: 60px; height: 60px; }
.plsm-art svg { width: 60px; height: 60px; }
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

// sessmgr 客户端半部 v8：徽章对齐修复（基于 v7）。
// - 侧栏入口改用 15px SVG 图标（lucide archive，stroke currentColor）+ 独立 label 文本 span，
//   与市场/技能/插件徽章完全同款（此前 🗄 emoji 与文字同 span，图标宽度/基线与 SVG 徽章不齐）
// - 遵循槽契约 ownerProps.wide：窄轨（56px rail）只显示图标，宽栏才显示文字与计数
// - 槽注册 label 改 thunk（每次投影重读，随 locale 切换）
// v7 内容：GLM 审计采纳项（遮罩对账/TTL、无条件 hook、flash 覆盖）。
// - useZh 无条件 hook + useCallback 稳定订阅（条件调用会在 locale 服务装卸时崩整树；内联订阅每渲染重订）
// - 乐观遮罩对账/TTL：目录 justUnarchived 随真值对账 + 归档成功即撤遮罩；面板 removed 改 10s TTL——
//   修「捞回→再归档后该会话被旧遮罩永久吞掉、无 UI 路径捞回」的真 bug
// - flash 覆盖旧定时器：连续两条通知时旧 4s 定时器不再提前清掉新通知
// 其余同 v6（真 i18n：getLocale().active + 4+2 分组 order:-1/margin-bottom:8px + 捞回乐观移除）。
return {
  inject: ['sessions', 'workspaces', 'timer'],
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    const sessions = ctx.get('sessions')
    const workspaces = ctx.get('workspaces')
    if (sessions === undefined || workspaces === undefined) return

    const h = React.createElement

    // ---------- 文案（随 locale 切换，默认英文） ----------
    const localeSvc = ctx.get('locale')
    const EMPTY_SNAPSHOT = {}
    // 无条件 hook（GLM 审计 #3：条件调用在 locale 服务装卸时会崩整树）；
    // subscribe 用 useCallback 稳定引用（GLM #6：内联箭头每渲染退订重订）
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
      try {
        if (localeSvc === undefined || typeof localeSvc.getLocale !== 'function') return false
        const snap = localeSvc.getLocale()
        // LocaleSnapshot 形状：{ active: LocaleId, revision, locales } —— 字段是 active
        const id = typeof snap === 'string' ? snap : (snap !== null && typeof snap === 'object' ? String(snap.active ?? '') : '')
        return id.toLowerCase().startsWith('zh')
      } catch (error) { return false }
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
        running: '运行中', active: '未归档', archived: '已归档',
        archive: '归档', unarchive: '捞回', export: '导出…', del: '删除…',
        open: '打开', cancel: '取消', confirmDelete: '永久删除',
        deleteTitle: (t) => '删除会话「' + t + '」？',
        deleteBody: '将从磁盘永久删除该会话的全部记录（聊天日志 session.jsonl.zstd 及其全部状态）。删除后什么都不剩，无法恢复、无法找回。',
        deleteCascade: (n) => '该会话是主会话：删除它会连带删除其下辖全部子会话（共 ' + n + ' 个，合计 ' + (n + 1) + ' 个会话）。',
        deleteLive: (n) => '该子树有 ' + n + ' 个会话已加载在内存中（当前版本没有卸载接口），暂时无法删除；重启 DSH 后即可删除。',
        deleteHint: '归档只是收起，删除才是销毁。如果以后还可能要看，建议先归档。',
        archivedEntry: '已归档', ungrouped: '未加入工作区', empty: '没有已归档会话',
        noticeArchived: '已归档', noticeUnarchived: '已捞回', noticeDeleted: '已删除', noticeExported: '已导出到 ',
        busy: '处理中…', close: '关闭', previewUnavailable: '删除预览不可用，确认时将再次校验。',
        subagents: (n) => String(n) + ' 个子会话', subagentsTitle: '子会话',
      } : {
        running: 'Running', active: 'Active', archived: 'Archived',
        archive: 'Archive', unarchive: 'Unarchive', export: 'Export…', del: 'Delete…',
        open: 'Open', cancel: 'Cancel', confirmDelete: 'Delete permanently',
        deleteTitle: (t) => 'Delete session "' + t + '"?',
        deleteBody: "This permanently removes the session's entire record from disk (chat log and all state). Nothing will remain and it cannot be recovered.",
        deleteCascade: (n) => 'This is a main session: deleting it also deletes every sub session under it (' + n + ' more, ' + (n + 1) + ' sessions total).',
        deleteLive: (n) => n + ' session(s) in this subtree are loaded in memory (this version has no unload API); deletion is blocked until the next DSH restart.',
        deleteHint: 'Archiving only hides a session; deleting destroys it. If you might need it later, archive it instead.',
        archivedEntry: 'Archived', ungrouped: 'No workspace', empty: 'No archived sessions',
        noticeArchived: 'Archived', noticeUnarchived: 'Unarchived', noticeDeleted: 'Deleted', noticeExported: 'Exported to ',
        busy: 'Working…', close: 'Close', previewUnavailable: 'Delete preview unavailable; the deletion will be validated again on confirm.',
        subagents: (n) => String(n) + ' subagents', subagentsTitle: 'Subagents',
      }
    }

    // ---------- 小组件 ----------
    function ArchiveIcon() {
      // 图标套件定稿（ui-redraw SPEC）：档案盒=盒盖 + 盒身 + accent 抽屉拉手（可取回）；15px 固定盒
      return h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', style: { flex: 'none' } },
        h('path', { d: 'M4 4.5 h16 a0.5 0.5 0 0 1 0.5 0.5 v3 a0.5 0.5 0 0 1 -0.5 0.5 H4 a0.5 0.5 0 0 1 -0.5-0.5 V5 a0.5 0.5 0 0 1 0.5-0.5 Z' }),
        h('path', { d: 'M5.5 8.5 V18 a2 2 0 0 0 2 2 h9 a2 2 0 0 0 2-2 V8.5' }),
        h('path', { d: 'M9.5 11.8 h5', stroke: 'var(--dsw-alias-accent, #4f7cff)' }))
    }
    function Dot(props) {
      return h('span', { className: 'sessmgr-dot ' + (props.on === true ? 'sessmgr-dot-on' : '') })
    }
    function Menu(props) {
      // props: items [{key,label,danger,disabled,onClick}], onClose
      React.useEffect(() => {
        const away = (event) => {
          if (!(event.target instanceof Node)) return
          const root = document.querySelector('.sessmgr-menu')
          if (root !== null && root.contains(event.target)) return
          props.onClose()
        }
        document.addEventListener('pointerdown', away)
        return () => document.removeEventListener('pointerdown', away)
      }, [])
      return h('div', { className: 'sessmgr-menu', role: 'menu' },
        props.items.map((it) => h('button', {
          key: it.key, type: 'button', role: 'menuitem',
          className: 'sessmgr-menu-item' + (it.danger === true ? ' sessmgr-danger' : ''),
          disabled: it.disabled === true,
          onClick: (event) => { event.stopPropagation(); props.onClose(); it.onClick() },
        }, it.label)))
    }

    // ---------- 删除确认弹窗 ----------
    function DeleteDialog(props) {
      // props: { sessionId, label, callerSessionId, zh, onClose, onDeleted }
      const t = copy(props.zh)
      const [preview, setPreview] = React.useState(undefined)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(undefined)
      React.useEffect(() => {
        let stale = false
        host.call('session.deletePreview', { sessionIds: [props.sessionId], callerSessionId: props.callerSessionId })
          .then((res) => { if (!stale) setPreview(res) })
          .catch((e) => { if (!stale) setPreview({ ok: false, error: String(e) }) })
        return () => { stale = true }
      }, [props.sessionId])
      React.useEffect(() => {
        const esc = (event) => { if (event.key === 'Escape') props.onClose() }
        document.addEventListener('keydown', esc)
        return () => document.removeEventListener('keydown', esc)
      }, [])
      const previewErr = preview !== undefined && preview !== null && !Array.isArray(preview.results) && typeof preview.error === 'string' ? preview.error : undefined
      const row = preview !== undefined && preview !== null && Array.isArray(preview.results) ? preview.results[0] : undefined
      const subtreeSize = row !== undefined && typeof row.subtreeSize === 'number' ? row.subtreeSize : 1
      const liveIds = row !== undefined && Array.isArray(row.liveIds) ? row.liveIds : []
      const blocked = liveIds.length > 0 || busy
      const doDelete = () => {
        setBusy(true); setError(undefined)
        host.call('session.delete', { sessionIds: [props.sessionId], confirm: true, callerSessionId: props.callerSessionId })
          .then((res) => {
            const r = res !== null && res !== undefined && Array.isArray(res.results) ? res.results[0] : undefined
            if (r !== undefined && r.ok === true) { props.onDeleted(props.sessionId); props.onClose(); return }
            const envErr = res !== null && typeof res === 'object' && typeof res.error === 'string' ? res.error : undefined
            setError(r !== undefined && typeof r.error === 'string' ? r.error : (envErr !== undefined ? envErr : 'delete failed'))
            setBusy(false)
          })
          .catch((e) => { setError(String(e && e.message !== undefined ? e.message : e)); setBusy(false) })
      }
      return h('div', { className: 'sessmgr-overlay' },
        h('div', { className: 'sessmgr-backdrop', onClick: props.onClose }),
        h('div', { className: 'sessmgr-dialog', role: 'dialog', 'aria-modal': 'true' },
          h('div', { className: 'sessmgr-dialog-head' },
            h('div', { className: 'sessmgr-dialog-title' }, t.deleteTitle(props.label)),
            h('button', { type: 'button', className: 'sessmgr-dialog-close', onClick: props.onClose, 'aria-label': t.close }, '✕')),
          h('div', { className: 'sessmgr-dialog-body' },
            h('p', null, t.deleteBody),
            subtreeSize > 1 ? h('p', { className: 'sessmgr-warn-text' }, t.deleteCascade(subtreeSize - 1)) : null,
            liveIds.length > 0 ? h('p', { className: 'sessmgr-error-text' }, t.deleteLive(liveIds.length)) : null,
            h('p', { className: 'sessmgr-hint' }, t.deleteHint),
            previewErr !== undefined ? h('p', { className: 'sessmgr-hint' }, t.previewUnavailable) : null,
            error !== undefined ? h('p', { className: 'sessmgr-error-text' }, error) : null),
          h('div', { className: 'sessmgr-dialog-actions' },
            h('button', { type: 'button', className: 'sessmgr-btn', onClick: props.onClose }, t.cancel),
            h('button', { type: 'button', className: 'sessmgr-btn sessmgr-btn-danger', disabled: blocked, onClick: doDelete },
              busy ? t.busy : t.confirmDelete))))
    }

    // ---------- 目录弹层行 ----------
    function CatalogRow(props) {
      // props: entry, summary, archived, level, zh, callerSessionId, actions
      const t = copy(props.zh)
      const [menuOpen, setMenuOpen] = React.useState(false)
      const [expanded, setExpanded] = React.useState(false)
      const e = props.entry
      const label = props.summary !== undefined && typeof props.summary.displayTitle === 'string'
        ? props.summary.displayTitle
        : (typeof e.label === 'string' && e.label.length > 0 ? e.label : e.id)
      const running = e.activity === 'running' || (props.summary !== undefined && props.summary.running === true)
      const canExpand = e.hasChildren === true
      const toggle = (event) => {
        event.stopPropagation()
        const next = !expanded
        setExpanded(next)
        if (next && typeof sessions.refreshSubagents === 'function') sessions.refreshSubagents(e.id)
        if (typeof sessions.setSubagentCatalogOpen === 'function') sessions.setSubagentCatalogOpen(e.id, next)
      }
      const openSelf = () => {
        if (typeof sessions.openSubagent === 'function' && typeof props.parentId === 'string') {
          sessions.openSubagent({ parentSessionId: props.parentId, childSessionId: e.id, mode: e.mode === 'continuable' ? 'continuable' : 'one-shot' })
        } else if (typeof sessions.open === 'function') sessions.open(e.id)
        props.actions.closeAll()
      }
      const act = (method, extra) => props.actions.mutate(method, { sessionIds: [e.id], ...extra }, label)
      const items = []
      if (props.archived) items.push({ key: 'unarchive', label: t.unarchive, onClick: () => act('session.unarchive') })
      else items.push({ key: 'archive', label: t.archive, disabled: running, onClick: () => act('session.archive') })
      items.push({ key: 'export', label: t.export, onClick: () => act('session.export', { targetId: e.id }) })
      items.push({ key: 'delete', label: t.del, danger: true, disabled: running, onClick: () => props.actions.confirmDelete(e.id, label) })
      return h(React.Fragment, null,
        h('div', { className: 'sessmgr-row', role: 'treeitem', 'aria-selected': 'false', style: { paddingLeft: String(8 + props.level * 14) + 'px' } },
          canExpand
            ? h('button', { type: 'button', className: 'sessmgr-chev' + (expanded ? ' sessmgr-chev-open' : ''), onClick: toggle, 'aria-label': 'expand' }, '▸')
            : h('span', { className: 'sessmgr-chev-space' }),
          h('div', { className: 'sessmgr-click', onClick: openSelf, role: 'button' },
            h(Dot, { on: running }),
            h('span', { className: 'sessmgr-label' }, label),
            h('span', { className: 'sessmgr-sub' }, e.mode === 'continuable' ? 'continuable' : 'one-shot')),
          h('button', {
            type: 'button', className: 'sessmgr-row-actions', 'aria-label': 'actions',
            onClick: (event) => { event.stopPropagation(); setMenuOpen(!menuOpen) },
          }, '⋯'),
          menuOpen ? h(Menu, { items, onClose: () => setMenuOpen(false) }) : null),
        expanded ? h(CatalogBranch, { parentId: e.id, level: props.level + 1, zh: props.zh, callerSessionId: props.callerSessionId, actions: props.actions }) : null)
    }

    // ---------- 目录分支（递归） ----------
    function CatalogBranch(props) {
      // props: parentId, level, zh, callerSessionId, actions
      const catalogs = props.actions.useSessions((s) => s.subagentsByParent)
      const summaries = props.actions.useSessions((s) => s.byId)
      const archivedIds = props.actions.useWorkspaces((s) => s.archivedSessionIds)
      const archivedSet = new Set((Array.isArray(archivedIds) ? archivedIds : []).filter((id) => !props.actions.isJustUnarchived(id)))
      const catalog = catalogs[props.parentId]
      const entries = catalog !== undefined && Array.isArray(catalog.entries)
        ? catalog.entries.filter((x) => x !== null && typeof x === 'object' && x.kind === 'child' && !props.actions.isRemoved(x.id))
        : []
      // 分支内部同样按 运行/未归档/已归档 排序，但不加分区头（保持树感）
      const score = (e) => {
        const running = e.activity === 'running' || (summaries[e.id] !== undefined && summaries[e.id].running === true)
        if (archivedSet.has(e.id)) return 2
        return running ? 0 : 1
      }
      const sorted = [...entries].sort((a, b) => score(a) - score(b))
      if (catalog === undefined || catalog.state === 'loading') {
        return h('div', { className: 'sessmgr-loading', style: { paddingLeft: String(8 + props.level * 14) + 'px' } }, '…')
      }
      return h('div', { role: 'group', className: props.level > 0 ? 'sessmgr-children' : undefined },
        sorted.map((e) => h(CatalogRow, {
          key: e.id, entry: e, summary: summaries[e.id], archived: archivedSet.has(e.id),
          level: props.level, zh: props.zh, callerSessionId: props.callerSessionId, actions: props.actions, parentId: props.parentId,
        })))
    }

    // ---------- 分区头 ----------
    function Section(props) {
      // props: title, count, open, onToggle, defaultOpenNote
      return h('button', { type: 'button', className: 'sessmgr-section', onClick: props.onToggle },
        h('span', { className: 'sessmgr-chev' + (props.open ? ' sessmgr-chev-open' : '') }, '▸'),
        h('span', null, props.title),
        h('span', { className: 'sessmgr-count' }, String(props.count)))
    }

    // ---------- 目录弹层主体 ----------
    function CatalogPanel(props) {
      // props: sessionId, zh, actions (useSessions/useWorkspaces via closure)
      const t = copy(props.zh)
      const summaries = props.actions.useSessions((s) => s.byId)
      const archivedIds = props.actions.useWorkspaces((s) => s.archivedSessionIds)
      const archivedSet = new Set((Array.isArray(archivedIds) ? archivedIds : []).filter((id) => !props.actions.isJustUnarchived(id)))
      const catalogs = props.actions.useSessions((s) => s.subagentsByParent)
      const catalog = catalogs[props.sessionId]
      const entries = catalog !== undefined && Array.isArray(catalog.entries)
        ? catalog.entries.filter((x) => x !== null && typeof x === 'object' && x.kind === 'child' && !props.actions.isRemoved(x.id))
        : []
      const diagnostics = catalog !== undefined && Array.isArray(catalog.entries)
        ? catalog.entries.filter((x) => x !== null && typeof x === 'object' && x.kind === 'diagnostic')
        : []
      const isRunning = (e) => e.activity === 'running' || (summaries[e.id] !== undefined && summaries[e.id].running === true)
      const running = entries.filter((e) => !archivedSet.has(e.id) && isRunning(e))
      const active = entries.filter((e) => !archivedSet.has(e.id) && !isRunning(e))
      const archived = entries.filter((e) => archivedSet.has(e.id))
      const [openSec, setOpenSec] = React.useState({ running: true, active: true, archived: false })
      const toggleSec = (k) => setOpenSec((cur) => ({ ...cur, [k]: !cur[k] }))
      const renderRows = (list) => list.map((e) => h(CatalogRow, {
        key: e.id, entry: e, summary: summaries[e.id], archived: archivedSet.has(e.id),
        level: 0, zh: props.zh, callerSessionId: props.sessionId, actions: props.actions, parentId: props.sessionId,
      }))
      return h('div', { className: 'sessmgr-pop', role: 'tree' },
        h('div', { className: 'sessmgr-pop-head' },
          h('span', null, t.subagentsTitle),
          h('button', { type: 'button', className: 'sessmgr-icon-btn', 'aria-label': 'refresh', onClick: () => sessions.refreshSubagents(props.sessionId) }, '↻')),
        running.length > 0 ? h(Section, { title: t.running, count: running.length, open: openSec.running, onToggle: () => toggleSec('running') }) : null,
        openSec.running ? renderRows(running) : null,
        h(Section, { title: t.active, count: active.length, open: openSec.active, onToggle: () => toggleSec('active') }),
        openSec.active ? renderRows(active) : null,
        openSec.active && diagnostics.map((d) => h('div', { key: d.id, className: 'sessmgr-row sessmgr-row-disabled' }, h('span', { className: 'sessmgr-label' }, d.id + ' (' + String(d.reason) + ')'))),
        archived.length > 0 || true
          ? h(Section, { title: t.archived, count: archived.length, open: openSec.archived, onToggle: () => toggleSec('archived') })
          : null,
        openSec.archived ? renderRows(archived) : null,
        props.actions.notice !== undefined ? h('div', { className: 'sessmgr-notice' }, props.actions.notice) : null)
    }

    // ---------- 头部动作（替换上游 subagent-catalog cell） ----------
    function CatalogAction(props) {
      const zh = useZh()
      const [open, setOpen] = React.useState(false)
      const [removed, setRemoved] = React.useState(() => new Set())
      const [justUnarchived, setJustUnarchived] = React.useState(() => new Set())
      const [notice, setNotice] = React.useState(undefined)
      const [deleteTarget, setDeleteTarget] = React.useState(undefined)
      const rootRef = React.useRef(null)
      const summaries = props.useSessions((s) => s.byId)
      const catalogs = props.useSessions((s) => s.subagentsByParent)
      const archivedIds = props.useWorkspaces((s) => s.archivedSessionIds)
      const sessionId = props.sessionId

      // 后代计数（触发钮显示）：沿 parentId 链 BFS
      const descendants = React.useMemo(() => {
        let count = 0, runningCount = 0
        const queue = []
        for (const id of Object.keys(summaries)) if (summaries[id].parentId === sessionId) queue.push(id)
        const seen = new Set(queue)
        while (queue.length > 0) {
          const id = queue.shift()
          count += 1
          if (summaries[id].running === true) runningCount += 1
          for (const other of Object.keys(summaries)) {
            if (!seen.has(other) && summaries[other].parentId === id) { seen.add(other); queue.push(other) }
          }
        }
        return { count, runningCount }
      }, [summaries, sessionId])

      const catalog = catalogs[sessionId]
      const directCount = catalog !== undefined && Array.isArray(catalog.entries)
        ? catalog.entries.filter((x) => x !== null && typeof x === 'object' && x.kind === 'child').length
        : 0
      const visible = descendants.count > 0 || directCount > 0
        || (catalog !== undefined && (catalog.state === 'loading' || catalog.state === 'error'))

      // 挂载时水合目录：select() 会 refresh 一次，但页签恢复/时序竞争下可能缺席；
      // 目录到位（ready 且有条目）后 visible 才转 true，无子会话的会话保持隐藏。
      // 乐观遮罩对账（GLM 审计 #4）：真值已不含的 id 从遮罩移除——
      // 之后若该会话被再次归档（真值重新包含它），归档区能正确显示，而不是被旧遮罩永久吞掉。
      const archivedKey = (Array.isArray(archivedIds) ? archivedIds : []).join(',')
      React.useEffect(() => {
        const truth = new Set(Array.isArray(archivedIds) ? archivedIds : [])
        setJustUnarchived((cur) => {
          const next = new Set([...cur].filter((id) => truth.has(id)))
          return next.size === cur.size ? cur : next
        })
      }, [archivedKey])

      const catalogMissing = catalog === undefined
      React.useEffect(() => {
        if (!catalogMissing) return
        if (typeof sessions.refreshSubagents !== 'function') return
        try { Promise.resolve(sessions.refreshSubagents(sessionId)).catch(() => {}) } catch (error) { /* noop */ }
      }, [catalogMissing, sessionId])

      React.useEffect(() => {
        if (!open) return
        if (typeof sessions.refreshSubagents === 'function') sessions.refreshSubagents(sessionId)
        if (typeof sessions.setSubagentCatalogOpen === 'function') sessions.setSubagentCatalogOpen(sessionId, true)
        const away = (event) => {
          if (!(event.target instanceof Node)) return
          if (rootRef.current !== null && rootRef.current.contains(event.target)) return
          setOpen(false)
        }
        document.addEventListener('pointerdown', away)
        return () => {
          document.removeEventListener('pointerdown', away)
          if (typeof sessions.setSubagentCatalogOpen === 'function') sessions.setSubagentCatalogOpen(sessionId, false)
        }
      }, [open, sessionId])

      const flashRef = React.useRef(undefined)
      const flash = (text) => {
        if (typeof flashRef.current === 'function') flashRef.current()
        setNotice(text)
        flashRef.current = ctx.timeout(() => setNotice(undefined), 4000)
      }
      const actions = {
        useSessions: props.useSessions,
        useWorkspaces: props.useWorkspaces,
        notice,
        isRemoved: (id) => removed.has(id),
        isJustUnarchived: (id) => justUnarchived.has(id),
        closeAll: () => setOpen(false),
        confirmDelete: (id, label) => setDeleteTarget({ id, label }),
        mutate: (method, payload, label) => {
          // zh 取自组件渲染闭包（useZh 只能在渲染期调用，事件处理器里再调是 hook 违规）
          const t = copy(zh)
          host.call(method, { ...payload, callerSessionId: sessionId })
            .then((res) => {
              if (method === 'session.export') {
                const outDir = res !== null && typeof res === 'object' && typeof res.outDir === 'string' ? res.outDir : undefined
                flash(outDir !== undefined ? t.noticeExported + outDir : 'export ok')
                return
              }
              const r = res !== null && typeof res === 'object' && Array.isArray(res.results) ? res.results[0] : undefined
              if (r !== undefined && r.ok === true) {
                if (method === 'session.archive') {
                  flash(t.noticeArchived + ' · ' + label)
                  // 归档成功即撤销该 id 的捞回遮罩（捞回后 4.5s 窗口内又归档的竞态）
                  const doneIds = Array.isArray(payload.sessionIds) ? payload.sessionIds : []
                  if (doneIds.length > 0) setJustUnarchived((cur) => {
                    const next = new Set([...cur].filter((id) => !doneIds.includes(id)))
                    return next.size === cur.size ? cur : next
                  })
                }
                else if (method === 'session.unarchive') {
                  flash(t.noticeUnarchived + ' · ' + label)
                  // 乐观分区：宿主推送（约 4.5s）到达前先把该行当作未归档
                  const okIds = Array.isArray(payload.sessionIds) ? payload.sessionIds : []
                  if (okIds.length > 0) setJustUnarchived((cur) => new Set([...cur, ...okIds]))
                }
                else flash('ok')
              } else {
                const envErr = res !== null && typeof res === 'object' && typeof res.error === 'string' ? res.error : undefined
                flash(r !== undefined && typeof r.error === 'string' ? r.error : (envErr !== undefined ? envErr : 'failed'))
              }
            })
            .catch((e) => flash(String(e && e.message !== undefined ? e.message : e)))
        },
      }
      const onDeleted = (id) => setRemoved((cur) => new Set([...cur, id]))

      if (!visible) return null
      return h('div', { className: 'sessmgr-root', ref: rootRef },
        h('button', {
          type: 'button', className: 'sessmgr-trigger', 'aria-haspopup': 'tree', 'aria-expanded': open,
          onClick: () => setOpen(!open),
        },
          h(Dot, { on: descendants.runningCount > 0 }),
          h('span', null, copy(zh).subagents(Math.max(descendants.count, directCount))),
          h('span', { className: 'sessmgr-chev' + (open ? ' sessmgr-chev-open' : '') }, '▾')),
        open ? h(CatalogPanel, { sessionId, zh, actions }) : null,
        deleteTarget !== undefined ? h(DeleteDialog, {
          sessionId: deleteTarget.id, label: deleteTarget.label, callerSessionId: sessionId, zh,
          onClose: () => setDeleteTarget(undefined), onDeleted,
        }) : null)
    }

    // ---------- 侧栏「已归档」入口 + 浮层 ----------
    function ArchivedEntry(props) {
      const zh = useZh()
      const t = copy(zh)
      const [open, setOpen] = React.useState(false)
      const [notice, setNotice] = React.useState(undefined)
      const [removed, setRemoved] = React.useState(() => new Set())
      const [deleteTarget, setDeleteTarget] = React.useState(undefined)
      const archivedIds = props.useWorkspaces((s) => s.archivedSessionIds)
      const wsItems = props.useWorkspaces((s) => s.items)
      const summaries = props.useSessions((s) => s.byId)
      const currentId = props.useSessions((s) => s.current)
      const archived = (Array.isArray(archivedIds) ? archivedIds : []).filter((id) => !removed.has(id))
      const panelRef = React.useRef(null)

      React.useEffect(() => {
        if (!open) return
        const away = (event) => {
          if (!(event.target instanceof Node)) return
          if (panelRef.current !== null && panelRef.current.contains(event.target)) return
          setOpen(false)
        }
        document.addEventListener('pointerdown', away)
        return () => document.removeEventListener('pointerdown', away)
      }, [open])

      // 乐观移除用 TTL 撤销（GLM 审计 #4）：遮罩 10s 后自动撤除——
      // 届时宿主推送（约 4.5s）必然已到达，真值接管；捞回后再归档的会话能正常重现。
      // 被删的 id 本就不再回真值，TTL 到期撤遮罩也不会让它复活。
      const removedTimers = React.useRef({})
      const maskTemporarily = (ids) => {
        setRemoved((cur) => new Set([...cur, ...ids]))
        for (const id of ids) {
          if (typeof removedTimers.current[id] === 'function') removedTimers.current[id]()
          removedTimers.current[id] = ctx.timeout(() => {
            delete removedTimers.current[id]
            setRemoved((cur) => {
              if (!cur.has(id)) return cur
              const next = new Set(cur); next.delete(id); return next
            })
          }, 10000)
        }
      }

      const flashRef = React.useRef(undefined)
      const flash = (text) => {
        // GLM 审计：连续两条通知时，旧定时器不得提前清掉新通知——先撤旧再设新
        if (typeof flashRef.current === 'function') flashRef.current()
        setNotice(text)
        flashRef.current = ctx.timeout(() => setNotice(undefined), 4000)
      }
      const mutate = (method, payload, label) => {
        host.call(method, { ...payload, callerSessionId: typeof currentId === 'string' ? currentId : '' })
          .then((res) => {
            if (method === 'session.export') {
              const outDir = res !== null && typeof res === 'object' && typeof res.outDir === 'string' ? res.outDir : undefined
              flash(outDir !== undefined ? t.noticeExported + outDir : 'export ok')
              return
            }
            const r = res !== null && typeof res === 'object' && Array.isArray(res.results) ? res.results[0] : undefined
            const envErr = res !== null && typeof res === 'object' && typeof res.error === 'string' ? res.error : undefined
            if (r !== undefined && r.ok === true) {
              flash(t.noticeUnarchived + ' · ' + label)
              // 乐观移除：宿主推送（约 4.5s）到达前先从面板里拿掉该行（TTL 10s 自动撤销）
              const okIds = Array.isArray(payload.sessionIds) ? payload.sessionIds : []
              if (okIds.length > 0) maskTemporarily(okIds)
            }
            else flash(r !== undefined && typeof r.error === 'string' ? r.error : (envErr !== undefined ? envErr : 'failed'))
          })
          .catch((e) => flash(String(e && e.message !== undefined ? e.message : e)))
      }

      // 按工作区分组：ws.sessionIds ∩ archived；其余进未分组
      const groups = []
      const claimed = new Set()
      for (const ws of Array.isArray(wsItems) ? wsItems : []) {
        if (ws === null || typeof ws !== 'object') continue
        const ids = Array.isArray(ws.sessionIds) ? ws.sessionIds.filter((id) => archived.includes(id)) : []
        if (ids.length === 0) continue
        ids.forEach((id) => claimed.add(id))
        groups.push({ key: String(ws.id), title: typeof ws.title === 'string' && ws.title.length > 0 ? ws.title : String(ws.path ?? ws.id), ids })
      }
      const rest = archived.filter((id) => !claimed.has(id))
      if (rest.length > 0) groups.push({ key: '_ungrouped', title: t.ungrouped, ids: rest })

      return h('div', { className: 'sessmgr-arch-entry' },
        h('button', { type: 'button', className: 'sessmgr-arch-btn', onClick: () => setOpen(!open), title: t.archivedEntry },
          h(ArchiveIcon, null),
          props.wide === true
            ? h('span', { style: { textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, overflow: 'hidden' } }, t.archivedEntry)
            : null,
          props.wide === true && archived.length > 0 ? h('span', { className: 'sessmgr-count' }, String(archived.length)) : null),
        open ? h('div', { className: 'sessmgr-overlay' },
          h('div', { className: 'sessmgr-backdrop', onClick: () => setOpen(false) }),
          h('div', { className: 'sessmgr-archmodal', ref: panelRef },
            h('div', { className: 'sessmgr-dialog-head' },
              h('div', { className: 'sessmgr-dialog-title' }, t.archivedEntry + ' (' + String(archived.length) + ')'),
              h('button', { type: 'button', className: 'sessmgr-dialog-close', onClick: () => setOpen(false), 'aria-label': t.close }, '✕')),
            h('div', { className: 'sessmgr-archmodal-body' },
          groups.length === 0 ? h('div', { className: 'sessmgr-empty' }, t.empty) : null,
          groups.map((g) => h('div', { key: g.key, className: 'sessmgr-arch-group' },
            h('div', { className: 'sessmgr-arch-group-title' }, g.title),
            g.ids.map((id) => {
              const s = summaries[id]
              const label = s !== undefined && typeof s.displayTitle === 'string' ? s.displayTitle : id
              return h('div', { key: id, className: 'sessmgr-row' },
                h('div', { className: 'sessmgr-click', role: 'button', onClick: () => { if (typeof sessions.open === 'function') sessions.open(id); setOpen(false) } },
                  h(Dot, { on: false }),
                  h('span', { className: 'sessmgr-label' }, label)),
                h('button', { type: 'button', className: 'sessmgr-chip', onClick: () => mutate('session.unarchive', { sessionIds: [id] }, label) }, t.unarchive),
                h('button', { type: 'button', className: 'sessmgr-chip', onClick: () => mutate('session.export', { targetId: id }, label) }, t.export),
                h('button', { type: 'button', className: 'sessmgr-chip sessmgr-danger', onClick: () => setDeleteTarget({ id, label }) }, t.del))
            }))),
          notice !== undefined ? h('div', { className: 'sessmgr-notice' }, notice) : null))) : null,
        deleteTarget !== undefined ? h(DeleteDialog, {
          sessionId: deleteTarget.id, label: deleteTarget.label,
          callerSessionId: typeof currentId === 'string' ? currentId : '', zh,
          onClose: () => setDeleteTarget(undefined),
          onDeleted: (id) => setRemoved((cur) => new Set([...cur, id])),
        }) : null)
    }

    // ---------- 样式 ----------
    styles.insert(`
/* ===== 与上游子代理目录 + 市场/技能/插件面板（plins/sklui/plugmgr）同一设计语言 ===== */
.sessmgr-root { position: relative; display: inline-flex; }
/* 触发钮：上游目录触发钮同款（无框、tertiary、28px 高） */
.sessmgr-trigger { min-height: 28px; color: var(--dsw-alias-label-tertiary, #6b7280); cursor: pointer; background: none; border: 0; border-radius: 6px; align-items: center; gap: 4px; padding: 3px 6px 3px 4px; font-size: 12px; line-height: 18px; display: inline-flex; font-family: inherit; }
.sessmgr-trigger:hover, .sessmgr-trigger:focus-visible { color: var(--dsw-alias-label-secondary, #374151); }
.sessmgr-trigger .sessmgr-count { margin: 0 2px; background: none; padding: 0; font-weight: inherit; color: inherit; }
/* 目录弹层：上游 menu 容器（--dsw-specific-menu / shadow-lv3 / 12px 圆角 / 4px 内边距） */
.sessmgr-pop { position: absolute; top: calc(100% + 5px); left: 0; z-index: 100; box-sizing: border-box; width: 336px; max-width: min(400px, calc(100vw - 32px)); max-height: min(560px, calc(100vh - 140px)); overflow: auto; background: var(--dsw-specific-menu, var(--dsw-alias-bg-overlay, #fff)); border-radius: 12px; box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,.18)); padding: 4px; display: flex; flex-direction: column; }
.sessmgr-pop-head { display: flex; justify-content: space-between; align-items: center; padding: 8px 11px 4px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #6b7280); }
.sessmgr-icon-btn { color: inherit; cursor: pointer; background: none; border: 0; border-radius: 6px; display: inline-flex; align-items: center; gap: 4px; padding: 4px 6px; font-size: 12px; font-family: inherit; }
.sessmgr-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.1)); }
/* 分区头：tertiary 小号大写，点击折叠 */
.sessmgr-section { display: flex; align-items: center; gap: 6px; width: 100%; box-sizing: border-box; text-align: left; padding: 8px 11px 4px; border: 0; background: none; cursor: pointer; font-size: 11px; line-height: 16px; font-weight: 600; letter-spacing: .05em; color: var(--dsw-alias-label-tertiary, #6b7280); text-transform: uppercase; font-family: inherit; border-radius: 6px; }
.sessmgr-count { margin-left: auto; font-weight: 500; font-size: 11px; color: var(--dsw-alias-label-tertiary, #9aa0aa); }
.sessmgr-chev { display: inline-flex; transition: transform .12s; font-size: 10px; color: var(--dsw-alias-label-tertiary, #9aa0aa); }
.sessmgr-chev-open { transform: rotate(90deg); }
.sessmgr-chev-space { flex: none; width: 14px; height: 18px; display: inline-block; }
/* 行：上游 row 同款（8px 圆角、13px/18px、hover 用 interactive-bg-hover） */
.sessmgr-row { box-sizing: border-box; width: 100%; min-height: 36px; display: flex; align-items: center; gap: 4px; border-radius: 8px; padding: 4px 6px 4px 8px; font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-primary, inherit); position: relative; }
.sessmgr-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.1)); }
.sessmgr-row-disabled { color: var(--dsw-alias-label-dimmed, #9aa0aa); }
.sessmgr-click { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; cursor: pointer; padding: 4px 0; }
.sessmgr-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; }
.sessmgr-sub { margin-left: auto; flex: none; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary, #9aa0aa); }
.sessmgr-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-border-l2, #d4d4da); flex: none; }
.sessmgr-dot-on { background: var(--dsw-alias-state-success-primary, #16a34a); animation: sessmgr-pulse 1.6s ease-in-out infinite; }
@keyframes sessmgr-pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
/* 行内 ⋯：上游 disclosure 风格（tertiary → hover 变深） */
.sessmgr-row-actions { visibility: hidden; color: var(--dsw-alias-label-tertiary, #9aa0aa); cursor: pointer; background: none; border: 0; border-radius: 6px; padding: 2px 6px; font-size: 13px; line-height: 18px; flex: none; font-family: inherit; }
.sessmgr-row:hover .sessmgr-row-actions { visibility: visible; }
.sessmgr-row-actions:hover { color: var(--dsw-alias-label-primary, #1f2328); background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
/* 行菜单：官方 menu 容器迷你版 */
.sessmgr-menu { position: absolute; right: 4px; top: calc(100% + 2px); z-index: 110; min-width: 148px; background: var(--dsw-specific-menu, var(--dsw-alias-bg-overlay, #fff)); border-radius: 12px; box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,.18)); padding: 4px; }
.sessmgr-menu-item { display: flex; align-items: center; width: 100%; box-sizing: border-box; text-align: left; padding: 6px 10px; border: 0; background: none; cursor: pointer; font-size: 13px; line-height: 18px; border-radius: 8px; color: var(--dsw-alias-label-primary, #1f2328); font-family: inherit; }
.sessmgr-menu-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.1)); }
.sessmgr-menu-item:disabled { color: var(--dsw-alias-label-dimmed, #9aa0aa); cursor: not-allowed; background: none; }
.sessmgr-danger { color: var(--dsw-alias-state-error-primary, #dc2626) !important; }
/* 模态体系：sklui 面板（模糊背板 / 20px 圆角 / border-strong / 48px 阴影） */
.sessmgr-overlay { position: fixed; inset: 0; z-index: 1000; display: flex; justify-content: center; align-items: center; }
.sessmgr-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.42); backdrop-filter: blur(2px); }
.sessmgr-dialog { position: relative; z-index: 1; width: 480px; max-width: calc(100vw - 48px); display: flex; flex-direction: column; overflow: hidden; border-radius: 20px; border: 1px solid var(--dsw-alias-border-strong, rgba(128,128,128,.25)); background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-primary, inherit); box-shadow: 0 18px 48px rgba(0,0,0,.28); font-family: inherit; }
.sessmgr-dialog-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 20px 24px 14px; border-bottom: 1px solid rgba(128,128,128,.14); flex: none; }
.sessmgr-dialog-title { font-size: 17px; font-weight: 650; line-height: 24px; word-break: break-all; }
.sessmgr-dialog-close { width: 30px; height: 30px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 10px; cursor: pointer; background: transparent; color: var(--dsw-alias-label-secondary, inherit); font-size: 14px; flex: none; }
.sessmgr-dialog-close:hover { background: var(--dsw-alias-bg-hover, rgba(128,128,128,.1)); }
.sessmgr-dialog-body { padding: 14px 24px 4px; }
.sessmgr-dialog-body p { margin: 0 0 10px; font-size: 13px; line-height: 1.6; }
.sessmgr-hint { color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 12px !important; }
.sessmgr-warn-text { color: var(--dsw-alias-state-warn-primary, #b45309); }
.sessmgr-error-text { color: var(--dsw-alias-state-error-primary, #dc2626); }
.sessmgr-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 24px 20px; }
/* 按钮体系：sklui btn（28px 高、8px 圆角、灰描边透明底；danger 红描边） */
.sessmgr-btn { border: 1px solid rgba(128,128,128,.28); background: transparent; color: var(--dsw-alias-label-secondary, inherit); border-radius: 8px; height: 28px; padding: 0 14px; cursor: pointer; font-size: 12px; font-family: inherit; }
.sessmgr-btn:hover { background: var(--dsw-alias-bg-hover, rgba(128,128,128,.08)); }
.sessmgr-btn:disabled { opacity: .45; cursor: default; }
.sessmgr-btn-danger { color: #dc2626; border-color: rgba(220,38,38,.35); }
.sessmgr-btn-danger:hover { background: rgba(220,38,38,.07); }
/* 通知条：上游 notice 风格 */
.sessmgr-notice { margin: 4px 4px 0; padding: 8px 11px; border-radius: 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #6b7280); word-break: break-all; }
.sessmgr-loading { padding: 8px 11px; color: var(--dsw-alias-label-tertiary, #9aa0aa); font-size: 12px; line-height: 18px; }
/* 子级树线：上游 children 同款 */
.sessmgr-children { margin-left: 15px; padding-left: 8px; border-left: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.2)); }
/* 侧栏入口：与市场/技能/插件徽章同款（49px 高、12px 圆角、透明底） */
.sessmgr-arch-entry { width: 100%; order: -1; margin-bottom: 8px; }
.sessmgr-arch-btn { box-sizing: border-box; width: 100%; height: 49px; display: flex; align-items: center; gap: 8px; padding: 0 8px 0 6px; border: 0; border-radius: 12px; cursor: pointer; font-size: 14px; font-family: inherit; color: var(--dsw-alias-label-primary, inherit); background: transparent; }
.sessmgr-arch-btn:hover { background: var(--dsw-alias-bg-hover, rgba(128,128,128,.08)); }
.sessmgr-arch-btn .sessmgr-count { margin-left: auto; }
/* 已归档模态：sklui 面板（560px，分组列表） */
.sessmgr-archmodal { position: relative; z-index: 1; width: 560px; max-width: calc(100vw - 48px); max-height: min(640px, calc(100vh - 48px)); display: flex; flex-direction: column; overflow: hidden; border-radius: 20px; border: 1px solid var(--dsw-alias-border-strong, rgba(128,128,128,.25)); background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-primary, inherit); box-shadow: 0 18px 48px rgba(0,0,0,.28); font-family: inherit; }
.sessmgr-archmodal-body { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 16px 16px; display: flex; flex-direction: column; }
.sessmgr-arch-group-title { padding: 10px 8px 4px; font-size: 11px; line-height: 16px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary, #6b7280); }
.sessmgr-archmodal .sessmgr-row { min-height: 44px; padding: 4px 8px; }
.sessmgr-empty { padding: 34px 0; text-align: center; font-size: 13px; color: var(--dsw-alias-label-tertiary, #6b7280); }
/* chip → sklui btn 缩小版 */
.sessmgr-chip { border: 1px solid rgba(128,128,128,.28); background: transparent; color: var(--dsw-alias-label-secondary, inherit); border-radius: 8px; height: 26px; padding: 0 12px; cursor: pointer; font-size: 12px; font-family: inherit; flex: none; }
.sessmgr-chip:hover { background: var(--dsw-alias-bg-hover, rgba(128,128,128,.08)); }
.sessmgr-chip.sessmgr-danger { color: #dc2626; border-color: rgba(220,38,38,.35); }
.sessmgr-chip.sessmgr-danger:hover { background: rgba(220,38,38,.07); }
`)

    // ---------- 槽注册 ----------
    slots.inject('conversation.session.header.actions', () => slots.register(
      { name: 'conversation.session.header.actions', id: 'subagent-catalog', order: 10 },
      (props) => h(CatalogAction, props),
    ))
    slots.inject('sidebar.footer.action', () => slots.register(
      { name: 'sidebar.footer.action', id: 'sessmgr-archived', order: 5, label: () => copy(isZhNow()).archivedEntry },
      (props) => h(ArchivedEntry, props),
    ))
  },
}

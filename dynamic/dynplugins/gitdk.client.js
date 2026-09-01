return {
  inject: ['slots'],
  async apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    styles.insert([
      '.gitdock-host { position: absolute; top: 0; right: 0; bottom: 0; pointer-events: none; z-index: 240; }',
      '.gitdock-host-open { pointer-events: auto; }',
      '.gitdock-handle { position: absolute; top: 50%; right: 0; transform: translateY(-50%); z-index: 241; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 10px 4px; width: 24px; box-sizing: border-box; border: 1px solid var(--ds-border, rgba(128,128,128,0.45)); border-right: 0; border-radius: 8px 0 0 8px; background: var(--ds-bg, #ffffff); box-shadow: -2px 0 8px rgba(0,0,0,0.12); cursor: pointer; font: inherit; font-size: 11px; color: var(--ds-text, inherit); pointer-events: auto; }',
      '.gitdock-handle:hover { background: var(--ds-hover, rgba(128,128,128,0.12)); }',
      '.gitdock-handle-text { writing-mode: vertical-rl; letter-spacing: 2px; font-weight: 600; }',
      '.gitdock-handle-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ds-accent, #4f7cff); }',
      '.gitdock-panel { position: absolute; top: 0; right: 0; bottom: 0; width: 460px; max-width: 90%; font-size: 12px; color: var(--ds-text, #1a1a1a); background: var(--ds-bg, #ffffff); border-left: 1px solid var(--ds-border, rgba(128,128,128,0.35)); box-shadow: -6px 0 24px rgba(0,0,0,0.12); display: flex; flex-direction: column; overflow: hidden; box-sizing: border-box; }',
      '.gitdock-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--ds-border, rgba(128,128,128,0.35)); }',
      '.gitdock-title { font-size: 13px; font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.gitdock-meta { font-size: 11px; color: #6b7280; }',
      '.gitdock-btn { font: inherit; font-size: 12px; border: 1px solid var(--ds-border, rgba(128,128,128,0.45)); background: transparent; color: var(--ds-text, inherit); border-radius: 6px; padding: 3px 10px; cursor: pointer; }',
      '.gitdock-btn:hover { background: var(--ds-hover, rgba(128,128,128,0.12)); }',
      '.gitdock-tabs { display: flex; gap: 4px; padding: 6px 8px 0; border-bottom: 1px solid var(--ds-border, rgba(128,128,128,0.25)); }',
      '.gitdock-tab { font: inherit; font-size: 12px; border: 0; background: transparent; color: #6b7280; border-radius: 6px 6px 0 0; padding: 4px 12px; cursor: pointer; border-bottom: 2px solid transparent; }',
      '.gitdock-tab:hover { background: var(--ds-hover, rgba(128,128,128,0.12)); }',
      '.gitdock-tab-active { color: var(--ds-text, inherit); font-weight: 600; border-bottom-color: var(--ds-accent, #4f7cff); }',
      '.gitdock-branchbar { display: flex; align-items: center; gap: 6px; padding: 6px 12px; }',
      '.gitdock-select { font: inherit; font-size: 12px; border: 1px solid var(--ds-border, rgba(128,128,128,0.45)); border-radius: 6px; background: var(--ds-surface, transparent); color: var(--ds-text, inherit); padding: 3px 6px; max-width: 180px; }',
      '.gitdock-body { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 0; position: relative; scrollbar-width: thin; }',
      '.gitdock-tree { position: relative; min-width: 100%; padding-bottom: 12px; }',
      '.gitdock-svg { position: absolute; left: 0; top: 0; pointer-events: none; }',
      '.gitdock-row { display: flex; align-items: center; gap: 8px; width: 100%; box-sizing: border-box; padding: 0 10px 0 0; border: 0; background: transparent; text-align: left; cursor: pointer; font: inherit; color: var(--ds-text, inherit); }',
      '.gitdock-row:hover { background: var(--ds-hover, rgba(128,128,128,0.12)); }',
      '.gitdock-row-selected { background: var(--ds-hover, rgba(128,128,128,0.2)); }',
      '.gitdock-row-head { background: rgba(64,158,255,0.07); }',
      '.gitdock-subject { flex: 1 1 0; min-width: 0; font-size: 12.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      '.gitdock-pills { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; }',
      '.gitdock-pill { font-size: 10px; line-height: 1.4; padding: 2px 6px; border-radius: 999px; white-space: nowrap; }',
      '.gitdock-pill-head { color: #ffffff; background: var(--ds-accent, #4f7cff); }',
      '.gitdock-pill-branch { color: #ffffff; background: #2da44e; }',
      '.gitdock-pill-tag { color: #5b4300; background: #f0c24b; }',
      '.gitdock-pill-remote { color: #1f6feb; background: transparent; border: 1px solid #1f6feb; }',
      '.gitdock-pill-more { color: #6b7280; background: transparent; border: 1px solid var(--ds-border, rgba(128,128,128,0.45)); }',
      '.gitdock-rowmeta { flex: 0 1 auto; font-size: 11px; color: #6b7280; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }',
      '.gitdock-hash { flex: 0 0 auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: #6b7280; }',
      '.gitdock-change { font: 12px/1.9 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-all; }',
      '.gitdock-st-m { color: #bf8700; }',
      '.gitdock-st-a { color: #2da44e; }',
      '.gitdock-st-d { color: #cf222e; }',
      '.gitdock-st-u { color: #6b7280; }',
      '.gitdock-st-r { color: #bf3989; }',
      '.gitdock-pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: 11.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--ds-text, inherit); }',
      '.gitdock-empty { padding: 16px; font-size: 12px; color: #6b7280; text-align: center; }',
      '.gitdock-error { margin: 6px; padding: 8px 10px; border: 1px solid rgba(214,69,69,0.55); color: rgb(200,56,56); border-radius: 6px; font-size: 12px; }',
      '.gitdock-changes { padding: 8px 12px; }',
    ].join('\n'))

    const PANEL_WIDTH = 460
    const ROW_H = 30
    const COL_W = 16
    const GRAPH_BASE = 14
    const PALETTE = ['#1f6feb', '#8957e5', '#2da44e', '#bf8700', '#cf222e', '#bf3989', '#1b7c83', '#57606a']
    const SVG_NS = 'http://www.w3.org/2000/svg'

    let dockEl = null
    let hostEl = undefined
    let cellNode = null
    let refreshCb = null
    let currentView = 'graph'
    let currentDetail = null
    let currentState = null
    let selectedHash = null

    function findDockHost(node) {
      let cursor = node
      while (cursor !== null && cursor !== undefined && cursor.parentElement !== null) {
        cursor = cursor.parentElement
        try {
          const st = window.getComputedStyle(cursor)
          if (/(auto|scroll|overlay)/.test(st.overflowY) && cursor.clientHeight > 120) return cursor.parentElement
        } catch (error) { /* keep climbing */ }
      }
      return undefined
    }

    function el(tag, className, text) {
      const node = document.createElement(tag)
      if (className !== undefined && className !== '') node.className = className
      if (text !== undefined) node.textContent = text
      return node
    }

    function svgEl(tag, attrs) {
      const node = document.createElementNS(SVG_NS, tag)
      if (attrs !== undefined) {
        for (const key of Object.keys(attrs)) node.setAttribute(key, String(attrs[key]))
      }
      return node
    }

    function timeAgo(ts) {
      const diff = Math.max(0, Math.floor(Date.now() / 1000) - ts)
      if (diff < 60) return '刚刚'
      if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前'
      if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前'
      if (diff < 86400 * 30) return Math.floor(diff / 86400) + ' 天前'
      const d = new Date(ts * 1000)
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    }

    function computeLanes(commits) {
      const laneHead = []
      const free = []
      const rows = []
      for (const c of commits) {
        const parents = Array.isArray(c.parents) ? c.parents : []
        let lane = -1
        for (let j = 0; j < laneHead.length; j++) {
          if (laneHead[j] === c.hash) { lane = j; break }
        }
        const reclaimed = []
        for (let j = 0; j < laneHead.length; j++) {
          if (j !== lane && laneHead[j] === c.hash) { laneHead[j] = null; reclaimed.push(j) }
        }
        for (const j of reclaimed) free.push(j)
        if (lane === -1) {
          lane = free.length > 0 ? free.pop() : laneHead.length
          while (laneHead.length <= lane) laneHead.push(null)
        }
        const activeBefore = laneHead.map((h) => h !== null && h !== undefined)
        const extra = []
        for (const p of parents.slice(1)) {
          let existing = false
          for (let j = 0; j < laneHead.length; j++) {
            if (laneHead[j] === p) { existing = true; break }
          }
          if (existing) continue
          const k = free.length > 0 ? free.pop() : laneHead.length
          while (laneHead.length <= k) laneHead.push(null)
          laneHead[k] = p
          extra.push({ parent: p, lane: k })
        }
        laneHead[lane] = parents[0] ?? null
        rows.push({ commit: c, lane, extra, activeBefore })
      }
      return { rows, laneCount: laneHead.length }
    }

    function refPills(refs) {
      const pills = []
      if (typeof refs !== 'string' || refs.length === 0) return pills
      for (const raw of refs.split(', ')) {
        const name = raw.trim()
        if (name.length === 0) continue
        let cls = 'gitdock-pill-branch'
        let label = name
        if (name.indexOf('HEAD -> ') === 0) {
          cls = 'gitdock-pill-head'
          label = name.slice(8)
        } else if (name === 'HEAD') {
          cls = 'gitdock-pill-head'
        } else if (name.indexOf('tag: ') === 0) {
          cls = 'gitdock-pill-tag'
          label = name.slice(5)
        } else if (name.indexOf('origin/') === 0) {
          cls = 'gitdock-pill-remote'
        }
        if (label.length === 0) continue
        pills.push({ label, cls })
      }
      return pills
    }

    function showCommit(hash) {
      selectedHash = hash
      currentView = 'detail'
      currentDetail = { hash, text: null }
      render()
      host.call('gitPanelShow', { hash }).then((result) => {
        if (result !== null && typeof result === 'object' && result.ok === true) currentDetail = { hash, text: result.text }
        else if (currentDetail !== null && currentDetail.hash === hash) currentDetail = { hash, text: null, error: result !== null && typeof result === 'object' && typeof result.error === 'string' ? result.error : 'failed to show commit' }
        render()
      }).catch((failure) => {
        if (currentDetail !== null && currentDetail.hash === hash) currentDetail = { hash, text: null, error: String(failure && failure.message ? failure.message : failure) }
        render()
      })
    }

    function renderTree(body, state) {
      body.textContent = ''
      const commits = state !== null && state !== undefined && Array.isArray(state.commits) ? state.commits : []
      if (commits.length === 0) {
        body.appendChild(el('div', 'gitdock-empty', '该目录没有 git 提交记录'))
        return
      }
      const { rows, laneCount } = computeLanes(commits)
      const graphWidth = GRAPH_BASE + Math.max(1, laneCount) * COL_W
      const height = rows.length * ROW_H
      const svg = svgEl('svg', { width: graphWidth, height: height, viewBox: '0 0 ' + graphWidth + ' ' + height, 'class': 'gitdock-svg' })

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        const yTop = i * ROW_H
        const yMid = yTop + ROW_H / 2
        const yBot = yTop + ROW_H
        const xLane = GRAPH_BASE + row.lane * COL_W + COL_W / 2
        for (let j = 0; j < row.activeBefore.length; j++) {
          if (row.activeBefore[j] !== true) continue
          const x = GRAPH_BASE + j * COL_W + COL_W / 2
          svg.appendChild(svgEl('line', {
            x1: x, y1: yTop, x2: x, y2: yBot,
            stroke: PALETTE[j % PALETTE.length],
            'stroke-width': 2,
          }))
        }
        for (const edge of row.extra) {
          const xK = GRAPH_BASE + edge.lane * COL_W + COL_W / 2
          const color = PALETTE[edge.lane % PALETTE.length]
          const path = 'M ' + xLane + ' ' + yMid + ' C ' + xLane + ' ' + (yMid + 12) + ', ' + xK + ' ' + (yMid + 12) + ', ' + xK + ' ' + yBot
          svg.appendChild(svgEl('path', { d: path, fill: 'none', stroke: color, 'stroke-width': 2 }))
        }
        const isHead = typeof state.headHash === 'string' && state.headHash.length > 0 && row.commit.hash === state.headHash
        if (isHead) {
          const ring = svgEl('circle', { cx: xLane, cy: yMid, r: 8, fill: 'none', stroke: PALETTE[row.lane % PALETTE.length], 'stroke-width': 2, opacity: 0.5 })
          svg.appendChild(ring)
        }
        const dot = svgEl('circle', { cx: xLane, cy: yMid, r: isHead ? 5.5 : 4.5, fill: PALETTE[row.lane % PALETTE.length] })
        dot.style.stroke = 'var(--ds-bg, #ffffff)'
        dot.style.strokeWidth = '1.5'
        svg.appendChild(dot)
      }

      const tree = el('div', 'gitdock-tree')
      tree.style.minHeight = height + 'px'
      tree.appendChild(svg)
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        const c = row.commit
        const isHeadRow = typeof state.headHash === 'string' && c.hash === state.headHash
        const rowEl = el('button', 'gitdock-row' + (c.hash === selectedHash ? ' gitdock-row-selected' : '') + (isHeadRow ? ' gitdock-row-head' : ''))
        rowEl.style.height = ROW_H + 'px'
        rowEl.style.paddingLeft = graphWidth + 'px'
        rowEl.title = c.hash + '\n' + c.author + '\n' + (c.refs || '')
        rowEl.addEventListener('click', () => showCommit(c.hash))
        rowEl.appendChild(el('span', 'gitdock-subject', c.subject))
        const pillsWrap = el('span', 'gitdock-pills')
        const pills = refPills(c.refs)
        for (let p = 0; p < Math.min(pills.length, 2); p++) {
          pillsWrap.appendChild(el('span', pills[p].cls, pills[p].label))
        }
        if (pills.length > 2) pillsWrap.appendChild(el('span', 'gitdock-pill-more', '+' + (pills.length - 2)))
        rowEl.appendChild(pillsWrap)
        rowEl.appendChild(el('span', 'gitdock-rowmeta', c.author + ' · ' + timeAgo(c.ts)))
        rowEl.appendChild(el('span', 'gitdock-hash', c.shortHash))
        tree.appendChild(rowEl)
      }
      body.appendChild(tree)
    }

    function changeClass(line) {
      if (typeof line !== 'string' || line.length < 2) return 'gitdock-st-u'
      const x = line[0]
      const y = line[1]
      if (x === 'A' || y === 'A') return 'gitdock-st-a'
      if (x === 'D' || y === 'D') return 'gitdock-st-d'
      if (x === 'R' || y === 'R') return 'gitdock-st-r'
      if (x === 'M' || y === 'M') return 'gitdock-st-m'
      return 'gitdock-st-u'
    }

    function render() {
      if (dockEl === null) return
      const state = currentState
      const inner = dockEl.querySelector('.gitdock-inner')
      if (inner === null) return
      inner.textContent = ''

      const head = el('div', 'gitdock-head')
      const title = el('span', 'gitdock-title')
      title.textContent = currentView === 'detail' ? '提交详情' : 'Git 提交树'
      head.appendChild(title)
      if (state !== null && state !== undefined && typeof state.branch === 'string' && currentView !== 'detail') {
        head.appendChild(el('span', 'gitdock-meta', '分支 ' + state.branch))
      }
      const refreshBtn = el('button', 'gitdock-btn', '刷新')
      refreshBtn.addEventListener('click', () => { if (refreshCb !== null) refreshCb() })
      head.appendChild(refreshBtn)
      const closeBtn = el('button', 'gitdock-btn', '关闭')
      closeBtn.addEventListener('click', () => { if (refreshCb !== null) refreshCb({ close: true }) })
      head.appendChild(closeBtn)
      inner.appendChild(head)

      if (currentView === 'detail') {
        const body = el('div', 'gitdock-body')
        body.style.padding = '6px'
        const back = el('button', 'gitdock-btn', '← 返回')
        back.addEventListener('click', () => { currentView = 'graph'; currentDetail = null; render() })
        body.appendChild(back)
        if (currentDetail !== null && currentDetail.error !== undefined && currentDetail.error !== null) {
          body.appendChild(el('div', 'gitdock-error', currentDetail.error))
        }
        body.appendChild(el('pre', 'gitdock-pre', currentDetail !== null && currentDetail.text !== null ? currentDetail.text : '加载中…'))
        inner.appendChild(body)
        return
      }

      const tabs = el('div', 'gitdock-tabs')
      const graphTab = el('button', 'gitdock-tab' + (currentView === 'graph' ? ' gitdock-tab-active' : ''), '提交图')
      graphTab.addEventListener('click', () => { currentView = 'graph'; render() })
      const changesTab = el('button', 'gitdock-tab' + (currentView === 'changes' ? ' gitdock-tab-active' : ''), '变更 ' + (state !== null && state !== undefined && typeof state.dirty === 'number' ? '(' + state.dirty + ')' : ''))
      changesTab.addEventListener('click', () => { currentView = 'changes'; render() })
      tabs.appendChild(graphTab)
      tabs.appendChild(changesTab)
      inner.appendChild(tabs)

      if (state !== null && state !== undefined && Array.isArray(state.branches) && state.branches.length > 0) {
        const bar = el('div', 'gitdock-branchbar')
        const select = el('select', 'gitdock-select')
        for (const branch of state.branches) {
          const option = el('option', '', branch)
          option.value = branch
          if (branch === state.branch) option.selected = true
          select.appendChild(option)
        }
        const switchBtn = el('button', 'gitdock-btn', '切换分支')
        switchBtn.addEventListener('click', () => {
          host.call('gitPanelSwitch', { branch: select.value }).then((result) => {
            if (result !== null && typeof result === 'object' && result.ok === true) { if (refreshCb !== null) refreshCb() }
            else {
              const err = el('div', 'gitdock-error', result !== null && typeof result === 'object' && typeof result.error === 'string' ? result.error : 'switch failed')
              inner.insertBefore(err, inner.querySelector('.gitdock-body'))
            }
          }).catch((failure) => {
            const err = el('div', 'gitdock-error', String(failure && failure.message ? failure.message : failure))
            inner.insertBefore(err, inner.querySelector('.gitdock-body'))
          })
        })
        bar.appendChild(select)
        bar.appendChild(switchBtn)
        inner.appendChild(bar)
      }

      const body = el('div', 'gitdock-body')
      if (currentView === 'graph') {
        renderTree(body, state)
      } else {
        body.style.padding = '6px'
        const changes = state !== null && state !== undefined && Array.isArray(state.changes) ? state.changes : []
        if (changes.length === 0) body.appendChild(el('div', 'gitdock-empty', '工作区干净，没有未提交变更'))
        else {
          const box = el('div', 'gitdock-changes')
          for (const line of changes) {
            box.appendChild(el('div', 'gitdock-change ' + changeClass(line), line))
          }
          body.appendChild(box)
        }
      }
      inner.appendChild(body)
    }

    function closePanel() {
      if (dockEl !== null && dockEl.parentElement !== null) dockEl.parentElement.removeChild(dockEl)
      dockEl = null
      hostEl = undefined
    }

    function GitPanel(props) {
      const [open, setOpen] = React.useState(false)
      const [dirty, setDirty] = React.useState(0)

      const cellRef = (node) => { cellNode = node }

      refreshCb = (options) => {
        if (options !== undefined && options !== null && options.close === true) {
          closePanel()
          setOpen(false)
          return
        }
        host.call('gitPanelState', {}).then((result) => {
          if (result !== null && typeof result === 'object' && result.ok === true) {
            currentState = result
            setDirty(typeof result.dirty === 'number' ? result.dirty : 0)
          }
          render()
        }).catch(() => {
          render()
        })
      }

      React.useEffect(() => () => { closePanel() }, [])

      const toggle = () => {
        const next = !open
        if (next) {
          const host = findDockHost(cellNode)
          hostEl = host !== undefined ? host : document.body
          const isBody = hostEl === document.body
          if (!isBody) {
            try {
              if (window.getComputedStyle(hostEl).position === 'static') hostEl.style.position = 'relative'
            } catch (error) { /* keep going */ }
          }
          dockEl = el('div', 'gitdock-host gitdock-host-open')
          dockEl.style.cssText = isBody
            ? 'position: fixed; top: 0; right: 0; bottom: 0; width: ' + PANEL_WIDTH + 'px; max-width: 90vw; z-index: 260; pointer-events: auto;'
            : 'pointer-events: auto;'
          const panel = el('div', 'gitdock-panel')
          if (isBody) panel.style.cssText = 'position: static; width: 100%; height: 100%;'
          const inner = el('div', 'gitdock-inner')
          inner.style.cssText = 'display: flex; flex-direction: column; height: 100%; overflow: hidden;'
          panel.appendChild(inner)
          dockEl.appendChild(panel)
          const handle = el('button', 'gitdock-handle')
          handle.type = 'button'
          handle.title = 'Git 提交树与变更面板'
          handle.style.right = isBody ? '100%' : (PANEL_WIDTH + 24) + 'px'
          handle.addEventListener('click', () => { refreshCb({ close: true }) })
          handle.appendChild(el('span', 'gitdock-handle-text', 'Git'))
          dockEl.appendChild(handle)
          hostEl.appendChild(dockEl)
          refreshCb()
        } else {
          closePanel()
        }
        setOpen(next)
      }

      return React.createElement('button', {
        type: 'button',
        className: 'gitdock-handle',
        style: { position: 'absolute', top: '50%', right: 0, transform: 'translateY(-50%)' },
        'aria-haspopup': 'dialog',
        'aria-expanded': open === true,
        title: 'Git 提交树与变更面板',
        ref: cellRef,
        onClick: toggle,
      },
        dirty > 0 ? React.createElement('span', { className: 'gitdock-handle-dot' }) : null,
        React.createElement('span', { className: 'gitdock-handle-text' }, 'Git'))
    }

    slots.inject('conversation.session.header.actions', () => slots.register(
      {
        name: 'conversation.session.header.actions',
        id: 'git-panel',
        order: 30,
        label: () => 'Git',
      },
      GitPanel,
    ))
  },
}
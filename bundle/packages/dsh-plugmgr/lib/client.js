// Plugin manager for the sidebar foot: list/run/stop/delete non-official
// (runtime-defined) Cordis plugins without the agent. Host & injected plugins
// are DISCOVERED from the live loader via remote.pluginInventory.list()
// (no hard-coded list); the dynamic plugins come from dynamicCordisRunner.
window.__ModuleLoader__.load({
  id: '@local/dsh-plugmgr',
  factory: (require) => {
    const React = require('react')

    const css = [
      '[class$="_footerActions"] { flex-direction: column; align-items: stretch; gap: 4px; }',
      '[class$="_footerActions"] > [class$="_layer"] { margin: 12px 0 0 0; min-height: 49px; }',
      '[class$="_footerActions"] button { color: var(--dsw-alias-label-primary, inherit); }',
      '[class$="_footerActions"] button { transition: background .12s ease; border-radius: 8px !important; }',
      '[class$="_footerActions"] button:hover { background: rgba(0,0,0,.05) !important; }',
      '[class*="collapsed"] [class$="_footerActions"] { align-items: center; }',
      '.plugmgr-root{display:flex;align-items:center;flex:0 1 auto;min-width:0;position:relative;order:-1}',
      '.plugmgr-badge{box-sizing:border-box;width:100%;height:49px;display:flex;align-items:center;gap:8px;padding:0 8px 0 6px;border:none;border-radius:12px;cursor:pointer;font-size:14px;font-family:inherit;color:var(--dsw-alias-label-primary,inherit);background:transparent}',
      '.plugmgr-badge:hover{background:var(--dsw-alias-bg-hover,rgba(128,128,128,.08))}',
      '.plugmgr-overlay{position:fixed;inset:0;z-index:1000;display:flex;justify-content:center;align-items:center}',
      '.plugmgr-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.42);backdrop-filter:blur(2px)}',
      '.plugmgr-panel{position:relative;z-index:1;width:860px;max-width:calc(100vw - 48px);height:min(780px,100vh - 48px);display:flex;flex-direction:column;overflow:hidden;border-radius:20px;border:1px solid var(--dsw-alias-border-strong,rgba(128,128,128,.25));background:var(--dsw-alias-bg-layer-2,#ffffff);color:var(--dsw-alias-label-primary,inherit);box-shadow:0 18px 48px rgba(0,0,0,.28);font-family:inherit}',
      '.plugmgr-header{display:flex;align-items:flex-start;justify-content:space-between;padding:20px 24px 14px;border-bottom:1px solid rgba(128,128,128,.14);flex:none}',
      '.plugmgr-title{font-size:17px;font-weight:650;line-height:24px}',
      '.plugmgr-subtitle{margin-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#6b7280)}',
      '.plugmgr-close{width:30px;height:30px;padding:0;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:10px;cursor:pointer;background:transparent;color:var(--dsw-alias-label-secondary,inherit)}',
      '.plugmgr-close:hover{background:var(--dsw-alias-bg-hover,rgba(128,128,128,.1))}',
      '.plugmgr-error{margin:10px 24px 0;padding:8px 12px;border-radius:10px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#dc2626);background:rgba(220,38,38,.08);flex:none}',
      '.plugmgr-body{flex:1;min-height:0;overflow-y:auto;padding:14px 24px 24px;display:flex;flex-direction:column}',
      '.plugmgr-section{display:flex;align-items:center;gap:8px;margin:14px 0 8px;font-size:12px;font-weight:650;color:var(--dsw-alias-label-tertiary,#6b7280);text-transform:uppercase;letter-spacing:.04em}',
      '.plugmgr-section-count{font-size:11px;font-weight:500;color:var(--dsw-alias-label-tertiary,#9ca3af);text-transform:none;letter-spacing:0}',
      '.plugmgr-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#6b7280);margin-bottom:6px}',
      '.plugmgr-search{box-sizing:border-box;flex:1;min-width:0;margin:2px 0 4px;border:1px solid rgba(128,128,128,.3);border-radius:10px;background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font-size:13px;font-family:inherit;padding:8px 12px}',
      '.plugmgr-search:focus{outline:2px solid var(--dsw-alias-accent,#4f7cff);outline-offset:0;border-color:transparent}',
      '.plugmgr-toolbar{display:flex;align-items:center;gap:8px;flex:none}',
      '.plugmgr-chips{display:flex;align-items:center;gap:6px;flex:none;margin:2px 0 4px}',
      '.plugmgr-chip{border:1px solid rgba(128,128,128,.25);background:transparent;color:var(--dsw-alias-label-secondary,inherit);border-radius:999px;height:26px;padding:0 11px;cursor:pointer;font-size:12px;font-family:inherit;white-space:nowrap}',
      '.plugmgr-chip:hover{background:var(--dsw-alias-bg-hover,rgba(128,128,128,.08));border-color:rgba(128,128,128,.45)}',
      '.plugmgr-chip-off{opacity:.45;cursor:default}',
      '.plugmgr-chip-off:hover{background:transparent;border-color:rgba(128,128,128,.25)}',
      '.plugmgr-copy{padding:0 9px;height:24px;border-radius:7px;font-size:11px}',
      '.plugmgr-sub{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9ca3af);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.plugmgr-card{border:1px solid rgba(128,128,128,.16);border-radius:14px;padding:12px 14px;margin-bottom:10px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-layer-1,transparent);transition:border-color .12s ease,box-shadow .12s ease}',
      '.plugmgr-card:hover{border-color:rgba(128,128,128,.34);box-shadow:0 3px 12px rgba(0,0,0,.06)}',
      '.plugmgr-card-head{display:flex;align-items:center;gap:8px}',
      '.plugmgr-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary,#6b7280);flex:none}',
      '.plugmgr-name{flex:1;min-width:0;font-size:13px;font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.plugmgr-pill{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 9px;border-radius:999px;font-size:11px;line-height:20px;flex:none}',
      '.plugmgr-pill-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}',
      '.plugmgr-pill-active{color:#16a34a;background:rgba(22,163,74,.12)}',
      '.plugmgr-pill-failed{color:#dc2626;background:rgba(220,38,38,.1)}',
      '.plugmgr-pill-pending{color:#a16207;background:rgba(245,158,11,.14)}',
      '.plugmgr-pill-off{color:#9ca3af;background:rgba(128,128,128,.14)}',
      '.plugmgr-row{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:9px}',
      '.plugmgr-row:hover{background:var(--dsw-alias-bg-hover,rgba(128,128,128,.06))}',
      '.plugmgr-row-module{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,inherit)}',
      '.plugmgr-dot{width:7px;height:7px;border-radius:50%;flex:none}',
      '.plugmgr-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px}',
      '.plugmgr-btn{border:1px solid rgba(128,128,128,.28);background:transparent;color:var(--dsw-alias-label-secondary,inherit);border-radius:8px;height:26px;padding:0 12px;cursor:pointer;font-size:12px;font-family:inherit}',
      '.plugmgr-btn:hover{background:var(--dsw-alias-bg-hover,rgba(128,128,128,.08))}',
      '.plugmgr-btn:disabled{opacity:.45;cursor:default}',
      '.plugmgr-btn-primary{color:#ffffff;background:var(--dsw-alias-accent,#4f7cff);border-color:transparent}',
      '.plugmgr-btn-primary:hover{filter:brightness(1.06)}',
      '.plugmgr-btn-danger{color:#dc2626;border-color:rgba(220,38,38,.35)}',
      '.plugmgr-btn-danger:hover{background:rgba(220,38,38,.07)}',
      '.plugmgr-collapse{display:inline-flex;align-items:center;gap:4px;border:none;background:transparent;cursor:pointer;font-size:12px;color:var(--dsw-alias-accent,#4f7cff);font-family:inherit;padding:2px 0}',
      '.plugmgr-footer{display:flex;align-items:center;justify-content:space-between;flex:none;padding:12px 24px;border-top:1px solid rgba(128,128,128,.14);font-size:12px;color:var(--dsw-alias-label-tertiary,#6b7280)}',
    ].join('\n')

    function PlugIcon() {
      // lucide wrench (ISC): intentionally a wrench — "extensions = tools".
      return React.createElement('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': 'true',
      }, React.createElement('path', {
        d: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }))
    }

    function CloseIcon() {
      return React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        React.createElement('path', { d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }))
    }

    let appCtx = undefined

    function statusOf(row) {
      const latest = row !== null && typeof row === 'object' ? row.latestRun : undefined
      const active = row !== null && typeof row === 'object' ? row.activeRun : undefined
      if (latest !== null && typeof latest === 'object' && latest.status === 'awaiting-approval') return { key: 'approval', label: '待审批', cls: 'plugmgr-pill-pending' }
      if (active !== null && typeof active === 'object') return { key: 'running', label: '运行中', cls: 'plugmgr-pill-active' }
      if (latest !== null && typeof latest === 'object' && (latest.status === 'failed' || latest.error !== undefined)) return { key: 'failed', label: '失败', cls: 'plugmgr-pill-failed' }
      if (row !== null && typeof row === 'object' && row.currentPackageId !== undefined) return { key: 'stopped', label: '已停止', cls: 'plugmgr-pill-off' }
      return { key: 'stopped', label: '未运行', cls: 'plugmgr-pill-off' }
    }

    function basenameOf(moduleName) {
      const s = String(moduleName ?? '')
      const idx = s.lastIndexOf('/')
      return idx === -1 ? s : s.slice(idx + 1)
    }

    // Host-loader discovery: classify every live loader entry by module name.
    function classifyHost(entries) {
      const local = []
      const injected = []
      const official = []
      if (!Array.isArray(entries)) return { local, injected, official }
      for (const entry of entries) {
        const moduleName = typeof entry.moduleName === 'string' ? entry.moduleName : ''
        const isLocal = moduleName.startsWith('./') || moduleName.startsWith('@local/')
        const isOfficial = moduleName.startsWith('@deepseek-ai/') || moduleName.startsWith('cordis:')
        if (isLocal) local.push(entry)
        else if (isOfficial) official.push(entry)
        else injected.push(entry)
      }
      return { local, injected, official }
    }

    function fiberDot(phase, enabled) {
      if (enabled === false) return { color: '#9ca3af' }
      if (phase === 'active') return { color: '#16a34a' }
      if (phase === 'failed') return { color: '#dc2626' }
      if (phase === 'loading' || phase === 'unloading') return { color: '#f59e0b' }
      return { color: '#9ca3af' }
    }

    function SectionTitle(props) {
      return React.createElement('div', { className: 'plugmgr-section', id: props.anchor },
        props.title,
        React.createElement('span', { className: 'plugmgr-section-count' }, props.count))
    }

    function jumpTo(anchor) {
      const el = document.getElementById(anchor)
      if (el !== null && typeof el.scrollIntoView === 'function') {
        try { el.scrollIntoView({ behavior: 'smooth', block: 'start' }) } catch (error) { el.scrollIntoView() }
      }
    }

    function ManagerButton(props) {
      const wide = props.wide === true
      const useSessions = props.useSessions
      const sessionsSnapshot = typeof useSessions === 'function' ? useSessions((s) => s) : undefined
      const runner = appCtx.dynamicCordisRunner
      const remote = appCtx.remote.dynamicCordisRunner
      const inventoryRemote = appCtx.remote.pluginInventory

      const [open, setOpen] = React.useState(false)
      const [rows, setRows] = React.useState(null)
      const [hostEntries, setHostEntries] = React.useState(null)
      const [showOfficial, setShowOfficial] = React.useState(false)
      const [query, setQuery] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)

      const refresh = () => {
        setError(null)
        remote.inventory().then((answered) => {
          if (answered !== null && typeof answered === 'object' && answered.ok === true) setRows(Array.isArray(answered.value) ? answered.value : [])
          else setError(answered !== null && typeof answered === 'object' && answered.error !== undefined && typeof answered.error.message === 'string' ? answered.error.message : '读取动态插件清单失败')
        }).catch((failure) => {
          setError(String(failure && failure.message ? failure.message : failure))
        })
        if (inventoryRemote !== undefined && typeof inventoryRemote.list === 'function') {
          inventoryRemote.list().then((answered) => {
            if (answered !== null && typeof answered === 'object' && answered.ok === true && answered.value !== null && typeof answered.value === 'object' && Array.isArray(answered.value.entries)) setHostEntries(answered.value.entries)
          }).catch(() => { /* loader inventory unavailable */ })
        }
      }

      React.useEffect(() => {
        if (open === true) refresh()
      }, [open])

      const runPlugin = (row) => {
        const packages = Array.isArray(row.packages) ? row.packages : []
        const target = (row.activeRun !== null && typeof row.activeRun === 'object' && typeof row.activeRun.packageId === 'string')
          ? row.activeRun.packageId
          : (typeof row.currentPackageId === 'string' ? row.currentPackageId : (typeof row.nextPackageId === 'string' ? row.nextPackageId : (packages.length > 0 ? packages[packages.length - 1].packageId : undefined)))
        if (typeof target !== 'string') { setError('没有可运行的版本'); return }
        const pkg = packages.find((p) => p !== null && typeof p === 'object' && p.packageId === target)
        setBusy(true)
        runner.startUserRun({
          agentId: row.agentId,
          pluginId: row.pluginId,
          packageId: target,
          mode: 'run',
          hasClientHalf: pkg !== undefined && pkg.hasClientHalf === true,
        }).then(() => {
          setBusy(false)
          refresh()
        }).catch((failure) => {
          setBusy(false)
          setError(String(failure && failure.message ? failure.message : failure))
        })
      }

      const stopPlugin = (row) => {
        setBusy(true)
        remote.stopFromPanel(row.agentId, row.pluginId).then(() => {
          setBusy(false)
          refresh()
        }).catch((failure) => {
          setBusy(false)
          setError(String(failure && failure.message ? failure.message : failure))
        })
      }

      const removePlugin = (row) => {
        if (window.confirm('删除插件 ' + row.pluginId + '（含全部版本）？此操作不可恢复。') !== true) return
        setBusy(true)
        remote.undefineFromPanel(row.agentId, row.pluginId).then(() => {
          setBusy(false)
          refresh()
        }).catch((failure) => {
          setBusy(false)
          setError(String(failure && failure.message ? failure.message : failure))
        })
      }

      // ── host / injected sections (discovered, not hard-coded) ─────────────
      const hostGroups = hostEntries === null ? { local: [], injected: [], official: [] } : classifyHost(hostEntries)
      const q = query.trim().toLowerCase()
      const matches = (entry) => q === '' || String(entry.moduleName ?? '').toLowerCase().includes(q) || String(entry.entryId ?? '').toLowerCase().includes(q)
      const localFiltered = hostGroups.local.filter(matches)
      const injectedFiltered = hostGroups.injected.filter(matches)
      const officialFiltered = hostGroups.official.filter(matches)

      const hostCard = (entry) => {
        const dot = fiberDot(entry.fiberPhase, entry.enabled)
        const displayName = basenameOf(entry.moduleName).replace(/\.mjs$/, '')
        return React.createElement('div', { key: 'host:' + entry.entryId, className: 'plugmgr-card' },
          React.createElement('div', { className: 'plugmgr-card-head' },
            React.createElement('span', { className: 'plugmgr-name', title: entry.moduleName, style: { fontWeight: 600 } }, displayName),
            React.createElement('span', { className: 'plugmgr-pill ' + (entry.enabled === false ? 'plugmgr-pill-off' : entry.fiberPhase === 'failed' ? 'plugmgr-pill-failed' : 'plugmgr-pill-active') },
              React.createElement('span', { className: 'plugmgr-pill-dot', style: { background: dot.color } }),
              entry.enabled === false ? '已禁用' : entry.fiberPhase === 'failed' ? '挂载失败' : entry.fiberPhase === 'active' ? '已挂载' : entry.fiberPhase ?? '未知'),
            React.createElement('button', {
              type: 'button',
              className: 'plugmgr-btn plugmgr-copy',
              title: '复制 patch 配置行',
              onClick: () => {
                const yaml = '- id: ' + entry.entryId + '\n  name: ' + JSON.stringify(entry.moduleName)
                try {
                  if (window.navigator !== undefined && typeof window.navigator.clipboard !== 'undefined' && typeof window.navigator.clipboard.writeText === 'function') window.navigator.clipboard.writeText(yaml).catch(() => {})
                  else { window.prompt('复制以下配置行（写入 cordis.patch.yml）：', yaml) }
                } catch (error) { window.prompt('复制以下配置行（写入 cordis.patch.yml）：', yaml) }
              },
            }, '复制配置')),
          React.createElement('div', { className: 'plugmgr-sub', title: entry.entryId + ' — ' + entry.moduleName }, entry.entryId + '  ·  ' + entry.moduleName))
      }

      const hostLocalCards = localFiltered.map(hostCard)
      const injectedCards = injectedFiltered.map(hostCard)
      const officialRows = showOfficial === false ? null : officialFiltered.map((entry) => {
        const dot = fiberDot(entry.fiberPhase, entry.enabled)
        return React.createElement('div', { key: 'official:' + entry.entryId, className: 'plugmgr-row' },
          React.createElement('span', { className: 'plugmgr-dot', style: { background: dot.color } }),
          React.createElement('span', { className: 'plugmgr-row-module', title: entry.entryId + ' — ' + entry.moduleName }, basenameOf(entry.moduleName)))
      })

      // ── dynamic section ───────────────────────────────────────────────────
      const cards = (rows ?? []).map((row) => {
        if (row === null || typeof row !== 'object') return null
        const status = statusOf(row)
        const packages = Array.isArray(row.packages) ? row.packages : []
        const activePkg = row.activeRun !== null && typeof row.activeRun === 'object' ? packages.find((p) => p !== null && typeof p === 'object' && p.packageId === row.activeRun.packageId) : undefined
        const currentPkg = typeof row.currentPackageId === 'string' ? packages.find((p) => p !== null && typeof p === 'object' && p.packageId === row.currentPackageId) : undefined
        const name = (activePkg !== undefined && typeof activePkg.name === 'string' && activePkg.name.length > 0) ? activePkg.name : ((currentPkg !== undefined && typeof currentPkg.name === 'string' && currentPkg.name.length > 0) ? currentPkg.name : row.pluginId)

        return React.createElement('div', {
          key: row.pluginId,
          className: 'plugmgr-card',
        },
          React.createElement('div', { className: 'plugmgr-card-head' },
            React.createElement('span', { className: 'plugmgr-id' }, row.pluginId),
            React.createElement('span', { className: 'plugmgr-name' }, name),
            React.createElement('span', { className: 'plugmgr-pill ' + status.cls },
              React.createElement('span', { className: 'plugmgr-pill-dot' }),
              status.label)),
          React.createElement('div', { className: 'plugmgr-actions' },
            React.createElement('button', {
              type: 'button',
              className: 'plugmgr-btn plugmgr-btn-primary',
              disabled: busy === true || status.key === 'running' || status.key === 'approval',
              onClick: () => runPlugin(row),
            }, status.key === 'running' ? '运行中' : '运行'),
            React.createElement('button', {
              type: 'button',
              className: 'plugmgr-btn',
              disabled: busy === true || status.key !== 'running',
              onClick: () => stopPlugin(row),
            }, '停止'),
            React.createElement('button', {
              type: 'button',
              className: 'plugmgr-btn plugmgr-btn-danger',
              disabled: busy === true,
              onClick: () => removePlugin(row),
            }, '删除')))
      }).filter((node) => node !== null)

      const overlay = open === false ? null : React.createElement('div', { className: 'plugmgr-overlay' },
        React.createElement('div', { className: 'plugmgr-backdrop', onClick: () => setOpen(false) }),
        React.createElement('div', {
          className: 'plugmgr-panel',
          role: 'dialog',
          'aria-modal': 'true',
        },
          React.createElement('div', { className: 'plugmgr-header' },
            React.createElement('div', {},
              React.createElement('div', { className: 'plugmgr-title' }, '插件管理'),
              React.createElement('div', { className: 'plugmgr-subtitle' }, '宿主组合（本地 / 注入 / 官方）· 动态插件 · 实时发现')),
            React.createElement('button', { type: 'button', className: 'plugmgr-close', onClick: () => setOpen(false), 'aria-label': '关闭' }, React.createElement(CloseIcon, null))),
          error !== null ? React.createElement('div', { className: 'plugmgr-error' }, error) : null,
          React.createElement('div', { className: 'plugmgr-body' },
            React.createElement('div', { className: 'plugmgr-toolbar' },
              React.createElement('input', {
                className: 'plugmgr-search',
                type: 'search',
                placeholder: '搜索插件名称 / id / 模块路径…',
                value: query,
                onChange: (e) => setQuery(e.target.value),
              }),
              React.createElement('div', { className: 'plugmgr-chips' },
                React.createElement('button', { type: 'button', className: 'plugmgr-chip', onClick: () => jumpTo('plugmgr-sec-local') }, '本地 ' + localFiltered.length),
                React.createElement('button', { type: 'button', className: 'plugmgr-chip' + (injectedFiltered.length === 0 ? ' plugmgr-chip-off' : ''), disabled: injectedFiltered.length === 0, onClick: () => jumpTo('plugmgr-sec-injected') }, '注入 ' + injectedFiltered.length),
                React.createElement('button', { type: 'button', className: 'plugmgr-chip', onClick: () => jumpTo('plugmgr-sec-official') }, '官方 ' + hostGroups.official.length),
                React.createElement('button', { type: 'button', className: 'plugmgr-chip', onClick: () => jumpTo('plugmgr-sec-dynamic') }, '动态 ' + (rows === null ? '…' : rows.length)))),
            React.createElement(SectionTitle, { anchor: 'plugmgr-sec-local', title: '本地宿主插件', count: localFiltered.length + ' / ' + hostGroups.local.length }),
            React.createElement('div', { className: 'plugmgr-hint' }, '写在 cordis.patch.yml，随 dsh 启动加载；启用/停用需改配置并重启。'),
            hostEntries === null ? React.createElement('div', { className: 'plugmgr-hint' }, '读取 loader 清单中…') : (localFiltered.length === 0 ? React.createElement('div', { className: 'plugmgr-hint' }, q !== '' ? '无匹配。' : '没有本地宿主插件。') : hostLocalCards),
            React.createElement(SectionTitle, { anchor: 'plugmgr-sec-injected', title: '运行时注入', count: injectedFiltered.length + ' / ' + hostGroups.injected.length }),
            React.createElement('div', { className: 'plugmgr-hint' }, '经 dev_inject_plugin 注入，记录在 ~/.dsh/injector/registry.json，重启后自动恢复。'),
            injectedFiltered.length === 0 ? React.createElement('div', { className: 'plugmgr-hint' }, q !== '' ? '无匹配。' : '没有运行时注入的插件。') : injectedCards,
            React.createElement(SectionTitle, { anchor: 'plugmgr-sec-official', title: '官方插件', count: officialFiltered.length + ' / ' + hostGroups.official.length }),
            React.createElement('button', { type: 'button', className: 'plugmgr-collapse', onClick: () => setShowOfficial((was) => !was) }, showOfficial === true ? '收起列表 ▲' : '展开列表 ▼'),
            officialRows,
            React.createElement(SectionTitle, { anchor: 'plugmgr-sec-dynamic', title: '动态插件', count: rows === null ? '…' : rows.length + ' 个' }),
            rows !== null && cards.length === 0 ? React.createElement('div', { className: 'plugmgr-hint' }, '没有动态插件（重启后自动清空）') : null,
            cards),
          React.createElement('div', { className: 'plugmgr-footer' },
            React.createElement('span', {}, '宿主插件随 dsh 启动加载；动态插件运行于 cordis-dynamic 分组 · ' + (hostEntries === null ? 0 : hostEntries.length) + ' 个 loader 条目'))))

      return React.createElement('div', { className: 'plugmgr-root' },
        React.createElement('button', {
          type: 'button',
          className: 'plugmgr-badge',
          'aria-haspopup': 'dialog',
          'aria-expanded': open === true,
          title: '管理插件（底层 + 动态）',
          onClick: () => { setOpen((wasOpen) => !wasOpen); setError(null) },
        },
          React.createElement(PlugIcon, null),
          wide === true ? React.createElement('span', { style: { textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, overflow: 'hidden' } }, '插件') : null),
        overlay)
    }

    return {
      inject: ['slots', 'remote', 'remote.dynamicCordisRunner', 'dynamicCordisRunner', 'remote.pluginInventory'],
      apply(ctx) {
        appCtx = ctx
        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.setAttribute('data-plugin-css', '@local/dsh-plugmgr')
          tag.textContent = css
          document.head.appendChild(tag)
          return () => { try { tag.remove() } catch (error) { /* best-effort */ } }
        })
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'plugin-manager',
            order: 1,
            label: () => '插件',
          },
          ManagerButton,
        ))
      },
    }
  },
})

return {
  inject: ['slots'],
  async apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    // ---------- locale 检测（快照字段 active；服务缺席静默回退英文） ----------
    function zhFromSnapshot(snap) {
      try {
        const id = typeof snap === 'string' ? snap : (snap !== null && typeof snap === 'object' ? String(snap.active ?? '') : '')
        return id.toLowerCase().startsWith('zh')
      } catch (error) { return false }
    }
    function isZh() {
      try {
        const loc = ctx.get('locale')
        if (loc === undefined) return false
        if (typeof loc.getSnapshot === 'function') {
          const snap = loc.getSnapshot()
          const id = typeof snap === 'string' ? snap : (snap !== null && typeof snap === 'object' ? snap.active : undefined)
          if (id !== undefined && id !== null && id !== '') return String(id).toLowerCase().startsWith('zh')
        }
        if (typeof loc.getLocale === 'function') return zhFromSnapshot(loc.getLocale())
        return false
      } catch (error) { return false }
    }
    function useZh() {
      const loc = ctx.get('locale')
      if (loc !== undefined && typeof loc.subscribe === 'function' && typeof React.useSyncExternalStore === 'function') {
        try { React.useSyncExternalStore((fn) => loc.subscribe(fn), () => (typeof loc.getSnapshot === 'function' ? loc.getSnapshot() : undefined)) } catch (error) { /* noop */ }
      }
      return isZh()
    }
    function copy(zh) {
      return zh ? {
        choose: '选择模式',
        currentLabel: (name) => '当前模式：' + name,
        currentTitle: '当前 Agent preset（模式）— 点击切换',
        current: '当前',
        customPreset: '自定义 Agent preset。',
        presets: {
          standard: { name: '标准模式', description: '功能完整的编码 Agent，支持文件编辑、Shell、文件与网页检索、Skills、计划、目标、子代理和工作流。' },
          code: { name: 'PTC 模式', description: '具备标准模式的全部能力，并通过 Code Mode SDK 呈现工具，让模型用一个 TypeScript 程序组合多步操作。' },
          minimal: { name: '极简模式', description: '仅提供持久 bash 与 str_replace_editor 的双工具编码 Agent。' },
          cordis: { name: '创造模式', description: '用于创建自定义 Agent preset：具备标准模式的全部能力，并提供运行时检查、插件实验和 preset 创作指导。' },
        },
      } : {
        choose: 'Choose mode',
        currentLabel: (name) => 'Current mode: ' + name,
        currentTitle: 'Current agent preset (mode) — click to switch',
        current: 'Current',
        customPreset: 'Custom Agent preset.',
        presets: {
          standard: { name: 'Standard Mode', description: 'Full-featured coding agent: file editing, shell, file & web search, skills, plans, goals, subagents, and workflows.' },
          code: { name: 'PTC Mode', description: 'All standard-mode capabilities, with tools presented through the Code Mode SDK so the model composes multi-step operations in one TypeScript program.' },
          minimal: { name: 'Minimal Mode', description: 'A two-tool coding agent with only a persistent bash and str_replace_editor.' },
          cordis: { name: 'Creation Mode', description: 'For building custom agent presets: all standard-mode capabilities plus runtime inspection, plugin experiments, and preset authoring guidance.' },
        },
      }
    }

    styles.insert([
      '.modepicker-root { position: relative; display: inline-flex; align-items: center; }',
      '.modepicker-trigger { display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 12px; line-height: 1; color: var(--ds-text, inherit); background: var(--ds-surface, transparent); border: 1px solid var(--ds-border, rgba(128,128,128,0.45)); border-radius: 999px; padding: 4px 10px; cursor: pointer; }',
      '.modepicker-trigger:hover { background: var(--ds-hover, rgba(128,128,128,0.12)); }',
      '.modepicker-trigger:disabled { opacity: 0.6; cursor: default; }',
      '.modepicker-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ds-accent, #4f7cff); flex: none; }',
      '.modepicker-name { font-weight: 500; }',
      '.modepicker-chevron { display: inline-flex; opacity: 0.75; }',
      '.modepicker-backdrop { position: fixed; inset: 0; z-index: 1248; }',
      '.modepicker-menu { position: absolute; top: calc(100% + 6px); right: 0; z-index: 1250; min-width: 300px; max-width: min(380px, calc(100vw - 32px)); max-height: 60vh; overflow: auto; background: var(--ds-bg, #ffffff); border: 1px solid var(--ds-border, rgba(128,128,128,0.45)); border-radius: 10px; box-shadow: 0 12px 32px rgba(0,0,0,0.22); padding: 6px; }',
      '.modepicker-item { display: block; width: 100%; text-align: left; font: inherit; background: transparent; border: 0; border-radius: 8px; padding: 8px 10px; cursor: pointer; color: var(--ds-text, inherit); }',
      '.modepicker-item:hover { background: var(--ds-hover, rgba(128,128,128,0.12)); }',
      '.modepicker-item:disabled { opacity: 0.5; cursor: default; }',
      '.modepicker-item-active { outline: 1px solid var(--ds-accent, #4f7cff); outline-offset: -1px; }',
      '.modepicker-item-name { font-size: 13px; font-weight: 600; display: flex; justify-content: space-between; align-items: center; gap: 8px; }',
      '.modepicker-item-current { font-size: 11px; font-weight: 500; color: var(--ds-accent, #4f7cff); flex: none; }',
      '.modepicker-item-desc { margin-top: 3px; font-size: 12px; line-height: 1.5; color: var(--ds-text-weak, rgba(128,128,128,1)); }',
      '.modepicker-error { position: absolute; top: calc(100% + 6px); right: 0; z-index: 300; background: var(--ds-bg, #ffffff); border: 1px solid rgba(214, 69, 69, 0.55); color: rgb(200, 56, 56); border-radius: 6px; padding: 5px 10px; max-width: 300px; font-size: 12px; }',
    ].join('\n'))

    function displayName(preset, t) {
      if (preset === null || typeof preset !== 'object' || typeof preset.id !== 'string') return ''
      const known = t.presets[preset.id]
      if (known !== undefined) return known.name
      if (typeof preset.name === 'string' && preset.name.length > 0) return preset.name
      return preset.id
    }
    function displayDescription(preset, t) {
      if (preset === null || typeof preset !== 'object' || typeof preset.id !== 'string') return ''
      const known = t.presets[preset.id]
      if (known !== undefined) return known.description
      if (typeof preset.description === 'string' && preset.description.length > 0) return preset.description
      return t.customPreset
    }

    function Chevron() {
      return React.createElement('svg', {
        className: 'modepicker-chevron',
        width: 14,
        height: 14,
        viewBox: '0 0 14 14',
        fill: 'none',
        'aria-hidden': 'true',
      }, React.createElement('path', {
        d: 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z',
        fill: 'currentColor',
      }))
    }

    function ModePicker(props) {
      const zh = useZh()
      const t = copy(zh)
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const [state, setState] = React.useState({ ok: false, loading: true, current: null, presets: [] })
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)

      const refresh = () => {
        host.call('state', { sessionId }).then((result) => {
          if (result !== null && typeof result === 'object' && result.ok === true) setState({ ...result, loading: false })
          else setError(result !== null && typeof result === 'object' && typeof result.error === 'string' ? result.error : 'failed to load presets')
        }).catch((failure) => {
          setError(String(failure && failure.message ? failure.message : failure))
        })
      }

      React.useEffect(() => { refresh() }, [sessionId])

      const select = (presetId) => {
        setBusy(true)
        setError(null)
        host.call('switch', { sessionId, presetId, confirmed: true }).then((result) => {
          setBusy(false)
          if (result !== null && typeof result === 'object' && result.ok === true) {
            setOpen(false)
            setError(null)
            refresh()
          } else {
            setError(result !== null && typeof result === 'object' && typeof result.error === 'string' ? result.error : 'switch failed')
          }
        }).catch((failure) => {
          setBusy(false)
          setError(String(failure && failure.message ? failure.message : failure))
        })
      }

      const byId = {}
      for (const preset of state.presets) {
        if (preset !== null && typeof preset === 'object' && typeof preset.id === 'string') byId[preset.id] = preset
      }
      const currentName = typeof state.current === 'string' && byId[state.current] !== undefined ? displayName(byId[state.current], t) : (typeof state.current === 'string' ? state.current : t.choose)

      const trigger = React.createElement('button', {
        type: 'button',
        className: 'modepicker-trigger',
        'aria-haspopup': 'menu',
        'aria-expanded': open === true,
        'aria-label': t.currentLabel(currentName),
        title: t.currentTitle,
        disabled: busy === true || state.loading === true,
        onClick: () => {
          setOpen((wasOpen) => !wasOpen)
          setError(null)
          refresh()
        },
      },
        React.createElement('span', { className: 'modepicker-dot' }),
        React.createElement('span', { className: 'modepicker-name' }, state.loading === true ? '…' : currentName),
        React.createElement(Chevron, null))

      const items = state.presets
        .filter((preset) => preset !== null && typeof preset === 'object' && typeof preset.id === 'string')
        .map((preset) => {
          const isCurrent = preset.id === state.current
          return React.createElement('button', {
            key: preset.id,
            type: 'button',
            className: 'modepicker-item' + (isCurrent ? ' modepicker-item-active' : ''),
            disabled: preset.broken === true || busy === true || isCurrent,
            onClick: () => select(preset.id),
          },
            React.createElement('span', { className: 'modepicker-item-name' },
              React.createElement('span', null, displayName(preset, t)),
              isCurrent ? React.createElement('span', { className: 'modepicker-item-current' }, t.current) : null),
            React.createElement('span', { className: 'modepicker-item-desc' }, displayDescription(preset, t)))
        })

      const menu = open === false ? null : React.createElement('span', null,
        React.createElement('span', { className: 'modepicker-backdrop', onClick: () => setOpen(false) }),
        React.createElement('div', { className: 'modepicker-menu', role: 'menu' }, items))

      const errorNode = error === null ? null : React.createElement('div', { className: 'modepicker-error' }, String(error))

      return React.createElement('span', { className: 'modepicker-root' }, trigger, menu, errorNode)
    }

    slots.inject('conversation.session.header.actions', () => slots.register(
      {
        name: 'conversation.session.header.actions',
        id: 'agent-preset',
        order: -10,
        label: () => 'Agent preset',
        inject: (sessionId) => ({ sessionId }),
      },
      ModePicker,
    ))
  },
}

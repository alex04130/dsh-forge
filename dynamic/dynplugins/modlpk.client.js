// modlpk client v2（P0 修复）：活会话走官方 api.sessions.selectModel（装 picked、无 idle 门）；
// 离线会话走 host deferred append；失败画 errorStrip；refresh 依赖 sessionId。
return {
  inject: ['slots'],
  async apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    const isZh = () => libIsZh(ctx)
    function useZh() {
      const loc = ctx.get('locale')
      if (loc !== undefined && typeof loc.subscribe === 'function' && typeof React.useSyncExternalStore === 'function') {
        try { React.useSyncExternalStore((fn) => loc.subscribe(fn), () => (typeof loc.getSnapshot === 'function' ? loc.getSnapshot() : undefined)) } catch (error) { /* noop */ }
      }
      return isZh()
    }
    function copy(zh) {
      return zh ? {
        loadFailed: '读取模型目录失败',
        switchFailed: '切换模型失败',
        providerDefault: 'Provider 默认',
        chooseModel: '选择模型',
        model: '模型',
        effort: '推理等级',
        loading: '加载中…',
        appliesNextStep: '运行中的会话：从下一轮请求起用新模型',
        noModels: '没有可用模型',
        noEfforts: '当前模型未提供推理等级。',
      } : {
        loadFailed: 'Failed to load the model catalog',
        switchFailed: 'Failed to switch the model',
        providerDefault: 'Provider default',
        chooseModel: 'Choose model',
        model: 'Model',
        effort: 'Reasoning effort',
        loading: 'Loading…',
        appliesNextStep: 'Running session: the new model applies from the next step',
        noModels: 'No models available',
        noEfforts: 'The current model offers no reasoning levels.',
      }
    }

    styles.insert([
      '.modelpick-root { min-width: 0; position: relative; }',
      '.modelpick-trigger { min-width: 0; max-width: 220px; height: 28px; color: var(--dsw-alias-label-secondary, inherit); cursor: pointer; background: 0 0; border: none; border-radius: 24px; outline: none; align-items: center; gap: 4px; padding: 0 4px 0 8px; font-size: 13px; font-weight: 500; line-height: 20px; display: flex; }',
      '.modelpick-trigger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12)); }',
      '.modelpick-trigger:disabled { color: var(--dsw-alias-label-dimmed, #9ca3af); cursor: default; }',
      '.modelpick-triggerLabel { text-overflow: ellipsis; white-space: nowrap; min-width: 0; overflow: hidden; }',
      '.modelpick-triggerEffort { color: var(--dsw-alias-label-caption, #6b7280); flex: none; }',
      '.modelpick-chevron { color: var(--dsw-alias-label-caption, #6b7280); flex: none; transition: transform 0.12s; }',
      '.modelpick-chevronOpen { transform: rotate(180deg); }',
      '.modelpick-menu { z-index: 1250; border: 1px solid var(--dsw-alias-border-inverted, rgba(128,128,128,0.45)); background: var(--dsw-specific-menu, var(--ds-bg, #ffffff)); width: min(240px, 100vw - 32px); max-height: min(360px, calc(100vh - 190px)); box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,0.22)); color: var(--dsw-alias-label-primary, inherit); border-radius: 12px; flex-direction: column; padding: 4px; display: flex; position: absolute; bottom: calc(100% + 8px); right: 0; overflow: hidden; }',
      '.modelpick-status, .modelpick-empty { color: var(--dsw-alias-label-tertiary, #6b7280); padding: 10px; font-size: 13px; line-height: 20px; }',
      '.modelpick-error { background: var(--dsw-alias-interactive-bg-hover-danger, #ffebe9); color: var(--dsw-alias-state-error-primary, #a40e26); border-radius: 8px; margin-bottom: 4px; padding: 7px 8px; font-size: 12px; line-height: 18px; display: flex; }',
      '.modelpick-note { background: var(--dsw-alias-bg-module-platform, rgba(128,128,128,0.08)); color: var(--dsw-alias-state-warn-label, #a16207); border-radius: 8px; margin-bottom: 4px; padding: 7px 8px; font-size: 12px; line-height: 18px; }',
      '.modelpick-groups { min-height: 0; overflow-y: auto; }',
      '.modelpick-group + .modelpick-group { margin-top: 4px; }',
      '.modelpick-groupTitle { z-index: 1; background: var(--dsw-specific-menu, var(--ds-bg, #ffffff)); color: var(--dsw-alias-label-tertiary, #6b7280); padding: 5px 8px 3px; font-size: 12px; font-weight: 500; line-height: 18px; position: sticky; top: 0; }',
      '.modelpick-option { width: 100%; min-height: 38px; color: inherit; text-align: left; cursor: pointer; background: 0 0; border: none; border-radius: 10px; outline: none; align-items: center; gap: 8px; padding: 6px 8px; display: flex; }',
      '.modelpick-option:hover:not(:disabled), .modelpick-option:focus-visible { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12)); }',
      '.modelpick-option:disabled { color: var(--dsw-alias-label-dimmed, #9ca3af); cursor: default; }',
      '.modelpick-optionCopy { flex-direction: column; flex: 1; min-width: 0; display: flex; }',
      '.modelpick-modelName { color: inherit; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 500; line-height: 20px; overflow: hidden; }',
      '.modelpick-description { color: var(--dsw-alias-label-tertiary, #6b7280); text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 18px; overflow: hidden; }',
      '.modelpick-check { color: var(--dsw-alias-label-primary, inherit); flex: 0 0 18px; place-items: center; display: grid; }',
      '.modelpick-cell { width: 100%; height: 40px; color: var(--dsw-alias-label-primary, inherit); cursor: pointer; text-align: left; background: 0 0; border: none; border-radius: 10px; align-items: center; gap: 8px; padding: 0 10px; font-size: 14px; line-height: 22px; display: flex; }',
      '.modelpick-cell:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12)); }',
      '.modelpick-cellLabel { text-overflow: ellipsis; white-space: nowrap; flex: auto; min-width: 0; overflow: hidden; }',
      '.modelpick-cellValue { text-overflow: ellipsis; white-space: nowrap; min-width: 0; color: var(--dsw-alias-label-tertiary, #6b7280); flex: 0 auto; overflow: hidden; }',
      '.modelpick-cellChevron { color: var(--dsw-alias-label-tertiary, #6b7280); flex: none; }',
    ].join('\n'))

    function Chevron({ open }) {
      return React.createElement('svg', {
        className: 'modelpick-chevron' + (open === true ? ' modelpick-chevronOpen' : ''),
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

    function ChevronRight() {
      return React.createElement('svg', {
        className: 'modelpick-cellChevron',
        width: 14,
        height: 14,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
      }, React.createElement('path', {
        d: 'M6 3l5 5-5 5',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }))
    }

    function Check() {
      return React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        React.createElement('path', { d: 'M3.5 8.5l3 3 6-6.5', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    function ModelPicker(props) {
      const zh = useZh()
      const t = copy(zh)
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const locked = props.locked === true
      const [open, setOpen] = React.useState(false)
      const [pane, setPane] = React.useState('root')
      const [state, setState] = React.useState({ status: 'loading', current: null, groups: [] })
      const [note, setNote] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const rootRef = React.useRef(null)
      const sessionsSvc = ctx.get('sessions')
      // 官方 selectModel 成功后记住 picked：活会话的 requestHeader 要等下一次真实请求才更新，
      // 期间的 refresh 不得把已确认的新选择打回旧值（picked 才是活路由）。
      const pickedRef = React.useRef(null)

      const refresh = () => {
        if (sessionId === '') return
        host.call('state', { sessionId }).then((result) => {
          if (result !== null && typeof result === 'object' && result.ok === true) {
            const serverCurrent = result.current ?? null
            const picked = pickedRef.current
            const usePicked = picked !== null && picked.sessionId === sessionId && (
              serverCurrent === null
              || serverCurrent.provider !== picked.provider
              || serverCurrent.model !== picked.model
              || (typeof serverCurrent.reasoningEffort === 'string' ? serverCurrent.reasoningEffort : '') !== (typeof picked.reasoningEffort === 'string' ? picked.reasoningEffort : '')
            )
            setState({
              status: 'ready',
              current: usePicked === true ? { provider: picked.provider, model: picked.model, ...(typeof picked.reasoningEffort === 'string' ? { reasoningEffort: picked.reasoningEffort } : {}) } : serverCurrent,
              groups: Array.isArray(result.groups) ? result.groups : [],
              live: result.live === true,
              agentStatus: typeof result.status === 'string' ? result.status : undefined,
            })
          } else {
            setState((s) => ({ ...s, status: 'error', message: result !== null && typeof result.error === 'string' ? result.error : t.loadFailed }))
          }
        }).catch((failure) => {
          setState((s) => ({ ...s, status: 'error', message: String(failure && failure.message ? failure.message : failure) }))
        })
      }

      React.useEffect(() => { pickedRef.current = null; refresh() }, [sessionId])
      React.useEffect(() => {
        if (open === true) { setPane('root'); refresh() }
      }, [open])
      React.useEffect(() => {
        if (locked === true) setOpen(false)
      }, [locked])
      React.useEffect(() => {
        if (open === false) return
        const onDown = (event) => {
          if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [open])

      // 活会话的官方切换路径：与官方 ModelSelect 同一条 RPC（resolveCallConfig + 装 picked
      // + saveDefaultModelSelection；官方无 idle 门，运行中切换下一步生效）。
      const officialSelect = (selection) => {
        try {
          if (sessionsSvc === undefined || typeof sessionsSvc.binding !== 'function') return null
          const binding = sessionsSvc.binding(sessionId)
          const api = binding !== null && typeof binding === 'object' && binding.session !== null && typeof binding.session === 'object' ? binding.session.api : undefined
          const domain = api !== null && typeof api === 'object' ? api.sessions : undefined
          if (domain === null || typeof domain !== 'object' || typeof domain.selectModel !== 'function') return null
          return Promise.resolve(domain.selectModel({
            sessionId,
            provider: selection.provider,
            model: selection.model,
            ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
          }))
        } catch (error) {
          return null
        }
      }

      const select = (selection) => {
        setBusy(true)
        const official = officialSelect(selection)
        const noteOnSuccess = (applied) => {
          if (applied === 'live-official') {
            pickedRef.current = { sessionId, provider: selection.provider, model: selection.model, ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) }
            return state.agentStatus !== undefined && state.agentStatus !== 'idle' ? t.appliesNextStep : null
          }
          return null
        }
        const handleOk = (result) => {
          setBusy(false)
          setNote(noteOnSuccess(result.applied) ?? (typeof result.note === 'string' && result.note.length > 0 ? result.note : null))
          setOpen(false)
          setPane('root')
          refresh()
        }
        const handleFail = (message) => {
          setBusy(false)
          setState((s) => ({ ...s, status: 'error', message }))
        }
        if (official !== null) {
          official.then((r) => {
            if (r !== null && typeof r === 'object' && r.ok === false) {
              handleFail(typeof r.error === 'string' ? r.error : (r.error !== null && typeof r.error === 'object' && typeof r.error.message === 'string' ? r.error.message : t.switchFailed))
              return
            }
            handleOk({ ok: true, applied: 'live-official' })
          }).catch((failure) => {
            handleFail(String(failure && failure.message ? failure.message : failure))
          })
          return
        }
        // 离线会话（或官方 api 不可达时由 host 判定）：deferred append / 明确的拒绝理由。
        host.call('select', {
          sessionId,
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        }).then((result) => {
          if (result !== null && typeof result === 'object' && result.ok === true) handleOk(result)
          else handleFail(result !== null && typeof result === 'object' && typeof result.error === 'string' ? result.error : t.switchFailed)
        }).catch((failure) => {
          handleFail(String(failure && failure.message ? failure.message : failure))
        })
      }

      const current = state.current !== null && typeof state.current === 'object' ? state.current : null
      const groups = Array.isArray(state.groups) ? state.groups : []
      let currentChoice = null
      for (const group of groups) {
        if (group === null || typeof group !== 'object') continue
        for (const m of (Array.isArray(group.models) ? group.models : [])) {
          if (m === null || typeof m !== 'object') continue
          if (current !== null && current.provider === group.id && current.model === m.id) currentChoice = { group, model: m }
        }
      }
      const reasoning = currentChoice !== null && currentChoice.model.reasoning !== null && typeof currentChoice.model.reasoning === 'object' ? currentChoice.model.reasoning : undefined
      const effectiveEffort = (current !== null && typeof current.reasoningEffort === 'string' && current.reasoningEffort.length > 0) ? current.reasoningEffort : (reasoning !== undefined && typeof reasoning.defaultEffort === 'string' ? reasoning.defaultEffort : undefined)
      const effortLabel = reasoning === undefined ? undefined : (effectiveEffort === undefined ? t.providerDefault : (((Array.isArray(reasoning.efforts) ? reasoning.efforts : []).find((level) => level !== null && typeof level === 'object' && level.id === effectiveEffort) || { name: effectiveEffort }).name ?? effectiveEffort))
      const effortChoices = reasoning === undefined ? [] : [
        ...(reasoning.defaultEffort === undefined ? [{ effort: undefined, label: t.providerDefault, description: undefined }] : []),
        ...(Array.isArray(reasoning.efforts) ? reasoning.efforts : []).map((effort) => ({ effort: effort.id, label: typeof effort.name === 'string' && effort.name.length > 0 ? effort.name : effort.id, description: typeof effort.description === 'string' && effort.description.length > 0 ? effort.description : undefined })),
      ]
      const modelLabel = currentChoice !== null && typeof currentChoice.model.name === 'string' && currentChoice.model.name.length > 0 ? currentChoice.model.name : (current !== null && typeof current.model === 'string' ? current.model : t.chooseModel)
      const triggerLabel = effortLabel === undefined ? modelLabel : modelLabel + ' · ' + effortLabel

      const choose = (selection) => {
        if (current !== null && current.provider === selection.provider && current.model === selection.model) { setOpen(false); setPane('root'); return }
        select(selection)
      }
      const chooseEffort = (effort) => {
        if (current === null) return
        if (effectiveEffort === effort) { setOpen(false); setPane('root'); return }
        select({ provider: current.provider, model: current.model, reasoningEffort: effort })
      }

      const onKeyDown = (event) => {
        if (event.key === 'Escape' && open === true) {
          event.preventDefault()
          if (pane !== 'root') setPane('root')
          else setOpen(false)
        }
      }

      const cell = (label, value, onPick) => React.createElement('button', {
        type: 'button',
        role: 'menuitem',
        className: 'modelpick-cell',
        onClick: onPick,
      },
        React.createElement('span', { className: 'modelpick-cellLabel' }, label),
        React.createElement('span', { className: 'modelpick-cellValue' }, value),
        React.createElement(ChevronRight, null))

      const trigger = React.createElement('button', {
        type: 'button',
        className: 'modelpick-trigger',
        'aria-haspopup': 'menu',
        'aria-expanded': open === true,
        title: triggerLabel,
        disabled: sessionId === '' || busy === true || locked === true,
        onClick: () => { if (open === true) setOpen(false); else { setPane('root'); setOpen(true); refresh() } },
      },
        React.createElement('span', { className: 'modelpick-triggerLabel' }, modelLabel),
        effortLabel !== undefined ? React.createElement('span', { className: 'modelpick-triggerEffort' }, '· ' + effortLabel) : null,
        React.createElement(Chevron, { open }))

      const errorStrip = state.status === 'error' && typeof state.message === 'string' ? React.createElement('div', { className: 'modelpick-error' }, state.message) : null
      const noteStrip = note !== null && pane === 'root' ? React.createElement('div', { className: 'modelpick-note' }, note) : null

      const modelOptions = groups.map((group) => {
        if (group === null || typeof group !== 'object') return null
        const provider = typeof group.id === 'string' ? group.id : String(group.provider ?? '')
        const options = (Array.isArray(group.models) ? group.models : []).map((m) => {
          if (m === null || typeof m !== 'object' || typeof m.id !== 'string') return null
          const isCurrent = current !== null && m.id === current.model && current.provider === provider
          return React.createElement('button', {
            key: provider + ':' + m.id,
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': isCurrent === true,
            className: 'modelpick-option',
            disabled: busy === true,
            onClick: () => choose({ provider, model: m.id }),
          },
            React.createElement('span', { className: 'modelpick-optionCopy' },
              React.createElement('span', { className: 'modelpick-modelName' }, typeof m.name === 'string' && m.name.length > 0 ? m.name : m.id),
              typeof m.description === 'string' && m.description.length > 0 ? React.createElement('span', { className: 'modelpick-description' }, m.description) : null),
            isCurrent === true ? React.createElement('span', { className: 'modelpick-check' }, React.createElement(Check, null)) : null)
        }).filter((node) => node !== null)
        return React.createElement('div', { key: provider, className: 'modelpick-group' },
          React.createElement('div', { className: 'modelpick-groupTitle' }, typeof group.name === 'string' && group.name.length > 0 ? group.name : provider),
          options)
      }).filter((node) => node !== null)

      const effortOptions = effortChoices.map((level) => {
        const isCurrent = effectiveEffort === level.effort
        return React.createElement('button', {
          key: level.effort === undefined ? 'provider-default' : 'effort:' + level.effort,
          type: 'button',
          role: 'menuitemradio',
          'aria-checked': isCurrent === true,
          className: 'modelpick-option',
          disabled: busy === true,
          onClick: () => chooseEffort(level.effort),
        },
          React.createElement('span', { className: 'modelpick-optionCopy' },
            React.createElement('span', { className: 'modelpick-modelName' }, level.label),
            level.description !== undefined ? React.createElement('span', { className: 'modelpick-description' }, level.description) : null),
          isCurrent === true ? React.createElement('span', { className: 'modelpick-check' }, React.createElement(Check, null)) : null)
      })

      const menuContent = pane === 'root' ? React.createElement(React.Fragment, null,
        noteStrip,
        cell(t.model, modelLabel, () => setPane('model')),
        reasoning !== undefined ? cell(t.effort, effortLabel ?? t.providerDefault, () => setPane('effort')) : null,
      ) : pane === 'model' ? React.createElement(React.Fragment, null,
        errorStrip,
        state.status === 'loading' ? React.createElement('div', { className: 'modelpick-status' }, t.loading) : null,
        React.createElement('div', { className: 'modelpick-groups' }, modelOptions),
        state.status === 'ready' && modelOptions.length === 0 ? React.createElement('div', { className: 'modelpick-empty' }, t.noModels) : null,
      ) : React.createElement(React.Fragment, null,
        errorStrip,
        effortOptions.length === 0 ? React.createElement('div', { className: 'modelpick-empty' }, t.noEfforts) : effortOptions,
      )

      const menu = open === false ? null : React.createElement('div', { className: 'modelpick-menu', role: 'menu' }, menuContent)

      return React.createElement('div', { ref: rootRef, className: 'modelpick-root', onKeyDown }, trigger, menu)
    }

    slots.inject('conversation.input.model', () => slots.register(
      { name: 'conversation.input.model', priority: -1 },
      ModelPicker,
    ))
  },
}

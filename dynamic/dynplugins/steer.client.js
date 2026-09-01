return {
  apply(ctx) {
    const slots = ctx.get('slots')
    const sessions = ctx.get('sessions')
    if (slots === undefined || sessions === undefined) return

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
        sent: '已插话（steer）',
        hint: '插话（当前动作完成后生效） · 右侧 ⏹ 硬打断 · Enter 排队',
      } : {
        sent: 'Steered (steer)',
        hint: 'to steer (takes effect after the current action finishes) · ⏹ on the right hard-interrupts · Enter queues',
      }
    }

    styles.insert(`
.subagent-steer-hint { font-size:12px; color: var(--dsw-alias-label-secondary); padding:0 4px; }
.subagent-steer-hint strong { color: var(--dsw-alias-label-primary); font-weight:600; }
.subagent-steer-hint .steer-ok { color: var(--dsw-alias-state-success-primary); }
`)

    function debug(entry) {
      try {
        const arr = Array.isArray(globalThis.__steerDebug) ? globalThis.__steerDebug : []
        arr.push(Object.assign({ t: Date.now() }, entry))
        if (arr.length > 60) arr.shift()
        globalThis.__steerDebug = arr
      } catch (error) { /* best-effort */ }
    }

    const timer = ctx.get('timer')
    let cooldown = false

    function subagentContext() {
      try {
        const current = sessions.list !== undefined && typeof sessions.list.getSnapshot === 'function' ? sessions.list.getSnapshot().current : undefined
        if (typeof current !== 'string' || current.length === 0) return null
        const binding = sessions.binding(current)
        if (binding === undefined || binding.session === undefined || typeof binding.session.getSnapshot !== 'function') return null
        const snapshot = binding.session.getSnapshot()
        if (snapshot === null || snapshot === undefined || snapshot.subagent === null || snapshot.subagent === undefined) return null
        return { sessionId: current, binding }
      } catch (error) {
        return null
      }
    }

    function onKeyDownCapture(event) {
      const base = {
        key: String(event.key),
        ctrl: event.ctrlKey === true,
        meta: event.metaKey === true,
        shift: event.shiftKey === true,
        composing: event.isComposing === true,
        keyCode: event.keyCode,
        targetTag: event.target !== null && event.target !== undefined ? String(event.target.tagName) : null,
        trusted: event.isTrusted,
      }
      if (!(event.ctrlKey || event.metaKey) || event.key !== 'Enter') return
      if (event.shiftKey === true) { debug(Object.assign({ stop: 'shift' }, base)); return }
      if (event.isComposing === true || event.keyCode === 229) { debug(Object.assign({ stop: 'composing' }, base)); return }
      const target = event.target
      if (target === null || target === undefined || target.tagName !== 'TEXTAREA') { debug(Object.assign({ stop: 'not-textarea' }, base)); return }
      const card = target.closest !== undefined ? target.closest('[data-composer-card]') : null
      if (card === null) { debug(Object.assign({ stop: 'no-card' }, base)); return }
      if (target.disabled === true || target.readOnly === true) { debug(Object.assign({ stop: 'locked' }, base)); return }
      const info = subagentContext()
      if (info === null) { debug(Object.assign({ stop: 'not-subagent-session' }, base)); return }
      const value = String(target.value ?? '').trim()
      if (value.length === 0) { debug(Object.assign({ stop: 'empty' }, base)); return }
      if (cooldown) { debug(Object.assign({ stop: 'cooldown' }, base)); return }
      cooldown = true
      event.preventDefault()
      event.stopImmediatePropagation()
      debug(Object.assign({ stop: 'steer-sent', value: value.slice(0, 24), sessionId: info.sessionId }, base))
      try {
        target.focus()
        target.setSelectionRange(0, target.value.length)
        document.execCommand('delete')
      } catch (error) { /* best-effort */ }
      if (timer !== undefined && typeof timer.timeout === 'function') timer.timeout(() => { cooldown = false }, 500)
      else cooldown = false
      Promise.resolve(host.call('steer', { sessionId: info.sessionId, text: value })).then((result) => {
        if (result !== null && typeof result === 'object' && result.ok === true) {
          debug(Object.assign({ stop: 'steer-ok', delivered: result.delivered }, base))
          try { document.dispatchEvent(new CustomEvent('subagent-steer:done')) } catch (error) { /* best-effort */ }
        } else {
          debug(Object.assign({ stop: 'steer-rpc-error', error: result !== null && typeof result === 'object' ? String(result.error ?? 'unknown') : String(result) }, base))
        }
      }, (error) => {
        debug(Object.assign({ stop: 'steer-rejected', error: String(error && error.message ? error.message : error) }, base))
      })
    }

    document.addEventListener('keydown', onKeyDownCapture, true)
    ctx.effect(() => () => {
      try { document.removeEventListener('keydown', onKeyDownCapture, true) } catch (error) { /* best-effort */ }
    })

    function SubagentSteerHint(props) {
      const zh = useZh()
      const t = copy(zh)
      const snapshot = props.session
      const [flash, setFlash] = React.useState(false)
      React.useEffect(() => {
        let timer = null
        const onDone = () => {
          setFlash(true)
          if (timer !== null) { try { clearTimeout(timer) } catch (error) { /* best-effort */ } }
          timer = setTimeout(() => setFlash(false), 4000)
        }
        document.addEventListener('subagent-steer:done', onDone)
        return () => {
          document.removeEventListener('subagent-steer:done', onDone)
          if (timer !== null) { try { clearTimeout(timer) } catch (error) { /* best-effort */ } }
        }
      }, [])
      if (snapshot === null || snapshot === undefined || snapshot.subagent === null || snapshot.subagent === undefined) return null
      if (snapshot.running !== true && flash !== true) return null
      if (flash) {
        return React.createElement('div', { className: 'subagent-steer-hint' },
          React.createElement('span', { className: 'steer-ok' }, '✓ ' + t.sent),
        )
      }
      return React.createElement('div', { className: 'subagent-steer-hint' },
        React.createElement('strong', null, 'Ctrl+Enter'), ' ' + t.hint,
      )
    }

    slots.inject('conversation.composer.dock', () => slots.register(
      { name: 'conversation.composer.dock', id: 'subagent-steer-hint', order: 10 },
      SubagentSteerHint,
    ))
  },
}

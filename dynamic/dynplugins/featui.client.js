return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    const h = React.createElement

    styles.insert([
      '.featsw-page { display:flex; flex-direction:column; gap:16px; padding:4px 0 24px; max-width:560px; color:var(--dsw-alias-label-primary, inherit); }',
      '.featsw-h { font-size:18px; font-weight:600; margin:0; }',
      '.featsw-card { border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28)); border-radius:12px; padding:16px 18px; display:flex; flex-direction:column; gap:4px; background:var(--dsw-alias-bg-layer-1, transparent); }',
      '.featsw-toggle-row { display:flex; align-items:center; justify-content:space-between; gap:12px; min-height:40px; }',
      '.featsw-toggle-label { font-size:14px; font-weight:500; }',
      '.featsw-switch { width:40px; height:22px; border-radius:999px; border:0; padding:2px; cursor:pointer; background:var(--dsw-alias-fill-tertiary, #d1d5db); position:relative; flex:none; }',
      '.featsw-switch[aria-checked="true"] { background:var(--dsw-alias-accent, #4f7cff); }',
      '.featsw-thumb { display:block; width:18px; height:18px; border-radius:50%; background:#fff; transform:translateX(0); transition:transform 120ms ease; }',
      '.featsw-switch[aria-checked="true"] .featsw-thumb { transform:translateX(18px); }',
      '.featsw-row { display:flex; align-items:center; justify-content:space-between; gap:12px; min-height:40px; border-top:.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.18)); }',
      '.featsw-row-name { font-size:13px; font-weight:500; }',
      '.featsw-actions { display:flex; gap:8px; justify-content:flex-end; padding-top:12px; }',
      '.featsw-btn { font:inherit; font-size:13px; padding:6px 12px; border-radius:8px; cursor:pointer; border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35)); background:transparent; color:inherit; }',
      '.featsw-btn:disabled { opacity:.45; cursor:default; }',
      '.featsw-btn-primary { background:var(--dsw-alias-accent, #4f7cff); color:#fff; border-color:transparent; }',
      '.featsw-err { color:var(--dsw-alias-state-error-primary, #a40e26); font-size:13px; }',
      '.featsw-pending { display:flex; gap:8px; align-items:center; flex-wrap:wrap; font-size:13px; min-height:40px; }',
    ].join('\n'))

    const FEATURE_IDS = [
      'console.web',
      'plasmid.repair',
      'plasmid.coordination',
      'plasmid.inject.brief',
      'plasmid.nudge.error',
      'plasmid.broadcast.meta',
      'mailbridge.forge_mailbridge_send',
      'teamhub.teams',
      'archive.archive_read_event',
      'verify.verify_claim',
    ]
    const NAMES = {
      'console.web': ['控制台', 'Console'],
      'plasmid.repair': ['修复质粒', 'Repair plasmids'],
      'plasmid.coordination': ['协作质粒', 'Coordination plasmids'],
      'plasmid.inject.brief': ['开场 brief', 'Opening brief'],
      'plasmid.nudge.error': ['报错轻推', 'Error nudge'],
      'plasmid.broadcast.meta': ['元数据广播', 'Metadata broadcast'],
      'mailbridge.forge_mailbridge_send': ['跨会话投递', 'Cross-session send'],
      'teamhub.teams': ['团队', 'Teams'],
      'archive.archive_read_event': ['档案读取', 'Archive read'],
      'verify.verify_claim': ['言行检查', 'Verify claims'],
    }

    function isZhNow() {
      try {
        const loc = ctx.get('locale')
        if (loc === undefined) return true
        const snap = typeof loc.getSnapshot === 'function' ? loc.getSnapshot()
          : (typeof loc.getLocale === 'function' ? loc.getLocale() : undefined)
        const id = typeof snap === 'string' ? snap : (snap !== null && typeof snap === 'object' ? String(snap.active || '') : '')
        if (id === '') return true
        return id.toLowerCase().startsWith('zh')
      } catch (error) { return true }
    }

    function nameOf(id, zh, fallback) {
      const pair = NAMES[id]
      if (pair) return zh ? pair[0] : pair[1]
      return typeof fallback === 'string' && fallback !== '' ? fallback : id
    }

    function copy(zh) {
      return zh ? {
        title: '功能开关',
        master: 'Forge 功能',
        discard: '放弃修改',
        save: '保存',
        saving: '保存中…',
        loadFailed: '无法加载',
        retry: '重试',
        allow: '批准',
        deny: '拒绝',
      } : {
        title: 'Features',
        master: 'Forge',
        discard: 'Discard',
        save: 'Save',
        saving: 'Saving…',
        loadFailed: 'Could not load',
        retry: 'Retry',
        allow: 'Allow',
        deny: 'Deny',
      }
    }

    function draftFrom(snap) {
      // 行来源：host 的活目录（含 label，如注入包通道）；无则退回内置 FEATURE_IDS。
      const listed = Array.isArray(snap.features)
        ? snap.features.map((row) => (row !== null && typeof row === 'object'
            ? { id: String(row.id || ''), label: typeof row.label === 'string' ? row.label : '' }
            : { id: '', label: '' })).filter((row) => row.id.length > 0)
        : []
      const features = (listed.length > 0 ? listed : FEATURE_IDS.map((id) => ({ id, label: '' })))
        .map((row) => (row.label === '' ? { id: row.id } : { id: row.id, label: row.label }))
      const off = Array.isArray(snap.profile && snap.profile.off) ? snap.profile.off.filter((x) => typeof x === 'string') : []
      return {
        enabled: snap.enabled !== false,
        off,
        features,
        pending: Array.isArray(snap.pending) ? snap.pending : [],
      }
    }

    function sameDraft(a, b) {
      if (a.enabled !== b.enabled) return false
      return (a.off || []).slice().sort().join('|') === (b.off || []).slice().sort().join('|')
    }

    function Switch(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        className: 'featsw-switch',
        'aria-checked': props.on === true ? 'true' : 'false',
        'aria-label': props.label,
        onClick: props.onClick,
      }, h('span', { className: 'featsw-thumb' }))
    }

    function SettingsPage() {
      const zh = isZhNow()
      const t = copy(zh)
      const [live, setLive] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [saving, setSaving] = React.useState(false)

      const load = () => {
        setErr(null)
        host.call('featsw/state', {}).then((r) => {
          if (r !== null && typeof r === 'object' && r.ok === true) {
            const d = draftFrom(r)
            setLive(d)
            setDraft(d)
          } else setErr(r !== null && typeof r === 'object' && typeof r.error === 'string' ? r.error : t.loadFailed)
        }).catch((f) => setErr(String(f && f.message ? f.message : f)))
      }
      React.useEffect(() => { load() }, [])

      if (err !== null && draft === null) {
        return h('div', { className: 'featsw-page' },
          h('h2', { className: 'featsw-h' }, t.title),
          h('p', { className: 'featsw-err' }, err),
          h('button', { type: 'button', className: 'featsw-btn', onClick: load }, t.retry))
      }
      if (draft === null) return h('div', { className: 'featsw-page' }, h('h2', { className: 'featsw-h' }, t.title))

      const dirty = live === null ? false : !sameDraft(live, draft)
      const toggleMaster = () => setDraft((cur) => ({ ...cur, enabled: !cur.enabled }))
      const toggleFeature = (id) => setDraft((cur) => {
        const has = cur.off.indexOf(id) >= 0
        return { ...cur, off: has ? cur.off.filter((x) => x !== id) : cur.off.concat([id]) }
      })
      const discard = () => { if (live !== null) setDraft(live); setErr(null) }
      const save = () => {
        setSaving(true); setErr(null)
        host.call('featsw/save', { enabled: draft.enabled, off: draft.off }).then((r) => {
          setSaving(false)
          if (r !== null && typeof r === 'object' && r.ok === true) {
            const d = draftFrom(r)
            setLive(d); setDraft(d)
          } else setErr(r !== null && typeof r === 'object' && typeof r.error === 'string' ? r.error : t.loadFailed)
        }).catch((f) => { setSaving(false); setErr(String(f && f.message ? f.message : f)) })
      }
      const decide = (id, allow) => {
        host.call('featsw/decide', { id, allow }).then((r) => {
          if (r !== null && typeof r === 'object' && r.ok === true) {
            const d = draftFrom(r)
            setLive(d)
            setDraft((cur) => dirty ? cur : d)
          }
        }).catch(() => {})
      }

      const pending = (draft.pending || []).filter((p) => p && p.status === 'pending')
      const rows = (draft.features || []).map((row) => ({
        id: row.id,
        name: nameOf(row.id, zh, row.label),
        on: draft.off.indexOf(row.id) < 0,
      }))

      return h('div', { className: 'featsw-page' },
        h('h2', { className: 'featsw-h' }, t.title),
        h('div', { className: 'featsw-card' },
          h('div', { className: 'featsw-toggle-row' },
            h('span', { className: 'featsw-toggle-label' }, t.master),
            h(Switch, { on: draft.enabled, label: t.master, onClick: toggleMaster })),
          draft.enabled ? rows.map((row) => h('div', { key: row.id, className: 'featsw-row' },
            h('span', { className: 'featsw-row-name' }, row.name),
            h(Switch, { on: row.on, label: row.name, onClick: () => toggleFeature(row.id) }))) : null,
          err !== null ? h('p', { className: 'featsw-err' }, err) : null,
          h('div', { className: 'featsw-actions' },
            h('button', { type: 'button', className: 'featsw-btn', disabled: !dirty || saving, onClick: discard }, t.discard),
            h('button', { type: 'button', className: 'featsw-btn featsw-btn-primary', disabled: !dirty || saving, onClick: save }, saving ? t.saving : t.save))),
        pending.length > 0 ? h('div', { className: 'featsw-card' },
          pending.map((p) => h('div', { key: p.id, className: 'featsw-pending' },
            h('span', { style: { flex: 1 } }, nameOf(String(p.feature), zh)),
            h('button', { type: 'button', className: 'featsw-btn featsw-btn-primary', onClick: () => decide(p.id, true) }, t.allow),
            h('button', { type: 'button', className: 'featsw-btn', onClick: () => decide(p.id, false) }, t.deny)))) : null)
    }

    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'featsw', order: 13, label: function () { return isZhNow() ? '功能开关' : 'Features' } },
      SettingsPage,
    ))
  },
}

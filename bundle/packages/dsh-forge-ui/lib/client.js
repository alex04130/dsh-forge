// @local/dsh-forge-ui —— forge 主面板（浏览器半部，静态包）。
//
// 为什么是静态包：动态 client 半部跑在 cordis-client-runner 的沙箱里，
// 只拿到 React/console/styles/host，**没有 require** —— 拿不到官方 ui-primitives 的图标。
//
// 数据从哪来：走 forge 自己在宿主 HTTP 上开的 /dsh-forge/projects（见 bundle/plugins/projapi.mjs）。
// 不用官方 ctx.remote 命名空间，是因为浏览器侧那份清单是构建期生成、外部插件加不进去
// （docs/ADAPTATION-0.2.0-rc.2.md §6.16/§6.17）。
// 宿主 HTTP origin 从 window.__DSH_TRANSPORT__.streamBaseUrl 拿 —— 官方对
// "页 origin 与宿主 HTTP origin 不同" 这种情况专门留的字段（桌面版就是这种：dsh-app://app）。
window.__ModuleLoader__.load({
  id: '@local/dsh-forge-ui',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const PANEL = 'forge'
    const NS = 'forgeUi'
    const ROUTE = '/dsh-forge/projects'

    const CSS = `
.fgu-root { display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden; color: var(--dsw-alias-label-primary, inherit); font-family: inherit; }
.fgu-head { flex: none; display: flex; align-items: center; gap: 6px; padding: 14px 20px 0; border-bottom: 1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.16)); }
.fgu-tab { border: none; background: transparent; color: var(--dsw-alias-label-secondary, inherit); font: inherit; font-size: 13px; cursor: pointer; padding: 8px 12px 10px; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.fgu-tab[data-on="1"] { color: var(--dsw-alias-label-primary, inherit); border-bottom-color: var(--dsw-alias-brand-primary, currentColor); font-weight: 600; }
.fgu-cols { flex: 1; min-height: 0; display: flex; }
.fgu-left { flex: none; width: 264px; min-width: 264px; border-right: 1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.16)); display: flex; flex-direction: column; min-height: 0; }
.fgu-left-body { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 8px; }
.fgu-right { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; padding: 18px 20px 28px; }
.fgu-grp { font-size: 11px; font-weight: 650; letter-spacing: .05em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary, #9ca3af); padding: 12px 8px 6px; }
.fgu-grp:first-child { padding-top: 2px; }
.fgu-proj { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 9px; cursor: pointer; }
.fgu-proj:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.10)); }
.fgu-proj[data-on="1"] { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.16)); }
.fgu-pname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.fgu-pmeta { font-size: 11px; color: var(--dsw-alias-label-tertiary, #9ca3af); flex: none; }
.fgu-arch { border: none; background: transparent; color: var(--dsw-alias-label-tertiary, #9ca3af); cursor: pointer; font: inherit; font-size: 11px; opacity: 0; flex: none; }
.fgu-proj:hover .fgu-arch { opacity: 1; }
.fgu-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--dsw-alias-label-tertiary, #9ca3af); }
.fgu-dot[data-l="green"] { background: var(--dsw-alias-status-success, #22c55e); }
.fgu-dot[data-l="yellow"] { background: var(--dsw-alias-status-warning, #eab308); }
.fgu-dot[data-l="red"] { background: var(--dsw-alias-status-danger, #ef4444); }
.fgu-dot[data-l="gray"] { background: var(--dsw-alias-label-tertiary, #9ca3af); }
.fgu-new { flex: none; padding: 10px; border-top: 1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.16)); }
.fgu-btn { border: 1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.28)); background: transparent; color: var(--dsw-alias-label-secondary, inherit); border-radius: 8px; height: 28px; padding: 0 11px; font: inherit; font-size: 12px; cursor: pointer; }
.fgu-btn:hover { border-color: var(--dsw-alias-border-strong, rgba(128,128,128,.5)); }
.fgu-btn-p { width: 100%; }
.fgu-input { width: 100%; box-sizing: border-box; height: 30px; padding: 0 9px; font: inherit; font-size: 13px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.3)); background: var(--dsw-alias-bg-layer-1, transparent); color: inherit; }
.fgu-title { font-size: 16px; font-weight: 650; }
.fgu-sub { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 17px; color: var(--dsw-alias-label-tertiary, #9ca3af); margin-top: 2px; word-break: break-all; }
.fgu-rhead { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 14px; }
.fgu-card { border: 1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.2)); border-radius: 12px; padding: 12px 14px; margin-bottom: 10px; }
.fgu-ch { font-size: 12px; font-weight: 650; letter-spacing: .04em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary, #9ca3af); margin: 18px 0 8px; display: flex; align-items: center; gap: 8px; }
.fgu-ch:first-child { margin-top: 0; }
.fgu-row { display: flex; align-items: center; gap: 8px; padding: 7px 2px; border-bottom: 1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.12)); }
.fgu-row:last-child { border-bottom: none; }
.fgu-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.fgu-tag { font-size: 11px; color: var(--dsw-alias-label-tertiary, #9ca3af); flex: none; }
.fgu-note { font-size: 12px; line-height: 19px; color: var(--dsw-alias-label-tertiary, #9ca3af); }
.fgu-empty { font-size: 13px; color: var(--dsw-alias-label-tertiary, #9ca3af); padding: 20px 2px; }
.fgu-err { font-size: 12px; line-height: 18px; color: var(--dsw-alias-status-danger, #ef4444); padding: 8px; word-break: break-word; }
.fgu-warn { font-size: 12px; line-height: 18px; border: 1px solid var(--dsw-alias-status-warning, #eab308); border-radius: 9px; padding: 8px 10px; margin-bottom: 10px; }
`

    const zh = {
      panel: 'Forge',
      tabProject: '项目', tabConsole: '集群', tabManage: 'Forge',
      projects: '项目', unregistered: '未登记', archived: '已归档',
      newProject: '+ 新建项目', namePlaceholder: '项目名，回车创建',
      noProjects: '还没有项目。用下面的「新建项目」建第一个。',
      noUnregistered: '没有未登记的目录。',
      loading: '读取中…',
      pickOne: '从左栏选一个项目。',
      members: '成员', tasks: '看板', cwds: '目录', rounds: '归档轮次',
      noMembers: '这个项目还没有团队。',
      noTasks: '看板上还没有条目。',
      noCwds: '还没有目录。',
      archiveRoster: '归档团队', archiveProject: '归档', unarchive: '取消归档',
      register: '登记为项目',
      remove: '移除', add: '添加',
      cwdPlaceholder: '目录绝对路径，回车添加',
      memberName: '队员名', role: '角色', newMember: '+ 新建队员', working: '建立中…',
      needName: '队员名不能为空',
      send: '发消息', msgPlaceholder: '给这个队员发一句话，回车发送',
      pickExisting: '从已有会话挑选', noFree: '没有空闲会话可以挑选。', pick: '选它', taskPlaceholder: '看板条目，回车添加', noDetail: '（没有描述与产出）',
      sessions: '会话', people: '人',
      consoleTitle: '集群控制台',
      consoleNote: '这个 tab 是骨架：节点状态、控制 verb、会话与文件下发都落在这里。宿主侧的 /forge-control 已在跑（19 个 verb，自签 bearer token）。',
      manageTitle: 'Forge',
      manageNote: '收拢 插件 / 能力 / 模型 / 技能。能从官方 @Remote 拿到的就直接拿，不再自造一层宿主半部。',
      v1: '骨架，尚未接线。',
    }
    const en = {
      panel: 'Forge',
      tabProject: 'Projects', tabConsole: 'Cluster', tabManage: 'Forge',
      projects: 'Projects', unregistered: 'Unregistered', archived: 'Archived',
      newProject: '+ New project', namePlaceholder: 'Project name, press Enter',
      noProjects: 'No project yet. Use “New project” below to create the first one.',
      noUnregistered: 'No unregistered directory.',
      loading: 'Loading…',
      pickOne: 'Pick a project on the left.',
      members: 'Members', tasks: 'Board', cwds: 'Directories', rounds: 'Rounds',
      noMembers: 'This project has no team yet.',
      noTasks: 'The board is empty.',
      noCwds: 'No directory yet.',
      archiveRoster: 'Archive team', archiveProject: 'Archive', unarchive: 'Unarchive',
      register: 'Register as project',
      remove: 'Remove', add: 'Add',
      cwdPlaceholder: 'Absolute directory path, press Enter',
      memberName: 'Member name', role: 'Role', newMember: '+ New member', working: 'Creating…',
      needName: 'Member name is required',
      send: 'Message', msgPlaceholder: 'Send this member a line, press Enter',
      pickExisting: 'Pick an existing session', noFree: 'No free session to pick.', pick: 'Pick', taskPlaceholder: 'Board item, press Enter', noDetail: '(no description or output)',
      sessions: 'sessions', people: 'people',
      consoleTitle: 'Cluster console',
      consoleNote: 'Skeleton: node state, control verbs, session and file fan-out land here. The host /forge-control already runs (19 verbs, self-signed bearer token).',
      manageTitle: 'Forge',
      manageNote: 'Collects plugins / capabilities / models / skills. Whatever an official @Remote already exposes is called directly instead of growing another host half.',
      v1: 'Skeleton, not wired yet.',
    }

    // 图标来自官方公开的 primitives；解析不到就退化成文字，面板仍然可用。
    let IconPanel = null
    try {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      if (primitives !== null && typeof primitives === 'object'
        && typeof primitives.IconCubeOutlineRegular === 'function') IconPanel = primitives.IconCubeOutlineRegular
    } catch (error) { /* keep the glyph fallback */ }

    function ForgeIcon(props) {
      const size = props !== null && typeof props === 'object' && typeof props.size === 'number' ? props.size : 18
      if (IconPanel !== null) return h(IconPanel, { size })
      return h('span', { style: { fontSize: String(Math.round(size * 0.85)) + 'px', lineHeight: 1 } }, '⌘')
    }

    // ── 数据层：宿主 HTTP origin + 一个 op 调用 ───────────────────────────────
    // streamBaseUrl 是官方给"页 origin 与宿主 HTTP origin 不同"留的字段（桌面版正是如此：
    // 页是 dsh-app://app，宿主是 http://127.0.0.1:<port>）。取不到就退回相对路径 ——
    // 由 Electron 的自定义协议处理器决定是否转发。
    function baseUrl() {
      try {
        const t = window.__DSH_TRANSPORT__
        if (t !== null && typeof t === 'object' && typeof t.streamBaseUrl === 'string' && t.streamBaseUrl !== '') {
          return t.streamBaseUrl.replace(/\/+$/, '')
        }
      } catch (error) { /* fall through */ }
      return ''
    }

    async function call(op, args) {
      const res = await fetch(baseUrl() + ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forge-client': '1' },
        body: JSON.stringify(Object.assign({ op }, args || {})),
      })
      const text = await res.text()
      let body
      try { body = JSON.parse(text) } catch { throw new Error('宿主返回的不是 JSON（HTTP ' + res.status + '）：' + text.slice(0, 160)) }
      if (body !== null && typeof body === 'object' && body.ok === false) throw new Error(String(body.error || '调用失败'))
      return body
    }

    /** 项目的彩灯：有未完成看板条目=绿；有 stale=黄；否则灰。 */
    function lampOf(p) {
      const tasks = Array.isArray(p.tasks) ? p.tasks : []
      const open = tasks.some((t) => t && t.status !== 'completed' && t.status !== 'cancelled' && t.status !== 'failed')
      if (open) return 'green'
      if (Array.isArray(p.stale) && p.stale.length > 0) return 'yellow'
      return 'gray'
    }

    function ProjectRow(props) {
      const p = props.p
      return h('div', { className: 'fgu-proj', 'data-on': props.selected === p.id ? '1' : '0', onClick: () => props.onPick(p.id) },
        h('span', { className: 'fgu-dot', 'data-l': lampOf(p) }),
        h('span', { className: 'fgu-pname' }, p.name || p.id),
        h('span', { className: 'fgu-pmeta' }, String((p.members || []).length) + '/' + String((p.tasks || []).length)),
        props.archived
          ? h('button', { type: 'button', className: 'fgu-arch', onClick: (e) => { e.stopPropagation(); props.onUnarchive(p) } }, props.t('unarchive'))
          : h('button', { type: 'button', className: 'fgu-arch', onClick: (e) => { e.stopPropagation(); props.onArchive(p) } }, props.t('archiveProject')))
    }

    function LeftColumn(props) {
      const t = props.t
      const [draft, setDraft] = React.useState('')
      const live = props.projects.filter((p) => !p.dormant && !p.implicit)
      const unreg = props.projects.filter((p) => !p.dormant && p.implicit)
      const arch = props.projects.filter((p) => p.dormant)
      const submit = () => {
        const name = draft.trim()
        if (name === '') return
        setDraft('')
        props.onCreate(name)
      }
      return h('div', { className: 'fgu-left' },
        h('div', { className: 'fgu-left-body' },
          props.error !== null ? h('div', { className: 'fgu-err' }, props.error) : null,
          props.problem !== null ? h('div', { className: 'fgu-warn' }, 'projects.json 有问题：' + props.problem) : null,
          props.loading ? h('div', { className: 'fgu-empty' }, t('loading')) : null,
          !props.loading && live.length === 0 ? h('div', { className: 'fgu-empty' }, t('noProjects')) : null,
          live.length > 0 ? h('div', null,
            h('div', { className: 'fgu-grp' }, t('projects')),
            live.map((p) => h(ProjectRow, { key: p.id, p, t, selected: props.selected, onPick: props.onPick, onArchive: props.onArchive, onUnarchive: props.onUnarchive }))) : null,
          unreg.length > 0 ? h('div', null,
            h('div', { className: 'fgu-grp' }, t('unregistered')),
            unreg.map((p) => h(ProjectRow, { key: p.id, p, t, selected: props.selected, onPick: props.onPick, onArchive: props.onArchive, onUnarchive: props.onUnarchive }))) : null,
          arch.length > 0 ? h('div', null,
            h('div', { className: 'fgu-grp' }, t('archived')),
            arch.map((p) => h(ProjectRow, { key: p.id, p, t, selected: props.selected, onPick: props.onPick, onArchive: props.onArchive, onUnarchive: props.onUnarchive, archived: true }))) : null),
        h('div', { className: 'fgu-new' },
          h('input', {
            className: 'fgu-input', value: draft, placeholder: t('namePlaceholder'),
            onChange: (e) => setDraft(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') submit() },
          })))
    }

    function Card(props) {
      return h('div', null,
        h('div', { className: 'fgu-ch' }, props.title,
          h('span', { className: 'fgu-tag' }, String(props.count))),
        props.children)
    }

    const STATUS_CYCLE = ['pending', 'in_progress', 'completed']
    const STATUS_LABEL = { pending: '待办', in_progress: '进行中', completed: '完成', failed: '失败', cancelled: '取消' }
    const PRESETS = ['forge-team', 'forge-team-creative', 'forge-team-distill']

    function Inline(props) {
      return h('div', { style: { display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' } }, props.children)
    }

    function ProjectDetail(props) {
      const t = props.t
      const p = props.p
      const [cwdDraft, setCwdDraft] = React.useState('')
      const [taskDraft, setTaskDraft] = React.useState('')
      const [mName, setMName] = React.useState('')
      const [mCwd, setMCwd] = React.useState('')
      const [mRole, setMRole] = React.useState('')
      const [mPreset, setMPreset] = React.useState(PRESETS[0])
      const [mBusy, setMBusy] = React.useState(false)
      const [mErr, setMErr] = React.useState(null)
      const [openTask, setOpenTask] = React.useState(undefined)
      const [msgFor, setMsgFor] = React.useState(undefined)
      const [msgText, setMsgText] = React.useState('')
      const [free, setFree] = React.useState(null)

      if (p === undefined) return h('div', { className: 'fgu-empty' }, t('pickOne'))
      const cwds = Array.isArray(p.cwds) ? p.cwds : []
      const members = Array.isArray(p.members) ? p.members : []
      const tasks = Array.isArray(p.tasks) ? p.tasks : []
      const act = props.onAct

      const addMember = () => {
        const name = mName.trim()
        if (name === '') { setMErr(t('needName')); return }
        setMBusy(true); setMErr(null)
        props.createSession(mCwd !== '' ? mCwd : (cwds[0] || ''), mPreset)
          .then((sessionId) => act('memberAdd', { projectId: p.id, sessionId, memberId: name, role: mRole, preset: mPreset }))
          .then(() => { setMName(''); setMRole('') })
          .catch((e) => setMErr(String((e && e.message) || e)))
          .then(() => setMBusy(false))
      }

      return h('div', null,
        h('div', { className: 'fgu-rhead' },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { className: 'fgu-title' }, p.implicit ? t('unregistered') : t('members')),
            h('div', { className: 'fgu-title', style: { fontSize: 14, fontWeight: 600, marginTop: 6 } }, p.name || p.id),
            h('div', { className: 'fgu-sub' }, cwds.length > 0 ? cwds.join('  \u00b7  ') : t('noCwds'))),
          p.implicit
            ? h('button', { type: 'button', className: 'fgu-btn', onClick: () => props.onRegister(p) }, t('register'))
            : h('button', { type: 'button', className: 'fgu-btn', onClick: () => props.onArchiveRoster(p) }, t('archiveRoster'))),

        h(Card, { title: t('cwds'), count: cwds.length },
          h('div', null, cwds.map((c) => h('div', { key: c, className: 'fgu-row' },
            h('span', { className: 'fgu-name' }, c),
            h('button', { type: 'button', className: 'fgu-arch', style: { opacity: 1 }, onClick: () => act('removeCwd', { projectId: p.id, cwd: c }) }, t('remove'))))),
          h(Inline, null,
            h('input', { className: 'fgu-input', style: { flex: 1, minWidth: 180 }, value: cwdDraft, placeholder: t('cwdPlaceholder'),
              onChange: (e) => setCwdDraft(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter' && cwdDraft.trim() !== '') { act('addCwd', { projectId: p.id, cwd: cwdDraft.trim() }); setCwdDraft('') } } }),
            h('button', { type: 'button', className: 'fgu-btn', onClick: () => { if (cwdDraft.trim() !== '') { act('addCwd', { projectId: p.id, cwd: cwdDraft.trim() }); setCwdDraft('') } } }, t('add')))),

        h(Card, { title: t('members'), count: members.length },
          members.length === 0
            ? h('div', { className: 'fgu-empty' }, t('noMembers'))
            : h('div', null, members.map((m) => h(React.Fragment, { key: m.sessionId },
              h('div', { className: 'fgu-row' },
                h('span', { className: 'fgu-dot', 'data-l': 'gray' }),
                h('span', { className: 'fgu-name' }, m.memberId || m.sessionId),
                h('span', { className: 'fgu-tag' }, m.role || ''),
                h('span', { className: 'fgu-tag' }, m.preset || ''),
                h('button', { type: 'button', className: 'fgu-arch', style: { opacity: 1 }, onClick: () => { setMsgFor(msgFor === m.sessionId ? undefined : m.sessionId); setMsgText('') } }, t('send')),
                h('button', { type: 'button', className: 'fgu-arch', style: { opacity: 1 }, onClick: () => act('memberRemove', { projectId: p.id, sessionId: m.sessionId }) }, t('remove'))),
              msgFor === m.sessionId
                ? h('div', { style: { display: 'flex', gap: 6, padding: '0 2px 8px' } },
                  h('input', { className: 'fgu-input', style: { flex: 1 }, autoFocus: true, value: msgText, placeholder: t('msgPlaceholder'),
                    onChange: (e) => setMsgText(e.target.value),
                    onKeyDown: (e) => { if (e.key === 'Enter' && msgText.trim() !== '') { act('memberMessage', { from: props.currentSessionId, to: m.sessionId, text: msgText.trim() }); setMsgText(''); setMsgFor(undefined) } } }),
                  h('button', { type: 'button', className: 'fgu-btn', onClick: () => { if (msgText.trim() !== '') { act('memberMessage', { from: props.currentSessionId, to: m.sessionId, text: msgText.trim() }); setMsgText(''); setMsgFor(undefined) } } }, t('send')))
                : null))),
          h(Inline, null,
            h('input', { className: 'fgu-input', style: { width: 130 }, value: mName, placeholder: t('memberName'), onChange: (e) => setMName(e.target.value) }),
            h('select', { className: 'fgu-input', style: { width: 150 }, value: mCwd, onChange: (e) => setMCwd(e.target.value) },
              h('option', { value: '' }, cwds[0] || t('noCwds')),
              cwds.map((c) => h('option', { key: c, value: c }, c))),
            h('input', { className: 'fgu-input', style: { width: 110 }, value: mRole, placeholder: t('role'), onChange: (e) => setMRole(e.target.value) }),
            h('select', { className: 'fgu-input', style: { width: 180 }, value: mPreset, onChange: (e) => setMPreset(e.target.value) },
              PRESETS.map((x) => h('option', { key: x, value: x }, x))),
            h('button', { type: 'button', className: 'fgu-btn', disabled: mBusy, onClick: addMember }, mBusy ? t('working') : t('newMember')),
            h('button', { type: 'button', className: 'fgu-btn', onClick: () => call('freeSessions', {}).then((r) => setFree(Array.isArray(r.sessions) ? r.sessions : [])).catch((e) => setMErr(String((e && e.message) || e))) }, t('pickExisting'))),
          free !== null ? h('div', { style: { marginTop: 8 } },
            free.length === 0 ? h('div', { className: 'fgu-note' }, t('noFree')) : free.slice(0, 12).map((x) => h('div', { key: x.sessionId, className: 'fgu-row' },
              h('span', { className: 'fgu-name' }, x.title || x.sessionId),
              h('span', { className: 'fgu-tag' }, x.cwd || ''),
              h('button', { type: 'button', className: 'fgu-btn', style: { height: 22, fontSize: 11 }, onClick: () => { act('memberAdd', { projectId: p.id, sessionId: x.sessionId, memberId: (x.title || x.sessionId).slice(0, 24), role: '', preset: mPreset }); setFree(null) } }, t('pick'))))) : null,
          mErr !== null ? h('div', { className: 'fgu-err' }, mErr) : null),

        h(Card, { title: t('tasks'), count: tasks.length },
          tasks.length === 0
            ? h('div', { className: 'fgu-empty' }, t('noTasks'))
            : h('div', null, tasks.map((x) => h('div', { key: x.id },
              h('div', { className: 'fgu-row' },
                h('button', { type: 'button', className: 'fgu-btn', style: { flex: 'none', padding: '0 8px', height: 22, fontSize: 11 },
                  onClick: () => act('taskWrite', { projectId: p.id, id: x.id, title: x.title, status: STATUS_CYCLE[(STATUS_CYCLE.indexOf(x.status) + 1) % STATUS_CYCLE.length], assignee: x.assignee, description: x.description, output: x.output }) },
                  STATUS_LABEL[x.status] || x.status || '待办'),
                h('span', { className: 'fgu-name', style: { cursor: 'pointer' }, onClick: () => setOpenTask(openTask === x.id ? undefined : x.id) }, x.title || x.id),
                h('span', { className: 'fgu-tag' }, x.assignee || '')),
              openTask === x.id
                ? h('div', { className: 'fgu-note', style: { padding: '2px 2px 8px' } },
                  x.description ? h('div', null, x.description) : null,
                  x.output ? h('div', { style: { marginTop: 4 } }, x.output) : null,
                  (x.description === '' && x.output === '') ? h('div', null, t('noDetail')) : null)
                : null))),
          h(Inline, null,
            h('input', { className: 'fgu-input', style: { flex: 1, minWidth: 180 }, value: taskDraft, placeholder: t('taskPlaceholder'),
              onChange: (e) => setTaskDraft(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter' && taskDraft.trim() !== '') { act('taskWrite', { projectId: p.id, title: taskDraft.trim(), status: 'pending' }); setTaskDraft('') } } }),
            h('button', { type: 'button', className: 'fgu-btn', onClick: () => { if (taskDraft.trim() !== '') { act('taskWrite', { projectId: p.id, title: taskDraft.trim(), status: 'pending' }); setTaskDraft('') } } }, t('add')))),

        h('div', { className: 'fgu-note', style: { marginTop: 8 } },
          t('rounds') + ' ' + String((p.archived || []).length) + (p.captain ? '  \u00b7  captain ' + p.captain : '')))
    }

    function ConsoleTab(props) {
      return h('div', null,
        h('div', { className: 'fgu-title' }, props.t('consoleTitle')),
        h('div', { className: 'fgu-note', style: { marginTop: 8 } }, props.t('consoleNote')))
    }

    function ManageTab(props) {
      const secs = ['插件', '能力', '模型', '技能']
      return h('div', null,
        h('div', { className: 'fgu-title' }, props.t('manageTitle')),
        h('div', { className: 'fgu-note', style: { marginTop: 8 } }, props.t('manageNote')),
        secs.map((label) => h('div', { key: label, className: 'fgu-card' },
          h('div', { className: 'fgu-title' }, label),
          h('div', { className: 'fgu-note', style: { marginTop: 4 } }, props.t('v1')))))
    }

    const TABS = [['project', 'tabProject'], ['console', 'tabConsole'], ['manage', 'tabManage']]

    function ForgePage(props) {
      const t = props.t
      const [tab, setTab] = React.useState('project')
      const [projects, setProjects] = React.useState([])
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState(null)
      const [problem, setProblem] = React.useState(null)
      const [selected, setSelected] = React.useState(undefined)
      // 当前会话 id 的取法：SessionListState **没有** current 字段，官方是从 byId 里挑
      // retainedBy.mainView > 0 的那个（ui-workspace/src/client/tree.ts 的 mainSessionId）。
      // 我原先写 x.current → undefined → 服务端 str() 成空串 → 用户看到「from/to 不能为空」。
      // 选择器返回字符串而非新对象，快照比对稳定。
      const currentSessionId = props.useSessions((list) => {
        if (list === null || typeof list !== 'object' || list.byId === null || typeof list.byId !== 'object') return undefined
        const main = Object.values(list.byId).find((s) => s !== null && typeof s === 'object'
          && s.retainedBy !== null && typeof s.retainedBy === 'object' && (s.retainedBy.mainView ?? 0) > 0)
        return main !== undefined && typeof main.id === 'string' ? main.id : undefined
      })

      const reload = React.useCallback(() => {
        setLoading(true)
        call('list', {})
          .then((res) => {
            setProjects(Array.isArray(res.projects) ? res.projects : [])
            setProblem(typeof res.problem === 'string' && res.problem !== '' ? res.problem : null)
            setError(null)
          })
          .catch((e) => setError(String((e && e.message) || e)))
          .then(() => setLoading(false))
      }, [])
      React.useEffect(() => { reload() }, [reload])

      const run = (op, args) => {
        call(op, args).then(() => reload()).catch((e) => setError(String((e && e.message) || e)))
      }

      const current = selected === undefined ? undefined : projects.find((p) => p.id === selected)
      let body
      if (tab === 'console') body = h(ConsoleTab, { t })
      else if (tab === 'manage') body = h(ManageTab, { t })
      else {
        body = h('div', { className: 'fgu-cols' },
          h(LeftColumn, {
            t, projects, loading, error, problem, selected,
            onPick: (id) => setSelected(id),
            onCreate: (name) => run('create', { name, cwds: [] }),
            onArchive: (p) => run('archiveProject', { projectId: p.id }),
            onUnarchive: (p) => run('unarchiveProject', { projectId: p.id }),
          }),
          h('div', { className: 'fgu-right' },
            h(ProjectDetail, {
              t, p: current, createSession: props.createSession, onAct: run, currentSessionId,
              onArchiveRoster: (x) => run('archiveRoster', { projectId: x.id }),
              onRegister: (x) => run('create', { name: x.name || x.id, cwds: x.cwds || [] }),
            })))
      }

      return h('div', { className: 'fgu-root' },
        h('div', { className: 'fgu-head' }, TABS.map(([key, label]) => h('button', {
          key, type: 'button', className: 'fgu-tab', 'data-on': tab === key ? '1' : '0',
          onClick: () => setTab(key),
        }, t(label)))),
        body)
    }

    return {
      // 'remote' 必须声明在 inject 里：客户端 ctx.remote 是属性代理，未注入时访问
      // ctx.remote.session 会抛 `cannot get property "remote.session" without inject`
      // （操作员点「+ 新建队员」时实测撞到）。声明后 ctx.remote 才可合法读取。
      inject: ['slots', 'locale', 'remote'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-forge-ui: dictionaries')
        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.setAttribute('data-plugin-css', '@local/dsh-forge-ui')
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => { try { tag.remove() } catch (error) { /* best-effort */ } }
        })
        // The sidebar owns the button and resolves its label from this metadata;
        // the cell itself only draws the icon.
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL, order: 20, locale: NS, label: () => t('panel') },
          ForgeIcon,
        ))
        // 建会话走**官方已挂载的** remote 命名空间：`session` 是 dsh-api-remotes
        // apply() 里那 25 个之一，客户端直接可用（这也是为什么 forge 自己的数据
        // 得走自注册路由、而建会话不用 —— 后者官方有面）。
        const createSession = async (cwd, preset) => {
          const remote = ctx.remote
          if (remote === undefined || remote === null || remote.session === undefined) throw new Error('ctx.remote.session 不可用')
          const res = await remote.session.create(Object.assign({}, cwd ? { cwd } : {}, { agentPreset: preset }))
          if (res !== null && typeof res === 'object' && res.ok === false) {
            throw new Error(String(res.error && res.error.message ? res.error.message : res.error))
          }
          const value = res !== null && typeof res === 'object' && res.value !== undefined ? res.value : res
          if (value === null || typeof value !== 'object' || typeof value.sessionId !== 'string') throw new Error('session.create 没回 sessionId')
          return value.sessionId
        }
        ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: PANEL, locale: NS, inject: () => ({ t, createSession }) },
          ForgePage,
        ))
      },
    }
  },
})

// T8b 组织写面：projects.json 队 CRUD + 白板/弹窗/通话另文件。不 kv.open。
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { DSH_HOME, atomicWriteJson } from './forge-common.mjs'
import {
  loadProjects, saveProjects, findTeam, teamOfSession, teamView,
  FORGE_TEAM_PRESETS, isForgeTeamPreset, DEFAULT_WAKE,
} from './projects.mjs'

const WORKSPACE = join(DSH_HOME, 'storages', 'workspace.json')
const PROJCACHE = join(DSH_HOME, 'storages', 'session_projcache', 'sessions')
const BOARD_ROOT = join(DSH_HOME, 'team-board')
const INBOX_ROOT = join(DSH_HOME, 'console-inbox')
const TALK_ROOT = join(DSH_HOME, 'team-talk')
const MAILBOX = join(DSH_HOME, 'storages', 'agent_mailbox.json')

const TASK_STATUSES = ['pending', 'claimed', 'in_progress', 'completed', 'failed', 'cancelled']
const OPEN_TASK = new Set(['pending', 'claimed', 'in_progress'])
const INBOX_WINDOW_MS = 60000
const INBOX_BURST = 8
const BOARD_COOLDOWN_MS = 15000
const boardLast = new Map()

function nowId(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1679615).toString(36)
}

function slugTeam(projectId) {
  const base = String(projectId || 'x').replace(/^p-/, '').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 24)
  const rand = Math.random().toString(36).slice(2, 6)
  return 'team-' + (base || 'x') + '-' + rand
}

function cleanMemberId(value) {
  const id = String(value ?? '').trim()
  if (id.length === 0 || id.length > 48) return ''
  if (!/^[0-9a-zA-Z_.\-\u4e00-\u9fff]+$/.test(id)) return ''
  return id
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return fallback }
}

async function appendJsonl(file, row) {
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, JSON.stringify(row) + '\n', 'utf8')
}

async function readJsonl(file, cap) {
  let text = ''
  try { text = await readFile(file, 'utf8') } catch { return [] }
  const out = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try { out.push(JSON.parse(s)) } catch { /* skip */ }
  }
  if (Number.isFinite(cap) && cap > 0 && out.length > cap) return out.slice(-cap)
  return out
}

function inboxPath(projectId) {
  return join(INBOX_ROOT, String(projectId || 'unknown') + '.jsonl')
}

function boardPath(teamId) {
  // 必须继续 slug：旧看板落在 boards/<projectId 去掉 p- 前缀>.jsonl，
  // teamId 现在等于 projectId，直接拿 id 当文件名会让历史看板整片读不到。
  return join(BOARD_ROOT, slugTeam(teamId) + '.jsonl')
}

function talkPath(from, to) {
  const a = String(from)
  const b = String(to)
  const key = a < b ? a + '__' + b : b + '__' + a
  return join(TALK_ROOT, key + '.jsonl')
}

export async function inboxPending(projectId) {
  const rows = await readJsonl(inboxPath(projectId), 400)
  return rows.filter((r) => r && r.status === 'pending')
}

export async function inboxLookup(projectId, id) {
  const rows = await readJsonl(inboxPath(projectId), 400)
  return rows.find((r) => r && r.id === id) || null
}

export async function inboxHasOpen(projectId) {
  const pending = await inboxPending(projectId)
  return pending.length > 0
}

export async function teamLampExtra(projectId) {
  const pending = await inboxPending(projectId)
  if (pending.some((r) => r && r.kind === 'error')) return 'red'
  if (pending.length > 0) return 'yellow'
  return 'gray'
}

export async function listFreeSessions() {
  const ws = await readJson(WORKSPACE, {})
  const archived = new Set(Array.isArray(ws?.global?.archivedSessionIds) ? ws.global.archivedSessionIds : [])
  const tables = ws?.tables?.workspaces && typeof ws.tables.workspaces === 'object' ? ws.tables.workspaces : {}
  const cfg = await loadProjects()
  const taken = new Set()
  for (const p of cfg.projects || []) {
    for (const m of p.members || []) if (m && m.sessionId) taken.add(m.sessionId)
  }
  const out = []
  for (const w of Object.values(tables)) {
    if (!w || typeof w !== 'object') continue
    const ids = Array.isArray(w.sessionIds) ? w.sessionIds : []
    for (const id of ids) {
      if (typeof id !== 'string' || id.length === 0) continue
      if (archived.has(id) || taken.has(id)) continue
      let title = ''
      try {
        const rec = JSON.parse(await readFile(join(PROJCACHE, id + '.json'), 'utf8'))
        title = rec?.record?.rows?.title?.val || rec?.title || ''
      } catch { title = '' }
      out.push({
        sessionId: id,
        title: String(title || '').trim(),
        cwd: typeof w.path === 'string' ? w.path : '',
        workspace: typeof w.title === 'string' ? w.title : '',
      })
    }
  }
  out.sort((a, b) => (a.title || a.sessionId).localeCompare(b.title || b.sessionId))
  return { ok: true, sessions: out, presets: FORGE_TEAM_PRESETS }
}

export async function createTeam({ projectId, name, members, actor }) {
  const cfg = await loadProjects()
  const project = (cfg.projects || []).find((p) => p && p.id === projectId)
  if (!project) return { ok: false, error: '没有这个项目' }
  const display = String(name ?? '').trim()
  if (display.length === 0 || display.length > 64) return { ok: false, error: '队名 1–64 字' }
  const specs = Array.isArray(members) ? members : []
  const added = []
  for (const spec of specs) {
    const sid = String(spec?.sessionId || spec?.existingSessionId || '').trim()
    if (sid === '') return { ok: false, error: '队员必须已有会话' }
    if (teamOfSession(cfg, sid)) return { ok: false, error: '会话已在别队，先减员再加' }
    const memberId = cleanMemberId(spec.memberId) || sid.slice(0, 12)
    const role = String(spec.role ?? '').trim() || '队员'
    const preset = String(spec.preset || 'forge-team').trim()
    if (!isForgeTeamPreset(preset)) return { ok: false, error: '入队只能 forge-team / forge-team-creative / forge-team-distill' }
    added.push({ sessionId: sid, memberId, role, preset })
  }
  // 一个项目只有一支团队（2026-10-02 合并）：项目自己就是团队，不再有 teams[]。
  // 项目上已经有人 = 已经开过一轮，先归档当前队员再开新的。
  const current = Array.isArray(project.members) ? project.members : []
  if (current.length > 0) return { ok: false, error: '这个项目已经有团队了，先归档当前队员再开新一轮' }
  project.name = display
  project.members = added
  project.tasks = []
  project.stale = []
  // 队长就是第一名成员 —— 与 legacyFromHit 的算法保持一致，
  // 否则 createTeam 造出来的状态和读回来看到的状态会对不上。
  if (added.length > 0) project.captain = added[0].sessionId
  await saveProjects(cfg)
  return { ok: true, team: teamView(project), actor: actor || 'ui' }
}

export async function renameTeam(teamId, name) {
  const display = String(name ?? '').trim()
  if (display.length === 0 || display.length > 64) return { ok: false, error: '队名 1–64 字' }
  const cfg = await loadProjects()
  const hit = findTeam(cfg, teamId)
  if (!hit) return { ok: false, error: '没有这支队' }
  // team 与 project 合并之后，名字只有一个落点：项目名。
  hit.project.name = display
  await saveProjects(cfg)
  return { ok: true, teamId, name: display }
}

export async function archiveTeam(teamId) {
  const cfg = await loadProjects()
  const hit = findTeam(cfg, teamId)
  if (!hit) return { ok: false, error: '没有这支队' }
  const p = hit.project
  const snapshot = {
    at: new Date().toISOString(),
    name: String(p.name ?? ''),
    ...(typeof p.captain === 'string' && p.captain.length > 0 ? { captain: p.captain } : {}),
    ...(typeof p.goal === 'string' && p.goal.length > 0 ? { goal: p.goal } : {}),
    members: Array.isArray(p.members) ? p.members : [],
    tasks: Array.isArray(p.tasks) ? p.tasks : [],
    stale: Array.isArray(p.stale) ? p.stale : [],
  }
  if (!Array.isArray(p.archived)) p.archived = []
  p.archived.push(snapshot)
  p.members = []
  p.tasks = []
  p.stale = []
  // captain / goal 也必须清掉：它们是"这一轮开过队"的唯一标记，
  // 留着的话 forge_team_create 会一直回 "you already lead team"，
  // 于是「归档当前队员、开新一轮」根本走不通（活实例回归第 5 条撞到的就是这个）。
  delete p.captain
  delete p.goal
  await saveProjects(cfg)
  return { ok: true, teamId, name: snapshot.name, projectId: p.id, archived: true, round: p.archived.length }
}

export async function restoreTeam(teamId) {
  const cfg = await loadProjects()
  const hit = findTeam(cfg, teamId)
  if (hit === null) return { ok: false, error: '没有这支归档队' }
  const p = hit.project
  const archived = Array.isArray(p.archived) ? p.archived : []
  if (archived.length === 0) return { ok: false, error: '没有这支归档队' }
  if (Array.isArray(p.members) && p.members.length > 0) return { ok: false, error: '项目已经有在跑的团队，先归档它再恢复' }
  const round = archived[archived.length - 1]
  p.archived = archived.slice(0, -1)
  p.members = Array.isArray(round.members) ? round.members : []
  p.tasks = Array.isArray(round.tasks) ? round.tasks : []
  p.stale = Array.isArray(round.stale) ? round.stale : []
  if (typeof round.captain === 'string' && round.captain.length > 0) p.captain = round.captain
  if (typeof round.goal === 'string' && round.goal.length > 0) p.goal = round.goal
  await saveProjects(cfg)
  return { ok: true, teamId, name: String(p.name ?? ''), projectId: p.id, restoredRound: archived.length }
}

export async function addMember({ teamId, sessionId, memberId, role, preset, actor }) {
  const sid = String(sessionId ?? '').trim()
  if (sid === '') return { ok: false, error: '必须已有会话' }
  const cfg = await loadProjects()
  const other = teamOfSession(cfg, sid)
  if (other && other.team.teamId !== teamId) return { ok: false, error: '会话已在别队，先减员再加' }
  const hit = findTeam(cfg, teamId)
  if (!hit) return { ok: false, error: '没有这支队' }
  if (!Array.isArray(hit.project.members)) hit.project.members = []
  if (hit.project.members.some((m) => m.sessionId === sid)) return { ok: false, error: '已经在队里' }
  const id = cleanMemberId(memberId) || sid.slice(0, 12)
  const face = String(preset || 'forge-team').trim()
  if (!isForgeTeamPreset(face)) return { ok: false, error: '入队只能三档纯 forge' }
  hit.project.members.push({
    sessionId: sid,
    memberId: id,
    role: String(role ?? '').trim() || '队员',
    preset: face,
  })
  await saveProjects(cfg)
  return { ok: true, member: hit.project.members[hit.project.members.length - 1], actor: actor || 'ui' }
}

export async function removeMember({ teamId, sessionId }) {
  const sid = String(sessionId ?? '').trim()
  const cfg = await loadProjects()
  const hit = findTeam(cfg, teamId)
  if (!hit) return { ok: false, error: '没有这支队' }
  if (!Array.isArray(hit.project.members)) hit.project.members = []
  const before = hit.project.members.length
  hit.project.members = hit.project.members.filter((m) => m.sessionId !== sid)
  if (hit.project.members.length === before) return { ok: false, error: '队里没有这个人' }
  if (hit.project.distillSessionId === sid) delete hit.project.distillSessionId
  await saveProjects(cfg)
  return { ok: true, teamId, sessionId: sid }
}

export async function writeTask({ teamId, id, title, status, assignee, description, output, actorTeamId }) {
  const cfg = await loadProjects()
  const hit = findTeam(cfg, teamId)
  if (!hit) return { ok: false, error: '没有这支队' }
  if (actorTeamId && actorTeamId !== teamId) {
    await enqueueInbox(hit.project.id, {
      kind: 'notice',
      title: '别队改了自己的任务',
      detail: '对方没有改你们的板，只是告知。',
      teamId,
    })
    return { ok: false, error: '不改别人队的任务，已告知对方' }
  }
  if (!Array.isArray(hit.project.tasks)) hit.project.tasks = []
  let task = typeof id === 'string' && id.length > 0 ? hit.project.tasks.find((t) => t.id === id) : null
  if (!task) {
    const next = 't' + String(hit.project.tasks.length + 1)
    task = {
      id: next,
      title: String(title ?? '').trim() || next,
      status: 'pending',
      assignee: String(assignee ?? ''),
      description: String(description ?? ''),
      output: '',
    }
    hit.project.tasks.push(task)
  }
  if (typeof title === 'string' && title.trim() !== '') task.title = title.trim()
  if (typeof description === 'string') task.description = description
  if (typeof assignee === 'string') task.assignee = assignee
  if (typeof output === 'string') task.output = output
  if (typeof status === 'string' && status.length > 0) {
    if (!TASK_STATUSES.includes(status)) return { ok: false, error: '状态不对' }
    task.status = status
  }
  await saveProjects(cfg)
  return { ok: true, task }
}

export async function boardRead(teamId, since) {
  const hit = findTeam(await loadProjects(), teamId)
  if (!hit) return { ok: false, error: '没有这支队' }
  const posts = await readJsonl(boardPath(teamId), 200)
  const marker = String(since || '')
  let delta = posts
  if (marker !== '') {
    const i = posts.findIndex((p) => p && p.id === marker)
    delta = i >= 0 ? posts.slice(i + 1) : posts
  }
  const last = posts.length ? posts[posts.length - 1].id : ''
  return { ok: true, teamId, posts, delta, since: last, injected: delta }
}

export async function boardPost({ teamId, text, from, fromName, taskId }) {
  const body = String(text ?? '').trim()
  if (body.length === 0) return { ok: false, error: '空留言' }
  const hit = findTeam(await loadProjects(), teamId)
  if (!hit) return { ok: false, error: '没有这支队' }
  const sender = String(from || '')
  if (sender !== '' && sender !== 'console') {
    const key = teamId + '|' + sender + '|' + String(taskId || '')
    const prev = boardLast.get(key) || 0
    if (Date.now() - prev < BOARD_COOLDOWN_MS) {
      return { ok: false, error: '这条任务的白板还在冷却' }
    }
    boardLast.set(key, Date.now())
  }
  const row = {
    id: nowId('p'),
    ts: Date.now(),
    from: sender,
    fromName: String(fromName || from || ''),
    text: body.slice(0, 4000),
    taskId: taskId ? String(taskId) : '',
  }
  await mkdir(BOARD_ROOT, { recursive: true })
  await appendJsonl(boardPath(teamId), row)
  return { ok: true, post: row, delta: [row], injected: [row] }
}

export function talkRelation(cfg, fromId, toId) {
  const a = teamOfSession(cfg, fromId)
  const b = teamOfSession(cfg, toId)
  const projectOfDistill = (sid) => (cfg.projects || []).find((p) => p && p.distillSessionId === sid)
  const da = projectOfDistill(fromId)
  const db = projectOfDistill(toId)
  if (a && b && a.team.teamId === b.team.teamId) return { kind: 'same-team', project: a.project, team: a.team }
  // 蒸馏岗不是队员，但同项目通话免批（岗≠队员，不算灯/互唤预算）
  if (a && db && a.project.id === db.id) return { kind: 'same-team', project: a.project, team: a.team }
  if (b && da && b.project.id === da.id) return { kind: 'same-team', project: b.project, team: b.team }
  if (da && db && da.id === db.id) return { kind: 'same-team', project: da, team: null }
  if (a && b && a.project.id === b.project.id) return { kind: 'cross-team', project: a.project }
  return { kind: 'cross-project', project: a ? a.project : b ? b.project : da || db || null }
}

async function enqueueMailbox(to, from, fromName, wrapped) {
  let store
  try { store = JSON.parse(await readFile(MAILBOX, 'utf8')) } catch {
    store = { unit: { name: 'agent_mailbox', version: 0 }, global: null, tables: { msg: {} } }
  }
  if (!store.tables) store.tables = {}
  if (!store.tables.msg || typeof store.tables.msg !== 'object') store.tables.msg = {}
  const id = nowId('m')
  store.tables.msg[id] = { id, from: from || null, fromName: fromName || '', to, text: wrapped, ts: Date.now() }
  await atomicWriteJson(MAILBOX, store)
  return id
}

// console / mailbridge apply 时注入；sidecar 无 agents 则退回排队。
let talkRuntime = null
export function bindTalkRuntime(runtime) {
  talkRuntime = runtime && typeof runtime === 'object' ? runtime : null
}

function wrapTalk(sender, fromName, body) {
  const clean = String(body || '').replace(/(\n*\s*(?:\[\/cross-session message\]|\[cross-session message end\])\s*)+$/, '')
  if (sender === 'console' || sender === '') {
    return '[控制台通话]\n\n' + clean.slice(0, 200000) + '\n\n[cross-session message end]'
  }
  const label = (fromName || sender || 'unknown') + (sender ? ' (' + sender + ')' : '')
  return '[cross-session message from ' + label + ']\n\n' + clean.slice(0, 200000)
    + '\n\n（这是一条跨会话协作消息。若它要求回复，处理后请用 forge_mailbridge_send 把结论发回给发送方会话 ' + sender + '，而不是只写在本地对话里。）'
    + '\n\n[cross-session message end]'
}

// ── 上游 0.1.5-rc.2 兼容层（R2，2026-09-11）────────────────────────────────
// rc.2 换掉了 sessionPersistence 的公开 API：旧 inspect(id) → { meta, events }；
// 新 stat(id) → { header, … }（无 events）+ open(id, 'read') → handle.read() → { events }。
// 特性探测优先新核，旧核回退，让同一份 lib 在两代核上都能跑。
async function persistenceRead(persist, id) {
  if (persist === undefined || persist === null) return undefined
  if (typeof persist.stat === 'function' && typeof persist.open === 'function') {
    const snapshot = await persist.stat(id)
    if (snapshot === undefined || snapshot === null) return undefined
    const handle = await persist.open(id, 'read')
    try {
      const result = await handle.read(0, Number.MAX_SAFE_INTEGER)
      const events = result !== null && typeof result === 'object' && Array.isArray(result.events) ? result.events : []
      return { events, meta: typeof snapshot === 'object' ? snapshot.header : undefined }
    } finally {
      try { await handle.close() } catch (error) { /* best-effort */ }
    }
  }
  if (typeof persist.inspect === 'function') {
    const inspection = await persist.inspect(id)
    if (inspection === null || typeof inspection !== 'object') return undefined
    return { events: Array.isArray(inspection.events) ? inspection.events : [], meta: inspection.meta }
  }
  return undefined
}

async function lastAgentOptions(sessionId) {
  const persist = talkRuntime && talkRuntime.sessionPersistence
  if (!persist) return undefined
  try {
    const inspection = await persistenceRead(persist, sessionId)
    const events = inspection !== undefined && Array.isArray(inspection.events) ? inspection.events : []
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      const header = event !== undefined && event !== null ? event.data && event.data.header : undefined
      const cfg = header !== undefined ? header.config : undefined
      if (event !== null && typeof event === 'object' && event.type === 'request/header'
        && cfg !== null && typeof cfg === 'object' && typeof cfg.provider === 'string' && typeof cfg.model === 'string') {
        return { provider: cfg.provider, model: cfg.model }
      }
    }
  } catch { /* resume with defaults */ }
  return undefined
}

function pushToAgent(agent, message) {
  if (agent === undefined || agent === null) return false
  try {
    if (typeof agent.status === 'string' && agent.status === 'running' && typeof agent.steer === 'function') {
      agent.steer(message)
      return true
    }
    if (typeof agent.followup === 'function') {
      agent.followup(message)
      return true
    }
  } catch { /* fall through */ }
  try {
    if (typeof agent.followup === 'function') {
      agent.followup(message)
      return true
    }
  } catch { /* fall through */ }
  return false
}

async function deliverTalk(target, wrapped, sender, fromName, wantWake) {
  const message = {
    id: nowId('m'),
    role: 'user',
    content: [{ type: 'text', text: wrapped }],
    source: sender && sender !== 'console'
      ? { kind: 'user', rpcId: nowId('rpc'), senderSessionId: sender }
      : { kind: 'user', rpcId: nowId('rpc') },
  }
  const agents = talkRuntime && talkRuntime.agents
  if (agents !== undefined && typeof agents.get === 'function') {
    const live = agents.get(target)
    if (pushToAgent(live, message)) return { delivered: 'live', messageId: message.id }
    if (wantWake === true && typeof agents.resume === 'function') {
      try {
        const agentOptions = await lastAgentOptions(target)
        await agents.resume({ resumeSessionId: target, ...(agentOptions !== undefined ? { agentOptions } : {}) })
        const resumed = agents.get(target)
        if (pushToAgent(resumed, message)) return { delivered: 'woken', messageId: message.id, agentOptions: agentOptions || null }
      } catch (error) {
        return { delivered: 'queued', messageId: message.id, error: String(error && error.message ? error.message : error) }
      }
    }
  }
  let mailboxId = null
  try { mailboxId = await enqueueMailbox(target, sender || 'console', fromName || '控制台', wrapped) } catch { mailboxId = null }
  return { delivered: mailboxId ? 'queued' : 'logged', messageId: message.id, mailboxId }
}

export async function talkSend({ from, to, text, wake, fromName, approved }) {
  const body = String(text ?? '').trim()
  if (body.length === 0) return { ok: false, error: '空消息' }
  const target = String(to ?? '').trim()
  const sender = String(from ?? '').trim()
  if (target === '') return { ok: false, error: '没有收件人' }
  const cfg = await loadProjects()
  const fromConsole = sender === 'console' || sender === ''
  if (!fromConsole) {
    const rel = talkRelation(cfg, sender, target)
    if (rel.kind !== 'same-team' && approved !== true) {
      const projectId = rel.project && rel.project.id ? rel.project.id : 'unknown'
      const pending = await enqueueInbox(projectId, {
        kind: rel.kind === 'cross-project' ? 'wake-cross-project' : 'wake-cross-team',
        title: rel.kind === 'cross-project' ? '跨项目互唤' : '跨队互唤',
        from: sender,
        to: target,
        text: body,
        wake: wake === true,
      })
      return { ok: true, queued: true, inboxId: pending.id, relation: rel.kind }
    }
  }
  // 控制台人点：默认唤醒。模型同队：显式 wake 才冷启动。
  const wantWake = fromConsole ? wake !== false : wake === true
  const wrapped = wrapTalk(fromConsole ? 'console' : sender, fromName, body)
  await mkdir(TALK_ROOT, { recursive: true })
  const row = { id: nowId('c'), ts: Date.now(), from: fromConsole ? 'console' : sender, to: target, text: body.slice(0, 4000), wake: wantWake }
  await appendJsonl(talkPath(row.from, target), row)
  const sent = await deliverTalk(target, wrapped, row.from, fromName || (fromConsole ? '控制台' : sender), wantWake)
  return {
    ok: true,
    delivered: sent.delivered,
    relation: fromConsole ? 'console' : 'same-team',
    approval: false,
    talkId: row.id,
    messageId: sent.messageId,
    mailboxId: sent.mailboxId || null,
    error: sent.error,
  }
}

export async function talkRead(from, to) {
  return { ok: true, posts: await readJsonl(talkPath(from, to), 100) }
}

function mergeKey(row) {
  return [row.kind, row.from || '', row.to || '', row.teamId || '', String(row.title || '')].join('|')
}

export async function enqueueInbox(projectId, item) {
  const pid = String(projectId || 'unknown')
  await mkdir(INBOX_ROOT, { recursive: true })
  const file = inboxPath(pid)
  const rows = await readJsonl(file, 400)
  const pending = rows.filter((r) => r && r.status === 'pending')
  const key = mergeKey(item)
  const twin = pending.find((r) => mergeKey(r) === key)
  if (twin) {
    twin.count = (twin.count || 1) + 1
    twin.ts = Date.now()
    if (item.text) twin.text = String(item.text).slice(0, 4000)
    await rewriteInbox(pid, rows)
    return twin
  }
  const windowed = pending.filter((r) => Date.now() - (r.ts || 0) < INBOX_WINDOW_MS)
  const hidden = windowed.length >= INBOX_BURST
  const row = {
    id: nowId('i'),
    ts: Date.now(),
    status: 'pending',
    hidden: hidden === true,
    count: 1,
    projectId: pid,
    kind: item.kind || 'notice',
    title: String(item.title || '待处理'),
    detail: String(item.detail || ''),
    from: item.from || '',
    to: item.to || '',
    text: item.text ? String(item.text).slice(0, 4000) : '',
    teamId: item.teamId || '',
    sessionId: item.sessionId || '',
    callId: item.callId || '',
    toolName: item.toolName || '',
    questions: Array.isArray(item.questions) ? item.questions : undefined,
    payload: item.payload && typeof item.payload === 'object' ? item.payload : undefined,
  }
  await appendJsonl(file, row)
  return row
}

async function rewriteInbox(projectId, rows) {
  const file = inboxPath(projectId)
  await mkdir(INBOX_ROOT, { recursive: true })
  await writeFile(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8')
}

export async function inboxList(projectId) {
  const pid = String(projectId || '')
  if (pid === '') {
    const cfg = await loadProjects()
    const all = []
    for (const p of cfg.projects || []) {
      const rows = await readJsonl(inboxPath(p.id), 400)
      for (const r of rows) all.push(r)
    }
    const pending = all.filter((r) => r && r.status === 'pending')
    return { ok: true, pending, hidden: pending.filter((r) => r.hidden === true).length, burst: INBOX_BURST, windowMs: INBOX_WINDOW_MS }
  }
  const rows = await readJsonl(inboxPath(pid), 400)
  const pending = rows.filter((r) => r && r.status === 'pending')
  return { ok: true, projectId: pid, pending, hidden: pending.filter((r) => r.hidden === true).length }
}

export async function inboxDecide({ id, allow, answers, actor }) {
  const cfg = await loadProjects()
  for (const p of cfg.projects || []) {
    const rows = await readJsonl(inboxPath(p.id), 400)
    const item = rows.find((r) => r && r.id === id)
    if (!item) continue
    item.status = allow === true ? 'allowed' : 'denied'
    item.decidedAt = Date.now()
    item.actor = actor || 'ui'
    if (answers) item.answers = answers
    await rewriteInbox(p.id, rows)
    if (allow === true) {
      if (item.kind === 'wake-cross-team' || item.kind === 'wake-cross-project') {
        await talkSend({ from: item.from, to: item.to, text: item.text || '（已批）', wake: true, fromName: item.from, approved: true })
      }
      if (item.kind === 'team-create' && item.payload) {
        const out = await createTeam({ ...item.payload, actor: 'approved-model' })
        item.result = out
      }
      if (item.kind === 'team-add' && item.payload) {
        const out = await addMember({ ...item.payload, actor: 'approved-model' })
        item.result = out
      }
    }
    await rewriteInbox(p.id, rows)
    return { ok: true, item }
  }
  return { ok: false, error: '没有这条待办' }
}

// WebUI 抢先答掉了一个已进收件箱的提问时调用：把那一行标记掉，
// 免得 console 一直挂着一条已经没人等的待办。不借用 allowed/denied 语义，另立一个状态。
export async function inboxSupersede({ id, actor }) {
  const cfg = await loadProjects()
  for (const p of cfg.projects || []) {
    const rows = await readJsonl(inboxPath(p.id), 400)
    const item = rows.find((r) => r && r.id === id)
    if (!item) continue
    if (item.status !== 'pending') return { ok: true, item }
    item.status = 'superseded'
    item.decidedAt = Date.now()
    item.actor = actor || 'webui'
    await rewriteInbox(p.id, rows)
    return { ok: true, item }
  }
  return { ok: false, error: '没有这条待办' }
}

export async function requestModelMutate(kind, payload, from) {
  const cfg = await loadProjects()
  const projectId = payload.projectId || (findTeam(cfg, payload.teamId)?.project.id) || 'unknown'
  return enqueueInbox(projectId, {
    kind,
    title: kind === 'team-create' ? '模型建队' : '模型加人',
    from,
    payload,
    teamId: payload.teamId || '',
  })
}

export function distillFileName(sessionId) {
  return 'distill-' + String(sessionId || '').replace(/^session-/, '').slice(0, 8) + '.md'
}

export async function distillExists(projectId, sessionId) {
  const file = distillFileName(sessionId)
  try {
    await readFile(join(DSH_HOME, 'project-memory', String(projectId || ''), file), 'utf8')
    return { ok: true, file }
  } catch {
    return { ok: false, file }
  }
}

export async function markStaleDistilled(projectId, stale) {
  const out = []
  for (const s of stale || []) {
    const hit = await distillExists(projectId, s && s.sessionId)
    out.push({ ...s, distilled: hit.ok === true, distillFile: hit.file })
  }
  return out
}

export async function distillStale({ teamId, sessionId, force }) {
  const cfg = await loadProjects()
  const hit = findTeam(cfg, teamId)
  if (!hit) return { ok: false, error: '没有这支队' }
  const sid = String(sessionId ?? '').trim()
  const stale = (hit.project.stale || []).find((s) => s.sessionId === sid)
  if (!stale) return { ok: false, error: '没有这条过时对话' }
  const post = hit.project.distillSessionId
  if (!post) {
    return {
      ok: false,
      needPost: true,
      error: '还没有蒸馏岗。先开一个 forge-team-distill 会话，再勾进这支队。',
    }
  }
  const existed = await distillExists(hit.project.id, sid)
  if (existed.ok === true && force !== true) {
    return { ok: true, already: true, file: existed.file, distillSessionId: post, projectId: hit.project.id }
  }
  const note = String(stale.note || sid)
  const file = existed.file
  if (existed.ok !== true) {
    const md = '# 蒸馏 ' + note + '\n\n来源会话 `' + sid + '`\n岗 `' + post + '`\n\n请蒸馏岗读该会话日志，把要点写进本文件。\n'
    const dir = join(DSH_HOME, 'project-memory', hit.project.id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, file), md, 'utf8')
  }
  const text = '请蒸馏过时对话 `' + sid + '`（' + note + '）。产物写到项目记忆 `' + file + '`。不要 spawn。'
  const sent = await talkSend({ from: 'console', to: post, text, fromName: '控制台', wake: true })
  return { ok: true, file, distillSessionId: post, projectId: hit.project.id, delivered: sent && sent.delivered }
}

export async function claimDistill({ projectId, sessionId }) {
  const sid = String(sessionId ?? '').trim()
  if (sid === '') return { ok: false, error: '必须已有蒸馏会话' }
  const fresh = await loadProjects()
  const p = (fresh.projects || []).find((x) => x && x.id === projectId)
  if (!p) return { ok: false, error: '没有这个项目' }
  p.distillSessionId = sid
  await saveProjects(fresh)
  return { ok: true, distillSessionId: sid, note: '项目蒸馏岗，不是队员' }
}

export { FORGE_TEAM_PRESETS, DEFAULT_WAKE, OPEN_TASK }

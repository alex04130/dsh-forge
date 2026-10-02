// PDA 组织真值：~/.dsh/projects.json。
//
// **2026-10-02 破坏性变更：存储层不再有 team 这个概念。**
// 项目自己就带着成员、看板与归档快照；原来的 `project.teams[]` 这一层被拍平。
//   - 存储形状（version 3）：{ id, name, cwds[], members[], tasks[], stale[],
//                              archived[], memory, wake, crossTeam, distillSessionId? }
//   - 旧形状（version 2）里每条 team 的 members/tasks/stale 在读取时**并集**进项目；
//     `archivedTeams[]` 并进项目的 `archived[]`。`saveProjects()` 一律写新形状，
//     所以**文件在第一次写的时候自然迁移**，不需要单独的迁移脚本。
//   - 工具层的措辞仍然是 team / 团队（模型看得见的名字不动），只是它底下操作的是项目。
//
// 对外仍导出「队形状」视图（teamView）：{ teamId, name, projectId, members, tasks, stale }，
// 且 **teamId === projectId**，这样 10 个既有消费者不必同时改。
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DSH_HOME, atomicWriteJson, errText } from './forge-common.mjs'

export const PROJECTS_PATH = join(DSH_HOME, 'projects.json')

/** 本文件写出的存储版本。v2 = 带 teams[] 的旧形状，v3 = 纯项目。 */
export const PROJECTS_VERSION = 3

export const DEFAULT_WAKE = { windowMs: 60000, perTarget: 3, projectTotal: 8 }

export function defaults() {
  return { version: PROJECTS_VERSION, projects: [] }
}

export function normalize(raw) {
  const base = defaults()
  if (raw === null || typeof raw !== 'object') return base
  const projects = Array.isArray(raw.projects) ? raw.projects.filter((p) => p !== null && typeof p === 'object' && typeof p.id === 'string' && p.id.length > 0) : []
  return { version: PROJECTS_VERSION, projects: projects.map(normalizeProject) }
}

function memberIdOf(m) {
  if (typeof m === 'string' && m.length > 0) return m
  if (m !== null && typeof m === 'object' && typeof m.sessionId === 'string' && m.sessionId.length > 0) return m.sessionId
  return ''
}

function normalizeMember(m) {
  if (typeof m === 'string' && m.length > 0) return { sessionId: m, memberId: m, role: '' }
  if (m === null || typeof m !== 'object') return null
  const sessionId = typeof m.sessionId === 'string' ? m.sessionId : ''
  if (sessionId === '') return null
  const preset = typeof m.preset === 'string' ? m.preset.trim() : ''
  return {
    sessionId,
    memberId: typeof m.memberId === 'string' && m.memberId.length > 0 ? m.memberId : sessionId,
    role: typeof m.role === 'string' ? m.role : '',
    ...(preset !== '' ? { preset } : {}),
  }
}

function normalizeTask(t) {
  if (t === null || typeof t !== 'object') return null
  const title = typeof t.title === 'string' ? t.title.trim() : ''
  if (title === '' && typeof t.id !== 'string') return null
  return {
    id: typeof t.id === 'string' && t.id.length > 0 ? t.id : '',
    title: title || t.id || '',
    status: typeof t.status === 'string' ? t.status : 'pending',
    assignee: typeof t.assignee === 'string' ? t.assignee : '',
    description: typeof t.description === 'string' ? t.description : '',
    output: typeof t.output === 'string' ? t.output : '',
  }
}

function normalizeStale(s) {
  if (s === null || typeof s !== 'object') return null
  const sessionId = typeof s.sessionId === 'string' ? s.sessionId : ''
  if (sessionId === '') return null
  return { sessionId, note: typeof s.note === 'string' ? s.note : '' }
}

function membersOf(raw) {
  return Array.isArray(raw) ? raw.map(normalizeMember).filter((m) => m !== null) : []
}

function tasksOf(raw) {
  return Array.isArray(raw) ? raw.map(normalizeTask).filter((x) => x !== null) : []
}

function staleOf(raw) {
  return Array.isArray(raw) ? raw.map(normalizeStale).filter((x) => x !== null) : []
}

/** 按 sessionId 去重的并集（旧文件里多条 team 可能有重叠成员）。 */
function unionMembers(lists) {
  const out = []
  const seen = new Set()
  for (const list of lists) {
    for (const m of list) {
      if (seen.has(m.sessionId)) continue
      seen.add(m.sessionId)
      out.push(m)
    }
  }
  return out
}

function unionBy(lists, keyOf) {
  const out = []
  const seen = new Set()
  for (const list of lists) {
    for (const x of list) {
      const key = keyOf(x)
      if (key !== '' && seen.has(key)) continue
      if (key !== '') seen.add(key)
      out.push(x)
    }
  }
  return out
}

/** 一个归档快照：归档时把当时的成员/看板整块存下来，项目本身清空以便重新开工。 */
function normalizeArchive(a) {
  if (a === null || typeof a !== 'object') return null
  const at = typeof a.at === 'string' ? a.at : ''
  return {
    at,
    name: typeof a.name === 'string' ? a.name : '',
    // captain / goal 属于这一轮团队，归档时必须跟着快照走，
    // 否则 restore 之后项目和"没开过队"没区别。
    ...(typeof a.captain === 'string' && a.captain.length > 0 ? { captain: a.captain } : {}),
    ...(typeof a.goal === 'string' && a.goal.length > 0 ? { goal: a.goal } : {}),
    members: membersOf(a.members),
    tasks: tasksOf(a.tasks),
    stale: staleOf(a.stale),
  }
}

function normalizeBudget(raw) {
  const wake = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    windowMs: Number.isFinite(wake.windowMs) && wake.windowMs > 0 ? wake.windowMs : DEFAULT_WAKE.windowMs,
    perTarget: Number.isFinite(wake.perTarget) && wake.perTarget > 0 ? wake.perTarget : DEFAULT_WAKE.perTarget,
    projectTotal: Number.isFinite(wake.projectTotal) && wake.projectTotal > 0 ? wake.projectTotal : DEFAULT_WAKE.projectTotal,
  }
}

function lampOfTasks(tasks) {
  const list = Array.isArray(tasks) ? tasks : []
  const open = list.some((t) => t && t.status !== 'completed' && t.status !== 'cancelled' && t.status !== 'failed')
  return open ? 'green' : 'gray'
}

/**
 * 拍平一条项目记录。旧形状（带 `teams[]`）在这里被并集成纯项目：
 * 多条 team 的 members / tasks / stale 各取并集，`archivedTeams[]` 并进 `archived[]`。
 * @param p - 原始记录，v2 或 v3 均可。
 * @returns v3 的项目记录。
 */
function normalizeProject(p) {
  const cwds = Array.isArray(p.cwds) ? p.cwds.filter((c) => typeof c === 'string' && c.length > 0) : []
  const legacyTeams = Array.isArray(p.teams) ? p.teams.filter((t) => t !== null && typeof t === 'object') : []

  // v3 的字段优先；缺失就从旧 teams[] 并集出来。
  const directMembers = membersOf(p.members)
  const directTasks = tasksOf(p.tasks)
  const directStale = staleOf(p.stale)
  const teamMembers = legacyTeams.map((t) => membersOf(t.members))
  const teamTasks = legacyTeams.map((t) => tasksOf(t.tasks))
  const teamStale = legacyTeams.map((t) => staleOf(t.stale))

  const members = directMembers.length > 0 ? directMembers : unionMembers(teamMembers)
  const tasks = directTasks.length > 0 ? directTasks : unionBy(teamTasks, (t) => t.id)
  const stale = directStale.length > 0 ? directStale : unionBy(teamStale, (s) => s.sessionId)

  const owned = new Set()
  for (const t of legacyTeams) {
    if (Array.isArray(t.ownedSessions)) for (const id of t.ownedSessions) if (typeof id === 'string' && id.length > 0) owned.add(id)
  }
  if (Array.isArray(p.ownedSessions)) for (const id of p.ownedSessions) if (typeof id === 'string' && id.length > 0) owned.add(id)

  const directArchived = Array.isArray(p.archived) ? p.archived.map(normalizeArchive).filter((a) => a !== null) : []
  const legacyArchived = Array.isArray(p.archivedTeams)
    ? p.archivedTeams.map((t) => (t === null || typeof t !== 'object' ? null : normalizeArchive({
      at: typeof t.at === 'string' ? t.at : '',
      name: typeof t.name === 'string' ? t.name : '',
      members: t.members,
      tasks: t.tasks,
      stale: t.stale,
    }))).filter((a) => a !== null)
    : []

  return {
    id: p.id,
    name: typeof p.name === 'string' && p.name.length > 0 ? p.name : p.id,
    cwds,
    memory: typeof p.memory === 'string' && p.memory.length > 0 ? p.memory : ('project-memory/' + p.id + '/README.md'),
    wake: normalizeBudget(p.wake),
    crossTeam: normalizeBudget(p.crossTeam || p.wake),
    ...(typeof p.distillSessionId === 'string' && p.distillSessionId.length > 0 ? { distillSessionId: p.distillSessionId } : {}),
    ...(typeof p.captain === 'string' && p.captain.length > 0 ? { captain: p.captain } : {}),
    ...(typeof p.goal === 'string' && p.goal.length > 0 ? { goal: p.goal } : {}),
    // 两级归档（用户 2026-10-02）：
    //   project.archived    = 归档的**团队轮次**（在内层点归档 = 归档当前全部队员）
    //   project.archivedAt  = **项目**已归档（在外层点归档 = 归档整个项目）
    // 两个位置同一个词，靠 UI 所在层级区分含义。
    ...(typeof p.archivedAt === 'string' && p.archivedAt.length > 0 ? { archivedAt: p.archivedAt } : {}),
    members,
    tasks,
    stale,
    ...(owned.size > 0 ? { ownedSessions: [...owned] } : {}),
    archived: directArchived.length > 0 ? directArchived : legacyArchived,
  }
}

/**
 * 未登记 cwd 的隐式项目（无成员、无看板）。id 形如 `cwd:<绝对路径>`。
 * @param cwd - 该会话的工作目录。
 * @returns 项目记录，`implicit: true`。
 */
export function implicitProject(cwd) {
  const path = typeof cwd === 'string' && cwd.length > 0 ? cwd : '(unknown)'
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  const name = parts.length > 0 ? parts[parts.length - 1] : path
  return {
    id: 'cwd:' + path,
    name,
    cwds: path === '(unknown)' ? [] : [path],
    memory: '',
    wake: { ...DEFAULT_WAKE },
    crossTeam: { ...DEFAULT_WAKE },
    members: [],
    tasks: [],
    stale: [],
    archived: [],
    implicit: true,
  }
}

export function matchCwd(project, cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return false
  const needle = cwd.replace(/\\/g, '/')
  for (const raw of project.cwds) {
    const root = String(raw).replace(/\\/g, '/')
    if (needle === root) return true
    if (needle.startsWith(root.endsWith('/') ? root : root + '/')) return true
  }
  return false
}

/**
 * 项目成员的并集视图。旧形状的 `teams[]` 已由 normalize 拍平，这里只读项目自己的 members；
 * 仍带旧形状兜底，便于直接喂未 normalize 的原始记录。
 * @param project - 项目记录（v3，或未拍平的 v2）。
 * @returns 成员数组。
 */
export function allTeamMembers(project) {
  const direct = Array.isArray(project?.members) ? project.members : []
  if (direct.length > 0) return direct
  const out = []
  for (const team of Array.isArray(project?.teams) ? project.teams : []) {
    for (const m of Array.isArray(team.members) ? team.members : []) out.push(m)
  }
  return out
}

/** 项目 → 「队形状」视图（teamId === projectId，消费者不必改）。 */
export function teamView(project) {
  if (project === null || project === undefined) return null
  const members = allTeamMembers(project)
  const tasks = Array.isArray(project.tasks) ? project.tasks : []
  const stale = Array.isArray(project.stale) ? project.stale : []
  const owned = Array.isArray(project.ownedSessions) ? project.ownedSessions : []
  return {
    teamId: project.id,
    name: project.name,
    projectId: project.id,
    members,
    tasks,
    stale,
    ...(owned.length > 0 ? { ownedSessions: owned } : {}),
    archived: Array.isArray(project.archived) ? project.archived : [],
  }
}

export function projectOf(cfg, { sessionId, cwd } = {}) {
  const projects = cfg && Array.isArray(cfg.projects) ? cfg.projects : []
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    const byMember = projects.find((p) => allTeamMembers(p).some((m) => memberIdOf(m) === sessionId))
    if (byMember !== undefined) return byMember
  }
  if (typeof cwd === 'string' && cwd.length > 0) {
    const byCwd = projects.find((p) => matchCwd(p, cwd))
    if (byCwd !== undefined) return byCwd
  }
  return implicitProject(cwd)
}

export function sameProject(cfg, a, b) {
  const pa = projectOf(cfg, a)
  const pb = projectOf(cfg, b)
  if (pa.id === pb.id) return true
  if (typeof a.cwd === 'string' && a.cwd.length > 0 && typeof b.cwd === 'string' && b.cwd.length > 0) {
    return a.cwd.replace(/\\/g, '/') === b.cwd.replace(/\\/g, '/')
  }
  return false
}

/**
 * 两个会话是否同属一个项目。team 与 project 已合并，所以这与 {@link sameProject} 同义，
 * 保留独立导出只为让调用点的意图读起来更清楚。
 */
export function sameTeam(cfg, a, b) {
  const idA = typeof a?.sessionId === 'string' ? a.sessionId : ''
  const idB = typeof b?.sessionId === 'string' ? b.sessionId : ''
  if (idA === '' || idB === '') return false
  const projects = cfg && Array.isArray(cfg.projects) ? cfg.projects : []
  const holder = projects.find((p) => allTeamMembers(p).some((m) => memberIdOf(m) === idA))
  if (holder === undefined) return false
  return allTeamMembers(holder).some((m) => memberIdOf(m) === idB)
}

/**
 * 按 id 找项目。**teamId 就是 projectId，唯一。**
 *
 * 破坏性变更：旧文件里的 `teamId`（形如 `team-xxxx`）**不再可解析**。
 * normalize 已经把 `teams[]` 拍平丢掉，所以这里没有、也不该有旧 id 兜底。
 * 迁移指引见 docs/MIGRATION-projects-v3.md。
 * @param cfg - 已 normalize 的配置。
 * @param teamId - projectId。
 * @returns `{ project, team }`，找不到为 null。
 */
export function findTeam(cfg, teamId) {
  const id = String(teamId ?? '')
  if (id === '') return null
  const projects = cfg && Array.isArray(cfg.projects) ? cfg.projects : []
  for (const p of projects) {
    if (p.id === id) return { project: p, team: teamView(p) }
  }
  return null
}

let cached = null
let cachedAt = 0

/** 上一次 loadProjects() 读文件出的事；null 表示正常。"文件不存在"不算错。 */
let loadError = null

/**
 * 上一次读 projects.json 出的错（文件坏掉 / 读不动），正常时为 null。
 * 调用方**必须**在"找不到项目"时把它一起报出去 —— 否则
 * "文件坏了"会被说成"没有项目"，让人往完全错的方向查（2026-10-02 实际踩过）。
 * @returns 错误文本，或 null。
 */
export function projectsLoadError() { return loadError }

export async function loadProjects() {
  const now = Date.now()
  if (cached !== null && now - cachedAt < 1000) return cached

  let text
  try {
    text = await readFile(PROJECTS_PATH, 'utf8')
  } catch (error) {
    // 文件还不存在是**正常状态**（第一次用 forge 项目功能），不是错误。
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
      loadError = null
      cached = defaults(); cachedAt = now
      return cached
    }
    loadError = '读不到 ' + PROJECTS_PATH + '：' + errText(error)
    console.error('[forge/projects] ' + loadError)
    cached = defaults(); cachedAt = now
    return cached
  }

  try {
    // 编辑器可能带 BOM 存 UTF-8；JSON.parse 不接受它，而报出来的错会是莫名其妙的
    // "Unexpected token '\uFEFF'"。先剥掉 —— 这是合法文件，不是坏文件。
    cached = normalize(JSON.parse(text.replace(/^\uFEFF/, '')))
    loadError = null
  } catch (error) {
    // 文件在、但解析不了 —— **绝不静默**：这是坏文件，不是"没有项目"。
    loadError = PROJECTS_PATH + ' 解析失败：' + errText(error)
    console.error('[forge/projects] ' + loadError
      + ' —— 已按"没有项目"继续，但这不是正常状态，请修好这个文件或删掉它。')
    cached = defaults()
  }
  cachedAt = now
  return cached
}

/**
 * 写回 projects.json。**写出去的一定是 v3（无 teams[]）**，
 * 所以旧文件在第一次写的时候自然完成迁移。
 * @param cfg - 要写的配置；会先 normalize。
 * @returns 写出的（已拍平的）配置。
 */
export async function saveProjects(cfg) {
  const next = normalize(cfg)
  await atomicWriteJson(PROJECTS_PATH, next)
  cached = next
  cachedAt = Date.now()
  return next
}

/** 看板彩灯：有未完成任务即绿，否则灰；extra 可把它拉高到黄/红。 */
export function lampOfTeam(team, extra) {
  const base = lampOfTasks(team !== null && typeof team === 'object' ? team.tasks : undefined)
  if (extra === 'red') return 'red'
  if (extra === 'yellow' && base !== 'green') return 'yellow'
  if (extra === 'yellow') return 'green'
  return base
}

export const FORGE_TEAM_PRESETS = ['forge-team', 'forge-team-creative', 'forge-team-distill']

export function isForgeTeamPreset(id) {
  return FORGE_TEAM_PRESETS.includes(String(id || ''))
}

/**
 * 会话归属的项目。成员表优先；其次是显式 stale / owned 记录
 * （用户 2026-09-12 裁定：cwd 不能决定归属）。
 * @param cfg - 已 normalize 的配置。
 * @param sessionId - 会话 id。
 * @returns `{ project, team }`，无归属为 null。
 */
export function teamOfSession(cfg, sessionId) {
  const id = String(sessionId ?? '')
  if (id === '') return null
  const projects = cfg && Array.isArray(cfg.projects) ? cfg.projects : []
  for (const p of projects) {
    if (allTeamMembers(p).some((m) => memberIdOf(m) === id)) return { project: p, team: teamView(p) }
  }
  for (const p of projects) {
    const stale = Array.isArray(p.stale) ? p.stale : []
    if (stale.some((s) => s !== null && typeof s === 'object' && s.sessionId === id)) return { project: p, team: teamView(p) }
    const owned = Array.isArray(p.ownedSessions) ? p.ownedSessions : []
    if (owned.includes(id)) return { project: p, team: teamView(p) }
  }
  return null
}

export function seedFromCwds(cwds) {
  const seen = new Set()
  const projects = []
  for (const cwd of cwds) {
    if (typeof cwd !== 'string' || cwd.length === 0) continue
    const norm = cwd.replace(/\\/g, '/')
    if (seen.has(norm)) continue
    seen.add(norm)
    const parts = norm.split('/').filter(Boolean)
    const name = parts.length > 0 ? parts[parts.length - 1] : norm
    const id = 'p-' + name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
    projects.push({
      id: id.length > 0 ? id : ('p-' + String(projects.length + 1)),
      name,
      cwds: [cwd],
      memory: 'project-memory/' + (id.length > 0 ? id : 'p-x') + '/README.md',
      wake: { ...DEFAULT_WAKE },
      crossTeam: { ...DEFAULT_WAKE },
      members: [],
      tasks: [],
      stale: [],
      archived: [],
    })
  }
  return { version: PROJECTS_VERSION, projects }
}

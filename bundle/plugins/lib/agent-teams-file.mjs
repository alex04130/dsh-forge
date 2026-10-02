// 组织读面（T8）：真值仅 ~/.dsh/projects.json（项目 + teams[]）。
// 不 kv.open。agent_teams.json 已废。
import { readFile, writeFile, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { DSH_HOME } from './forge-common.mjs'
// 本模块自己导出 teamView()，所以项目侧那个同名视图必须换名进来。
import { loadProjects, saveProjects, findTeam, lampOfTeam, teamView as projectTeamView } from './projects.mjs'
import { teamLampExtra, inboxHasOpen, archiveTeam, markStaleDistilled } from './team-org.r2.mjs'

const MEMORY_ROOT = join(DSH_HOME, 'project-memory')

function memberView(m) {
  return {
    memberId: m.memberId,
    role: m.role || '',
    sessionId: m.sessionId,
    preset: m.preset || '',
    lamp: 'gray',
  }
}

function teamCard(project, team, extraLamp) {
  const tasks = Array.isArray(team.tasks) ? team.tasks : []
  const members = Array.isArray(team.members) ? team.members : []
  return {
    teamId: team.teamId,
    name: team.name,
    projectId: project.id,
    projectName: project.name,
    distillSessionId: project.distillSessionId || '',
    memberCount: members.length,
    taskCount: tasks.length,
    lamp: lampOfTeam(team, extraLamp),
    members: members.map(memberView),
    tasks,
    stale: Array.isArray(team.stale) ? team.stale : [],
  }
}

/**
 * 一个项目只有一支团队（2026-10-02 team/project 合并）。没有成员也没有看板 = 还没开队，
 * 返回空数组，让界面能区分"还没建队"和"有队伍"。
 * @param p - 项目记录。
 * @param extraLamp - teamLampExtra 的结果。
 * @returns 卡片数组，长度 0 或 1。
 */
function teamCardsOf(p, extraLamp) {
  const members = Array.isArray(p.members) ? p.members : []
  const tasks = Array.isArray(p.tasks) ? p.tasks : []
  if (members.length === 0 && tasks.length === 0 && typeof p.captain !== 'string') return []
  return [teamCard(p, projectTeamView(p), extraLamp)]
}

function summaryOf(text, skipTitle) {
  const lines = String(text || '').split('\n')
  let skipped = false
  for (const ln of lines) {
    const raw = ln.trim()
    if (!raw) continue
    const s = raw.replace(/^#+\s*/, '').trim()
    if (!s) continue
    if (skipTitle && /^#+\s/.test(raw) && !skipped) { skipped = true; continue }
    return s.slice(0, 80)
  }
  return ''
}

function safeMemoryName(name) {
  const s = String(name ?? '').replace(/\\/g, '/')
  if (s === '' || s.includes('..') || s.includes('/') || s.includes('\0')) return ''
  return s
}

function memoryDir(projectId) {
  return join(DSH_HOME, 'project-memory', String(projectId || ''))
}

async function readmeSummary(projectId) {
  try {
    const text = await readFile(join(memoryDir(projectId), 'README.md'), 'utf8')
    return summaryOf(text, true)
  } catch {
    return ''
  }
}

export async function projectCards() {
  const cfg = await loadProjects()
  const projects = []
  for (const p of cfg.projects || []) {
    const extra = await teamLampExtra(p.id)
    const teams = teamCardsOf(p, extra)
    const lamps = teams.map((t) => t.lamp)
    projects.push({
      id: p.id,
      name: p.name,
      path: Array.isArray(p.cwds) && p.cwds[0] ? p.cwds[0] : p.id,
      memory: p.memory || '',
      summary: await readmeSummary(p.id),
      distillSessionId: p.distillSessionId || '',
      teamCount: teams.length,
      lamp: lamps.includes('green') ? 'green' : lamps.includes('yellow') ? 'yellow' : lamps.includes('red') ? 'red' : extra === 'yellow' || extra === 'red' ? extra : 'gray',
      teams,
      archivedTeams: (p.archived || []).map((a, i) => ({
        teamId: p.id,
        round: i + 1,
        at: a.at || '',
        name: a.name || '',
        memberCount: Array.isArray(a.members) ? a.members.length : 0,
      })),
      wake: p.wake,
    })
  }
  return { ok: true, source: 'projects.json', projects }
}

export async function teamView(want) {
  const cfg = await loadProjects()
  const q = typeof want === 'string' ? want : ''
  if (q === '') {
    const all = []
    for (const p of cfg.projects || []) {
      const extra = await teamLampExtra(p.id)
      for (const c of teamCardsOf(p, extra)) all.push(c)
    }
    return { ok: true, teams: all }
  }
  const hit = findTeam(cfg, q)
  if (hit) {
    const extra = await teamLampExtra(hit.project.id)
    const card = teamCard(hit.project, hit.team, extra)
    card.stale = await markStaleDistilled(hit.project.id, card.stale)
    return {
      ok: true,
      project: { id: hit.project.id, name: hit.project.name, memory: hit.project.memory, distillSessionId: hit.project.distillSessionId || '' },
      team: card,
      teams: [card],
      inboxOpen: await inboxHasOpen(hit.project.id),
    }
  }
  const project = (cfg.projects || []).find((p) => p && (p.id === q || p.name === q)) || null
  if (!project) return { ok: true, project: null, teams: [] }
  const extra = await teamLampExtra(project.id)
  return {
    ok: true,
    project: { id: project.id, name: project.name, memory: project.memory, distillSessionId: project.distillSessionId || '' },
    teams: teamCardsOf(project, extra),
  }
}

export async function archiveLiveTeam(teamId) {
  // 历史名。归档 = 移入 project.archived[] 可捞回，不是从 JSON 抹掉。
  return archiveTeam(teamId)
}

export async function readProjectMemory(projectId, fileName) {
  const cfg = await loadProjects()
  const project = (cfg.projects || []).find((p) => p && p.id === projectId)
  if (!project) return { ok: false, error: '没有这个项目' }
  const dir = memoryDir(project.id)
  const want = safeMemoryName(fileName)
  if (want !== '') {
    let text = ''
    try { text = await readFile(join(dir, want), 'utf8') } catch { text = '' }
    return { ok: true, projectId: project.id, name: project.name, file: want, text }
  }
  let files = []
  try {
    const names = await readdir(dir)
    for (const name of names) {
      if (!name || name.startsWith('.')) continue
      if (safeMemoryName(name) === '') continue
      try {
        const st = await stat(join(dir, name))
        if (st.isFile()) files.push({ name, bytes: st.size, mtime: st.mtimeMs })
      } catch { /* skip */ }
    }
  } catch { files = [] }
  files.sort((a, b) => (a.name === 'README.md' ? -1 : b.name === 'README.md' ? 1 : a.name.localeCompare(b.name)))
  let readme = ''
  try { readme = await readFile(join(dir, 'README.md'), 'utf8') } catch { readme = '' }
  return { ok: true, projectId: project.id, name: project.name, files, summary: summaryOf(readme, true), readme }
}

export async function writeProjectMemory(projectId, text, fileName) {
  const cfg = await loadProjects()
  const project = (cfg.projects || []).find((p) => p && p.id === projectId)
  if (!project) return { ok: false, error: '没有这个项目' }
  const name = safeMemoryName(fileName) || 'README.md'
  const file = join(memoryDir(project.id), name)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, String(text ?? ''), 'utf8')
  return { ok: true, projectId: project.id, file: name }
}

export async function deleteProjectMemory(projectId, fileName) {
  const cfg = await loadProjects()
  const project = (cfg.projects || []).find((p) => p && p.id === projectId)
  if (!project) return { ok: false, error: '没有这个项目' }
  const name = safeMemoryName(fileName)
  if (name === '') return { ok: false, error: '文件名不对' }
  if (name === 'README.md') return { ok: false, error: '引导文件不能删' }
  try { await unlink(join(memoryDir(project.id), name)) } catch (e) {
    return { ok: false, error: '没有这个文件' }
  }
  return { ok: true, projectId: project.id, file: name }
}

export { MEMORY_ROOT }

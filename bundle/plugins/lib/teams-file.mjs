// T8b：teamhub 文件面适配。禁止 kv.open('agent_teams')（句柄独占）。
// 组织真值 = projects.json；模板 = team-templates/；队内离线信 = agent_mailbox.json。
import { readdir, readFile, unlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DSH_HOME, atomicWriteJson } from './forge-common.mjs'
import { loadProjects, saveProjects, teamOfSession, findTeam, teamView as projectTeamView, projectsLoadError } from './projects.mjs'
import { archiveTeam } from './team-org.mjs'

const TPL_ROOT = join(DSH_HOME, 'team-templates')
const MAIL = join(DSH_HOME, 'storages', 'team_mail.json')

function legacyFromHit(hit) {
  const team = hit.team
  const members = Array.isArray(team.members) ? team.members : []
  const captain = (members[0] && members[0].sessionId)
    || (typeof hit.project.captain === 'string' && hit.project.captain.length > 0 ? hit.project.captain : '')
    || team.teamId
  return {
    teamId: team.teamId,
    name: team.name,
    goal: typeof hit.project.goal === 'string' ? hit.project.goal : '',
    captain,
    members: members.map((m) => ({
      id: m.memberId || m.sessionId,
      sessionId: m.sessionId,
      role: m.role || '',
      existing: true,
      createdAt: 0,
      preset: m.preset,
    })),
    tasks: Array.isArray(team.tasks) ? team.tasks : [],
    nextTask: (Array.isArray(team.tasks) ? team.tasks.length : 0) + 1,
    createdAt: 0,
    projectId: hit.project.id,
  }
}

async function readMailbox() {
  try {
    const store = JSON.parse(await readFile(MAIL, 'utf8'))
    const table = store && store.tables && store.tables.msg && typeof store.tables.msg === 'object' ? store.tables.msg : {}
    return { store, table }
  } catch {
    return { store: { unit: { name: 'agent_mailbox', version: 0 }, global: null, tables: { msg: {} } }, table: {} }
  }
}

async function readTemplates() {
  const template = {}
  try {
    const files = await readdir(TPL_ROOT)
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      try {
        const rec = JSON.parse(await readFile(join(TPL_ROOT, f), 'utf8'))
        if (rec && typeof rec === 'object' && typeof rec.templateId === 'string') template[rec.templateId] = rec
      } catch { /* skip */ }
    }
  } catch { /* missing dir */ }
  return template
}

export function openTeamsFile() {
  return {
    async loadAll() {
      const cfg = await loadProjects()
      const team = {}
      const archive = {}
      for (const p of cfg.projects || []) {
        // 一个项目只有一支团队（2026-10-02 合并）：开过队的项目才进 team 表。
        const members = Array.isArray(p.members) ? p.members : []
        const tasks = Array.isArray(p.tasks) ? p.tasks : []
        // 有 captain 就算开过队 —— 零成员的队也必须可见，否则 forge_team_create 的
        // 「你已经带了一支队」那道闸会失效，可以反复建空队。
        if (members.length > 0 || tasks.length > 0 || (typeof p.captain === 'string' && p.captain.length > 0)) {
          const rec = legacyFromHit({ project: p, team: projectTeamView(p) })
          if (rec.captain) team[rec.captain] = rec
        }
        // 归档表按"轮次"出条目；键是 projectId#轮次（restore 只恢复最近一轮）。
        for (const [i, round] of (Array.isArray(p.archived) ? p.archived : []).entries()) {
          const key = p.id + '#' + String(i + 1)
          const snap = { teamId: p.id, name: round.name || p.name, members: round.members, tasks: round.tasks, stale: [] }
          archive[key] = { ...legacyFromHit({ project: p, team: snap }), round: i + 1, archivedAt: round.at || '' }
        }
      }
      const { table } = await readMailbox()
      const template = await readTemplates()
      return { tables: { team, archive, mail: table, template } }
    },

    async putRecord(table, key, record) {
      if (table === 'template') {
        await mkdir(TPL_ROOT, { recursive: true })
        const id = String(record && record.templateId ? record.templateId : key)
        await atomicWriteJson(join(TPL_ROOT, id + '.json'), { ...record, templateId: id })
        return
      }
      if (table === 'mail') {
        const { store, table: msg } = await readMailbox()
        msg[String(key)] = record
        store.tables.msg = msg
        await atomicWriteJson(MAIL, store)
        return
      }
      if (table === 'archive') {
        const teamId = record && record.teamId ? record.teamId : key
        await archiveTeam(teamId)
        return
      }
      if (table === 'team') {
        const cfg = await loadProjects()
        const teamId = record && record.teamId ? record.teamId : ''
        const hit = teamId ? findTeam(cfg, teamId) : teamOfSession(cfg, key)
        const memberList = (record.members || []).map((m) => ({
          sessionId: m.sessionId,
          memberId: m.id || m.sessionId,
          role: m.role || '',
          ...(m.preset ? { preset: m.preset } : {}),
        }))
        if (!hit) {
          // 新建：挂到调用方所在项目，否则挂 dsh-forge
          const byCaller = teamOfSession(cfg, key)
          const project = byCaller ? byCaller.project : (cfg.projects || []).find((p) => p.id === 'p-dsh-forge') || (cfg.projects || [])[0]
          if (!project) {
            // 别把"文件坏了"说成"没有项目" —— 那会把人引到完全错的方向。
            const why = projectsLoadError()
            throw new Error(why !== null
              ? 'projects.json 读不出来，所以挂不上团队：' + why
              : 'projects.json 里一个项目都没有，挂不上团队；先建一个项目')
          }
          project.name = record.name || project.name
          project.captain = record.captain || project.captain
          project.goal = record.goal || project.goal
          project.members = memberList
          project.tasks = Array.isArray(record.tasks) ? record.tasks : []
          project.stale = []
          await saveProjects(cfg)
          return
        }
        hit.project.name = record.name || hit.project.name
        hit.project.captain = record.captain || hit.project.captain
        hit.project.goal = record.goal || hit.project.goal
        hit.project.members = memberList
        if (Array.isArray(record.tasks)) hit.project.tasks = record.tasks
        await saveProjects(cfg)
        return
      }
    },

    async deleteRecord(table, key) {
      if (table === 'template') {
        try { await unlink(join(TPL_ROOT, String(key) + '.json')) } catch { /* missing */ }
        return
      }
      if (table === 'mail') {
        const { store, table: msg } = await readMailbox()
        delete msg[String(key)]
        store.tables.msg = msg
        await atomicWriteJson(MAIL, store)
        return
      }
      if (table === 'team') {
        const cfg = await loadProjects()
        const hit = teamOfSession(cfg, key) || findTeam(cfg, key)
        if (hit) await archiveTeam(hit.project.id)
      }
    },

    close() { /* file unit: nothing to close */ },
  }
}

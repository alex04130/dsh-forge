/**
 * Offline harness for the team→project merge (`projects.json` v2 → v3).
 *
 * Runs against a THROWAWAY `DSH_HOME` so it never touches the real
 * `~/.dsh/projects.json`. Set the env var before the dynamic imports below,
 * because `forge-common.mjs` resolves `DSH_HOME` at module-load time.
 *
 *   node tests/projects-v3/driver.mjs
 *
 * No network, no Codex, no browser, no running DSH.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-projv3-'))
process.env.DSH_HOME = HOME

const LIB = pathToFileURL(join(process.cwd(), 'bundle/plugins/lib')).href
const P = await import(LIB + '/projects.mjs')
const Org = await import(LIB + '/team-org.r2.mjs')

let pass = 0
const fails = []
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log('  ok   ' + label) }
  else { fails.push(label + (extra === undefined ? '' : '  → ' + extra)); console.log('  FAIL ' + label + (extra === undefined ? '' : '  → ' + extra)) }
}
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want))

// ── 1. 拍平：v2 两支队 → 纯项目 ──────────────────────────────────────────────
console.log('[1] v2 多队拍平')
const v2 = {
  version: 2,
  projects: [{
    id: 'p-x', name: 'X', cwds: ['/a', '/b'],
    teams: [
      { teamId: 'team-1', name: 'A', projectId: 'p-x', members: [{ sessionId: 's1', role: 'r1' }], tasks: [{ id: 't1', title: 'T1', status: 'pending' }], stale: [] },
      { teamId: 'team-2', name: 'B', projectId: 'p-x', members: [{ sessionId: 's1' }, { sessionId: 's2' }], tasks: [{ id: 't1', title: 'dup' }, { id: 't2', title: 'T2' }], stale: [{ sessionId: 's9', note: 'n' }], ownedSessions: ['o1'] },
    ],
    archivedTeams: [{ teamId: 'team-0', name: 'old', members: [{ sessionId: 's0' }], tasks: [] }],
  }],
}
const n = P.normalize(v2)
const p = n.projects[0]
eq('version → 3', n.version, 3)
ok('输出里没有 teams 字段', !('teams' in p))
eq('members 按 sessionId 去重并集', p.members.map((m) => m.sessionId), ['s1', 's2'])
eq('tasks 按 id 去重并集', p.tasks.map((t) => t.id), ['t1', 't2'])
eq('stale 并集', p.stale.map((s) => s.sessionId), ['s9'])
eq('ownedSessions 并集', p.ownedSessions, ['o1'])
eq('archivedTeams → archived', p.archived.length, 1)
eq('归档快照保留成员', p.archived[0].members.map((m) => m.sessionId), ['s0'])
ok('归档快照带 at', typeof p.archived[0].at === 'string')

// ── 2. 项目自己那份赢 ────────────────────────────────────────────────────────
console.log('[2] 项目已有 members 时以项目为准')
const n2 = P.normalize({ version: 2, projects: [{ id: 'p-y', members: [{ sessionId: 'own' }], tasks: [], stale: [], teams: [{ teamId: 't', members: [{ sessionId: 'legacy' }], tasks: [] }] }] })
eq('项目自己的 members 赢', n2.projects[0].members.map((m) => m.sessionId), ['own'])

// ── 3. 幂等 + v3 直通 ────────────────────────────────────────────────────────
console.log('[3] 幂等与 v3 直通')
eq('normalize 幂等', P.normalize(n), n)
const n3 = P.normalize({ version: 3, projects: [{ id: 'p-z', name: 'Z', cwds: [], members: [{ sessionId: 'z1' }], tasks: [], stale: [], archived: [] }] })
eq('v3 原样通过', n3.projects[0].members.map((m) => m.sessionId), ['z1'])

// ── 4. 队形状视图：teamId === projectId ──────────────────────────────────────
console.log('[4] teamView 契约（消费者零改动的依据）')
const v = P.teamView(p)
eq('teamId === projectId', v.teamId, p.id)
eq('projectId', v.projectId, 'p-x')
eq('name 取自项目', v.name, 'X')
eq('findTeam(projectId) 命中', P.findTeam(n, 'p-x') !== null, true)
eq('findTeam(旧 teamId) 不再命中（破坏性变更）', P.findTeam(n, 'team-2'), null)
eq('teamOfSession 按成员命中', P.teamOfSession(n, 's2') !== null, true)
eq('teamOfSession 按 stale 命中', P.teamOfSession(n, 's9') !== null, true)
eq('teamOfSession 按 owned 命中', P.teamOfSession(n, 'o1') !== null, true)
eq('allTeamMembers', P.allTeamMembers(p).length, 2)
eq('lampOfTeam 有未完成任务 → green', P.lampOfTeam(v), 'green')
eq('lampOfTeam extra=red', P.lampOfTeam(v, 'red'), 'red')

// ── 5. 读写往返（临时 DSH_HOME，不碰真文件） ─────────────────────────────────
console.log('[5] 写出去的一定是 v3')
const cfgPath = join(HOME, 'projects.json')
writeFileSync(cfgPath, JSON.stringify(v2), 'utf8')
const loaded = await P.loadProjects()
const saved = await P.saveProjects(loaded)
const onDisk = JSON.parse(readFileSync(cfgPath, 'utf8'))
eq('落盘 version', onDisk.version, 3)
ok('落盘没有 teams 字段', !('teams' in onDisk.projects[0]))
ok('落盘没有 archivedTeams 字段', !('archivedTeams' in onDisk.projects[0]))
eq('saveProjects 返回值 == 磁盘内容', saved, onDisk)

// ── 6. team-org 的写面全落项目 ───────────────────────────────────────────────
console.log('[6] createTeam / archiveTeam / restoreTeam 落项目')
const proj = (id) => JSON.parse(readFileSync(cfgPath, 'utf8')).projects.find((x) => x && x.id === id)

// p-x 拍平后自带成员，正是"已有团队"的那种项目 —— createTeam 必须拒绝它。
const refused = await Org.createTeam({ projectId: 'p-x', name: 'again', members: [], actor: 'test' })
eq('已有团队的项目拒绝再建', refused.ok, false)

// 建一个真正的空项目来做写面测试。
const base = await P.loadProjects()
base.projects.push({
  id: 'p-empty', name: '空项目', cwds: [], memory: '',
  wake: { ...P.DEFAULT_WAKE }, crossTeam: { ...P.DEFAULT_WAKE },
  members: [], tasks: [], stale: [], archived: [],
})
await P.saveProjects(base)

const created = await Org.createTeam({
  projectId: 'p-empty',
  name: 'Y-round',
  members: [{ sessionId: 'm1', memberId: 'me', role: '队长', preset: 'forge-team' }, { sessionId: 'm2', memberId: 'bot', role: '审查', preset: 'forge-team' }],
  actor: 'test',
})
eq('createTeam ok', created.ok, true)
ok('落盘没有 teams 字段（createTeam）', !('teams' in proj('p-empty')))
eq('空项目拿到 2 名成员', proj('p-empty').members.length, 2)
eq('队名落到项目名', proj('p-empty').name, 'Y-round')

const archived = await Org.archiveTeam('p-empty')
eq('archiveTeam ok', archived.ok, true)
eq('返回轮次号', archived.round, 1)
eq('成员已清空', proj('p-empty').members.length, 0)
eq('看板已清空', proj('p-empty').tasks.length, 0)
eq('归档轮次 +1', proj('p-empty').archived.length, 1)
eq('快照保留了那 2 名成员', proj('p-empty').archived[0].members.length, 2)
// captain / goal 是"这一轮开过队"的唯一标记，归档必须一起清掉 ——
// 活实例回归第 5 条撞到的就是没清：归档后 forge_team_create 永远回
// "you already lead team"，于是「归档当前队员、开新一轮」走不通。
ok('归档后 captain 已清掉', !('captain' in proj('p-empty')))
ok('归档后 goal 已清掉', !('goal' in proj('p-empty')))
ok('快照里留住了 captain', typeof proj('p-empty').archived[0].captain === 'string')

const round2 = await Org.createTeam({
  projectId: 'p-empty',
  name: 'round-2',
  members: [{ sessionId: 'm3', memberId: 'r2', role: '队员', preset: 'forge-team' }],
  actor: 'test',
})
eq('归档后能开第二轮', round2.ok, true)
eq('第二轮只有 1 名成员', proj('p-empty').members.length, 1)

const again = await Org.createTeam({ projectId: 'p-empty', name: 'nope', members: [], actor: 'test' })
eq('第二轮在跑时仍然拒绝再建', again.ok, false)

const archived2 = await Org.archiveTeam('p-empty')
eq('第二轮归档 ok', archived2.ok, true)
eq('归档轮次到 2', proj('p-empty').archived.length, 2)
ok('第二轮归档后 captain 又清掉', !('captain' in proj('p-empty')))

const restored = await Org.restoreTeam('p-empty')
eq('restoreTeam ok', restored.ok, true)
eq('恢复的是第二轮', proj('p-empty').members.length, 1)
eq('归档轮次 -1', proj('p-empty').archived.length, 1)
ok('captain 随快照还回来', typeof proj('p-empty').captain === 'string')

const task = await Org.writeTask({ teamId: 'p-empty', title: '干活', assignee: 'me' })
eq('writeTask ok', task.ok, true)
eq('任务落到项目', proj('p-empty').tasks.length, 1)
eq('任务标题正确', proj('p-empty').tasks[0].title, '干活')

const lamp = await Org.teamLampExtra('p-empty')
ok('teamLampExtra 可调用', lamp === undefined || typeof lamp === 'string')

// ── 7. 旧团队 id 找不到（破坏性变更必须显式） ────────────────────────────────
console.log('[7] 旧 teamId 已失效')
const legacyLookup = P.findTeam(await P.loadProjects(), 'team-1')
eq('findTeam(team-1) === null', legacyLookup, null)

// ── 8. 零成员的队必须仍然可见（否则 forge_team_create 的"你已经带了一支队"闸会失效）
console.log('[8] 零成员队的可见性')
const TeamsFile = await import(LIB + '/teams-file.mjs')
const unit = TeamsFile.openTeamsFile()
// 用一个**专属项目**，落点才确定：putRecord 认的是"调用方会话属于哪个项目"，
// 找不到就按既有设计回退到 projects[0] —— 那是另一条分支，不该拿来测这件事。
const base8 = await P.loadProjects()
base8.projects.push({
  id: 'p-team8', name: '空队测试', cwds: [], memory: '',
  wake: { ...P.DEFAULT_WAKE }, crossTeam: { ...P.DEFAULT_WAKE },
  members: [{ sessionId: 'cap8', memberId: 'cap8', role: '队长' }], tasks: [], stale: [], archived: [],
})
await P.saveProjects(base8)
const captainId = 'cap8'
await unit.putRecord('team', captainId, {
  teamId: 'team-random-xyz',   // teamhub 真的会自造一个随机 teamId
  name: 'EmptyTeam',
  goal: '空队也要在册',
  captain: captainId,
  members: [],                 // ← 关键：零成员
  tasks: [],
})
const all = await unit.loadAll()
ok('零成员的队出现在 team 表里', all.tables.team[captainId] !== undefined)
eq('表的键就是 captain', all.tables.team[captainId] === undefined ? null : all.tables.team[captainId].captain, captainId)
const t8 = JSON.parse(readFileSync(cfgPath, 'utf8')).projects.find((x) => x && x.id === 'p-team8')
eq('captain 落到项目上', t8.captain, captainId)
eq('goal 落到项目上', t8.goal, '空队也要在册')
eq('成员确实被清成 0', t8.members.length, 0)
ok('自造的随机 teamId 没有被持久化', !('teams' in t8))
const Cards = await import(LIB + '/agent-teams-file.mjs')
ok('projectCards 存在', typeof Cards.projectCards === 'function')

// ── 9. 编码与坏文件：BOM 算合法，坏文件必须可见 ─────────────────────────────
// 用户 2026-10-02 定的原则：**至少要让错误可以知道，不允许静默错误。**
console.log('[9] BOM 与坏文件')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 9a. 带 BOM 的合法文件 —— 剥掉 BOM 后应当正常读出，且不算错误。
const good = JSON.stringify({ version: 3, projects: [{ id: 'p-bom', name: 'BOM', cwds: [], members: [], tasks: [], stale: [], archived: [] }] }, null, 2)
writeFileSync(cfgPath, '\uFEFF' + good, 'utf8')
await sleep(1100)                       // loadProjects 有 1 秒缓存，必须等过去才会重读
const bomLoaded = await P.loadProjects()
eq('带 BOM 的文件能读出来', bomLoaded.projects.map((x) => x.id), ['p-bom'])
eq('带 BOM 不算错误', P.projectsLoadError(), null)

// 9b. 坏文件 —— 必须留下可见的错误，绝不静默当成"没有项目"。
writeFileSync(cfgPath, '{ this is not json', 'utf8')
await sleep(1100)
const brokenLoaded = await P.loadProjects()
eq('坏文件时回落到空项目表', brokenLoaded.projects.length, 0)
ok('坏文件留下了错误', typeof P.projectsLoadError() === 'string' && P.projectsLoadError().length > 0)
ok('错误文本点明了文件路径', String(P.projectsLoadError()).includes('projects.json'))
ok('错误文本点明了是解析失败', String(P.projectsLoadError()).includes('解析失败'))

// 9c. 文件不存在**不是**错误（第一次用这个功能就是这状态）。
rmSync(cfgPath, { force: true })
await sleep(1100)
const missing = await P.loadProjects()
eq('文件不存在时回落到空项目表', missing.projects.length, 0)
eq('文件不存在不算错误', P.projectsLoadError(), null)

rmSync(HOME, { recursive: true, force: true })

console.log('')
if (fails.length === 0) console.log('[projects-v3] 全部通过（' + pass + ' 项）')
else { console.log('[projects-v3] 失败 ' + fails.length + ' 项：'); for (const f of fails) console.log('  - ' + f) }
process.exit(fails.length === 0 ? 0 : 1)

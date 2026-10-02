// 项目记忆 CLI：动态插件 / 探针共用。stdout 只打一行 JSON。
import { loadProjects, teamOfSession } from './projects.mjs'
import { readProjectMemory, writeProjectMemory, deleteProjectMemory } from './agent-teams-file.mjs'

function out(value) {
  process.stdout.write(JSON.stringify(value) + '\n')
}

const argv = process.argv.slice(2)
const op = argv[0] || ''
const projectId = argv[1] || ''
const file = argv[2] || ''
const sid = argv[3] || ''

async function resolveProject(want, sessionId) {
  const cfg = await loadProjects()
  const projects = Array.isArray(cfg.projects) ? cfg.projects : []
  if (want) {
    const hit = projects.find((p) => p && (p.id === want || p.name === want))
    if (!hit) return { ok: false, error: '没有这个项目：' + want }
    return { ok: true, id: hit.id, name: hit.name }
  }
  if (sessionId) {
    const team = teamOfSession(cfg, sessionId)
    if (team) return { ok: true, id: team.project.id, name: team.project.name }
    const distill = projects.find((p) => p && p.distillSessionId === sessionId)
    if (distill) return { ok: true, id: distill.id, name: distill.name }
  }
  const fallback = projects.find((p) => p && p.id === 'p-dsh-forge') || projects[0]
  if (!fallback) return { ok: false, error: 'projects.json 里没有项目' }
  return { ok: true, id: fallback.id, name: fallback.name, inferred: true }
}

try {
  if (op === 'resolve') {
    out(await resolveProject(projectId, sid))
  } else if (op === 'list') {
    out(await readProjectMemory(projectId, ''))
  } else if (op === 'get') {
    out(await readProjectMemory(projectId, file || 'README.md'))
  } else if (op === 'put') {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString('utf8')
    out(await writeProjectMemory(projectId, text, file || 'README.md'))
  } else if (op === 'delete') {
    out(await deleteProjectMemory(projectId, file))
  } else {
    out({ ok: false, error: 'unknown op ' + op })
    process.exitCode = 1
  }
} catch (error) {
  out({ ok: false, error: error !== null && typeof error === 'object' && error.message ? error.message : String(error) })
  process.exitCode = 1
}

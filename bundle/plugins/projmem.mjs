// description: 项目记忆 CRUD（~/.dsh/project-memory/<id>/）。形态对齐 teams：子工具 + 元工具 memory。免审批。README.md 不能删。
import { jsonText } from './lib/forge-common.mjs'
import { registerTool } from './lib/forge-tools.mjs'
import { loadProjects, teamOfSession } from './lib/projects.mjs'
import { readProjectMemory, writeProjectMemory, deleteProjectMemory } from './lib/agent-teams-file.mjs'
import { installMemoryInject } from './lib/meminject.mjs'

function callerId(exec) {
  if (exec !== undefined && exec.agent !== undefined && typeof exec.agent.id === 'string') return exec.agent.id
  return undefined
}

async function resolveProject(projectId, exec) {
  const cfg = await loadProjects()
  const projects = Array.isArray(cfg.projects) ? cfg.projects : []
  const want = String(projectId ?? '').trim()
  if (want !== '') {
    const hit = projects.find((p) => p && (p.id === want || p.name === want))
    if (hit) return { ok: true, project: hit }
    return { ok: false, error: '没有这个项目：' + want }
  }
  const sid = callerId(exec)
  if (sid) {
    const team = teamOfSession(cfg, sid)
    if (team) return { ok: true, project: team.project }
    const distill = projects.find((p) => p && p.distillSessionId === sid)
    if (distill) return { ok: true, project: distill }
  }
  const fallback = projects.find((p) => p && p.id === 'p-dsh-forge') || projects[0]
  if (!fallback) return { ok: false, error: 'projects.json 里没有项目' }
  return { ok: true, project: fallback, inferred: true }
}

export default {
  inject: ['tools'],
  apply(ctx) {
    try { installMemoryInject(ctx) } catch (error) { console.warn('[projmem] meminject skipped:', String(error && error.message ? error.message : error)) }
    const OPS = {}
    OPS['forge_memory_list'] = {
      name: 'forge_memory_list',
      desc: '列出项目记忆文件（~/.dsh/project-memory/<id>/）。省略 projectId 时按调用方所在队/蒸馏岗推断，否则列 dsh-forge。',
      schema: {
        projectId: { type: 'string', description: '项目 id 或显示名（如 p-dsh-forge / dsh-forge）。省略则按调用方所在项目。' },
      },
      handler: async (args, exec) => {
        const resolved = await resolveProject(args?.projectId, exec)
        if (resolved.ok !== true) return jsonText(resolved)
        const out = await readProjectMemory(resolved.project.id, '')
        return jsonText({ ...out, inferred: resolved.inferred === true })
      },
    }
    OPS['forge_memory_get'] = {
      name: 'forge_memory_get',
      desc: '读取一份项目记忆文件全文。file 默认 README.md。',
      schema: {
        projectId: { type: 'string', description: '项目 id 或显示名。省略则按调用方所在项目。' },
        file: { type: 'string', description: '文件名（单层，禁止路径分隔）。默认 README.md。' },
      },
      handler: async (args, exec) => {
        const resolved = await resolveProject(args?.projectId, exec)
        if (resolved.ok !== true) return jsonText(resolved)
        const file = String(args?.file ?? '').trim() || 'README.md'
        const out = await readProjectMemory(resolved.project.id, file)
        return jsonText({ ...out, inferred: resolved.inferred === true })
      },
    }
    OPS['forge_memory_put'] = {
      name: 'forge_memory_put',
      desc: '新建或覆盖一份项目记忆文件。免审批。file 默认 README.md。禁止路径穿越。',
      schema: {
        projectId: { type: 'string', description: '项目 id 或显示名。省略则按调用方所在项目。' },
        file: { type: 'string', description: '文件名（单层）。默认 README.md。' },
        text: { type: 'string', required: true, description: '文件全文（覆盖写）。' },
      },
      handler: async (args, exec) => {
        const resolved = await resolveProject(args?.projectId, exec)
        if (resolved.ok !== true) return jsonText(resolved)
        const file = String(args?.file ?? '').trim() || 'README.md'
        const out = await writeProjectMemory(resolved.project.id, String(args?.text ?? ''), file)
        return jsonText({ ...out, inferred: resolved.inferred === true })
      },
    }
    OPS['forge_memory_delete'] = {
      name: 'forge_memory_delete',
      desc: '删除一份项目记忆文件。引导 README.md 不能删。免审批。',
      schema: {
        projectId: { type: 'string', description: '项目 id 或显示名。省略则按调用方所在项目。' },
        file: { type: 'string', required: true, description: '要删的文件名（不能是 README.md）。' },
      },
      handler: async (args, exec) => {
        const resolved = await resolveProject(args?.projectId, exec)
        if (resolved.ok !== true) return jsonText(resolved)
        const out = await deleteProjectMemory(resolved.project.id, String(args?.file ?? ''))
        return jsonText({ ...out, inferred: resolved.inferred === true })
      },
    }

    for (const key of Object.keys(OPS)) {
      const op = OPS[key]
      registerTool(ctx, op.name, op.desc, op.schema, op.handler)
    }
    const opParamTable = Object.keys(OPS).map((key) => {
      const op = OPS[key]
      const params = Object.entries(op.schema ?? {}).map(([pname, pdef]) => {
        const t = pdef !== null && typeof pdef === 'object' ? (pdef.type ?? '?') : '?'
        const req = pdef !== null && typeof pdef === 'object' && pdef.required === true ? ' (必填)' : ''
        const desc = pdef !== null && typeof pdef === 'object' && typeof pdef.description === 'string' ? ': ' + pdef.description.slice(0, 60) : ''
        return pname + '〈' + t + '〉' + req + desc
      }).join(', ')
      return '- `' + key.replace('memory_', '') + '` → ' + params
    }).join('\n')
  },
}

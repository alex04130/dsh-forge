// 项目记忆注入：**只在会话真正的开始注入一次**（用户 2026-09-11 拍）。
// 原实现挂在每次 agent/inbox/claimed 上、按 mtime 差量反复注入，导致每轮上下文都被记忆提示挤占。
// 现在：本轮进程里该会话的第一次 claim = 会话开始，注入一次未见/更新的文件指针；之后同一会话不再注入。
// 全文不塞进上下文（用 forge_memory_get 拉）。fail-closed。
import { readFile, writeFile, mkdir, readdir, stat, rename } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { DSH_HOME } from './forge-common.mjs'
import { loadProjects, teamOfSession } from './projects.mjs'

const MAX_POINTERS = 8
const SKIP = new Set(['.git', '.DS_Store'])

export function memoryDir(projectId) {
  return join(DSH_HOME, 'project-memory', String(projectId || ''))
}

export function seenPath(projectId) {
  return join(DSH_HOME, 'projects', String(projectId || 'unknown'), 'memory-seen.json')
}

function safeName(name) {
  const s = String(name ?? '').replace(/\\/g, '/')
  if (s === '' || s.includes('..') || s.includes('/') || s.includes('\0')) return ''
  return s
}

export async function listMemoryFiles(projectId) {
  const dir = memoryDir(projectId)
  let names = []
  try { names = await readdir(dir) } catch { return [] }
  const files = []
  for (const name of names) {
    if (!name || name.startsWith('.') || SKIP.has(name)) continue
    const ok = safeName(name)
    if (ok === '') continue
    try {
      const st = await stat(join(dir, ok))
      if (!st.isFile()) continue
      files.push({ name: ok, mtimeMs: st.mtimeMs, bytes: st.size })
    } catch { /* skip */ }
  }
  files.sort((a, b) => (a.name === 'README.md' ? -1 : b.name === 'README.md' ? 1 : a.name.localeCompare(b.name)))
  return files
}

export async function loadSeen(file) {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'))
    return data !== null && typeof data === 'object' ? data : {}
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return {}
    throw error
  }
}

export async function saveSeen(file, seen) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  await writeFile(tmp, JSON.stringify(seen, null, 2) + '\n', 'utf8')
  await rename(tmp, file)
}

export function diffSeen(files, seen, sessionId) {
  const map = seen !== null && typeof seen === 'object' ? seen : {}
  const slot = map[sessionId] !== null && typeof map[sessionId] === 'object' ? map[sessionId] : {}
  return (Array.isArray(files) ? files : []).filter((f) => {
    const known = slot[f.name]
    if (known === undefined) return true
    const mtime = typeof known === 'number' ? known : Number(known && known.mtimeMs)
    return !Number.isFinite(mtime) || Number(f.mtimeMs) > mtime
  })
}

export function markSeen(seen, sessionId, files) {
  const next = seen !== null && typeof seen === 'object' ? { ...seen } : {}
  const slot = { ...(next[sessionId] !== null && typeof next[sessionId] === 'object' ? next[sessionId] : {}) }
  for (const f of Array.isArray(files) ? files : []) {
    if (f && typeof f.name === 'string') slot[f.name] = Number(f.mtimeMs) || Date.now()
  }
  next[sessionId] = slot
  return next
}

function extractUserText(message) {
  if (message === null || typeof message !== 'object' || message.role !== 'user') return ''
  if (message.source !== null && typeof message.source === 'object' && typeof message.source.senderSessionId === 'string') return ''
  const content = Array.isArray(message.content) ? message.content : []
  const parts = []
  for (const b of content) {
    if (b !== null && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n').trim()
}

function firstLine(text) {
  const s = String(text || '').replace(/\r/g, '')
  for (const ln of s.split('\n')) {
    const t = ln.replace(/^#+\s*/, '').trim()
    if (t) return t.slice(0, 72)
  }
  return ''
}

async function peekLine(projectId, name) {
  try {
    const raw = await readFile(join(memoryDir(projectId), name), 'utf8')
    return firstLine(raw.slice(0, 400))
  } catch { return '' }
}

// 官方"注入"通道：agent.ctx.systemPrompt.section()。不用 steer/followup——
// 那两个是把消息塞进人类消息流（用户 2026-09-11：不要模仿人的软打断）。
export const CHANGED_SECTION_NAME = 'forge:project-memory-changed'
export const CHANGED_ORDER = 9051

export function pushSystemNote(agent, text) {
  try {
    const sp = agent && agent.ctx && typeof agent.ctx.get === 'function' ? agent.ctx.get('systemPrompt') : undefined
    if (sp === undefined || typeof sp.section !== 'function') return false
    sp.section({ name: CHANGED_SECTION_NAME, order: CHANGED_ORDER, text })
    return true
  } catch { return false }
}

async function projectOfAgent(agentId) {
  const cfg = await loadProjects()
  const hit = teamOfSession(cfg, agentId)
  if (hit && hit.project) return hit.project
  const distill = (cfg.projects || []).find((p) => p && p.distillSessionId === agentId)
  return distill || null
}

const claimedOnce = new Set()
/** 会话级闸：本轮进程里每个会话只放行第一次 claim（= 会话开始）。 */
const startedSessions = new Set()

export async function handleClaimed(payload) {
  const agent = payload && payload.agent
  const message = payload && payload.message
  if (agent === null || typeof agent !== 'object' || typeof agent.id !== 'string') return { ok: false, reason: 'no-agent' }
  if (startedSessions.has(agent.id)) return { ok: false, reason: 'not-session-start' }
  startedSessions.add(agent.id)
  const claimKey = agent.id + ':' + String(message && message.id ? message.id : '')
  if (claimedOnce.has(claimKey)) return { ok: false, reason: 'dup-listener' }
  claimedOnce.add(claimKey)
  if (claimedOnce.size > 800) {
    const first = claimedOnce.values().next().value
    if (first !== undefined) claimedOnce.delete(first)
  }
  const text = extractUserText(message)
  if (text === '') return { ok: false, reason: 'skip-injected-or-empty' }
  const project = await projectOfAgent(agent.id)
  if (!project || !project.id) return { ok: false, reason: 'no-project' }
  const files = await listMemoryFiles(project.id)
  if (files.length === 0) return { ok: false, reason: 'empty-memory' }
  const path = seenPath(project.id)
  const seen = await loadSeen(path)
  // 持久化闸：该会话只要注入过一次（seen 里已有它的 slot），就永不再注入。
  // 与内存 startedSessions 互补：不依赖模块缓存，重启/重挂载后依然成立。
  const slot = seen !== null && typeof seen === 'object' ? seen[agent.id] : undefined
  if (slot !== null && typeof slot === 'object' && Object.keys(slot).length > 0) return { ok: false, reason: 'already-injected-once' }
  const fresh = diffSeen(files, seen, agent.id).slice(0, MAX_POINTERS)
  if (fresh.length === 0) return { ok: false, reason: 'already-seen' }
  const note = '项目记忆有更新（' + project.id + '）。需要时读 ~/.dsh/project-memory/' + project.id + '/（forge_memory_list / forge_memory_get）；不一定要读。'
  const delivered = pushSystemNote(agent, note)
  if (!delivered) return { ok: false, reason: 'not-delivered' }
  await saveSeen(path, markSeen(seen, agent.id, fresh))
  return { ok: true, projectId: project.id, injected: fresh.map((f) => f.name) }
}

export const POINTER_SECTION_NAME = 'forge:project-memory-pointer'
export const POINTER_ORDER = 9050
export const POINTER_TEXT =
  '项目记忆在 ~/.dsh/project-memory/<projectId>/（项目 id 见 projects.json 或派工文本）。' +
  '对项目内容有任何需要理解的信息——决定、坑、遗留、可复用经验——都看那里：forge_memory_list 列文件、forge_memory_get 读全文。'

export function installMemoryInject(ctx) {
  // 静态指针：写死在提示词里，不需要注入、不占用户消息流、每轮不变（缓存安全）。
  try {
    const sp = ctx.systemPrompt
    if (sp !== undefined && typeof sp.section === 'function') {
      sp.section({ name: POINTER_SECTION_NAME, order: POINTER_ORDER, text: POINTER_TEXT })
    }
  } catch (error) {
    try { console.warn('[meminject] pointer section skipped:', String(error && error.message ? error.message : error)) } catch { /* noop */ }
  }
  ctx.on('agent/inbox/claimed', async (payload) => {
    try {
      await handleClaimed(payload)
    } catch (error) {
      try { console.warn('[meminject]', String(error && error.message ? error.message : error)) } catch { /* noop */ }
    }
  })
}

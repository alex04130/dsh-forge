// 上下文压缩后：把被收掉的 seq 坐标写进项目记忆，live 派给蒸馏岗，并提示本会话可能有损失。
// 不把正文塞进模型上下文（那会抵消压缩）。蒸馏岗按坐标从档案读原文。
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DSH_HOME } from './forge-common.mjs'
import { loadProjects, teamOfSession } from './projects.mjs'
import { talkSend } from './team-org.r2.mjs'

const seen = new Set()
const MAX_SEEN = 400

function flattenBlocks(blocks) {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  let out = ''
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && typeof block.text === 'string') out += block.text
    else if (typeof block === 'string') out += block
  }
  return out.trim()
}

function leafText(value, cap) {
  const s = String(value || '').replace(/\s+/g, ' ').trim()
  if (s.length <= cap) return s
  return s.slice(0, cap) + ' …'
}

async function projectOfSession(sessionId) {
  const cfg = await loadProjects()
  const hit = teamOfSession(cfg, sessionId)
  if (hit && hit.project) return hit.project
  const distill = (cfg.projects || []).find((p) => p && p.distillSessionId === sessionId)
  return distill || null
}

function makeId(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1679615).toString(36)
}

function pushAgent(agent, text) {
  if (agent === undefined || agent === null) return false
  const message = {
    id: makeId('m'),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user', rpcId: makeId('rpc') },
  }
  try {
    if (typeof agent.status === 'string' && agent.status === 'running' && typeof agent.steer === 'function') {
      agent.steer(message)
      return true
    }
    if (typeof agent.followup === 'function') {
      agent.followup(message)
      return true
    }
  } catch { /* contained */ }
  return false
}

export function installCompactionDistill(ctx, runtime) {
  const agents = runtime && runtime.agents
  ctx.on('session/event', (session, event) => {
    try {
      if (!event || event.type !== 'compaction/summary') return
      const data = event.data && typeof event.data === 'object' ? event.data : {}
      const compactionId = typeof data.compactionId === 'string' ? data.compactionId : ''
      const sid = session !== undefined && typeof session.id === 'string' ? session.id : ''
      if (sid === '') return
      const key = (compactionId || String(event.seq || '')) + '|' + sid
      if (seen.has(key)) return
      seen.add(key)
      if (seen.size > MAX_SEEN) {
        const first = seen.values().next().value
        if (first !== undefined) seen.delete(first)
      }
      const range = data.shadowedRange && typeof data.shadowedRange === 'object' ? data.shadowedRange : {}
      const start = range.start
      const end = range.end
      const seqs = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.filter((n) => Number.isFinite(n)).slice(0, 400) : []
      const tokens = typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : 0
      const summary = leafText(flattenBlocks(data.summary), 800)
      void handleCompaction({
        agents,
        sid,
        compactionId: compactionId || ('seq-' + String(event.seq || '')),
        start,
        end,
        seqs,
        tokens,
        summary,
        summarySeq: event.seq,
      }).catch((error) => {
        console.warn('[compdist]', String(error && error.message ? error.message : error))
      })
    } catch (error) {
      console.warn('[compdist] listener', String(error && error.message ? error.message : error))
    }
  })
}

export async function handleCompaction(job) {
  const project = await projectOfSession(job.sid)
  const projectId = project && project.id ? project.id : 'p-dsh-forge'
  const post = project && typeof project.distillSessionId === 'string' ? project.distillSessionId : ''
  // 蒸馏岗自己压缩：仍然落坐标档，但不回灌提示、不派给自己（用户 2026-09-12）。
  const selfCompaction = post !== '' && post === job.sid
  const short = String(job.sid).replace(/^session-/, '').slice(0, 8)
  const file = 'compact-' + short + '-' + String(job.compactionId).replace(/[^A-Za-z0-9._-]+/g, '').slice(0, 12) + '.md'
  const seqLine = job.seqs.length ? job.seqs.slice(0, 40).join(', ') + (job.seqs.length > 40 ? ' …' : '') : '（无 shadowedSeqs）'
  const md = [
    '# 压缩损失段',
    '',
    '- 会话 `' + job.sid + '`',
    '- compactionId `' + job.compactionId + '`',
    '- 摘要事件 seq `' + String(job.summarySeq ?? '') + '`',
    '- 被收范围 start `' + String(job.start ?? '') + '` → end `' + String(job.end ?? '') + '`',
    '- 约 ' + String(job.tokens) + ' token / ' + String(job.seqs.length) + ' 条 surface',
    '- shadowedSeqs：' + seqLine,
    '',
    '## 官方摘要（可能丢细节）',
    '',
    job.summary || '（空）',
    '',
    '## 蒸馏岗怎么做',
    '',
    '原文仍在会话日志，没有删。按上面的 seq 读被收掉的段落，把决策、坑、未完成写进本文件或另开 `distill-compact-*.md`。不要 spawn。',
    '',
  ].join('\n')
  const dir = join(DSH_HOME, 'project-memory', projectId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, file), md, 'utf8')

  const lossNote = [
    '[压缩提示]',
    '',
    '刚才做了一次上下文压缩，官方摘要可能丢掉细节（数字、路径、拍板原文）。',
    '被收范围 seq ' + String(job.start ?? '?') + ' → ' + String(job.end ?? '?') + '（约 ' + String(job.tokens) + ' token）。',
    '坐标已写项目记忆 `' + file + '`。',
    post ? '已通知蒸馏岗按 seq 从档案补蒸。需要某句原话，按 seq 读日志原文，不要靠摘要。' : '这个项目还没有蒸馏岗。坐标已落盘；要补蒸先开 forge-team-distill 再记到项目。',
  ].join('\n')

  if (job.dry !== true && !selfCompaction) {
    const live = job.agents !== undefined && typeof job.agents.get === 'function' ? job.agents.get(job.sid) : undefined
    pushAgent(live, lossNote)
  }

  if (post === '' || job.dry === true) return { ok: true, file, projectId, distillSessionId: post, dry: job.dry === true }
  if (selfCompaction) return { ok: true, file, projectId, distillSessionId: post, selfCompaction: true }
  const distillText = [
    '会话 `' + job.sid + '` 刚压缩。官方摘要可能有损失。',
    '请按项目记忆 `' + file + '` 的 seq 从档案读被收掉的原文，补蒸决策/坑/未完成。不要 spawn，不要回执空话。',
    '范围 start=' + String(job.start ?? '') + ' end=' + String(job.end ?? '') + ' tokens≈' + String(job.tokens) + '.',
  ].join('\n')
  const sent = await talkSend({ from: 'console', to: post, text: distillText, fromName: '控制台', wake: true })
  return { ok: true, file, projectId, distillSessionId: post, delivered: sent && sent.delivered }
}

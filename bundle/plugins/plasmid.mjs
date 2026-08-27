// description: 最薄质粒 v0（dsh-forge.md §5）：自荐制经验单元。plasmid_submit/search/get/report + 四道闸（格式/证据/密钥/查重）+ fitness 记录。注册表 = JSON 文件原子写，删除键只在人手里。
// 设计落地（v0 范围 = §5.11 最小闭环）：
//   - 只做修复质粒一类（type='fix'）、只在本场内跑（scope 默认 project）
//   - 自荐制：模型学到教训的当下自己调用 plasmid_submit（§5.5）
//   - 机器四道闸全自动：格式 → 证据 → 密钥 → 查重（§5.5）
//   - 证据闸挂档案（sessionQuery.readEvent 解析 <sessionId>:<seq> 句柄，引不出来直接拒）
//   - fitness 近期滑动窗口（§5.8），跌破 0.3 自动降级 status='idea'（删除键只在人手里）
//   - 管理面板数据面：GET /dsh-forge/plasmids（只读；面板 UI 单独交付 v0.1）
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { errText, jsonText, DSH_HOME, atomicWriteJson } from './lib/forge-common.mjs'
import { registerTool } from './lib/forge-tools.mjs'
function nowIso() {
  return new Date().toISOString()
}

// ── 注册表存取（原子写：tmp + rename，单进程串行由调用方掌握）────────────────
export function defaultRegistryPath() {
  return join(DSH_HOME, 'plasmids', 'registry.json')
}

// ── 配置（一切可配置：~/.dsh/plasmids/config.json，缺失则默认；UI 后续接设置/插件栏）──
export const DEFAULT_CONFIG = {
  inject: {
    enabled: true,          // 任务开始 T 差量注入总闸
    topK: 3,                // 注入条数
    minRelevance: 0.25,     // 词汇召回阈值
    matcher: 'lexical',     // lexical（默认，零依赖）| llm（A 语义精排）| vector（B RAG）；未配置后端自动回落
    briefDir: '',           // 空=默认 join(DSH_HOME,'projects')；brief 落盘目录
  },
  llm: {                    // A 语义精排配置（matcher:'llm' 或自动升级时用）
    provider: '',           // 空=该级不可用，回落 lexical（如 'scnet'）
    model: '',              // 如 'Kimi-K3'
    candidateK: 6,          // 词汇召回候选数（精排输入）
    maxChars: 4000,
  },
  vector: {                 // B RAG 配置（matcher:'vector' 时用；默认关，需配嵌入端点）
    enabled: false,         // 默认关闭：不是人人都会配置嵌入模型
    embedder: '',           // 嵌入模型端点 id（如 provider/model 名）；空=该级不可用，回落
    topK: 5,
  },
  nudge: {
    enabled: true,          // B′ 报错轻推
    perTaskPerPlasmid: 1,   // 每任务每质粒最多提醒次数
  },
  broadcast: {
    enabled: true,          // C 半径广播
    globalByDefault: false, // global scope 广播默认关（L3 人在场才开）
  },
}

export function defaultConfigPath() {
  return join(DSH_HOME, 'plasmids', 'config.json')
}

export async function loadConfig(file) {
  try {
    const raw = await readFile(file, 'utf8')
    const data = JSON.parse(raw)
    if (data !== null && typeof data === 'object') return deepMerge(DEFAULT_CONFIG, data)
    throw new Error(`config ${file} is not an object`)
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return { ...DEFAULT_CONFIG }
    throw error
  }
}

function deepMerge(base, overlay) {
  if (overlay === null || typeof overlay !== 'object' || Array.isArray(overlay)) return overlay
  const out = { ...base }
  for (const k of Object.keys(overlay)) {
    out[k] = typeof base?.[k] === 'object' && base[k] !== null && !Array.isArray(base[k])
      ? deepMerge(base[k], overlay[k])
      : overlay[k]
  }
  return out
}

export async function loadRegistry(file) {
  try {
    const raw = await readFile(file, 'utf8')
    const data = JSON.parse(raw)
    if (data !== null && typeof data === 'object' && Array.isArray(data.entries)) return data
    throw new Error(`registry ${file} is not a valid plasmid registry`)
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return { version: 1, entries: [] }
    throw error
  }
}
export async function saveRegistry(file, data) {
  await atomicWriteJson(file, data)
  // 同步生成人类可读目录（§5.7 落盘成文件让代理自己读）：plasmid_submit/search/get 之外，
  // 代理不用工具也能 read ~/.dsh/plasmids/catalog.md 看到有哪些经验；全文仍靠 plasmid_get 拉。
  try {
    const dir = dirname(file)
    const dst = join(dir, 'catalog.md')
    await mkdir(dir, { recursive: true })
    const tmp = `${dst}.tmp-${process.pid}`
    await writeFile(tmp, generateCatalog(data), 'utf8')
    await rename(tmp, dst)
  } catch (error) {
    // catalog 生成失败不阻断注册表写入（best-effort；探针/纯逻辑调用路径也可能无此目录）
  }
}

// 人类可读质粒目录（机器生成，勿手改）。纯函数便于探针与后续面板复用。
export function generateCatalog(data) {
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const lines = [
    '# 质粒目录（机器生成的速查表，勿手改）',
    '',
    '> 使用：先看本目录知道有哪些经验，需要全文用 plasmid_get 拉。新条目由 plasmid_submit 自动追加。',
    '',
  ]
  for (const e of entries) {
    const s = summarize(e)
    lines.push(`- **${s.id}** [${s.type}/${s.status}] ${s.confidence ?? 'medium'} · fitness ${s.fitness?.score ?? 0.5} · 证据 ${s.evidenceCount} 条`)
    lines.push(`  WHEN: ${s.when}`)
    if (s.worked !== '') lines.push(`  WORKED: ${s.worked}`)
  }
  return lines.join('\n') + '\n'
}

// ── id 与文本工具 ──────────────────────────────────────────────────────────
// 质粒 P-xxx 与缺口报告 G-xxx 各自独立计数（注册表共用一个文件，前缀区分）。
export function nextId(entries, seed = 'P-001') {
  const prefix = /^([PG])-/.exec(seed)?.[1] ?? 'P'
  let max = -1
  for (const e of Array.isArray(entries) ? entries : []) {
    const m = new RegExp(`^${prefix}-0?(\\d+)$`).exec(typeof e?.id === 'string' ? e.id : '')
    if (m !== null) { const n = Number(m[1]); if (n > max) max = n }
  }
  const base = /^[PG]-0?(\d+)$/.exec(seed)
  const n = max >= 0 ? max + 1 : (base !== null ? Number(base[1]) : 1)
  return `${prefix}-${String(n).padStart(3, '0')}`
}
export function tokensOf(text) {
  const s = String(text ?? '').toLowerCase()
  const out = []
  let word = ''
  const flush = () => { if (word !== '') { out.push(word); word = '' } }
  for (const ch of s) {
    if (/[\p{Script=Han}]/u.test(ch)) { flush(); out.push(ch) }
    else if (/[\p{L}\p{N}_]/u.test(ch)) word += ch
    else flush()
  }
  flush()
  return [...new Set(out)]
}
export function similarity(a, b) {
  const ta = new Set(tokensOf(a))
  const tb = new Set(tokensOf(b))
  if (ta.size === 0 || tb.size === 0) return 0
  let inter = 0
  for (const x of ta) if (tb.has(x)) inter++
  return inter / (ta.size + tb.size - inter)
}
function first(text, n) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}
export function summarize(e, relevance) {
  const isGap = e?.type === 'gap'
  return {
    id: e.id, type: e.type, status: e.status, confidence: e.confidence, scope: e.scope, version: e.version,
    when: first(e.what || e.when, 140), worked: first(e.worked, 140),
    evidenceCount: Array.isArray(e.evidence) ? e.evidence.length : 0,
    fitness: { score: e.fitness?.score ?? 0.5, seen: e.fitness?.seen ?? 0, worked: e.fitness?.worked ?? 0, failed: e.fitness?.failed ?? 0 },
    createdAt: e.createdAt, updatedAt: e.updatedAt, source: e.source,
    ...(isGap ? { outlet: e.outlet ?? 'backlog' } : {}),
    ...(typeof relevance === 'number' ? { relevance } : {}),
  }
}

// ── 四道闸（纯逻辑，可被探针/其他模型直接复用）──────────────────────────────
// 证据句柄：<sessionId>:<seq>（sessionId 不含冒号；在最后一个冒号处切分）
export function parseEvidenceHandle(raw) {
  const s = String(raw ?? '').trim()
  const i = s.lastIndexOf(':')
  if (i <= 0 || i === s.length - 1) return null
  const sessionId = s.slice(0, i).trim()
  const seq = Number(s.slice(i + 1).trim())
  if (sessionId.length === 0 || sessionId.includes(' ')) return null
  if (!Number.isSafeInteger(seq) || seq < 0) return null
  return { sessionId, seq }
}

export function gateFormat(args) {
  const type = String(args?.type ?? '')
  if (type !== 'fix') return { ok: false, error: `type 必须是 "fix"（v0 只做修复质粒一类），收到 ${JSON.stringify(type)}` }
  for (const k of ['when', 'worked', 'failed', 'why']) {
    const v = String(args?.[k] ?? '').trim()
    if (v.length === 0) return { ok: false, error: `${k} 必填且不能为空` }
    if (v.length > 4000) return { ok: false, error: `${k} 超过 4000 字符（${v.length}）` }
  }
  if (!Array.isArray(args.evidence) || args.evidence.length < 1 || args.evidence.length > 8) {
    return { ok: false, error: 'evidence 必须是 1..8 个 <sessionId>:<seq> 证据句柄（必须引用档案里真实存在的事件）' }
  }
  for (const e of args.evidence) {
    if (parseEvidenceHandle(e) === null) return { ok: false, error: `无效证据句柄：${JSON.stringify(e)}（应为 <sessionId>:<seq>）` }
  }
  if (args.confidence !== undefined && !['high', 'medium', 'low'].includes(args.confidence)) {
    return { ok: false, error: `confidence 必须是 high|medium|low，收到 ${JSON.stringify(args.confidence)}` }
  }
  if (typeof args.scope === 'string' && args.scope.length > 200) return { ok: false, error: 'scope 超过 200 字符' }
  return { ok: true }
}

// 高信号密钥模式（只报命中模式名，不回显疑似密钥本身）
const SECRET_PATTERNS = [
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'sk- 前缀凭证', re: /\bsk-[A-Za-z0-9]{16,}\b/ },
  { name: 'AWS AKIA', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}\b/ },
  { name: 'GitHub PAT', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/ },
  { name: '凭证赋值', re: /\b(?:passwd|password|secret|api[_-]?key|token)\b\s*[:=]\s*['"]?[A-Za-z0-9_\-./+]{12,}/i },
]
export function gateSecrets(...fields) {
  const blob = fields.map((f) => String(f ?? '')).join('\n')
  for (const p of SECRET_PATTERNS) {
    if (p.re.test(blob)) return { ok: false, matched: p.name }
  }
  return { ok: true }
}

export async function gateEvidence(evidence, sessionQuery) {
  const failures = []
  for (const e of Array.isArray(evidence) ? evidence : []) {
    const h = parseEvidenceHandle(e)
    if (h === null) { failures.push({ handle: String(e), error: '句柄格式无效' }); continue }
    try {
      const win = await sessionQuery.readEvent({ sessionId: h.sessionId, seq: h.seq })
      if (win === null || win === undefined || win.target === undefined || win.target === null) {
        failures.push({ handle: String(e), error: '该坐标处无事件' })
      }
    } catch (error) {
      failures.push({ handle: String(e), error: errText(error) })
    }
  }
  return failures.length === 0 ? { ok: true, checked: (evidence || []).length } : { ok: false, failures }
}

// ── 业务动作 ──────────────────────────────────────────────────────────────
// deps: { sessionQuery, registryPath, source }
export async function submitPlasmid(args, deps) {
  const sessionQuery = deps.sessionQuery
  const file = deps.registryPath
  const source = typeof deps.source === 'string' && deps.source.length > 0 ? deps.source : 'unknown'
  const fmt = gateFormat(args)
  if (!fmt.ok) return { accepted: false, gate: 'format', error: fmt.error }
  const ev = await gateEvidence(args.evidence, sessionQuery)
  if (!ev.ok) {
    return { accepted: false, gate: 'evidence', error: `证据闸不过：${ev.failures.map((f) => `${f.handle}: ${f.error}`).join('；')}。请用 archive_filter_events / archive_read_event 找到真实坐标再提交。` }
  }
  const sec = gateSecrets(args.when, args.worked, args.failed, args.why, args.scope ?? '')
  if (!sec.ok) return { accepted: false, gate: 'secret', error: `密钥闸不过：命中「${sec.matched}」。凭证不过质粒，请把具体值改写成方法描述（如「用环境变量传入」）再提交。` }

  const reg = await loadRegistry(file)
  const updateOf = typeof args.updateOf === 'string' && args.updateOf.trim() !== '' ? args.updateOf.trim() : ''

  if (updateOf === '' && reg.entries.length > 0) {
    const blob = `${args.when}\n${args.worked}\n${args.failed}\n${args.why}`
    let best = null
    for (const e of reg.entries) {
      if (e.type !== 'fix') continue
      const eb = `${e.when}\n${e.worked}\n${e.failed}\n${e.why}`
      const s = similarity(blob, eb)
      if (best === null || s > best.sim) best = { id: e.id, sim: s, when: e.when }
    }
    if (best !== null && best.sim >= 0.4) {
      return {
        accepted: false, gate: 'dedup',
        existingId: best.id, similarity: +best.sim.toFixed(2), existingWhen: first(best.when, 140),
        suggestion: '库里有相似质粒，别开新条：若确实是同一教训的新进展，用 updateOf 提交新版本；若是不同教训，请在文本里明确写出与该条的差异，再重试。',
      }
    }
  }

  let entry = null
  if (updateOf !== '') {
    const idx = reg.entries.findIndex((e) => e.id === updateOf)
    if (idx === -1) return { accepted: false, gate: 'format', error: `updateOf 引用不存在的质粒：${updateOf}` }
    const old = reg.entries[idx]
    entry = {
      ...old,
      when: args.when, worked: args.worked, failed: args.failed, why: args.why,
      confidence: args.confidence ?? old.confidence ?? 'medium',
      scope: args.scope ?? old.scope ?? 'project',
      evidence: args.evidence, version: (old.version || 1) + 1, updatedAt: nowIso(),
    }
    reg.entries[idx] = entry
  } else {
    entry = {
      id: nextId(reg.entries),
      type: 'fix', status: 'active',
      confidence: args.confidence ?? 'medium',
      scope: args.scope ?? 'project',
      source,
      version: 1,
      when: args.when, worked: args.worked, failed: args.failed, why: args.why,
      evidence: args.evidence,
      createdAt: nowIso(), updatedAt: nowIso(),
      fitness: { worked: 0, failed: 0, seen: 0, recent: [], score: 0.5 },
    }
    reg.entries.push(entry)
  }
  await saveRegistry(file, reg)
  return { accepted: true, id: entry.id, status: entry.status, version: entry.version, updated: updateOf !== '' }
}

// ── 缺口报告（§5.12：与质粒共用管道/证据闸/查重/注册表）────────────────────
// 缺口回答"这里少了个东西"，不改变行为，只进人待办。出口分流（§5.12 表）：
//   缺工具 → 先查插件市场雷达（采用优先），查无此物才进开发 backlog
//   流程可以更好 → 转方法质粒候选，走自荐制的闸
//   协作怎么配合更合适 → 不进 backlog，直接喂评分系统和能力卡
export function gateFormatGap(args) {
  for (const k of ['what', 'why']) {
    const v = String(args?.[k] ?? '').trim()
    if (v.length === 0) return { ok: false, error: `${k} 必填且不能为空` }
    if (v.length > 4000) return { ok: false, error: `${k} 超过 4000 字符（${v.length}）` }
  }
  if (typeof args.impact === 'string' && args.impact.length > 2000) return { ok: false, error: 'impact 超过 2000 字符' }
  if (!Array.isArray(args.evidence) || args.evidence.length < 1 || args.evidence.length > 8) {
    return { ok: false, error: 'evidence 必须是 1..8 个 <sessionId>:<seq> 证据句柄（必须引用档案里真实存在的事件）' }
  }
  for (const e of args.evidence) {
    if (parseEvidenceHandle(e) === null) return { ok: false, error: `无效证据句柄：${JSON.stringify(e)}（应为 <sessionId>:<seq>）` }
  }
  if (args.outlet !== undefined && !['backlog', 'plasmid-candidate', 'scoring'].includes(args.outlet)) {
    return { ok: false, error: `outlet 必须是 backlog|plasmid-candidate|scoring，收到 ${JSON.stringify(args.outlet)}` }
  }
  if (args.confidence !== undefined && !['high', 'medium', 'low'].includes(args.confidence)) {
    return { ok: false, error: `confidence 必须是 high|medium|low，收到 ${JSON.stringify(args.confidence)}` }
  }
  if (typeof args.scope === 'string' && args.scope.length > 200) return { ok: false, error: 'scope 超过 200 字符' }
  return { ok: true }
}

export async function submitGap(args, deps) {
  const sessionQuery = deps.sessionQuery
  const file = deps.registryPath
  const source = typeof deps.source === 'string' && deps.source.length > 0 ? deps.source : 'unknown'
  const fmt = gateFormatGap(args)
  if (!fmt.ok) return { accepted: false, gate: 'format', error: fmt.error }
  const ev = await gateEvidence(args.evidence, sessionQuery)
  if (!ev.ok) {
    return { accepted: false, gate: 'evidence', error: `证据闸不过：${ev.failures.map((f) => `${f.handle}: ${f.error}`).join('；')}。请用 archive_filter_events / archive_read_event 找到真实坐标再提交。` }
  }
  const sec = gateSecrets(args.what, args.why ?? '', args.impact ?? '', args.scope ?? '')
  if (!sec.ok) return { accepted: false, gate: 'secret', error: `密钥闸不过：命中「${sec.matched}」。凭证不过质粒，请把具体值改写成方法描述再提交。` }

  const reg = await loadRegistry(file)
  const blob = `${args.what}\n${args.why ?? ''}\n${args.impact ?? ''}`
  let best = null
  for (const e of reg.entries) {
    if (e.type !== 'gap') continue
    const eb = `${e.what}\n${e.why ?? ''}\n${e.impact ?? ''}`
    const s = similarity(blob, eb)
    if (best === null || s > best.sim) best = { id: e.id, sim: s, what: e.what }
  }
  if (best !== null && best.sim >= 0.5) {
    return {
      accepted: false, gate: 'dedup',
      existingId: best.id, similarity: +best.sim.toFixed(2), existingWhat: first(best.what, 140),
      suggestion: '已有相似缺口报告，别开新条：若该缺口有进展（已建/已撤/已绕过），需要人工更新原条状态；若确实是不同缺口，请在文本里明确写出差异再重试。',
    }
  }

  const entry = {
    id: nextId(reg.entries, 'G-001'),
    type: 'gap', status: 'open',
    outlet: args.outlet ?? 'backlog',
    confidence: args.confidence ?? 'medium',
    scope: args.scope ?? 'project',
    source,
    version: 1,
    what: args.what, why: args.why ?? '', impact: args.impact ?? '',
    evidence: args.evidence,
    createdAt: nowIso(), updatedAt: nowIso(),
    fitness: { worked: 0, failed: 0, seen: 0, recent: [], score: 0.5 },
  }
  reg.entries.push(entry)
  await saveRegistry(file, reg)
  return { accepted: true, id: entry.id, type: 'gap', outlet: entry.outlet, status: entry.status }
}

export function searchPlasmids(args, reg) {
  const entries = Array.isArray(reg?.entries) ? reg.entries : []
  const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
  const type = typeof args.type === 'string' ? args.type.trim() : ''
  const scope = typeof args.scope === 'string' ? args.scope.trim() : ''
  const status = typeof args.status === 'string' ? args.status.trim() : ''
  const pool = entries.filter((e) => {
    if (type !== '' && e.type !== type) return false
    if (scope !== '' && e.scope !== scope) return false
    if (status !== '' && e.status !== status) return false
    return true
  })
  const qTokens = tokensOf(query)
  const scored = pool.map((e) => {
    // fix 用 when/worked/failed/why；gap 用 what/why/impact（k3 实证：gap 的 what 不在旧
    // blob 里，按 what 内容搜不中；why 碰巧含词才会误命中）
    const parts = e.type === 'gap'
      ? [e.what ?? '', e.why ?? '', e.impact ?? '']
      : [e.when ?? '', e.worked ?? '', e.failed ?? '', e.why ?? '']
    parts.push(`${e.type} ${e.scope}`)
    const blob = parts.join('\n').toLowerCase()
    let matched = 0
    for (const t of qTokens) if (blob.includes(t)) matched++
    const ratio = qTokens.length === 0 ? 1 : matched / qTokens.length
    const sub = query !== '' && blob.includes(query) ? 1 : 0
    const relevance = qTokens.length === 0 ? 0 : +(0.7 * ratio + 0.3 * sub).toFixed(2)
    return { e, relevance }
  })
  scored.sort((a, b) => {
    const s = b.relevance - a.relevance || (b.e.fitness?.score ?? 0.5) - (a.e.fitness?.score ?? 0.5)
    return s !== 0 ? s : String(a.e.id).localeCompare(String(b.e.id))
  })
  const cap = Number.isSafeInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 100) : 20
  const hits = scored.slice(0, cap)
  return { count: hits.length, total: pool.length, results: hits.map(({ e, relevance }) => summarize(e, relevance)) }
}

export function getPlasmid(id, reg) {
  const e = (Array.isArray(reg?.entries) ? reg.entries : []).find((x) => x.id === id)
  if (e === undefined) return { ok: false, error: `没有质粒 ${id}` }
  return { ok: true, entry: e }
}

// ── 按需注入（T 差量，方案定稿 2026-08-25）─────────────────────────────────
// 打分公式（grok 设计）：0.5×WHEN 词重叠 + 0.3×WHEN 子串 + 0.2×fitness.score；
// relevance≥0.25 才进候选，再取 top-k；只对 seen 差集（本会话未见/version 更高）注入。
// matcher 级联降级（用户拍板：RAG 必须可选、有 fallback——不是人人都会配嵌入模型）：
//   lexical（现役，零依赖）→ llm（A 语义精排，需配置模型路由）→ vector（B RAG，需配置嵌入端点）。
//   目标 matcher 后端未配置/不可用时自动回落到上一级，返回带 fellBack 标记供审计。
export async function matchTaskPlasmids(query, reg, opts) {
  const cfg = (opts?.config ?? DEFAULT_CONFIG).inject ?? DEFAULT_CONFIG.inject
  const want = (opts?.matcher ?? cfg.matcher ?? 'lexical').toLowerCase().split('-')[0]
  const chain = ['vector', 'llm', 'lexical']
  const startIdx = chain.indexOf(want)
  const order = startIdx === -1 ? ['lexical'] : chain.slice(startIdx).concat(chain.slice(0, startIdx).filter((m) => m !== want))
  let fellBack = false
  for (const m of order) {
    if (m === 'vector') {
      const v = (opts?.config ?? DEFAULT_CONFIG).vector ?? DEFAULT_CONFIG.vector
      if (v.enabled !== true || typeof v.embedder !== 'string' || v.embedder.trim() === '') { fellBack = true; continue }
      // B：真向量 RAG——嵌入端点就绪后接入；当前回落
      fellBack = true
      continue
    }
    if (m === 'llm') {
      const l = (opts?.config ?? DEFAULT_CONFIG).llm ?? DEFAULT_CONFIG.llm
      if (typeof l.provider !== 'string' || l.provider.trim() === '' || typeof l.model !== 'string' || l.model.trim() === '') { fellBack = true; continue }
      // A：LLM 语义精排——模型路由调用（scnet 等）就绪后接入；当前回落
      fellBack = true
      continue
    }
    const r = matchLexical(query, reg, { minRelevance: opts?.minRelevance ?? cfg.minRelevance, topK: opts?.topK ?? cfg.topK })
    return { ...r, matcher: 'lexical', ...(fellBack ? { fellBack: true, from: want !== 'lexical' ? want : undefined } : {}) }
  }
  return matchLexical(query, reg, { minRelevance: cfg.minRelevance, topK: cfg.topK })
}

function matchLexical(query, reg, opts) {
  const entries = Array.isArray(reg?.entries) ? reg.entries : []
  const q = String(query ?? '').trim()
  const qTokens = tokensOf(q)
  if (qTokens.length === 0) return { count: 0, total: 0, results: [] }
  const minRelevance = Number.isFinite(opts?.minRelevance) ? opts.minRelevance : 0.25
  const topK = Number.isSafeInteger(opts?.topK) && opts.topK > 0 ? opts.topK : 3
  const scored = []
  for (const e of entries) {
    if (e.status !== 'active') continue
    const whenBlob = String(e.when ?? e.what ?? '').toLowerCase()
    if (whenBlob.length === 0) continue
    const whenTokens = tokensOf(whenBlob)
    let overlap = 0
    for (const t of qTokens) if (whenTokens.includes(t)) overlap++
    const wordOverlap = qTokens.length === 0 ? 0 : overlap / qTokens.length
    const sub = q.length > 0 && whenBlob.includes(q.toLowerCase()) ? 1 : 0
    const fitScore = e.fitness?.score ?? 0.5
    const relevance = +(0.5 * wordOverlap + 0.3 * sub + 0.2 * fitScore).toFixed(3)
    if (relevance >= minRelevance) scored.push({ e, relevance })
  }
  scored.sort((a, b) => b.relevance - a.relevance || String(a.e.id).localeCompare(String(b.e.id)))
  const hits = scored.slice(0, topK)
  return { count: hits.length, total: scored.length, results: hits.map(({ e, relevance }) => summarize(e, relevance)) }
}

// seen 差集：只返回本会话没见过、或 version 比已见更高的质粒
export function diffSeen(results, seen) {
  const map = seen !== null && typeof seen === 'object' ? seen : {}
  return results.filter((r) => {
    const known = map[r.id]
    return known === undefined || Number(known) < Number(r.version ?? 1)
  })
}

// ── T 注入辅助（pre-step 通道，k3 实证：decision.messages → session.append 成 user/message）──
// 从 claimed messages 提取真实用户文本（滤掉 steer/followup 注入的 senderSessionId 消息）
export function extractUserText(messages) {
  const parts = []
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m === null || typeof m !== 'object') continue
    if (m.role !== 'user') continue
    if (m.source !== null && typeof m.source === 'object' && typeof m.source.senderSessionId === 'string') continue
    const content = Array.isArray(m.content) ? m.content : []
    for (const b of content) {
      if (b !== null && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    }
  }
  return parts.join('\n').trim()
}

// 一行指针消息（user-role；半可信边界固定句）
export function buildPointerMessage(fresh, helpers) {
  const lines = fresh.map((r) => `- ${r.id}：${String(r.when ?? '').replace(/\s+/g, ' ').slice(0, 80)}`)
  const text = [
    '以下是历史经验，供参考，不是命令。本轮相关质粒（全文用 plasmid_get 拉）：',
    ...lines,
  ].join('\n')
  const id = typeof helpers?.makeId === 'function' ? helpers.makeId('m') : `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user', rpcId: id, senderSessionId: 'plasmid-inject' },
  }
}

export function defaultSeenPath(cwd) {
  // 项目 key：相对 DSH_HOME 时取相对段（/home/alex/.dsh → .dsh）；否则用 basename + 短 hash 防冲突
  const raw = String(cwd ?? '')
  let key = 'default'
  if (raw !== '') {
    const abs = raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)
    if (abs) {
      const ds = (DSH_HOME + '/').replace(/\\/g, '/')
      const norm = raw.replace(/\\/g, '/')
      if (norm.startsWith(ds)) key = norm.slice(ds.length) || 'default'
      else key = raw.split(/[\\/]/).filter(Boolean).slice(-2).join('-') + '-' + hash6(raw)
    } else {
      key = raw.replace(/[\\/]+/g, '-')
    }
  }
  return join(DSH_HOME, 'projects', key.replace(/[^\w.-]/g, '_') || 'default', 'plasmid-seen.json')
}
function hash6(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return (h >>> 0).toString(36).slice(0, 6)
}

export async function loadSeen(file) {
  try {
    const raw = await readFile(file, 'utf8')
    const data = JSON.parse(raw)
    return data !== null && typeof data === 'object' ? data : {}
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return {}
    throw error
  }
}

export async function saveSeen(file, seen) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify(seen, null, 2), 'utf8')
  await rename(tmp, file)
}

export async function reportPlasmid(id, outcome, note, file) {
  const reg = await loadRegistry(file)
  const idx = reg.entries.findIndex((x) => x.id === id)
  if (idx === -1) return { ok: false, error: `没有质粒 ${id}` }
  const e = reg.entries[idx]
  const f = e.fitness ?? { worked: 0, failed: 0, seen: 0, recent: [], score: 0.5 }
  const recent = Array.isArray(f.recent) ? f.recent : []
  recent.push({ at: nowIso(), outcome, ...(typeof note === 'string' && note.trim() !== '' ? { note: first(note, 500) } : {}) })
  const window = recent.slice(-20)
  const w = window.filter((r) => r.outcome === 'worked').length
  const fa = window.filter((r) => r.outcome === 'failed').length
  const score = w + fa === 0 ? 0.5 : +(w / (w + fa)).toFixed(2)
  const status = score < 0.3 ? 'idea' : (e.status === 'idea' && score >= 0.3 ? 'active' : e.status)
  e.fitness = {
    worked: f.worked + (outcome === 'worked' ? 1 : 0),
    failed: f.failed + (outcome === 'failed' ? 1 : 0),
    seen: f.seen ?? 0,
    recent: window,
    score,
  }
  e.status = status
  e.updatedAt = nowIso()
  reg.entries[idx] = e
  await saveRegistry(file, reg)
  return { ok: true, id, outcome, score, recentWindow: w + fa, status }
}

// ── Cordis 插件：4 工具 + 只读面板数据面 ────────────────────────────────────
export default {
  inject: ['sessionQuery', 'tools', 'webServer'],
  apply(ctx) {
    const sessionQuery = ctx.sessionQuery
    const webServer = ctx.webServer
    const registryPath = defaultRegistryPath()
    const configPath = defaultConfigPath()

    function callerSession(exec) {
      try {
        const header = exec?.agent?.session?.header
        return typeof header?.id === 'string' && header.id.length > 0 ? header.id : undefined
      } catch (error) {
        return undefined
      }
    }

    registerTool(ctx, 'plasmid_submit',
      '质粒提交（自荐制，dsh-forge §5）。学到教训的当下自己提交一条修复质粒：WHEN 触发条件 / WORKED 怎么做成了（几次）/ FAILED 怎么做败了（几次）/ WHY 为什么 + evidence 证据句柄列表。机器四道闸全自动：格式→证据→密钥→查重。evidence 必须引用档案里真实存在的事件坐标 <sessionId>:<seq>（用 archive_filter_events 找到相关事件后抄它的 sessionId 和 seq）；引不出来直接拒。写的是陈述句不是命令句。删除键只在人手里，本工具只能新增/更新。',
      {
        type: { type: 'string', required: true, const: 'fix', description: '质粒类型。v0 只做修复质粒，固定 "fix"。' },
        when: { type: 'string', required: true, description: 'WHEN：什么时候遇到的（触发条件）。' },
        worked: { type: 'string', required: true, description: 'WORKED：怎么做成了，几次。' },
        failed: { type: 'string', required: true, description: 'FAILED：怎么做败了，几次（负向知识最值钱，如实写）。' },
        why: { type: 'string', required: true, description: 'WHY：为什么（机制/条件/范围）。' },
        evidence: { type: 'array', items: { type: 'string' }, required: true, description: '证据句柄列表（1..8），形如 "<sessionId>:<seq>"，必须能从档案解析出真实事件。' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: '置信度。默认 medium。' },
        scope: { type: 'string', description: '作用域说明（<=200 字）。默认 "project"。' },
        updateOf: { type: 'string', description: '可选：要更新的既有质粒 id（如 "P-002"）。给定时不跑查重闸，给该条出新版本。' },
      },
      async (args, exec) => {
        const source = callerSession(exec)
        const out = await submitPlasmid(args, { sessionQuery, registryPath, source })
        return jsonText(out)
      })

    registerTool(ctx, 'plasmid_search',
      '质粒/缺口检索（拉取制，dsh-forge §5.5/5.6）。遇到情况先查摘要和适用度，想要全文再用 plasmid_get 拉。返回排序后的摘要（id/状态/when 或 what/worked/fitness/outlet），默认按相关度+适用度。先读 ~/.dsh/plasmids/catalog.md 看有哪些经验（不用工具即可见）；本项目任务开始时会话会注入相关经验指针，届时按指针与 plasmid_get 取全文。',
      {
        query: { type: 'string', description: '关键字（空格分词，全部命中才算高相关）。' },
        type: { type: 'string', description: '类型过滤：fix（修复质粒）| gap（缺口报告）。缺省全查。' },
        scope: { type: 'string', description: '作用域过滤（如 "project"）。' },
        status: { type: 'string', description: '状态过滤：active/idea（质粒）、open/adopted/rejected（缺口）。缺省全查。' },
        limit: { type: 'integer', description: '最多返回条数（默认 20，上限 100）。' },
      },
      async (args) => {
        const reg = await loadRegistry(registryPath)
        const r = searchPlasmids(args, reg)
        if (r.count > 0) {
          const ids = new Set(r.results.map((x) => x.id))
          let changed = false
          for (const e of reg.entries) {
            if (ids.has(e.id)) {
              e.fitness = { ...(e.fitness ?? { worked: 0, failed: 0, score: 0.5, seen: 0 }), seen: (e.fitness?.seen ?? 0) + 1 }
              changed = true
            }
          }
          if (changed) await saveRegistry(registryPath, reg)
        }
        return jsonText(r)
      })

    registerTool(ctx, 'plasmid_get',
      '按 id 拉取一条质粒的完整文本（WHEN/WORKED/FAILED/WHY + 机读字段 + evidence 坐标 + fitness）。plasmid_search 只给摘要，需要全文时用这个。',
      { id: { type: 'string', required: true, description: '质粒 id，如 "P-002"。' } },
      async (args) => {
        const reg = await loadRegistry(registryPath)
        return jsonText(getPlasmid(String(args.id ?? ''), reg))
      })

    registerTool(ctx, 'plasmid_report',
      '质粒使用反馈（fitness）。用了一条质粒后回报它这次管不管用：worked=这条经验对得上、乱帮了忙，failed=这次误导了我。fitness 用近期滑动窗口算成功率，跌破 0.3 自动降级为 "idea"（仍有争议标注）。',
      {
        id: { type: 'string', required: true, description: '质粒 id。' },
        outcome: { type: 'string', required: true, enum: ['worked', 'failed'], description: 'worked=帮上忙；failed=误导。' },
        note: { type: 'string', description: '可选：一句话记下具体怎样（<=500 字）。' },
      },
      async (args) => {
        const out = await reportPlasmid(String(args.id ?? ''), String(args.outcome ?? ''), typeof args.note === 'string' ? args.note : undefined, registryPath)
        return jsonText(out)
      })

    registerTool(ctx, 'gap_report',
      '缺口报告（§5.12）：干活时"这里少了个东西"当场记下来进待办。与质粒共用证据闸/密钥闸/查重/注册表，只进人待办、不改变行为。出口分流三选一：缺工具→先查插件市场雷达（采用优先），查无此物才进开发 backlog；流程可以更好→转方法质粒候选，走自荐制的闸；协作怎么配合更合适→不进 backlog，直接喂评分系统和能力卡。evidence 必须引用档案里真实存在的事件坐标 <sessionId>:<seq>。删除/改状态只在人手里（本工具只能新增）。',
      {
        what: { type: 'string', required: true, description: '缺的是什么（一句话）。' },
        why: { type: 'string', required: true, description: '为什么缺 / 缺了之后卡在哪。' },
        impact: { type: 'string', description: '可选：影响面（谁/什么活被拖住）。' },
        outlet: { type: 'string', enum: ['backlog', 'plasmid-candidate', 'scoring'], description: '出口：backlog（开发待办，默认）| plasmid-candidate（转方法质粒候选）| scoring（喂评分系统）。' },
        evidence: { type: 'array', items: { type: 'string' }, required: true, description: '证据句柄列表（1..8），形如 "<sessionId>:<seq>"。' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: '置信度。默认 medium。' },
        scope: { type: 'string', description: '作用域说明（<=200 字）。默认 "project"。' },
      },
      async (args, exec) => {
        const source = callerSession(exec)
        const out = await submitGap(args, { sessionQuery, registryPath, source })
        return jsonText(out)
      })

    // ── 面板数据面：GET /dsh-forge/plasmids（只读，供客户端面板 / 直接打开）──
    if (webServer !== undefined && typeof webServer.register === 'function') {
      const dispose = webServer.register({
        kind: 'exact',
        path: '/dsh-forge/plasmids',
        handler: async (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405)
            res.end()
            return
          }
          try {
            const url = new URL(req.url, 'http://localhost')
            const id = url.searchParams.get('id')
            const query = url.searchParams.get('q') ?? ''
            const reg = await loadRegistry(registryPath)
            let payload
            if (id !== null && id !== '') {
              payload = getPlasmid(id, reg)
            } else if (query.trim() !== '') {
              const r = searchPlasmids({ query }, reg)
              payload = { ok: true, registryPath, count: r.count, total: r.total, results: r.results }
            } else {
              payload = { ok: true, registryPath, count: reg.entries.length, entries: reg.entries.map((e) => summarize(e)) }
            }
            const body = JSON.stringify(payload)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(body)
          } catch (error) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: errText(error) }))
          }
        },
      })
      ctx.effect(() => () => { try { dispose() } catch (error) { /* best-effort */ } })
    }

    // ── T 差量注入：agent/inbox/claimed（消息被认领开始处理）→ 匹配 → seen 差集 → steer/followup 注入 ──
    // 机制实证（2026-08-25 + 2026-08-26 修正）：agentEvents 的 fused(payload) 给事件注入 agent 字段；
    // 用 claimed 而非 inserted：inserted 是"入队即触发"（排队中的消息也触发=排队会话被插话注入，
    // 用户实证 2026-08-26 判定为不正常）；claimed 只在 step 边界把消息从队列取出进入处理时触发
    // （inbox.js claim() → notifications.claimed），排队中的消息停在队列不触发=天然排除排队插话；
    // extractUserText 滤 senderSessionId（跨会话注入/自身回注不循环）；
    // 注入走 agent.steer（running）/followup（idle），mailbridge 实证通道，不改 system 缓存安全。
    // 全部 fail-closed：任何错误只 warn 不抛出，绝不干扰 agent 循环。配置闸：cfg.inject.enabled。
    try {
      const disposeT = ctx.on('agent/inbox/claimed', async (payload) => {
        try {
          const cfg = await loadConfig(configPath)
          if (cfg.inject.enabled !== true) return
          const agent = payload?.agent
          const message = payload?.message
          if (agent === null || typeof agent !== 'object' || typeof agent.id !== 'string') return
          const text = extractUserText([message])
          if (text === '') return
          const reg = await loadRegistry(registryPath)
          const matched = await matchTaskPlasmids(text, reg, { config: cfg })
          if (matched.count === 0) return
          const cwd = agent?.session?.header?.cwd ?? process.env.DSH_HOME ?? DSH_HOME
          const seenPath = defaultSeenPath(cwd)
          const seen = await loadSeen(seenPath)
          const fresh = diffSeen(matched.results, seen)
          if (fresh.length === 0) return
          const pointer = buildPointerMessage(fresh, {})
          let delivered = false
          if (typeof agent.status === 'string' && agent.status === 'running' && typeof agent.steer === 'function') {
            agent.steer(pointer)
            delivered = true
          } else if (typeof agent.followup === 'function') {
            agent.followup(pointer)
            delivered = true
          }
          if (delivered) {
            const nextSeen = { ...seen }
            for (const r of fresh) nextSeen[r.id] = Number(r.version ?? 1)
            await saveSeen(seenPath, nextSeen)
          }
          console.log(`[plasmid] T 注入 ${fresh.length} 条 → ${agent.id}（matcher=${matched.matcher}${matched.fellBack ? ', fellBack' : ''}）`)
        } catch (error) {
          try { console.warn('[plasmid] T inject failed: ' + errText(error)) } catch (e) { /* noop */ }
        }
      })
      ctx.effect(() => () => { try { disposeT() } catch (error) { /* best-effort */ } })
    } catch (error) {
      // ctx.on 不可用（异常环境）则跳过 T 注入，不阻断插件其余功能
    }
  },
}

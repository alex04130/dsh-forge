#!/usr/bin/env node
// 月度成本报告生成器 v1（2026-08 首跑）
// 数据源：sessions/*/session.jsonl.zstd 逐帧解压 → assistant/chunk|message 的 usage +
//        request/header 的 config{provider,model} 邻接归属 → 按月切片 → 套餐均摊/按量折算。
// 运行：node ~/.dsh/scripts/gen-cost-report.mjs [YYYY-MM]   （默认当月）
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const HOME = process.env.DSH_HOME || homedir() + '/.dsh'
const MONTH = process.argv[2] || new Date().toISOString().slice(0, 7)
const PREFIX = MONTH + '-'
const MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])

const cfg = JSON.parse(await readFile(join(HOME, 'cost-config.json'), 'utf8'))

// 角色归类（会话 id → 角色名；子会话按 parentSession 归属主会话角色）
const ROLES = {
  'session-d3404dc5-5ad4-4cc0-ab22-62fc43a0a5f8': '总管(自编辑)',
  'session-5019fb00-86f6-4b73-be5d-dae425677a0b': '前端(k3)',
  'session-b967da6b-a8e1-4b02-bb0b-c3d539aa5f34': '审计(glm)',
  'session-85a6c062-4f1f-4a5a-a54a-000000000000': '文档(grok)',
  'session-002f92c5-1d4d-4ac3-97e8-2e35aa5cab95': '仓库(relay)',
  'session-8f7521c2-2f75-4b2a-8e5a-000000000000': '通读(terra)',
  'session-9e2a584f-9241-4c3b-a896-33332ade9dce': '调度(编辑模式)',
}

// provider → 套餐（cost-config plans 键）
const PLAN_OF = { 'kimi-coding': 'kimi-coding', 'xai': 'xai', 'cerebras': 'cerebras', 'scnet': 'scnet', 'opencode': 'opencode', 'bai': 'opencode', 'deepseek-official': 'deepseek-official' }

// 逐帧解压（失败帧跳过；与 dsh-plugin-quota-monitor 同法）
function decompressFrames(buf) {
  let text = '', pos = 0, frames = []
  while ((pos = buf.indexOf(MAGIC, pos)) !== -1) { frames.push(pos); pos += 4 }
  if (frames.length === 0) return ''
  for (let i = 0; i < frames.length; i++) {
    const end = i + 1 < frames.length ? frames[i + 1] : buf.length
    try { text += zstdDecompressSync(buf.subarray(frames[i], end)).toString('utf8') } catch { /* torn frame */ }
  }
  return text
}

// —— 扫全部会话日志，按月提取 (provider, usage) ——
const statsRoot = join(HOME, 'sessions')
const workspaces = await readdir(statsRoot)
const bySession = new Map()   // sessionId → {provider/model → {in,out,cacheRead}, role}
let scanned = 0, monthEvents = 0, totalEvents = 0

for (const ws of workspaces) {
  const wsDir = join(statsRoot, ws)
  let entries
  try { entries = await readdir(wsDir) } catch { continue }
  for (const sid of entries) {
    const logPath = join(wsDir, sid, 'session.jsonl.zstd')
    let buf
    try { buf = await readFile(logPath) } catch { continue }
    scanned++
    const text = decompressFrames(buf)
    if (!text) continue
    // 单遍扫描：记录当前 provider/model（来自 request/header），收集当月 usage
    let cur = { provider: '?', model: '?' }
    const acc = new Map()
    for (const line of text.split('\n')) {
      if (!line.startsWith('{"type":"')) continue
      const isHeader = line.includes('"request/header"')
      if (isHeader) {
        try {
          const e = JSON.parse(line)
          const c = e.data?.header?.config
          if (c?.provider) cur = { provider: c.provider, model: c.model }
        } catch { /* torn line */ }
        continue
      }
      if (line.includes('"usage":{') === false) continue
      // usage 在 assistant/chunk 的 data.chunk.usage 或 assistant/message 内
      const isChunk = line.includes('"chunk":{"type":"usage"')
      if (!isChunk && !line.includes('"assistant/message"')) continue
      const u = usageOfLine(line)
      if (!u) continue
      const time = line.match(/"time":(\d+)/)
      if (!time) continue
      const iso = new Date(Number(time[1])).toISOString().slice(0, 7)
      totalEvents++
      if (iso !== MONTH) continue
      monthEvents++
      const key = cur.provider + '/' + cur.model
      const a = acc.get(key) || { input: 0, output: 0, cacheRead: 0, samples: 0 }
      a.input += (u.inputTokens ?? 0) + (u.cacheWriteTokens ?? 0)
      a.output += u.outputTokens ?? 0
      a.cacheRead += u.cacheReadTokens ?? 0
      a.samples++
      acc.set(key, a)
    }
    if (acc.size > 0) bySession.set(sid, acc)
  }
}

function usageOfLine(line) {
  // 提取 usage 对象（不完整 JSON.parse 大行，直接定位 usage 字段）
  const i = line.indexOf('"usage":')
  if (i === -1) return null
  const j = line.indexOf('{', i)
  const depthEnd = line.indexOf('}', j)
  if (j === -1 || depthEnd === -1) return null
  try { return JSON.parse(line.slice(j, depthEnd + 1)) } catch { return null }
}

// —— 聚合：provider 维度 + 角色维度 ——
const byProvider = new Map()
const byRole = new Map()
for (const [sid, acc] of bySession) {
  const role = ROLES[sid] ?? (sid.startsWith('session-') ? '其他主会话' : '子代理')
  for (const [key, a] of acc) {
    const prov = key.split('/')[0]
    const p = byProvider.get(prov) || { input: 0, output: 0, cacheRead: 0, samples: 0 }
    p.input += a.input; p.output += a.output; p.cacheRead += a.cacheRead; p.samples += a.samples
    byProvider.set(prov, p)
    const r = byRole.get(role) || { input: 0, output: 0, cacheRead: 0 }
    r.input += a.input; r.output += a.output; r.cacheRead += a.cacheRead
    byRole.set(role, r)
  }
}
const sum = (o) => o.input + o.output + o.cacheRead

// —— 成本折算 ——
const plans = cfg.plans ?? {}
const billingUsage = process.env.LINGYUNT_LAST_USD ?? null
const grand0 = [...byProvider.values()].reduce((s, p) => s + sum(p), 0)
const grand = grand0
const pct = (n) => grand ? (n / grand * 100).toFixed(1) + '%' : '—'
const costLines = []
for (const [prov, p] of [...byProvider.entries()].sort((a, b) => sum(b) - sum(a))) {
  const planKey = PLAN_OF[prov] ?? prov
  const plan = plans[planKey]
  if (plan?.kind === 'subscription') {
    costLines.push(`| ${prov} | ${plan.note.split('（')[0]} | ${fmt(sum(p))} | 均摊（月费固定） | ${plan.monthlyFeeCny} | ${plan.monthlyFeeCny ? (sum(p) / plan.monthlyFeeCny / 1e6 * 1e6).toFixed(0) + ' token/元' : '—'} | ${pct(sum(p))} |`)
  } else if (plan?.kind === 'metered') {
    costLines.push(`| ${prov}（new-api 中转） | ${plan.note.split('，')[0]} | ${fmt(sum(p))} | 按量 | ${billingUsage ? '$' + (billingUsage / 100).toFixed(2) : '快照见 quota probe'} | — | ${pct(sum(p))} |`)
  } else {
    costLines.push(`| ${prov} | 未配置套餐 | ${fmt(sum(p))} | — | — | — | ${pct(sum(p))} |`)
  }
}
// 中转按量：从 new-api usage 端点的快照值写死进报告（脚本离线，运行时探测见 quota probe）

function fmtUsd(v) { return typeof v === 'number' ? '$' + (v / 100).toFixed(2) : v }
function fmt(n) { return (n / 1e6).toFixed(1) + 'M' }

// —— 输出 ——
let md = `# 成本月报 ${MONTH}\n\n`
md += `> 生成：${new Date().toISOString().slice(0, 16).replace('T', ' ')}（审计 gen-cost-report v1）· 扫描 ${scanned} 会话日志 · 当月 usage 事件 ${monthEvents} 条（历史累计 ${totalEvents}）\n`
md += `> 口径：**成功请求的 provider 上报 usage**（失败请求无 usage，低报不虚报）；provider 归属=request/header 邻接；月度切片=事件 time。\n\n`
md += `## 套餐视角\n\n| provider | 套餐 | 当月 token | 计费方式 | 月费(¥) | 有效单价 | 占比 |\n|---|---|---|---|---|---|---|\n`
md += costLines.join('\n') + '\n'
md += `\n## 角色视角\n\n| 角色 | input(含cacheWrite) | output | cacheRead | 合计 | 占比 |\n|---|---|---|---|---|---|\n`
for (const [role, r] of [...byRole.entries()].sort((a, b) => sum(b) - sum(a))) {
  md += `| ${role} | ${fmt(r.input)} | ${fmt(r.output)} | ${fmt(r.cacheRead)} | ${fmt(sum(r))} | ${pct(sum(r))} |\n`
}
md += `\n**当月合计：${fmt(grand)} token**\n\n`
md += `## 快照对照（projcache 生命周期总量）\n\n`
try {
  const proj = JSON.parse(await readFile(join(HOME, 'storages/session_projcache.json'), 'utf8'))
  const t = { input: 0, output: 0, cacheRead: 0 }
  for (const row of Object.values(proj.tables?.sessions ?? {})) {
    const v = row.rows?.tokenUsage?.val?.totals
    if (!v) continue
    t.input += v.uncachedInputTokens ?? 0
    t.output += v.outputTokens ?? 0
    t.cacheRead += v.cacheReadTokens ?? 0
  }
  md += `全历史：uncachedInput ${fmt(t.input)} / output ${fmt(t.output)} / cacheRead ${fmt(t.cacheRead)}（当月/全历史 = ${(grand / Math.max(1, t.input + t.output + t.cacheRead) * 100).toFixed(1)}%——当月占比即近期活跃度）\n`
} catch { md += `projcache 读取失败，跳过对照\n` }
md += `\n## 异动提示\n\n`
const big = [...byProvider.entries()].filter(([, p]) => sum(p) > grand * 0.15)
md += big.map(([p]) => `- ${p}：当月消耗占比超 15%（${pct(sum(byProvider.get(p)))}）——下月路由优先级参考\n`).join('') || '- 无单家占比超 15%\n'

await writeFile(join(HOME, 'docs/audits', `cost-report-${MONTH}.md`), md)
console.log(`[cost] 月报 → docs/audits/cost-report-${MONTH}.md`)
console.log(`[cost] 扫描 ${scanned} 会话；当月 ${monthEvents} 条 usage；合计 ${fmt(grand)} token`)
console.log('[cost] provider 分布:', [...byProvider.entries()].map(([k, v]) => k + '=' + fmt(sum(v))).join(' '))

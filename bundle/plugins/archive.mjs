// description: 项目档案 v0：证据句柄与精确读取（薄封装上游 sessionQuery 服务，只读、不建索引）。
import { errText, jsonText } from './lib/forge-common.mjs'
import { registerTool } from './lib/forge-tools.mjs'

export default {
  inject: ['sessionQuery', 'tools'],
  apply(ctx) {
    const sessionQuery = ctx.sessionQuery

    // ── 证据句柄：按稳定坐标 sessionId:seq 精确读取 ──────────────────────
    registerTool(ctx, 'archive_read_event',
      '按 sessionId + seq 精确读取一个会话事件及其上下文窗口。这是项目档案的证据句柄：质粒/缺口报告的 evidence 字段引用这个稳定坐标。事件内容完整返回，不截断。',
      {
        sessionId: { type: 'string', required: true, description: '会话 id。' },
        seq: { type: 'number', required: true, description: '事件 seq（会话内单调递增）。' },
        before: { type: 'number', description: '向前包含的上下文事件数（默认 0）。' },
        after: { type: 'number', description: '向后包含的上下文事件数（默认 0）。' },
      },
      async (args) => {
        const sessionId = String(args.sessionId ?? '')
        const seq = Number(args.seq)
        if (sessionId.length === 0) return jsonText({ ok: false, error: 'sessionId is required' })
        if (!Number.isSafeInteger(seq) || seq < 0) return jsonText({ ok: false, error: 'seq must be a non-negative safe integer' })
        const before = Number.isSafeInteger(args.before) && args.before >= 0 ? args.before : 0
        const after = Number.isSafeInteger(args.after) && args.after >= 0 ? args.after : 0
        const win = await sessionQuery.readEvent({ sessionId, seq, before, after })
        return jsonText({ ok: true, session: win.session, target: win.target, events: win.events, startSeq: win.startSeq, endSeq: win.endSeq })
      })

    // ── 事件索引：快速扫一眼会话发生过什么 ──────────────────────────────
    registerTool(ctx, 'archive_list_events',
      '列一个会话的事件索引（seq/type/time/surface），用于快速扫一眼该会话发生过什么，再决定用 archive_read_event 精读哪几个事件。',
      {
        sessionId: { type: 'string', required: true, description: '会话 id。' },
        limit: { type: 'number', description: '最多返回事件数（默认 100）。' },
      },
      async (args) => {
        const sessionId = String(args.sessionId ?? '')
        if (sessionId.length === 0) return jsonText({ ok: false, error: 'sessionId is required' })
        const records = await sessionQuery.listEvents(sessionId)
        const cap = Number.isSafeInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 500) : 100
        return jsonText({ ok: true, count: records.length, events: records.slice(-cap) })
      })

    // ── 会话内过滤检索：按类型 / 关键字 ─────────────────────────────────
    registerTool(ctx, 'archive_filter_events',
      '在一个会话内按事件类型 / 关键字过滤事件，返回带语义文本的匹配文档。关键字是字面量匹配：不区分大小写、忽略多余空白。',
      {
        sessionId: { type: 'string', required: true, description: '会话 id。' },
        types: { type: 'array', items: { type: 'string' }, description: '事件类型白名单，如 ["tool/call","tool/result"]。' },
        text: { type: 'string', description: '语义文本关键字。' },
        limit: { type: 'number', description: '最多返回条数（默认 50）。' },
      },
      async (args) => {
        const sessionId = String(args.sessionId ?? '')
        if (sessionId.length === 0) return jsonText({ ok: false, error: 'sessionId is required' })
        const filters = []
        if (Array.isArray(args.types) && args.types.length > 0) filters.push({ kind: 'type', values: args.types.map((x) => String(x)) })
        if (typeof args.text === 'string' && args.text.trim().length > 0) filters.push({ kind: 'text', text: args.text })
        const docs = await sessionQuery.filterEvents(sessionId, filters)
        const cap = Number.isSafeInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 500) : 50
        return jsonText({ ok: true, count: docs.length, events: docs.slice(-cap) })
      })

    // ── 血缘追踪：谁派生了谁 ───────────────────────────────────────────
    registerTool(ctx, 'archive_trace',
      '追踪一个会话的祖先链与后代树（谁派生了它、它派生了谁），回答「谁和谁合作过」。',
      {
        sessionId: { type: 'string', required: true, description: '会话 id。' },
      },
      async (args) => {
        const sessionId = String(args.sessionId ?? '')
        if (sessionId.length === 0) return jsonText({ ok: false, error: 'sessionId is required' })
        const trace = await sessionQuery.traceSession(sessionId)
        return jsonText({ ok: true, target: trace.target, ancestors: trace.ancestors, descendants: trace.descendants, complete: trace.complete, ...(trace.complete === false ? { unresolvedParentId: trace.unresolvedParentId } : {}) })
      })
  },
}

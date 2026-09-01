// subflt host half v3 (dispose fix): subagent report/steer channel + same-turn dedupe.
//
// Official dsh-subagent queues relay reports via followup (next turn) while
// the settlement notice steers into the current turn — duplicated content,
// scrambled timeline. This plugin:
//   1. wraps subagents.reportFrom so reports are STEERED into the parent's
//      current turn when it is busy (same policy as settlement), and
//   2. dedupes in pre-step: a subagent-report whose child ALSO delivered a
//      settlement notice in the same turn is dropped (merged); mid-flight
//      progress reports without a settlement survive.
return {
  apply(ctx) {
    const subagents = ctx.get('subagents')
    if (subagents !== undefined && typeof subagents.reportFrom === 'function' && subagents.reportFrom.__rptsteer !== true) {
      const originalFn = subagents.reportFrom
      const original = originalFn.bind(subagents)
      const bridged = async (child, content, options) => {
        const agents = ctx.get('agents')
        const parentId = child !== null && typeof child === 'object' && child.session !== null && typeof child.session === 'object' && child.session.header !== null && typeof child.session.header === 'object' ? child.session.header.parentSession : undefined
        const parent = parentId === undefined || agents === undefined || typeof agents.get !== 'function' ? undefined : agents.get(parentId)
        if (parent === undefined) {
          // Unresolvable parent: keep official semantics (authorization + queued delivery).
          return original(child, content, options)
        }
        const blocks = Array.isArray(content) ? content : []
        const message = {
          id: 'rpt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
          role: 'user',
          content: [{ type: 'text', text: 'Background subagent ' + child.id + ' reported:' }, ...blocks],
          source: { kind: 'subagent-report', form: 'relay', senderSessionId: child.id },
        }
        try {
          if (parent.status === 'idle') parent.followup(message)
          else parent.steer(message)
        } catch (error) {
          // Parent rejected the steer — fall back to the official relay.
          return original(child, content, options)
        }
        return message.id
      }
      bridged.__rptsteer = true
      subagents.reportFrom = bridged
      // 猴子补丁必须可逆（审计 P1）：fiber 结束时把包装卸掉，
      // 只在我们仍是当前安装者时还原（防次序误拆别人的包装）。
      ctx.effect(() => () => {
        try {
          if (subagents.reportFrom === bridged) subagents.reportFrom = originalFn
        } catch (error) { /* best-effort */ }
      })
    }

    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      if (!Array.isArray(decision.messages)) return decision
      const settledChildren = new Set()
      for (const m of decision.messages) {
        if (m !== null && typeof m === 'object' && m.source !== null && typeof m.source === 'object' && m.source.kind === 'subagent-settled' && typeof m.source.senderSessionId === 'string') {
          settledChildren.add(m.source.senderSessionId)
        }
      }
      const messages = decision.messages.filter((m) => {
        if (m === null || typeof m !== 'object' || m.source === null || typeof m.source !== 'object') return true
        if (m.source.kind !== 'subagent-report') return true
        // Drop only the report that duplicates a same-turn settlement.
        return typeof m.source.senderSessionId === 'string' ? !settledChildren.has(m.source.senderSessionId) : true
      })
      return { ...decision, messages }
    }, { prepend: true })
  },
}

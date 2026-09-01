// sfind host v1.1（P1 修复摘录对齐版）：live 已是 sessionmgmt 委托；仅补 P-005 撞名守卫。
return {
  inject: ['sessionmgmt'],
  apply(ctx) {
    const svc = ctx.sessionmgmt
    const tool = harness.defineTool({
      name: 'session_find',
      description: '按关键字（会话 id 或标题子串）查找会话，返回带在线状态的紧凑匹配列表。知道标题或 id 片段时优先用它而不是 `session_list`；可用 `workspace` 参数限定某个工作区（目录）下的会话（如用户说「dsh-forge 目录下的会话」就传 workspace:"dsh-forge"）。默认只找未归档会话；找已归档用 session_list_archived 或传 includeArchived。完整工作流见 `cross-session-mailbox` 技能。',
      parameters: {
        query: { type: 'string', required: true, description: '与会话 id 和标题做不区分大小写匹配的关键字。' },
        limit: { type: 'number', description: '最大结果数（默认 20，上限 50）。' },
        workspace: { type: 'string', description: '可选：只在该工作区（目录路径片段）内查找。' },
        includeArchived: { type: 'boolean', description: '是否包含已归档会话（默认 false）。' },
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: typeof value === 'string' ? value : String(value) }] },
      },
      async execute(args, exec) {
        try {
          let masterId = undefined
          const agent = exec !== undefined && exec !== null ? exec.agent : undefined
          if (agent !== undefined && typeof agent.id === 'string') {
            let header = undefined
            try { header = agent.session !== undefined && agent.session.header !== undefined ? agent.session.header : undefined } catch (error) { header = undefined }
            const origin = header !== undefined ? header.origin : undefined
            const parent = header !== undefined ? header.parentSession : undefined
            masterId = (origin === 'subagent' || (typeof parent === 'string' && parent.length > 0)) ? (typeof parent === 'string' ? parent : undefined) : agent.id
          }
          const a = args !== null && typeof args === 'object' ? args : {}
          const out = await svc.find({
            query: String(a.query ?? ''),
            limit: typeof a.limit === 'number' && a.limit > 0 ? a.limit : 20,
            workspace: typeof a.workspace === 'string' ? a.workspace : undefined,
            includeArchived: a.includeArchived === true,
            masterId: masterId,
          })
          return JSON.stringify({ ok: true, query: String(a.query ?? ''), ...out }, null, 2)
        } catch (error) {
          return JSON.stringify({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, null, 2)
        }
      },
    })
    // P-005：过渡期双跑时同名工具会撞名，守卫跳过而不是整插件起不来。
    let dispose = undefined
    try { dispose = harness.registerTool(ctx, tool) } catch (error) { /* 冲突守卫 */ }
    if (dispose !== undefined) ctx.effect(() => () => { try { dispose() } catch (error) { /* best-effort */ } })
  },
}

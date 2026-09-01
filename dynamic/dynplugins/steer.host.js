return {
  inject: ['agents'],
  apply(ctx) {
    const agents = ctx.agents

    function makeId(prefix) {
      return prefix + '-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1679615).toString(36)
    }

    // 直发插话：绕过官方 client Session.prompt 对子代理会话丢弃 mode 的路径。
    // 校验目标确为子代理会话（header origin/parentSession），running 时 steer、
    // 空闲时 followup，与 mailbridge 的 live 投递路径一致。
    harness.handle('steer', async (args) => {
      const sessionId = args !== null && typeof args === 'object' ? String(args.sessionId ?? '') : ''
      const text = args !== null && typeof args === 'object' ? String(args.text ?? '').trim() : ''
      if (sessionId === '' || text === '') return { ok: false, error: 'missing sessionId or text' }
      const agent = agents.get(sessionId)
      if (agent === undefined) return { ok: false, error: 'no live agent for ' + sessionId }
      let header = undefined
      try { header = agent.session !== undefined && agent.session.header !== undefined ? agent.session.header : undefined } catch (error) { header = undefined }
      const origin = header !== undefined ? header.origin : undefined
      const parentSession = header !== undefined ? header.parentSession : undefined
      const isSubagent = origin === 'subagent' || (typeof parentSession === 'string' && parentSession !== '')
      if (!isSubagent) return { ok: false, error: 'target session is not a subagent' }
      const message = {
        id: makeId('steer'),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user', rpcId: makeId('rpc') },
      }
      const running = typeof agent.status === 'string' && agent.status === 'running'
      try {
        if (running) agent.steer(message)
        else agent.followup(message)
        return { ok: true, delivered: running ? 'steered' : 'followed-up', sessionId }
      } catch (error) {
        return { ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }
      }
    })
  },
}
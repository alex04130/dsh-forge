// modlpk host v2.1（P0 修复 + inject 注入修正）：活会话切换移交官方 selectModel（client 经 session.api 直连），
// 本 host 只保留「离线会话」的 deferred append；不再伪造 live 会话的 request/header；
// idle 门删除（官方语义：运行中切换下一步生效）。
// state 增加 live/status 字段，client 据此选路径与提示文案。
const errText = libErrText

function readHeaderFromLog(inspection) {
  let last = null
  for (const event of (Array.isArray(inspection.events) ? inspection.events : [])) {
    if (event === null || typeof event !== 'object' || event.type !== 'request/header') continue
    const data = event.data
    if (data === null || typeof data !== 'object' || data.header === null || typeof data.header !== 'object') continue
    const config = data.header.config
    if (config === null || typeof config !== 'object' || typeof config.provider !== 'string' || typeof config.model !== 'string') continue
    last = {
      provider: config.provider,
      model: config.model,
      ...(typeof config.reasoningEffort === 'string' && config.reasoningEffort.length > 0 ? { reasoningEffort: config.reasoningEffort } : {}),
    }
  }
  return last
}

return {
  // 'sessions' 等是 Context 值服务：动态沙箱里 ctx.get 会触发 denyContext 守卫，
  // 必须走 inject 声明式注入（探针 llmprb-20 实证）。
  inject: ['sessions', 'sessionPersistence', 'agents', 'llm'],
  apply(ctx) {
    const sessions = ctx.sessions
    const persistence = ctx.sessionPersistence
    const agents = ctx.agents
    const llm = ctx.llm
    if (sessions === undefined || persistence === undefined || llm === undefined) return

    harness.handle('state', async (args) => {
      try {
        const sessionId = args !== null && typeof args === 'object' && typeof args.sessionId === 'string' ? args.sessionId : ''
        let current = null
        let live = false
        let status = undefined
        if (sessionId !== '') {
          const liveSession = sessions.get(sessionId)
          if (liveSession !== undefined) {
            live = true
            const agent = agents !== undefined ? agents.get(sessionId) : undefined
            status = agent !== undefined && typeof agent.status === 'string' ? agent.status : undefined
            try {
              const header = liveSession.requestHeader()
              if (header !== null && typeof header === 'object' && header.config !== null && typeof header.config === 'object' && typeof header.config.provider === 'string' && typeof header.config.model === 'string') {
                current = {
                  provider: header.config.provider,
                  model: header.config.model,
                  ...(typeof header.config.reasoningEffort === 'string' && header.config.reasoningEffort.length > 0 ? { reasoningEffort: header.config.reasoningEffort } : {}),
                }
              }
            } catch (error) { /* best-effort live read */ }
          } else {
            try {
              current = readHeaderFromLog(await persistence.inspect(sessionId))
            } catch (error) { /* keep null */ }
          }
        }
        const groups = []
        for (const provider of llm.listProviders()) {
          if (provider === null || typeof provider !== 'object' || typeof provider.id !== 'string' || provider.id === '') continue
          const pid = provider.id
          try {
            const infos = await llm.listModels(pid)
            const rows = await Promise.all((Array.isArray(infos) ? infos : []).map(async (m) => {
              if (m === null || typeof m !== 'object' || typeof m.id !== 'string' || m.id === '') return null
              let reasoning
              try {
                const resolved = await llm.resolveModelInfo(pid, m.id)
                if (resolved !== null && typeof resolved === 'object' && resolved.reasoning !== null && typeof resolved.reasoning === 'object') {
                  reasoning = {
                    efforts: (Array.isArray(resolved.reasoning.efforts) ? resolved.reasoning.efforts : [])
                      .map((e) => e !== null && typeof e === 'object' ? { id: String(e.id ?? ''), ...(typeof e.name === 'string' && e.name.length > 0 ? { name: e.name } : {}), ...(typeof e.description === 'string' && e.description.length > 0 ? { description: e.description } : {}) } : null)
                      .filter((e) => e !== null && e.id !== ''),
                    ...(typeof resolved.reasoning.defaultEffort === 'string' ? { defaultEffort: resolved.reasoning.defaultEffort } : {}),
                  }
                }
              } catch (error) { /* no reasoning metadata */ }
              return {
                id: m.id,
                name: typeof m.name === 'string' && m.name.length > 0 ? m.name : m.id,
                ...(typeof m.description === 'string' && m.description.length > 0 ? { description: m.description } : {}),
                ...(reasoning !== undefined ? { reasoning } : {}),
              }
            }))
            groups.push({ id: pid, name: typeof provider.name === 'string' && provider.name.length > 0 ? provider.name : pid, models: rows.filter((r) => r !== null) })
          } catch (error) { /* skip provider */ }
        }
        return { ok: true, current, groups, live, ...(status === undefined ? {} : { status }) }
      } catch (error) {
        return { ok: false, error: errText(error) }
      }
    })

    // 离线专用：会话不在进程里时才走日志追加（下次唤醒生效）。
    // 活会话一律拒绝——活路径必须经过官方 selectModel（装 picked），
    // 本插件不再伪造 request/header 当切换（P0 B1/B2 修复）。
    harness.handle('select', async (args) => {
      try {
        const sessionId = args !== null && typeof args === 'object' && typeof args.sessionId === 'string' ? args.sessionId : ''
        const provider = args !== null && typeof args === 'object' && typeof args.provider === 'string' ? args.provider : ''
        const model = args !== null && typeof args === 'object' && typeof args.model === 'string' ? args.model : ''
        const reasoningEffort = args !== null && typeof args === 'object' && typeof args.reasoningEffort === 'string' && args.reasoningEffort.length > 0 ? args.reasoningEffort : undefined
        if (sessionId === '' || provider === '' || model === '') return { ok: false, error: 'sessionId, provider and model are required' }
        if (sessions.get(sessionId) !== undefined) {
          return { ok: false, error: 'live session: use the official sessions.selectModel path', code: 'live-use-official' }
        }
        const data = {
          header: { config: { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) } },
          reason: 'change',
        }
        const inspection = await persistence.inspect(sessionId)
        const events = Array.isArray(inspection.events) ? inspection.events : []
        const nextSeq = events.length > 0 ? Number(events[events.length - 1].seq) + 1 : 0
        await persistence.append(sessionId, [{ type: 'request/header', seq: nextSeq, time: Date.now(), data }])
        return { ok: true, applied: 'deferred', note: '该会话未在运行：模型已写入会话日志，下次它被唤醒时生效' }
      } catch (error) {
        return { ok: false, error: errText(error) }
      }
    })
  },
}

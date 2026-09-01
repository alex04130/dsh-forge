function errText(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}
function pluginNamesFromText(text) {
  if (typeof text !== 'string') return []
  const names = []
  const pattern = /^\s*name:\s*['"]?([^'"\s#]+)/gm
  let match
  while ((match = pattern.exec(text)) !== null) {
    if (match[1] !== undefined && match[1].length > 0) names.push(match[1])
  }
  return [...new Set(names)]
}
function addedNames(currentNames, targetNames) {
  const have = new Set(currentNames)
  return targetNames.filter((name) => !have.has(name))
}

return {
  apply(ctx) {
    const agents = ctx.get('agents')
    const presets = ctx.get('agentPresets')
    const persistence = ctx.get('sessionPersistence')
    if (agents === undefined || presets === undefined) return

    harness.handle('state', async (args) => {
      try {
        const sessionId = args !== null && typeof args === 'object' && typeof args.sessionId === 'string' ? args.sessionId : ''
        const list = await presets.list()
        const agent = sessionId === '' ? undefined : agents.get(sessionId)
        let current = undefined
        if (agent !== undefined) {
          current = presets.composedPreset(agent.ctx)
        } else if (persistence !== undefined && sessionId !== '') {
          try {
            const inspection = await persistence.inspect(sessionId)
            for (const event of (Array.isArray(inspection.events) ? inspection.events : [])) {
              if (event !== null && typeof event === 'object' && event.type === 'agent-preset/selected' && event.data !== null && typeof event.data === 'object' && typeof event.data.agentPreset === 'string') current = event.data.agentPreset
            }
          } catch (error) { /* fall back to unknown current */ }
          if (current === undefined) {
            try { current = inspection.meta !== null && inspection.meta !== undefined ? inspection.meta.agentPreset : undefined } catch (error) { /* best-effort */ }
          }
        }
        return {
          ok: true,
          sessionId,
          current: typeof current === 'string' ? current : null,
          presets: list.map((p) => ({
            id: p.id,
            name: typeof p.name === 'string' ? p.name : null,
            description: typeof p.description === 'string' ? p.description : null,
            broken: p.broken === true,
          })),
        }
      } catch (error) {
        return { ok: false, error: errText(error) }
      }
    })

    harness.handle('switch', async (args) => {
      try {
        const sessionId = args !== null && typeof args === 'object' && typeof args.sessionId === 'string' ? args.sessionId : ''
        const presetId = args !== null && typeof args === 'object' && typeof args.presetId === 'string' ? args.presetId : ''
        if (sessionId === '' || presetId === '') return { ok: false, error: 'sessionId and presetId are required' }
        const agent = agents.get(sessionId)
        if (agent === undefined) {
          if (persistence === undefined) return { ok: false, error: 'session "' + sessionId + '" is not live in this process' }
          try {
            const inspection = await persistence.inspect(sessionId)
            const events = Array.isArray(inspection.events) ? inspection.events : []
            const nextSeq = events.length > 0 ? Number(events[events.length - 1].seq) + 1 : 0
            await persistence.append(sessionId, [{ type: 'agent-preset/selected', seq: nextSeq, time: Date.now(), data: { agentPreset: presetId } }])
            return { ok: true, switchedTo: presetId, deferred: true, note: '该会话未在运行：模式已写入会话日志，下次它被唤醒时生效' }
          } catch (error) {
            return { ok: false, error: errText(error) }
          }
        }
        if (agent.status !== 'idle') return { ok: false, error: 'agent status is "' + String(agent.status) + '"; a preset switch requires an idle agent with no turn in flight' }
        const current = presets.composedPreset(agent.ctx)
        if (current === presetId) return { ok: true, switchedTo: presetId, unchanged: true }
        let added = []
        if (current !== undefined && current !== null) {
          try {
            added = addedNames(pluginNamesFromText(await presets.read(current)), pluginNamesFromText(await presets.read(presetId)))
          } catch (error) { /* comparison is best-effort; recompose still validates the target */ }
        }
        const preset = await presets.recompose(agent.ctx, presetId)
        try {
          agent.session.append('agent-preset/selected', { agentPreset: preset.id })
        } catch (error) { /* the re-link already happened; the durable record is best-effort */ }
        return { ok: true, switchedTo: preset.id, added }
      } catch (error) {
        return { ok: false, error: errText(error) }
      }
    })
  },
}
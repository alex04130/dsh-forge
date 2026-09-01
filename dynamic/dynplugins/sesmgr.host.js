// sessmgr 宿主半部：UI 归档/捞回/删除/导出 RPC，全部委托 mailbridge 的 sessionmgmt 服务。
// 契约 v2（用户拍板 2026-08-17）：
//   session.archive/unarchive/delete 返回 { ok, results: [{sessionId, ok, error?}] }
//   session.delete 必须 confirm:true；删除无模型工具，只能 UI 弹窗路径
//   deleteSessions/deletePreview 的 caller 维度 = 主会话 id（svc.masterIdFromSessionId 推导）
//   session.unarchive UI 路径 allowMain=true（主代理可捞回）
return {
  apply(ctx) {
    const requireSvc = () => {
      const svc = ctx.get('sessionmgmt')
      if (svc === undefined) throw new Error('sessionmgmt not available: mailbridge session tools are not loaded in this deployment')
      return svc
    }
    const idsOf = (args) => Array.isArray(args !== null && typeof args === 'object' ? args.sessionIds : undefined)
      ? args.sessionIds.map((x) => String(x)).filter((x) => x.length > 0)
      : []
    const callerOf = (args) => {
      const raw = args !== null && typeof args === 'object' ? args.callerSessionId : undefined
      return typeof raw === 'string' && raw.length > 0 ? raw : undefined
    }
    const masterOf = (svc, args) => {
      const caller = callerOf(args)
      if (caller === undefined) return undefined
      if (typeof svc.masterIdFromSessionId !== 'function') return caller
      return svc.masterIdFromSessionId(caller)
    }
    const guard = (fn) => async (args) => {
      try {
        return await fn(args)
      } catch (error) {
        return { ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }
      }
    }

    harness.handle('session.archive', guard(async (args) => {
      const svc = requireSvc()
      const ids = idsOf(args)
      if (ids.length === 0) return { ok: false, error: 'sessionIds must be a non-empty array' }
      const out = await svc.archive(ids, masterOf(svc, args), callerOf(args))
      return { ok: true, results: out.results }
    }))

    harness.handle('session.unarchive', guard(async (args) => {
      const svc = requireSvc()
      const ids = idsOf(args)
      if (ids.length === 0) return { ok: false, error: 'sessionIds must be a non-empty array' }
      // UI 路径：允许捞回任意已归档会话（含主代理）
      const out = await svc.unarchive(ids, masterOf(svc, args), true)
      return { ok: true, results: out.results }
    }))

    harness.handle('session.deletePreview', guard(async (args) => {
      const svc = requireSvc()
      const ids = idsOf(args)
      if (ids.length === 0) return { ok: false, error: 'sessionIds must be a non-empty array' }
      if (typeof svc.deletePreview !== 'function') return { ok: false, error: 'deletePreview not supported by this sessionmgmt build' }
      // UI 路径：用户经弹窗确认操作，放宽为任意非自身会话（uiPath=true）
      const out = await svc.deletePreview(ids, masterOf(svc, args), true)
      return { ok: true, results: out.results }
    }))

    harness.handle('session.delete', guard(async (args) => {
      const svc = requireSvc()
      if (args === null || typeof args !== 'object' || args.confirm !== true) {
        return { ok: false, error: 'refusing to delete: confirm must be explicitly true（删除不可逆，必须由 UI 弹窗确认后传 confirm:true）' }
      }
      const ids = idsOf(args)
      if (ids.length === 0) return { ok: false, error: 'sessionIds must be a non-empty array' }
      // 删除仅限主会话页面发起（子代理页面拒绝；R7）
      const caller = callerOf(args)
      if (caller === undefined) return { ok: false, error: 'cannot resolve the calling session; deletion requires a live caller session' }
      // fail-closed（GLM 审计 #1）：无法验证调用方是否主会话时拒绝，而非跳过守卫
      if (typeof svc.masterIdFromSessionId !== 'function') {
        return { ok: false, error: 'cannot verify the caller is a main session (masterIdFromSessionId missing); deletion refused' }
      }
      const resolved = svc.masterIdFromSessionId(caller)
      if (resolved !== caller) return { ok: false, error: 'deletion is restricted to main sessions (a subagent page cannot delete sessions)' }
      const masterId = masterOf(svc, args)
      if (masterId === undefined) return { ok: false, error: 'cannot resolve the calling session; deletion requires a live caller session' }
      const out = await svc.deleteSessions(ids, masterId, true, true)
      return { ok: true, results: out.results }
    }))

    harness.handle('session.export', guard(async (args) => {
      const svc = requireSvc()
      if (typeof svc.exportSession !== 'function') return { ok: false, error: 'exportSession not supported by this sessionmgmt build' }
      const targetId = args !== null && typeof args === 'object' && typeof args.targetId === 'string' ? args.targetId : ''
      if (targetId.length === 0) return { ok: false, error: 'targetId is required' }
      const out = await svc.exportSession({
        targetId,
        format: args.format === 'jsonl' ? 'jsonl' : 'markdown',
        maxEventsPerSession: typeof args.maxEventsPerSession === 'number' ? args.maxEventsPerSession : undefined,
      })
      return out
    }))
  },
}

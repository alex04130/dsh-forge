return {
  inject: ['timer', 'sessions'],
  async apply(ctx) {
    const sessions = ctx.get('sessions')
    if (sessions === undefined) return

    // ---------- locale 检测（快照字段 active；服务缺席静默回退英文） ----------
    function zhFromSnapshot(snap) {
      try {
        const id = typeof snap === 'string' ? snap : (snap !== null && typeof snap === 'object' ? String(snap.active ?? '') : '')
        return id.toLowerCase().startsWith('zh')
      } catch (error) { return false }
    }
    function isZh() {
      try {
        const loc = ctx.get('locale')
        if (loc === undefined) return false
        if (typeof loc.getSnapshot === 'function') {
          const snap = loc.getSnapshot()
          const id = typeof snap === 'string' ? snap : (snap !== null && typeof snap === 'object' ? snap.active : undefined)
          if (id !== undefined && id !== null && id !== '') return String(id).toLowerCase().startsWith('zh')
        }
        if (typeof loc.getLocale === 'function') return zhFromSnapshot(loc.getLocale())
        return false
      } catch (error) { return false }
    }
    function copy(zh) {
      return zh ? { sendFail: '图片发送失败（传输错误），请重试' } : { sendFail: 'Image send failed (transport error). Please try again.' }
    }

    let patched = false
    // 补丁归属记录：只有本实例亲自安装过，dispose 才还原（审计 P1 修复）。
    let installedProto = null
    let installedOriginal = undefined
    // prototype 是类级共享的：任何一个已知会话的 binding 都能抵达，不绑当前会话。
    const anySessionId = () => {
      try {
        const list = sessions.list
        const snapshot = list !== null && typeof list === 'object' && typeof list.getSnapshot === 'function' ? list.getSnapshot() : undefined
        if (snapshot === null || typeof snapshot !== 'object') return undefined
        if (typeof snapshot.current === 'string') return snapshot.current
        for (const key of ['items', 'sessions', 'list']) {
          const arr = snapshot[key]
          if (Array.isArray(arr)) {
            for (const entry of arr) {
              const id = typeof entry === 'string' ? entry : (entry !== null && typeof entry === 'object' && typeof entry.id === 'string' ? entry.id : undefined)
              if (typeof id === 'string') return id
            }
          }
        }
        return undefined
      } catch (error) { return undefined }
    }
    const tryPatch = () => {
      if (patched === true) return true
      try {
        if (sessions === null || typeof sessions !== 'object') return false
        if (typeof sessions.binding !== 'function') return false
        const anyId = anySessionId()
        if (typeof anyId !== 'string') return false
        const binding = sessions.binding(anyId)
        if (binding === undefined || binding === null || binding.session === undefined || binding.session === null) return false
        const proto = Object.getPrototypeOf(binding.session)
        if (proto === null || typeof proto.prompt !== 'function') return false
        if (proto.prompt.__dshSubagentImageV4 === true) { patched = true; return true }

        const original = proto.prompt
        proto.prompt = async function patchedPrompt(content, mode) {
          const hasImage = Array.isArray(content) && content.some((part) => part !== null && typeof part === 'object' && part.type === 'image')
          if (hasImage === true && this.address !== undefined && this.address !== null && typeof this.address === 'object' && this.address.mode === 'continuable') {
            this.promptError = null
            this.lastAgentError = null
            this.promptAttempted = true
            if (this.blankBit) this.firstPromptPendingTurn = true
            this.notifier.markDirty()
            let result
            try {
              const routed = (await this.api.subagents.prompt({ ...this.address, content })).result
              result = routed !== null && typeof routed === 'object' && routed.ok === true ? { ok: true, value: { accepted: true } } : routed
            } catch (error) {
              result = { ok: false, error: { code: 'subagent-image', message: copy(isZh()).sendFail } }
            }
            if (result !== null && typeof result === 'object' && result.ok === true) {
              if (this.blankBit) {
                this.blankBit = false
                if (this.options !== null && typeof this.options === 'object' && typeof this.options.onEngaged === 'function') this.options.onEngaged(this)
                this.notifier.markDirty()
              }
              return result
            }
            this.promptError = { op: 'send', error: result !== null && typeof result === 'object' && result.error !== undefined ? result.error : { code: 'unknown', message: 'unknown error' } }
            this.notifier.markDirty()
            return result
          }
          return original.call(this, content, mode)
        }
        proto.prompt.__dshSubagentImageV4 = true
        installedProto = proto
        installedOriginal = original
        patched = true
        return true
      } catch (error) {
        return false
      }
    }

    // 停插件还原 prototype 补丁（仅限本实例安装的那份）。
    ctx.effect(() => () => {
      try {
        if (installedProto !== null && installedProto.prompt !== undefined && installedProto.prompt.__dshSubagentImageV4 === true) {
          installedProto.prompt = installedOriginal
        }
      } catch (error) { /* best-effort */ }
    })

    if (tryPatch() === false) {
      const stop = ctx.interval(() => {
        if (tryPatch() === true && typeof stop === 'function') stop()
      }, 1000)
    }
  },
}

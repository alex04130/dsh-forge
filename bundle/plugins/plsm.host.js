// plsm 宿主半部 v0.1.1：面板数据面 RPC。动态半部禁用 fetch，改为经 fs 服务直读
// ~/.dsh/plasmids/registry.json，搜索/摘要语义逐行移植 profiles/web/plugins/plasmid.mjs
// （tokensOf/first/summarize/searchPlasmids/getPlasmid），保证面板与 HTTP 数据面行为一致。
return {
  apply(ctx) {
    const fsSvc = ctx.get('fs')
    // DSH_HOME 部署常量：动态半部的 sandboxPolicy.workspaceRoot 是部署 home（/home/alex）而非会话
    // 工作区（/home/alex/.dsh），不能拿来拼路径（pkg-14 实测拼出 /home/alex/plasmids/...）。
    // 与 plasmid.mjs 的 process.env.DSH_HOME || ~/.dsh 同一指向，本部署即 /home/alex/.dsh。
    const REG_PATH = '/home/alex/.dsh/plasmids/registry.json'

    const errText = (error) => error !== null && typeof error === 'object'
      ? String(error.code ?? '') + ' ' + String(error.message !== undefined ? error.message : error)
      : String(error)
    async function readReg() {
      if (fsSvc === undefined) throw new Error('fs service unavailable to dynamic host half')
      try {
        const target = await fsSvc.resolve(REG_PATH)
        const text = await fsSvc.readText(target)
        const data = JSON.parse(text)
        if (data !== null && typeof data === 'object' && Array.isArray(data.entries)) return data
        return { version: 1, entries: [] }
      } catch (error) {
        // ENOENT = 注册表尚不存在，按空表；其余错误上浮给面板（拒绝静默吞错——本次调试的教训）
        // fs 服务的「不存在」是类型化错误 FS_NOT_FOUND（不是 Node 的 ENOENT）
        if (error !== null && typeof error === 'object' && ['ENOENT', 'FS_NOT_FOUND'].includes(String(error.code ?? ''))) return { version: 1, entries: [] }
        throw new Error('read ' + REG_PATH + ' failed: ' + errText(error))
      }
    }

    // ── 以下三个函数逐行移植 plasmid.mjs（勿改动语义） ──
    function first(text, n) {
      const s = String(text ?? '').replace(/\s+/g, ' ').trim()
      return s.length > n ? s.slice(0, n) + '…' : s
    }
    function tokensOf(text) {
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
    function summarize(e, relevance) {
      const isGap = e !== null && typeof e === 'object' && e.type === 'gap'
      const fit = e.fitness !== null && typeof e.fitness === 'object' ? e.fitness : {}
      const out = {
        id: e.id, type: e.type, status: e.status, confidence: e.confidence, scope: e.scope, version: e.version,
        when: first(e.what || e.when, 140), worked: first(e.worked, 140),
        evidenceCount: Array.isArray(e.evidence) ? e.evidence.length : 0,
        fitness: { score: fit.score ?? 0.5, seen: fit.seen ?? 0, worked: fit.worked ?? 0, failed: fit.failed ?? 0 },
        createdAt: e.createdAt, updatedAt: e.updatedAt, source: e.source,
      }
      if (isGap) out.outlet = e.outlet ?? 'backlog'
      if (typeof relevance === 'number') out.relevance = relevance
      return out
    }
    function searchPlasmids(args, reg) {
      const entries = Array.isArray(reg.entries) ? reg.entries : []
      const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
      const qTokens = tokensOf(query)
      const scored = entries.map((e) => {
        // fix 用 when/worked/failed/why；gap 用 what/why/impact（与 plasmid.mjs 同修，
        // gap 的 what 必须进检索 blob）
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
        const fa = a.e.fitness !== null && typeof a.e.fitness === 'object' && typeof a.e.fitness.score === 'number' ? a.e.fitness.score : 0.5
        const fb = b.e.fitness !== null && typeof b.e.fitness === 'object' && typeof b.e.fitness.score === 'number' ? b.e.fitness.score : 0.5
        const s = b.relevance - a.relevance || fb - fa
        return s !== 0 ? s : String(a.e.id).localeCompare(String(b.e.id))
      })
      const hits = scored.slice(0, 20)
      return { count: hits.length, total: entries.length, results: hits.map(({ e, relevance }) => summarize(e, relevance)) }
    }

    const guard = (fn) => async (args) => {
      try { return await fn(args) } catch (error) { return { ok: false, error: errText(error) } }
    }
    harness.handle('plasmid.list', guard(async (args) => {
      const reg = await readReg()
      const q = args !== null && typeof args === 'object' && typeof args.query === 'string' ? args.query.trim() : ''
      if (q === '') return { ok: true, count: reg.entries.length, entries: reg.entries.map((e) => summarize(e)) }
      const r = searchPlasmids({ query: q }, reg)
      return { ok: true, count: r.count, total: r.total, results: r.results }
    }))

    harness.handle('plasmid.detail', guard(async (args) => {
      const id = args !== null && typeof args === 'object' && typeof args.id === 'string' ? args.id : ''
      if (id === '') return { ok: false, error: 'id is required' }
      const reg = await readReg()
      const e = reg.entries.find((x) => x !== null && typeof x === 'object' && x.id === id)
      if (e === undefined) return { ok: false, error: '没有质粒 ' + id }
      return { ok: true, entry: e }
    }))
  },
}

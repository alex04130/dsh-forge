// description: web 搜索 provider 持久化选择（2026-09-01 转正，替换已退役的 dev_inject 包装器 web-search-provider-selector）。
// 背景：注入 kimi 搜索 provider 后 searchProviders 有两个（deepseek-official + kimi-coding），
// web 服务构造时 searchProviderId 未配 → WEB_PROVIDER_AMBIGUOUS 挂。此前靠 dev_inject 的
// selector 包装器 apply 时直设 web.searchProviderId（构造后属性可变，search 时读）。
// 转正后：读 ~/.dsh/web-search.provider.json（capm 模型页 capmgr/webSearch.set 写入），
// 直设 web.searchProviderId，重启自动恢复；前端切换即时生效（capm 运行时直设 + 本文件落盘）。
import { readFile, writeFile } from 'node:fs/promises'

const PROVIDER_FILE = (process.env.DSH_HOME || process.env.HOME + '/.dsh') + '/web-search.provider.json'

export default {
  inject: ['web'],
  apply(ctx) {
    const pick = (configured) => {
      if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
      // 无配置时保持 web 默认（构造时 config.searchProvider ?? env），不做强设
      return undefined
    }
    let applied = false
    readFile(PROVIDER_FILE, 'utf8')
      .then((raw) => {
        const data = JSON.parse(raw)
        const provider = pick(data !== null && typeof data === 'object' ? String(data.provider ?? '') : '')
        if (provider !== undefined) {
          ctx.web.searchProviderId = provider
          console.log('[web-search-select] searchProviderId set to ' + provider + ' (from ' + PROVIDER_FILE + ')')
        }
        applied = true
      })
      .catch(() => {
        // 文件不存在/不可读：无用户选择，保持默认；若多 provider 则 AMBIGUOUS，前端去设置。
        applied = true
      })
    // 提供 select/current/persist 给 capm host 复用（capm 也可直改属性；此为可选一致入口）。
    // 注意：cordis 把 apply 返回值当作 disposer/effect，普通对象会触发 "Invalid effect"，
    // 所以 API 走 ctx.provide 服务暴露，apply 不返回值。
    ctx.provide('webSearchSelect', {
      select(provider) {
        const p = pick(String(provider ?? ''))
        if (p === undefined) return undefined
        ctx.web.searchProviderId = p
        return p
      },
      current() { return ctx.web.searchProviderId },
      // 落盘（前端 capm webSearch.set 用）：运行时直设 + 写 ~/.dsh/web-search.provider.json，重启由 apply 恢复。
      async persist(provider) {
        const p = pick(String(provider ?? ''))
        if (p === undefined) return undefined
        ctx.web.searchProviderId = p
        await writeFile(PROVIDER_FILE, JSON.stringify({ provider: p, updatedAt: Date.now() }, null, 2), 'utf8').catch(() => { /* disk best-effort；运行时已生效 */ })
        return p
      },
    })
  },
}

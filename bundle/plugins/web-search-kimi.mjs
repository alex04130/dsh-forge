// description: kimi 订阅 web 搜索——同 DeepSeek search 机制（Anthropic Messages + web_search_20250305 server 工具），端点切 kimi-coding 订阅，凭证 KIMI_CODING_API_KEY。
// 背景：DSH 原生 web-search-deepseek 用 deepseek-official 余额跑搜索（余额 ¥10.48 告急，用户保留给搜索）；
// kimi 订阅同样支持 Anthropic web_search server 工具（实测 2026-08-27：server_tool_use + web_search_tool_result 块齐）——写 kimi 版
// 注册进 ctx.web.searchProviders（id=kimi-coding），与 deepseek-official 并存，用户配置 web.searchProvider 切换。
import { WebError } from '@deepseek-ai/dsh-web'
import z from '@deepseek-ai/schemastery'
import { errText } from './lib/forge-common.mjs'

const KIMI_PROVIDER_ID = 'kimi-coding'
const KIMI_BASE_URL = 'https://api.kimi.com/coding/v1'
const KIMI_DEFAULT_MODEL = 'kimi-for-coding'
const KIMI_API_VERSION = '2023-06-01'
const KIMI_DEFAULT_MAX_TOKENS = 4096
const KIMI_DEFAULT_MAX_USES = 5
// 设置命名空间由 loader 的 entry id 决定（entry.options.id 即 ns），这里不再自带常量。

const isPositiveInteger = (v) => Number.isInteger(v) && v > 0

function throwIfSearchAborted(signal) {
  if (signal?.aborted === true) throw new WebError('kimi search aborted', 'CANCELLED', { cause: signal?.reason })
}

/** 同 DeepSeek 版：Anthropic web_search_result 没有内联 snippet，摘要在 text block 的 citations[] 里（按 url 首次出现）。 */
function citationsByUrl(blocks) {
  const map = new Map()
  for (const block of blocks) {
    if (block?.type !== 'text' || block?.citations === undefined) continue
    for (const cite of block.citations) {
      if (cite?.url !== undefined && cite?.url !== null && !map.has(String(cite.url))) map.set(String(cite.url), cite)
    }
  }
  return map
}

function dedupeResults(items) {
  const seen = new Set()
  const out = []
  for (const item of items) {
    if (item?.url === undefined || item?.url === null || String(item.url).length === 0 || seen.has(String(item.url))) continue
    seen.add(String(item.url))
    out.push(item)
  }
  return out
}

class KimiSearchProvider {
  constructor(resolveOptions) {
    this.id = KIMI_PROVIDER_ID
    this.label = 'kimi-coding 订阅搜索'
    this.resolveOptions = resolveOptions
  }
  available() {
    const options = this.resolveOptions()
    return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined) && URL.canParse(options.baseURL) && isPositiveInteger(options.maxTokens) && isPositiveInteger(options.maxUses)
  }
  async search(request, signal) {
    const options = this.resolveOptions()
    const apiKey = typeof options.resolveApiKey === 'function' ? await options.resolveApiKey(signal) : options.apiKey
    throwIfSearchAborted(signal)
    const payload = {
      model: options.model,
      max_tokens: options.maxTokens,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: options.maxUses }],
      messages: [{ role: 'user', content: request.query }],
    }
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await fetch(new URL('messages', options.baseURL), {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Authorization': 'Bearer ' + apiKey,
          'anthropic-version': options.apiVersion,
          'Content-Type': 'application/json',
          'User-Agent': 'deepseek-harness-kimi-search/0.0.1',
        },
        body: JSON.stringify(payload),
      })
      const text = await response.text()
      let data
      try { data = JSON.parse(text) } catch { throw new WebError('Kimi returned an unprocessable response body: ' + errText({ message: text.slice(0, 200) }), 'WEB_PROVIDER_ERROR') }
      if (!response.ok) throw new WebError(`Kimi search request failed: ${data?.error?.message ?? text.slice(0, 200)}`, 'WEB_PROVIDER_ERROR')
      const blocks = Array.isArray(data?.content) ? data.content : []
      const resultBlocks = blocks.filter((b) => b?.type === 'web_search_tool_result')
      if (resultBlocks.length === 0) throw new WebError('Kimi returned no web_search_tool_result blocks; the request may not have triggered native web search', 'WEB_PROVIDER_ERROR')
      const cites = citationsByUrl(blocks)
      const items = []
      for (const block of resultBlocks) {
        if (block?.content === undefined) continue
        for (const row of block.content) {
          if (row === null || typeof row !== 'object' || row.type !== 'web_search_result') continue
          const url = typeof row.url === 'string' ? row.url : ''
          if (url === '') continue
          const cite = cites.get(url)
          items.push({
            url,
            title: typeof row.title === 'string' ? row.title : undefined,
            source: typeof row.source === 'object' && row.source !== null ? (typeof row.source.title === 'string' ? row.source.title : undefined) : undefined,
            page_age: row.page_age,
            ...(cite?.cited_text !== undefined ? { cited_text: cite.cited_text } : {}),
          })
        }
      }
      if (items.length === 0) throw new WebError('Kimi returned web_search_tool_result blocks but no parseable items', 'WEB_PROVIDER_ERROR')
      return { results: dedupeResults(items), note: 'kimi-coding 订阅搜索（Anthropic web_search_20250305）' }
    } catch (error) {
      if (error instanceof WebError) throw error
      if (signal?.aborted) throw new WebError('Kimi search aborted', 'CANCELLED')
      throw new WebError('Kimi search request failed: ' + errText(error), 'WEB_PROVIDER_ERROR', { cause: error })
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

// 0.2.0-rc.2 的插件配置是**声明式**的：具名导出 `Config` 为一个 Schemastery Schema
// （Cordis 以 Standard Schema 消费：`runtime.Config['~standard'].validate(config)`），
// 运行时从 `apply(ctx, config)` 的**第二个参数**读，字段是 volatile 引用，用 `.get()` 取值。
//
// 旧写法调 `settings.installSection(...)` —— 这个方法在 0.2.0-rc.2 的 ctx.settings 上
// **根本不存在**（只有 configure / prepareDocument / describe / update / replace / mutate），
// 于是 typeof 守卫静默跳过，这个 provider 的设置表单从来没装上过。
//
// 必须用**具名导出**且**不能有 default export**：Cordis 的 loader 走
// `exports.default ?? exports`，有 default 就会遮蔽 `Config`，schema 永远读不到。
export const name = 'web-search-kimi'
export const inject = ['web']
export const Config = z.object({
  apiKey: z.string().role('secret').volatile(),
  apiKeyEnv: z.string().role('credential-ref').default('KIMI_CODING_API_KEY').volatile(),
  baseURL: z.string().default(KIMI_BASE_URL).volatile(),
  model: z.string().default(KIMI_DEFAULT_MODEL).volatile(),
  apiVersion: z.string().default(KIMI_API_VERSION).volatile(),
  maxTokens: z.number().step(1).min(1).default(KIMI_DEFAULT_MAX_TOKENS).volatile(),
  maxUses: z.number().step(1).min(1).default(KIMI_DEFAULT_MAX_USES).volatile(),
})

export function apply(ctx, config) {
  const read = (field, fallback) => {
    const value = typeof config[field]?.get === 'function' ? config[field].get() : config[field]
    return value === undefined || value === null || value === '' ? fallback : value
  }
  const resolveOptions = () => {
    // apiKeyEnv 缺省时回落到环境变量名；凭证经 credentials 服务解析（同官方 provider）。
    const apiKeyEnv = read('apiKeyEnv', 'KIMI_CODING_API_KEY')
    const credentials = ctx.get('credentials')
    const resolveApiKey = credentials !== undefined
      ? async () => (await credentials.resolve(apiKeyEnv))?.value
      : undefined
    return {
      baseURL: read('baseURL', KIMI_BASE_URL),
      model: read('model', KIMI_DEFAULT_MODEL),
      apiVersion: read('apiVersion', KIMI_API_VERSION),
      maxTokens: read('maxTokens', KIMI_DEFAULT_MAX_TOKENS),
      maxUses: read('maxUses', KIMI_DEFAULT_MAX_USES),
      apiKey: read('apiKey', undefined),
      resolveApiKey,
    }
  }
  const provider = new KimiSearchProvider(() => resolveOptions())
  ctx.web.registerSearchProvider(provider)
  console.log('[web-search-kimi] provider registered: kimi-coding 订阅搜索')
}

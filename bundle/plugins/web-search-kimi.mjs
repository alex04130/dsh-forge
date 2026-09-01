// description: kimi 订阅 web 搜索——同 DeepSeek search 机制（Anthropic Messages + web_search_20250305 server 工具），端点切 kimi-coding 订阅，凭证 KIMI_CODING_API_KEY。
// 背景：DSH 原生 web-search-deepseek 用 deepseek-official 余额跑搜索（余额 ¥10.48 告急，用户保留给搜索）；
// kimi 订阅同样支持 Anthropic web_search server 工具（实测 2026-08-27：server_tool_use + web_search_tool_result 块齐）——写 kimi 版
// 注册进 ctx.web.searchProviders（id=kimi-coding），与 deepseek-official 并存，用户配置 web.searchProvider 切换。
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { WebError } from '@deepseek-ai/dsh-web'
import { errText } from './lib/forge-common.mjs'

const KIMI_PROVIDER_ID = 'kimi-coding'
const KIMI_BASE_URL = 'https://api.kimi.com/coding/v1'
const KIMI_DEFAULT_MODEL = 'kimi-for-coding'
const KIMI_API_VERSION = '2023-06-01'
const KIMI_DEFAULT_MAX_TOKENS = 4096
const KIMI_DEFAULT_MAX_USES = 5
const NS = 'web-search-kimi'

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

export default {
  inject: ['web'],
  apply(ctx) {
    let current = () => ({})
    const resolveOptions = () => {
      const c = current()
      const apiKeyEnv = c.apiKeyEnv ?? 'KIMI_CODING_API_KEY'
      const credentials = ctx.get('credentials')
      const resolveApiKey = credentials !== undefined
        ? async () => (await credentials.resolve(apiKeyEnv))?.value
        : undefined
      return {
        baseURL: c.baseURL ?? KIMI_BASE_URL,
        model: c.model ?? KIMI_DEFAULT_MODEL,
        apiVersion: c.apiVersion ?? KIMI_API_VERSION,
        maxTokens: c.maxTokens ?? KIMI_DEFAULT_MAX_TOKENS,
        maxUses: c.maxUses ?? KIMI_DEFAULT_MAX_USES,
        apiKey: undefined,
        resolveApiKey,
      }
    }
    const provider = new KimiSearchProvider(() => resolveOptions())
    // 新版 dsh-settings（2026-09 大更新）移除了 installSettingsSection/settingsNamespace 导出，
    // 改为 settings 服务的 installSection(owner, ns, schemaFn, entry, hooks)；schema 从属性表变成可调用函数。
    const settings = ctx.get('settings')
    if (settings !== undefined && typeof settings.installSection === 'function') {
      const schema = (value) => {
        const input = value !== null && typeof value === 'object' ? value : {}
        const out = {}
        for (const key of ['baseURL', 'model', 'apiKeyEnv']) {
          if (input[key] === undefined) continue
          if (typeof input[key] !== 'string') throw new TypeError('web-search-kimi.' + key + ' must be a string')
          out[key] = input[key]
        }
        for (const key of ['maxUses', 'maxTokens']) {
          if (input[key] === undefined) continue
          if (!isPositiveInteger(input[key])) throw new TypeError('web-search-kimi.' + key + ' must be a positive integer')
          out[key] = input[key]
        }
        return out
      }
      settings.installSection(ctx, NS, schema, { maxUses: 5, maxTokens: 4096 }, {
        setSource: (source) => { current = source },
        onChange: () => {},
      })
    }
    ctx.web.registerSearchProvider(provider)
    console.log('[web-search-kimi] provider registered: kimi-coding 订阅搜索')
  },
}

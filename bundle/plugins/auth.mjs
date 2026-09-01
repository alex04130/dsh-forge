// description: 订阅 OAuth 登录：auth_list / auth_login —— 把 pi-ai 原生注册的订阅登录 flow（SuperGrok/X Premium、Kimi Code 等）桥接给用户。
// 背景：DSH 原生注册了 flow 但无任何 UI/工具入口（真空缺）；用户用自己的订阅当 provider 替代中转站。
// 形态：静态 host 插件（与 plasmid.mjs 同构），经 dev_inject 注入器热挂（免重启）。
// 依赖：ctx.authorization（flow 注册表）、ctx.userQuestions（device-code 链接+验证码呈现给用户）。
import { defineTool } from '@deepseek-ai/dsh-tools'
import { errText, jsonText } from './lib/forge-common.mjs'

export default {
  inject: ['tools', 'userQuestions'],
  apply(ctx) {
    // authorization 可选获取：B 路径的 authorization-provider 动态提供（组合行缺席时）；
    // 注入期用 ctx.get 而非 inject 声明——cordis inject 语义是声明服务不可解析→整个注入
    // 挂起、apply 永不执行、沙箱 guard 拒 ctx.tools。判断在 execute 时做（未就绪报错而非崩溃）。
    const auth = ctx.get('authorization')
    const uq = ctx.get('userQuestions')

    const register = (definition) => {
      const dispose = ctx.tools.register(definition)
      ctx.effect(() => () => { try { dispose() } catch (error) { /* best-effort */ } })
    }

    register(defineTool({
      name: 'auth_list',
      description: '列出当前 DSH 支持用订阅/OAuth 登录的 LLM provider（如 llm-pi-ai/xai=SuperGrok/X Premium、llm-pi-ai/kimi-coding=Kimi Code、llm-pi-ai/anthropic=Claude Pro/Max、llm-pi-ai/openai-codex=ChatGPT Plus/Pro 等），含每个的登录方式与是否已有凭证。用于接入自己的订阅替代中转站。',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: typeof value === 'string' ? value : String(value) }] },
      },
      async execute() {
        const flows = auth.list().map((f) => ({
          key: f.key,
          label: f.label,
          methods: f.methods.map((m) => ({ id: m.id, label: m.label })),
          inFlight: f.inFlight === true,
        }))
        return jsonText({ ok: true, count: flows.length, flows })
      },
    }))

    register(defineTool({
      name: 'auth_login',
      description: '用 OAuth 登录一个订阅 provider（如 xai=SuperGrok/X Premium），把订阅当 LLM provider。触发 device-code 流程：会向你展示浏览器链接+验证码，你在浏览器完成授权后回来确认，之后该 provider 的路由直接可用。用 auth_list 查看可用 provider 与 key。',
      parameters: {
        provider: { type: 'string', required: true, description: '要登录的 provider key，如 "llm-pi-ai/xai"（xai=SuperGrok/X Premium）。先 auth_list 查看。' },
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: typeof value === 'string' ? value : String(value) }] },
      },
      async execute(args, exec) {
        if (uq === undefined) return jsonText({ ok: false, error: 'userQuestions 服务缺席，无法把授权链接呈现给你' })
        const key = String(args.provider)
        const desc = auth.describe(key)
        if (desc === undefined) return jsonText({ ok: false, error: '没有该 provider 的登录 flow：' + key })
        const method = desc.methods[0]?.id ?? 'oauth'

        const agent = exec !== undefined && exec.agent !== undefined ? exec.agent : undefined
        const signal = exec !== undefined && exec.signal !== undefined ? exec.signal : undefined

        let urlShown = false
        const shown = { current: null }
        const deferred = {}
        deferred.promise = new Promise((resolve) => { deferred.resolve = resolve })

        const interaction = {
          notify(notice) {
            try {
              const url = notice !== null && typeof notice === 'object' ? (notice.url ?? notice.verificationUri ?? '') : ''
              const code = notice !== null && typeof notice === 'object' ? (notice.code ?? notice.userCode ?? '') : ''
              if (url !== '' && !urlShown) {
                urlShown = true
                shown.current = { url, code }
                deferred.resolve(true)
              }
            } catch (error) { /* 呈现失败不中断授权轮询 */ }
          },
          prompt(prompt) {
            const kind = prompt !== null && typeof prompt === 'object' ? prompt.kind : 'text'
            const message = prompt !== null && typeof prompt === 'object' ? (prompt.message ?? '') : ''
            const options = prompt !== null && typeof prompt === 'object' && Array.isArray(prompt.options) ? prompt.options : []
            const item = {
              id: 'auth-prompt',
              question: message !== '' ? message : '请提供所需信息',
              ...(options.length > 0 ? { options: options.map((o) => (typeof o === 'string' ? { label: o } : { label: String(o.label ?? o) })) } : {}),
              ...(kind === 'secret' ? { detail: '（输入内容保密）' } : {}),
            }
            return uq.ask({ questions: [item], ...(agent !== undefined ? { agent } : {}), ...(signal !== undefined ? { signal } : {}) }).then((answer) => {
              const a = answer?.answers?.[0]
              if (a === undefined) throw new Error('未收到回答')
              if (kind === 'select') return a.selected[0] ?? ''
              return a.custom ?? a.selected[0] ?? ''
            })
          },
        }

        const beginPromise = auth.begin({ key, method, interaction, ...(signal !== undefined ? { signal } : {}) })
        try {
          const result = await Promise.race([
            deferred.promise.then(() => ({ kind: 'url' })),
            beginPromise.then((o) => ({ kind: 'done', outcome: o }), (e) => ({ kind: 'error', error: e })),
          ])
          if (result.kind === 'url' && shown.current !== null && shown.current.url !== '') {
            await uq.ask({
              questions: [{
                id: 'auth-open',
                question: '请在浏览器打开以下链接并在授权页输入验证码完成登录：',
                detail: '链接：' + shown.current.url + (shown.current.code !== '' ? '\n验证码：' + shown.current.code : '') + '\n\n完成授权后点下方按钮确认。',
                options: [{ label: '已完成授权' }],
              }],
              ...(agent !== undefined ? { agent } : {}),
              ...(signal !== undefined ? { signal } : {}),
            })
          } else if (result.kind === 'error') {
            return jsonText({ ok: false, provider: key, error: errText(result.error) })
          }
        } catch (error) {
          try { auth.cancel(key) } catch (cancelError) { /* best-effort */ }
          return jsonText({ ok: false, provider: key, cancelled: true, error: errText(error) })
        }

        const outcome = await beginPromise
        if (outcome !== null && typeof outcome === 'object' && outcome.status === 'authorized') {
          return jsonText({ ok: true, provider: key, status: 'authorized', note: '订阅已登录并写入凭证，llm-pi-ai 路由可直接用该 provider' })
        }
        return jsonText({ ok: false, provider: key, status: outcome?.status ?? 'unknown' })
      },
    }))
  },
}

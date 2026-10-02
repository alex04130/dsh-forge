// mailbridge 投递卡片（浏览器半部）。
//
// 为什么必须是"静态客户端包"而不是动态半部：
//   动态 client 半部跑在 cordis-client-runner 的沙箱里，只拿到 React/console/styles/host，
//   没有 import/require —— 既 require 不到官方的 ui-primitives 图标，也无法声明 ChatNodeDataMap。
//
// 它做什么：把 source.kind === 'mailbridge' 的 user/message 从"人类发的消息"里分出来，
// 渲染成一张有自己图标与标题的卡片。这是官方支持的增量路径（同 ui-user-questions 的
// question-reply 先例）：注册一个自有 ConversationNodeDefinition + 一个自有 key 的
// keyed chat renderer。
//
// 已知边界（2026-10-02）：
//   - steer 投递（目标活跃）→ 官方节点落进不可见的 context（rc.2 起纯文本 context 被
//     isVisibleChatNode 整体过滤），于是本卡片是唯一一行。
//   - followup 投递（目标是 idle，冷唤醒）→ 官方会另外产出一张 turn-trigger 卡片，
//     标题回落到「收到执行请求」，于是会出现两行。要压掉它只能以 priority:-1 遮蔽
//     conversation.chat.node 的 turn-trigger 格，并自己复刻官方对所有 kind 的渲染
//     （官方组件/helper/CSS 都未导出）。这里刻意不做那件事。
window.__ModuleLoader__.load({
  id: '@local/dsh-mailbridge-card',
  factory: (require) => {
    const React = require('react')

    // 图标来自官方公开的 primitives；解析不到就退化成文字（卡片仍然可用）。
    let IconPaperPlane = null
    let IconChevronDown = null
    try {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      if (primitives !== null && typeof primitives === 'object') {
        if (typeof primitives.IconPaperPlaneOutlineRegular === 'function') IconPaperPlane = primitives.IconPaperPlaneOutlineRegular
        if (typeof primitives.IconChevronDownOutlineRegular === 'function') IconChevronDown = primitives.IconChevronDownOutlineRegular
      }
    } catch (error) { /* keep the text fallback */ }

    // 官方的 append-surface 守卫；取不到就用同语义的内联版（排除被 shadow 的事件）。
    let isAppendSurfaceEvent = (event) => event === null || typeof event !== 'object'
      ? false
      : event.surfaceOp === undefined || event.surfaceOp === 'append'
    try {
      const surface = require('@deepseek-ai/dsh-session/surface')
      if (surface !== null && typeof surface === 'object' && typeof surface.isAppendSurfaceEvent === 'function') {
        isAppendSurfaceEvent = surface.isAppendSurfaceEvent
      }
    } catch (error) { /* keep the inline equivalent */ }

    const KIND = 'mailbridge'
    const NS = 'mailbridgeCard'

    const zh = {
      title: '跨会话消息',
      from: '来自会话',
      empty: '（空消息）',
      expand: '展开/收起正文',
    }
    const en = {
      title: 'Cross-session message',
      from: 'From session',
      empty: '(empty message)',
      expand: 'Toggle body',
    }

    const CSS = [
      '.mbc-root{border:1px solid var(--dsh-color-border-subtle, rgba(127,127,127,.25));border-radius:8px;margin:6px 0;overflow:hidden;background:var(--dsh-color-bg-elevated, transparent)}',
      '.mbc-head{display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;background:none;border:0;cursor:pointer;font:inherit;color:inherit;text-align:left}',
      '.mbc-icon{display:inline-flex;flex:none;opacity:.75}',
      '.mbc-title{font-weight:600;flex:none}',
      '.mbc-from{opacity:.6;font-size:.85em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
      '.mbc-chevron{margin-left:auto;flex:none;opacity:.6;transition:transform .12s ease}',
      '.mbc-chevron-open{transform:rotate(180deg)}',
      '.mbc-body{padding:0 10px 8px 10px;white-space:pre-wrap;word-break:break-word;opacity:.9}',
    ].join('\n')

    /** 卡片组件。data 由 definition 的 buildViewNode 给定，形状见 MailbridgeCardData。 */
    function MailbridgeCard({ node, t }) {
      const [open, setOpen] = React.useState(false)
      const data = node !== null && typeof node === 'object' && node.data !== null && typeof node.data === 'object' ? node.data : {}
      const from = typeof data.from === 'string' && data.from !== '' ? data.from : ''
      const text = typeof data.text === 'string' && data.text !== '' ? data.text : ''
      return React.createElement('section', { className: 'mbc-root', 'data-mailbridge-card': '' },
        React.createElement('button', {
          className: 'mbc-head',
          type: 'button',
          'aria-expanded': open,
          title: t('expand'),
          onClick: () => { setOpen(!open) },
        },
          React.createElement('span', { className: 'mbc-icon', 'aria-hidden': true },
            IconPaperPlane !== null ? React.createElement(IconPaperPlane, { size: 14 }) : '✉'),
          React.createElement('span', { className: 'mbc-title' }, t('title')),
          from !== '' ? React.createElement('span', { className: 'mbc-from' }, t('from') + ' ' + from) : null,
          IconChevronDown !== null
            ? React.createElement(IconChevronDown, { size: 12, className: open ? 'mbc-chevron mbc-chevron-open' : 'mbc-chevron' })
            : React.createElement('span', { className: open ? 'mbc-chevron mbc-chevron-open' : 'mbc-chevron' }, open ? '▴' : '▾'),
        ),
        open ? React.createElement('div', { className: 'mbc-body' }, text !== '' ? text : t('empty')) : null,
      )
    }

    /** 从 source 里取出投递方会话 id；不是本卡片的消息返回 null。 */
    function mailbridgeSource(event) {
      const data = event !== null && typeof event === 'object' ? event.data : undefined
      const source = data !== null && typeof data === 'object' ? data.source : undefined
      if (source === null || typeof source !== 'object' || source.kind !== KIND) return null
      return {
        from: typeof source.senderSessionId === 'string' && source.senderSessionId !== '' ? source.senderSessionId : undefined,
      }
    }

    /** 把 source.kind === 'mailbridge' 的 user/message 折成一张卡片。 */
    const definition = {
      kind: KIND,
      target: 'chat',
      match: (event) => {
        if (event === null || typeof event !== 'object' || event.type !== 'user/message') return null
        if (!isAppendSurfaceEvent(event)) return null
        if (mailbridgeSource(event) === null) return null
        return { id: String(event.data.id), role: 'start' }
      },
      start: (_context, match) => {
        const event = match.event
        if (event.type !== 'user/message') throw new Error('mailbridge card start requires user/message')
        const source = mailbridgeSource(event)
        if (source === null) throw new Error('mailbridge card start requires a mailbridge source')
        const blocks = Array.isArray(event.data.content) ? event.data.content : []
        const block = blocks.find((item) => item !== null && typeof item === 'object' && item.type === 'text')
        return {
          seq: event.seq,
          time: event.time,
          from: source.from,
          text: block !== undefined && typeof block.text === 'string' ? block.text : '',
        }
      },
      update: (context) => context.state,
      buildViewNode: (context) => {
        if (context.state === undefined) return null
        const state = context.state
        const location = context.start !== undefined && context.start !== null && context.start.location !== undefined
          ? context.start.location
          : { kind: 'unresolved' }
        return {
          key: context.key,
          kind: KIND,
          id: context.id,
          target: 'chat',
          anchorSeq: state.seq,
          location,
          visibility: 'visible',
          data: { from: state.from, text: state.text, time: state.time },
        }
      },
    }

    let appCtx

    return {
      inject: ['uiConversation', 'slots', 'locale'],
      apply(ctx) {
        appCtx = ctx
        ctx.uiConversation.events.register(definition)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-mailbridge-card: dictionaries')
        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.setAttribute('data-plugin-css', '@local/dsh-mailbridge-card')
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => { try { tag.remove() } catch (error) { /* best-effort */ } }
        })
        ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
          { name: 'conversation.chat.node', key: KIND, locale: NS },
          MailbridgeCard,
        ))
      },
    }
  },
})

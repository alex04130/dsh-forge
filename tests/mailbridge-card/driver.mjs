// 投递卡片客户端半部的自检。
//
// 为什么需要它：客户端半部在**浏览器**里跑，宿主 boot 不会执行它 ——
// 所以「启动 0 失败」和 check.mjs 的语法门都**覆盖不到**这段代码。
// 这里用最小的 window / document / require 桩把它真跑一遍，断言它注册了
// 正确的 ConversationNode 定义与 keyed chat 渲染器。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = join(HERE, '..', '..', 'bundle', 'packages', 'dsh-mailbridge-card', 'lib', 'client.js')

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      期望 ' + JSON.stringify(expected) + '\n      实得 ' + JSON.stringify(actual)))
}

// ── 桩 ──────────────────────────────────────────────────────────────────────

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
}
const fakeRequire = (name) => {
  if (name === 'react') return React
  // 图标包在桩里取不到 → 卡片应退化成文字，这条路径也要能跑通
  throw new Error('not stubbed: ' + name)
}

let styleInjected = false
const documentStub = {
  createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }),
  head: { appendChild: () => { styleInjected = true } },
}

const registeredNodes = []
const registeredSlots = []
const localeNamespaces = []
const ctx = {
  effect: (fn) => fn(),
  locale: {
    bind: () => (key) => key,
    register: (ns) => { localeNamespaces.push(ns); return () => {} },
  },
  uiConversation: { events: { register: (definition) => { registeredNodes.push(definition) } } },
  slots: {
    inject: (_name, contribute) => contribute(),
    register: (options, component) => { registeredSlots.push({ options, component }); return () => {} },
  },
}

// ── 求值客户端半部 ──────────────────────────────────────────────────────────
// client.js 在求值时调用 window.__ModuleLoader__.load({ id, factory })；
// 真模块表会在 import 时调 factory(require)，这里同步模拟。

let entry
let plugin
globalThis.window = {
  __ModuleLoader__: {
    load: (loaded) => { entry = loaded; plugin = loaded.factory(fakeRequire) },
  },
}
globalThis.document = documentStub

// eslint-disable-next-line no-new-func -- 客户端半部就是靠全局加载器注册的脚本
new Function('window', 'document', readFileSync(SOURCE, 'utf8'))(globalThis.window, documentStub)

console.log('[card] 模块表条目')
check('id', entry?.id, '@local/dsh-mailbridge-card')
check('factory 返回了插件对象', typeof plugin, 'object')

console.log('[card] apply()')
plugin.apply(ctx)
check('注入声明', plugin.inject, ['uiConversation', 'slots', 'locale'])
check('注册了一个 ConversationNode 定义', registeredNodes.length, 1)
check('定义 kind', registeredNodes[0]?.kind, 'mailbridge')
check('定义 target', registeredNodes[0]?.target, 'chat')
check('注册了一个 keyed 渲染器', registeredSlots.length, 1)
check('渲染器槽位名', registeredSlots[0]?.options?.name, 'conversation.chat.node')
check('渲染器 key', registeredSlots[0]?.options?.key, 'mailbridge')
check('样式已注入', styleInjected, true)
check('locale 命名空间', localeNamespaces, ['mailbridgeCard'])

console.log('[card] match() 分派')
const definition = registeredNodes[0]
const human = { type: 'user/message', seq: 1, data: { id: 'm1', content: [], source: { kind: 'user' } } }
const relay = { type: 'user/message', seq: 2, data: { id: 'm2', content: [], source: { kind: 'mailbridge', form: 'relay', senderSessionId: 's-parent' } } }
const shadowed = { type: 'user/message', seq: 3, surfaceOp: 'shadowed', data: { id: 'm3', content: [], source: { kind: 'mailbridge' } } }
check('人类消息不匹配', definition.match(human), null)
check('非 user/message 不匹配', definition.match({ type: 'turn/start', data: {} }), null)
check('被 shadow 的事件不匹配', definition.match(shadowed), null)
check('mailbridge 消息匹配', definition.match(relay), { id: 'm2', role: 'start' })

console.log('[card] start() → buildViewNode()')
const state = definition.start({}, { event: relay })
check('state.from 取到发送方', state.from, 's-parent')
check('state.seq 取到事件序号', state.seq, 2)
const node = definition.buildViewNode({ state, key: 'k', id: 'm2', start: { event: relay, location: { kind: 'turn', turn: { status: 'open' } } } })
check('view node kind', node?.kind, 'mailbridge')
check('view node location 透传', node?.location, { kind: 'turn', turn: { status: 'open' } })
check('view node 可见性', node?.visibility, 'visible')
check('view node data.from', node?.data?.from, 's-parent')

console.log('')
if (failures === 0) console.log('[card-selftest] 全部通过')
else { console.log('[card-selftest] ' + failures + ' 项失败'); process.exitCode = 1 }

// 假 codex app-server：只实现 codexsub.mjs 用到的 JSON-RPC 面，用来验证线协议与续接行为。
// FAKE_MODE: ok | resume-fail | die
import { appendFileSync } from 'node:fs'

const LOG = process.env.FAKE_LOG
const MODE = process.env.FAKE_MODE || 'ok'
let buf = ''

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n') }
function note(method, extra) { if (LOG) appendFileSync(LOG, method + (extra ? ' ' + extra : '') + '\n') }

function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize' || method === 'thread/start' || method === 'thread/resume' || method === 'turn/start' || method === 'turn/interrupt') {
    note(method, JSON.stringify(params ?? {}))
  } else if (method !== undefined) {
    note('notification:' + method)
  }
  if (id === undefined) return
  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { ok: true } })
  if (method === 'thread/start') {
    return send({ jsonrpc: '2.0', id, result: { thread: { id: 'thread-new-1', ephemeral: false } } })
  }
  if (method === 'thread/resume') {
    if (MODE === 'resume-fail') {
      return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'no rollout found for thread id' } })
    }
    return send({ jsonrpc: '2.0', id, result: { thread: { id: params.threadId } } })
  }
  if (method === 'turn/start') {
    const threadId = params.threadId
    const turnId = 'turn-1'
    send({ jsonrpc: '2.0', id, result: { turn: { id: turnId } } })
    if (MODE === 'die') { setTimeout(() => process.exit(3), 5); return }
    setTimeout(() => {
      send({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: {
          threadId,
          turnId,
          item: { type: 'agentMessage', id: 'item-1', text: 'hello from fake codex', phase: 'final_answer' },
        },
      })
      send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } })
    }, 20)
    return
  }
  if (method === 'turn/interrupt') return send({ jsonrpc: '2.0', id, result: {} })
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + String(method) } })
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  for (;;) {
    const nl = buf.indexOf('\n')
    if (nl < 0) break
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (line) handle(JSON.parse(line))
  }
})

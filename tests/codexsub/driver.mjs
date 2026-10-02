// codexsub 自检驱动：用假 app-server 跑通「首派发 → 续接 → 续接失败回退 → 进程猝死」，并核对线程表。
import { spawn as nodeSpawn } from 'node:child_process'
import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE = join(HERE, 'fake-app-server.mjs')
const LOG = join(HERE, 'methods.log')
const DSH = join(HERE, 'dsh-home')
process.env.DSH_HOME = DSH
rmSync(DSH, { recursive: true, force: true })
mkdirSync(DSH, { recursive: true })

// 被测文件用**仓库里的真品**：运行时生成一份只多了导出行的临时副本。
// 不在仓库里长期保留插桩副本，避免它和真品各自漂移。
const SOURCE = join(HERE, '..', '..', 'bundle', 'plugins', 'codexsub.mjs')
const INSTRUMENTED = join(HERE, 'codexsub-testable.generated.mjs')
// 副本落在 tests/ 下，所以它里面的 './lib/…' 要重指到真品旁边那份 lib/。
writeFileSync(INSTRUMENTED, readFileSync(SOURCE, 'utf8')
  .replace(/from '\.\/lib\//g, "from '../../bundle/plugins/lib/")
  + '\n// 自检用：把内部函数暴露给 driver（仅本生成副本，交付文件不含此行）\nexport { startCodexRun, CodexAppServerWire }\n', 'utf8')
const { startCodexRun } = await import('./codexsub-testable.generated.mjs')

const THREADS = join(DSH, 'codexsub', 'threads.json')
let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : `\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`))
}

function makeSpec(mode, spawnRecord) {
  return {
    cwd: HERE,
    permissionMode: 'never',
    env: {},
    disposeGraceMs: 2_000,
    spawn: (spec) => {
      spawnRecord.argv = spec.argv
      const child = nodeSpawn(process.execPath, [FAKE], {
        cwd: spec.cwd,
        env: { ...process.env, FAKE_LOG: LOG, FAKE_MODE: mode },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const done = new Promise((resolve, reject) => {
        child.on('close', (exitCode, signal) => resolve({ exitCode, signal }))
        child.on('error', reject)
      })
      done.catch(() => {})
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        control: undefined,
        collected: {},
        done,
        terminate() { try { child.kill('SIGKILL') } catch { /* 已经退出 */ } },
        async waitForExit() { await done.catch(() => {}); return true },
      }
    },
    onError: () => {},
    log: (message) => console.log('    [log] ' + message),
  }
}

// dispose() → requestCancel() → wire.interrupt() 会发 turn/interrupt，但它在 terminate 之前
// 能否写到管道是竞态的（A 场景出现、B 场景没出现），故序列断言把它过滤掉。
function methods() {
  if (!existsSync(LOG)) return []
  return readFileSync(LOG, 'utf8').split('\n').filter(Boolean)
    .map(line => line.split(' ')[0])
    .filter(method => method !== 'turn/interrupt')
}

function paramsOf(method) {
  return readFileSync(LOG, 'utf8').split('\n').filter(Boolean)
    .filter(line => line.startsWith(method + ' '))
    .map(line => JSON.parse(line.slice(method.length + 1)))
}

async function dispatch(parentId, mode) {
  const record = {}
  const controller = new AbortController()
  const run = await startCodexRun({
    label: 'test',
    prompt: [{ type: 'text', text: 'do the thing' }],
    parent: { id: parentId, session: { id: parentId, header: { cwd: HERE } } },
    signal: controller.signal,
    descriptor: {},
  }, makeSpec(mode, record))
  const result = await run.result
  await run.dispose()
  return { record, result }
}

// —— A 首次派发：thread/start ——
console.log('[A] 首次派发（无记录）')
{
  rmSync(LOG, { force: true })
  const { record, result } = await dispatch('sess-1', 'ok')
  check('argv 形状 = <node> <codex wrapper> app-server --stdio',
    [record.argv[0] === process.execPath, record.argv[2], record.argv[3]], [true, 'app-server', '--stdio'])
  check('调用序列', methods(), ['initialize', 'notification:initialized', 'thread/start', 'turn/start'])
  check('thread/start 不带 ephemeral', 'ephemeral' in paramsOf('thread/start')[0], false)
  check('thread/start 参数', paramsOf('thread/start')[0], { cwd: HERE, approvalPolicy: 'never' })
  check('turn/start 参数', paramsOf('turn/start')[0], {
    threadId: 'thread-new-1',
    input: [{ type: 'text', text: 'do the thing', text_elements: [] }],
  })
  check('结果', result, { output: [{ type: 'text', text: 'hello from fake codex' }], stopReason: 'completed' })
  check('线程表落盘', JSON.parse(readFileSync(THREADS, 'utf8')), { 'sess-1': 'thread-new-1' })
}

// —— B 第二次派发：thread/resume ——
console.log('[B] 同父会话再次派发（有记录）')
{
  rmSync(LOG, { force: true })
  const { result } = await dispatch('sess-1', 'ok')
  check('调用序列', methods(), ['initialize', 'notification:initialized', 'thread/resume', 'turn/start'])
  check('thread/resume 参数', paramsOf('thread/resume')[0],
    { threadId: 'thread-new-1', cwd: HERE, approvalPolicy: 'never' })
  check('结果', result, { output: [{ type: 'text', text: 'hello from fake codex' }], stopReason: 'completed' })
}

// —— C 续接失败：回退 thread/start 并覆盖保存 ——
console.log('[C] 续接失败（-32602）回退新建')
{
  rmSync(LOG, { force: true })
  const { result } = await dispatch('sess-1', 'resume-fail')
  check('调用序列', methods(), ['initialize', 'notification:initialized', 'thread/resume', 'thread/start', 'turn/start'])
  check('回退后线程表被覆盖', JSON.parse(readFileSync(THREADS, 'utf8')), { 'sess-1': 'thread-new-1' })
  check('结果仍是 completed', result.stopReason, 'completed')
}

// —— D 进程猝死：结果扁平化为 error 诊断，不 reject ——
console.log('[D] turn 中途进程退出')
{
  rmSync(LOG, { force: true })
  const { result } = await dispatch('sess-2', 'die')
  check('stopReason', result.stopReason, 'error')
  check('output 为空', result.output, [])
  check('诊断含进程事实', /^Product subagent failure \(product: Codex; stage: (process|turn); category: (process|unknown)/.test(result.diagnostic ?? ''), true)
  console.log('    diagnostic: ' + String(result.diagnostic).replace(/\n/g, ' | '))
}

// —— E 线程表损坏：当空表，照常新开 ——
console.log('[E] 线程表损坏（非法 JSON）')
{
  writeFileSync(THREADS, '{ this is not json', 'utf8')
  rmSync(LOG, { force: true })
  const { result } = await dispatch('sess-3', 'ok')
  check('调用序列（无 resume）', methods(), ['initialize', 'notification:initialized', 'thread/start', 'turn/start'])
  check('结果', result.stopReason, 'completed')
  check('损坏表被重建且保留旧键？', Object.keys(JSON.parse(readFileSync(THREADS, 'utf8'))), ['sess-3'])
}

// —— F dispose 不删线程记录 ——
console.log('[F] dispose 后线程表仍在')
{
  check('线程表存在', existsSync(THREADS), true)
  check('内容', Object.keys(JSON.parse(readFileSync(THREADS, 'utf8'))), ['sess-3'])
}

console.log(failures === 0 ? '\n[selftest] 全部通过' : `\n[selftest] 失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)

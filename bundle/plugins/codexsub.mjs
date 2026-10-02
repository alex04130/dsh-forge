// description: 持久 Codex 线程 subagent provider（注册名 codex）——线协议逐字复刻官方 subagent-codex，
// 唯一差别是线程不 ephemeral、按父会话 thread/resume 续接，让 Codex 侧对话跨多次派发累积上下文。
//
// 上游依据（rc.2 原文，本地克隆 _rc2_src）：
// - packages/subagent/subagent-codex/src/wire.ts —— app-server 方法名/参数/通知名/失败分类；
//   本文件 CodexAppServerWire 是它的逐字移植，只改 openThread（去 ephemeral + 加 resume 回退）。
// - packages/subagent/subagent-codex/src/run.ts —— 进程生命周期、启动失败诊断、stderr 转发、
//   清理阶梯（wire.close → stdin.end → terminate → waitForExit → done），逐字移植。
// - packages/subagent/subagent/src/out-of-process.ts —— NO_START_CAPABILITIES / resolveChildCwd /
//   settleRunResult / subprocessRunHandle 直接复用，不重写。
// thread/resume 的参数形状来自 codex app-server 协议源码 v2/thread.rs 的 ThreadResumeParams
// （serde rename_all = camelCase：threadId / cwd / model / approvalPolicy / approvalsReviewer /
// sandbox），响应为 ThreadResumeResponse{ thread }；rc.2 的 wire.ts 里没有这个方法，所以这一处
// 是「按协议」而不是「按代码」写的——见文件末尾自检报告里标注的不确定点。

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import {
  NO_START_CAPABILITIES,
  resolveChildCwd,
  settleRunResult,
  subprocessRunHandle,
} from '@deepseek-ai/dsh-subagent'
import { DSH_HOME, errText, atomicWriteJson } from './lib/forge-common.mjs'

const PREFIX = 'subagent-codex'

// 无 Config 形态：permission / model / grace 全部固定在官方默认值上（本插件的差别只在「线程续接」，
// 多一个配置面就多一处能和上游行为分叉的地方）。
const PERMISSION_MODE = 'never'
const DISPOSE_GRACE_MS = 3_000
const CHILD_ENV = {}

// 线程表落盘位置：沿用本仓「~/.dsh/<插件名>/<文件>.json」的既有约定
// （injector/registry.json、skillmanager/registry.json、plasmids/registry.json）。
const THREADS_PATH = join(DSH_HOME, 'codexsub', 'threads.json')

// —— 线程表（父会话 id → Codex thread id）——

// 读失败一律当空表：损坏的线程表最多让下一次派发新开线程，绝不能让 provider 起不来。
async function loadThreads() {
  try {
    const parsed = JSON.parse(await readFile(THREADS_PATH, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const map = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value.length > 0) map[key] = value
    }
    return map
  } catch {
    // ENOENT（首次运行）与 JSON 语法错误走同一条路：空表。
    return {}
  }
}

// atomicWriteJson 的临时名只带 pid，同进程并发写会互相覆盖对方的临时文件，所以这里串行化整条
// 读-改-写链；链自身永不 reject（落盘失败只影响下次能否续接，不该把本次派发拖失败）。
let writeQueue = Promise.resolve()

function saveThreadId(parentKey, threadId) {
  writeQueue = writeQueue
    .then(async () => {
      const map = await loadThreads()
      if (map[parentKey] === threadId) return
      map[parentKey] = threadId
      await atomicWriteJson(THREADS_PATH, map)
    })
    .catch(() => { /* 落盘失败不参与本次派发结果 */ })
  return writeQueue
}

// 键取父会话 id：同一个父会话的多次派发累积到同一个 Codex 线程上。
function parentThreadKey(request) {
  const parent = request.parent
  const id = parent?.session?.id ?? parent?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

// —— Codex app-server 启动命令 ——

// 官方写法是在模块加载期 createRequire 解析 @openai/codex/package.json；本插件推迟到首次派发，
// 因为 profile 未声明该依赖时，模块加载期解析失败会让整个插件 import 失败（官方那行在 forge-test
// profile 里正是这么挂的）。包不在本机时回退 PATH 上的 codex（同样的 app-server --stdio 子命令）。
let codexArgvCache

function codexArgv() {
  if (codexArgvCache !== undefined) return codexArgvCache
  try {
    const manifestPath = createRequire(import.meta.url).resolve('@openai/codex/package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const bin = manifest?.bin?.codex
    if (typeof bin !== 'string' || bin.length === 0) {
      throw new Error(`${PREFIX}: @openai/codex package.json declares no bin.codex`)
    }
    codexArgvCache = [process.execPath, resolve(dirname(manifestPath), bin), 'app-server', '--stdio']
  } catch {
    // 回退命令在 Windows 上是 npm 的 .cmd 薄片；Node 对 .cmd 的子进程启动有限制，
    // 这一路径未在本机验证过（本机没有装 codex）——见文件末尾报告的不确定点。
    codexArgvCache = ['codex', 'app-server', '--stdio']
  }
  return codexArgvCache
}

// —— 与官方 wire.ts 相同的协议常量与校验 ——

// 三种非交互 permission mode 映射到 thread/start（以及 thread/resume）的字段。
const THREAD_PERMISSION_PARAMS = {
  never: { approvalPolicy: 'never' },
  'approve-for-me': {
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
    sandbox: 'workspace-write',
  },
  'dangerously-bypass-approvals-and-sandbox': {
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  },
}

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${PREFIX}: app-server returned invalid ${label}`)
  }
  return value
}

function string(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${PREFIX}: app-server returned invalid ${label}`)
  }
  return value
}

function unattendedDecision(params) {
  const available = params.availableDecisions
  if (available === undefined || available === null) return 'decline'
  if (Array.isArray(available)) {
    if (available.includes('cancel')) return 'cancel'
    if (available.includes('decline')) return 'decline'
  }
  throw new Error(`${PREFIX}: app-server offered no unattended approval decision`)
}

function numericHttpStatus(value) {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 0
    && value <= 65_535
    ? value
    : undefined
}

function objectFailureInfo(value) {
  const keys = Object.keys(value)
  const category = keys[0]
  if (keys.length !== 1 || category === undefined) return { category: 'unknown' }
  const detail = value[category]
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) {
    return { category: 'unknown' }
  }
  const fields = detail
  switch (category) {
    case 'httpConnectionFailed':
    case 'responseStreamConnectionFailed':
    case 'responseStreamDisconnected':
    case 'responseTooManyFailedAttempts': {
      const httpStatus = numericHttpStatus(fields.httpStatusCode)
      return httpStatus === undefined
        ? { category: 'transport' }
        : { category: 'transport', httpStatus }
    }
    case 'activeTurnNotSteerable':
      return { category: 'product-error' }
    default:
      return { category: 'unknown' }
  }
}

function failureInfo(turn) {
  if (turn.status !== 'failed') return { category: 'unknown' }
  const error = turn.error
  if (error === null || typeof error !== 'object' || Array.isArray(error)) {
    return { category: 'unknown' }
  }
  const info = error.codexErrorInfo
  if (typeof info === 'string') {
    switch (info) {
      case 'contextWindowExceeded':
        return { category: 'limit', maxTokens: true }
      case 'sessionBudgetExceeded':
      case 'usageLimitExceeded':
        return { category: 'limit' }
      case 'serverOverloaded':
      case 'internalServerError':
        return { category: 'service' }
      case 'cyberPolicy':
      case 'misalignmentPolicyViolation':
      case 'unauthorized':
        return { category: 'access-policy' }
      case 'badRequest':
      case 'threadRollbackFailed':
      case 'other':
        return { category: 'product-error' }
      case 'sandboxError':
        return { category: 'access-policy', sandboxFailure: true }
      default:
        return { category: 'unknown' }
    }
  }
  return info !== null && typeof info === 'object' && !Array.isArray(info)
    ? objectFailureInfo(info)
    : { category: 'unknown' }
}

function unattendedDiagnostic(mode, request, decision, reason) {
  return `Codex unattended decision (mode: ${mode}; request: ${request}; decision: ${decision}): ${reason}`
}

function thrown(value) {
  return value instanceof Error ? value : new Error(String(value))
}

function abortError(signal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`${PREFIX}: app-server request aborted: ${String(signal.reason)}`)
}

async function raceAbort(pending, signal) {
  if (signal.aborted) {
    void pending.catch(() => {})
    throw abortError(signal)
  }
  let rejectAbort
  const aborted = new Promise((_resolve, reject) => { rejectAbort = reject })
  const onAbort = () => { rejectAbort(abortError(signal)) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([pending, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

// —— app-server 连接（wire.ts 逐字移植 + resume）——

/**
 * 一个 app-server 连接和它的单次 thread/turn。与官方 wire.ts 的差别只有两处：
 * `openThread` 优先 thread/resume，且 thread/start 不带 ephemeral。
 */
class CodexAppServerWire {
  constructor(input, output, permissionMode, model, savedThreadId) {
    this.input = input
    this.output = output
    this.permissionMode = permissionMode
    this.model = model
    this.savedThreadId = savedThreadId
    this.transport = new JsonRpcLineTransport(input, output)
    this.fatal = Promise.withResolvers()
    this.threadId = undefined
    this.turnId = undefined
    this.pendingTurnId = undefined
    this.turnCompleted = undefined
    this.earlyTurnNotifications = []
    this.lastFinalAnswer = undefined
    this.lastUnphasedAnswer = undefined
    this.diagnostic = undefined
    this.failure = undefined
    this.resumeNote = undefined
    this.diagnosticOrder = 0
    this.observationOrder = 0
    this.pendingDiagnostic = undefined
    this.inputEnded = false
    this.terminalObserved = false
    this.closed = false

    // 致命协议状态可能在本轮操作已经结算之后才到；这里先把共享 rejection 标记为已观察，
    // 免得它变成未处理拒绝（官方 wire.ts:229-233 的同一处理）。
    void this.fatal.promise.catch(() => {})
    this.transport.onRequest((method, params) => this.handleServerRequest(method, params))
    this.transport.onNotification((method, params) => {
      try {
        this.handleNotification(method, params)
      } catch (error) {
        this.fail(thrown(error))
      }
    })
    this.input.on('error', this.onInputError)
    this.input.on('end', this.onInputEnd)
    // 管道错误可能和协议关闭、进程拆除竞争；两个错误监听都留到流生命周期结束，
    // 免得迟到的 EPIPE 变成未处理的 EventEmitter error。
    output.on('error', this.onOutputError)
  }

  onInputError = (error) => { this.fail(error) }

  onOutputError = (error) => { this.fail(error) }

  onInputEnd = () => {
    this.inputEnded = true
    this.fail(new Error(`${PREFIX}: app-server protocol stream closed`))
  }

  /** 开始读取 app-server 帧。 */
  start() {
    this.transport.start()
  }

  /** 协议输出是否在终态 turn 通知之前就结束了。 */
  endedBeforeTerminal() {
    return this.inputEnded && !this.terminalObserved
  }

  /** 当前 thread id（openThread 成功后必定有值），供调用方落盘。 */
  currentThreadId() {
    return this.threadId
  }

  /** resume 失败回退到新线程时的原因文本；未发生回退则为 undefined。 */
  resumeFallbackNote() {
    return this.resumeNote
  }

  /**
   * 必需的 initialize/initialized 握手。
   * @param signal - 发布前取消信号。
   */
  async initialize(signal) {
    object(await this.guarded(this.transport.request('initialize', {
      clientInfo: {
        name: 'deepseek-harness',
        title: 'DeepSeek Harness',
        version: '0.0.1',
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    }, signal), signal), 'initialize response')
    this.transport.notify('initialized')
    await this.guarded(this.transport.flush(), signal)
  }

  /**
   * 打开本次 run 要用的线程：先按保存的 id 续接，续不上再新建（新建的线程**不** ephemeral）。
   * @param cwd - 父会话工作目录。
   * @param signal - 发布前取消信号。
   */
  async openThread(cwd, signal) {
    if (this.savedThreadId !== undefined) {
      const resumed = await this.resumeThread(this.savedThreadId, cwd, signal)
      if (resumed) return
    }
    await this.startThread(cwd, signal)
  }

  async startThread(cwd, signal) {
    const response = object(await this.guarded(this.transport.request('thread/start', {
      cwd,
      // 上游差异点：官方这里写死 ephemeral: true 并断言返回的 thread.ephemeral === true；
      // 持久线程必须省略该字段（默认 false ⇒ 线程落盘，thread/resume 才有东西可读）。
      ...this.model === undefined ? {} : { model: this.model },
      ...THREAD_PERMISSION_PARAMS[this.permissionMode],
    }, signal), signal), 'thread/start response')
    const thread = object(response.thread, 'thread/start thread')
    this.threadId = string(thread.id, 'thread/start thread id')
  }

  /**
   * 按 thread_id 续接已有线程。
   * @returns true 表示续接成功（threadId 已就位）；false 表示应回退 thread/start。
   */
  async resumeThread(threadId, cwd, signal) {
    try {
      const response = object(await this.guarded(this.transport.request('thread/resume', {
        threadId,
        cwd,
        ...this.model === undefined ? {} : { model: this.model },
        ...THREAD_PERMISSION_PARAMS[this.permissionMode],
      }, signal), signal), 'thread/resume response')
      const thread = object(response.thread, 'thread/resume thread')
      this.threadId = string(thread.id, 'thread/resume thread id')
      return true
    } catch (error) {
      // 线程已不在盘上 / app-server 不认识该方法 / 传输已死：都按「续不上」处理，回退新建。
      // 传输已死时随后的 thread/start 也会失败，那才是真正的启动失败。
      this.resumeNote = errText(error)
      return false
    }
  }

  /**
   * 提交唯一的文本任务，并等本 thread/turn 的权威终态通知。
   * @param texts - 已校验的任务文本块。
   * @param signal - 已发布 run 的本地取消信号。
   * @returns 共享 subagent 结果。
   */
  async runTurn(texts, signal) {
    const completion = Promise.withResolvers()
    this.turnCompleted = completion
    const threadId = this.threadId
    try {
      const response = object(await this.guarded(this.transport.request('turn/start', {
        threadId,
        input: texts.map(text => ({ type: 'text', text, text_elements: [] })),
      }, signal), signal), 'turn/start response')
      const turn = object(response.turn, 'turn/start turn')
      this.commitTurnId(string(turn.id, 'turn/start turn id'))
    } catch (error) {
      this.recordFailure({ stage: 'turn-start', category: 'unknown' })
      throw error
    }

    let completed
    let terminal
    try {
      completed = await this.guarded(completion.promise, signal)
      terminal = object(completed.params.turn, 'turn/completed turn')
    } catch (error) {
      this.recordFailure({ stage: 'turn', category: 'unknown' })
      throw error
    }
    const status = terminal.status
    if (status !== 'completed') {
      const parsed = failureInfo(terminal)
      this.recordFailure(parsed.httpStatus === undefined
        ? { stage: 'turn', category: parsed.category }
        : {
          stage: 'turn',
          category: parsed.category,
          httpStatus: parsed.httpStatus,
        })
      if (parsed.sandboxFailure) {
        this.recordDiagnostic(
          'sandbox execution',
          'failed',
          'Codex reported a sandbox failure',
          completed.order,
        )
      }
      if (parsed.maxTokens) {
        return { output: this.collectOutput(), stopReason: 'max-tokens' }
      }
      const detail = status === 'failed' ? `: ${parsed.category}` : ''
      throw new Error(`${PREFIX}: Codex turn ended with status ${String(status)}${detail}`)
    }
    const output = this.collectOutput()
    if (output.length === 0) {
      this.recordFailure({ stage: 'turn', category: 'invalid-result' })
      throw new Error(`${PREFIX}: Codex completed without a final answer`)
    }
    return { output, stopReason: 'completed' }
  }

  /** 尽力而为的远端取消；子进程不再接受协议请求时，本地结算与进程拆除仍是权威。 */
  interrupt() {
    if (this.threadId === undefined || this.turnId === undefined || this.closed) return
    void this.transport.request('turn/interrupt', {
      threadId: this.threadId,
      turnId: this.turnId,
    }).catch(() => {})
  }

  /** 目前观察到的最佳非 commentary 回答，保留原始字节。 */
  collectOutput() {
    const selected = this.lastFinalAnswer ?? this.lastUnphasedAnswer
    return selected !== undefined && selected.trim().length > 0
      ? [{ type: 'text', text: selected }]
      : []
  }

  /** 本轮观察到的最新安全 permission 事实。 */
  collectDiagnostic() {
    return this.diagnostic
  }

  /** 本轮已发布 turn 的结构化失败事实；只能在 runTurn 非 completed 返回/拒绝之后调用。 */
  collectFailure() {
    return this.failure
  }

  /** 摘除 JSON-RPC 监听并拒绝未决请求；幂等。 */
  close() {
    if (this.closed) return
    this.closed = true
    this.input.off('end', this.onInputEnd)
    this.transport.close()
  }

  async guarded(pending, signal) {
    const withFatal = Promise.race([this.fatal.promise, pending])
    return raceAbort(withFatal, signal)
  }

  fail(error) {
    this.fatal.reject(error)
  }

  observePendingTurnId(id) {
    if (this.turnCompleted === undefined) {
      throw new Error(`${PREFIX}: app-server referenced a turn before turn/start`)
    }
    if (this.pendingTurnId !== undefined && this.pendingTurnId !== id) {
      throw new Error(`${PREFIX}: app-server referenced conflicting turns`)
    }
    this.pendingTurnId = id
  }

  commitTurnId(id) {
    if (this.pendingTurnId !== undefined && this.pendingTurnId !== id) {
      throw new Error(`${PREFIX}: turn/start response did not match the active turn`)
    }
    this.turnId = id
    const pendingDiagnostic = this.pendingDiagnostic
    this.pendingDiagnostic = undefined
    if (pendingDiagnostic !== undefined) {
      this.recordDiagnostic(
        pendingDiagnostic.request,
        pendingDiagnostic.decision,
        pendingDiagnostic.reason,
        pendingDiagnostic.order,
      )
    }
    const notifications = this.earlyTurnNotifications.splice(0)
    for (const notification of notifications) {
      this.handleNotification(notification.method, notification.params, notification.order)
    }
  }

  /**
   * 校验请求里的 thread/turn 关联。
   * @returns true 表示匹配的 turn 还是临时的（诊断要推迟到 commitTurnId）。
   */
  validateRunIds(params, nullableTurn = false) {
    if (params.threadId !== this.threadId) {
      throw new Error(`${PREFIX}: app-server request referenced another thread`)
    }
    if (nullableTurn && params.turnId === null) return false
    const id = string(params.turnId, 'server request turn id')
    if (this.turnId === undefined) {
      this.observePendingTurnId(id)
      return true
    }
    if (id !== this.turnId) {
      throw new Error(`${PREFIX}: app-server request referenced another turn`)
    }
    return false
  }

  recordRequestDiagnostic(provisional, request, decision, reason) {
    const order = this.nextObservationOrder()
    if (provisional) {
      this.pendingDiagnostic = { order, request, decision, reason }
      return
    }
    this.recordDiagnostic(request, decision, reason, order)
  }

  recordDiagnostic(request, decision, reason, order = this.nextObservationOrder()) {
    if (order < this.diagnosticOrder) return
    this.diagnosticOrder = order
    this.diagnostic = unattendedDiagnostic(this.permissionMode, request, decision, reason)
  }

  recordFailure(facts) {
    this.failure = facts
  }

  nextObservationOrder() {
    this.observationOrder += 1
    return this.observationOrder
  }

  recordDeclinedItem(item, order) {
    if (item.type === 'commandExecution' && item.status === 'declined') {
      this.recordDiagnostic(
        'command execution',
        'declined',
        'Codex declined the command under the selected permission mode',
        order,
      )
      return true
    }
    if (item.type === 'fileChange' && item.status === 'declined') {
      this.recordDiagnostic(
        'file change',
        'declined',
        'Codex declined the file change under the selected permission mode',
        order,
      )
      return true
    }
    return false
  }

  handleServerRequest(method, params) {
    try {
      switch (method) {
        case 'item/commandExecution/requestApproval': {
          const provisional = this.validateRunIds(params)
          const decision = unattendedDecision(params)
          this.recordRequestDiagnostic(
            provisional,
            'command approval',
            decision === 'cancel' ? 'cancelled' : 'declined',
            'the provider does not grant interactive approval',
          )
          return Promise.resolve({ decision })
        }
        case 'item/fileChange/requestApproval': {
          const provisional = this.validateRunIds(params)
          const decision = unattendedDecision(params)
          this.recordRequestDiagnostic(
            provisional,
            'file approval',
            decision === 'cancel' ? 'cancelled' : 'declined',
            'the provider does not grant interactive approval',
          )
          return Promise.resolve({ decision })
        }
        case 'item/permissions/requestApproval':
          this.recordRequestDiagnostic(
            this.validateRunIds(params),
            'permission grant',
            'denied',
            'the provider grants no additional turn permissions',
          )
          return Promise.resolve({ permissions: {}, scope: 'turn' })
        case 'item/tool/requestUserInput':
          this.recordRequestDiagnostic(
            this.validateRunIds(params),
            'user input',
            'empty response',
            'the provider does not collect interactive answers',
          )
          return Promise.resolve({ answers: {} })
        case 'mcpServer/elicitation/request':
          this.recordRequestDiagnostic(
            this.validateRunIds(params, true),
            'MCP elicitation',
            'declined',
            'the provider does not collect interactive MCP input',
          )
          return Promise.resolve({ action: 'decline', content: null, _meta: null })
        default:
          throw new Error(`${PREFIX}: unsupported app-server request ${JSON.stringify(method)}`)
      }
    } catch (error) {
      const normalized = thrown(error)
      this.fail(normalized)
      return Promise.reject(normalized)
    }
  }

  handleNotification(method, params, order) {
    if (method === 'turn/started') {
      const threadId = string(params.threadId, 'turn/started thread id')
      if (threadId !== this.threadId) return
      const turn = object(params.turn, 'turn/started turn')
      if (this.turnCompleted !== undefined && this.turnId === undefined) {
        this.observePendingTurnId(string(turn.id, 'turn/started turn id'))
      }
      return
    }
    if (method === 'item/completed') {
      const threadId = string(params.threadId, 'item/completed thread id')
      if (threadId !== this.threadId) return
      const id = string(params.turnId, 'item/completed turn id')
      if (this.turnId === undefined) {
        if (this.turnCompleted !== undefined) {
          this.observePendingTurnId(id)
          this.earlyTurnNotifications.push({
            method,
            params,
            order: this.nextObservationOrder(),
          })
        }
        return
      }
      if (id !== this.turnId) return
      const item = object(params.item, 'item/completed item')
      if (this.recordDeclinedItem(item, order)) return
      if (item.type !== 'agentMessage') return
      const text = typeof item.text === 'string'
        ? item.text
        : (() => { throw new Error(`${PREFIX}: app-server returned an invalid agent message`) })()
      if (item.phase === 'final_answer') {
        this.lastFinalAnswer = text
      } else if (item.phase === null) {
        this.lastUnphasedAnswer = text
      } else if (item.phase !== 'commentary') {
        throw new Error(`${PREFIX}: app-server returned an unknown agent message phase ${JSON.stringify(item.phase)}`)
      }
      return
    }
    if (method !== 'turn/completed') return
    const threadId = string(params.threadId, 'turn/completed thread id')
    if (threadId !== this.threadId) return
    const turn = object(params.turn, 'turn/completed turn')
    const id = string(turn.id, 'turn/completed turn id')
    const turnCompleted = this.turnCompleted
    if (turnCompleted === undefined) return
    if (this.turnId === undefined) {
      this.observePendingTurnId(id)
      this.earlyTurnNotifications.push({
        method,
        params,
        order: this.nextObservationOrder(),
      })
      return
    }
    if (id !== this.turnId) return
    this.terminalObserved = true
    if (!['completed', 'interrupted', 'failed'].includes(String(turn.status))) {
      throw new Error(`${PREFIX}: app-server returned invalid terminal turn status ${String(turn.status)}`)
    }
    turnCompleted.resolve({
      params,
      order: order ?? this.nextObservationOrder(),
    })
  }
}

// —— 进程生命周期（run.ts 逐字移植）——

function failureDiagnostic(facts) {
  const fields = [
    'product: Codex',
    `stage: ${facts.stage}`,
    `category: ${facts.category}`,
  ]
  if (facts.httpStatus !== undefined) {
    fields.push(`HTTP status: ${facts.httpStatus}`)
  }
  const processFields = [
    ['exit code', facts.outcome?.exitCode],
    ['signal', facts.outcome?.signal],
  ]
  for (const [label, value] of processFields) {
    if (value !== null && value !== undefined) fields.push(`${label}: ${value}`)
  }
  return `Product subagent failure (${fields.join('; ')})`
}

class CodexRunFailure extends Error {
  constructor(facts, cause) {
    super(
      `${PREFIX}: ${failureDiagnostic(facts)}`,
      cause === undefined ? undefined : { cause },
    )
    this.facts = facts
    this.name = 'CodexRunFailure'
  }
}

/** 把未发布的 Host 失败藏进固定安全启动事实之后。 */
function codexStartupFailure(cause) {
  return new CodexRunFailure({ stage: 'initialize', category: 'unknown' }, cause)
}

/**
 * 校验并保留一次性的任务，然后才跨进程边界。
 * @param prompt - 共享 subagent 服务交来的任务内容。
 * @returns 逐字保留的非空文本块序列。
 */
function textTask(prompt) {
  if (prompt.length === 0) {
    throw new Error(`${PREFIX}: the one-shot task must contain only text blocks`)
  }
  const texts = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error(`${PREFIX}: the one-shot task must contain only text blocks`)
    }
    texts.push(block.text)
  }
  if (texts.every(text => text.trim().length === 0)) {
    throw new Error(`${PREFIX}: the one-shot task must not be empty`)
  }
  return texts
}

/**
 * 关私有 wire、终止托管进程范围，并等进程归属方证明它已经静默。
 * @param wire - 私有 app-server 协议连接。
 * @param child - 持有托管范围的共享服务句柄。
 */
async function disposeCodexChild(wire, child) {
  wire.close()

  let outcome
  void child.done.then(
    (value) => { outcome = value },
    () => {},
  )
  try {
    child.stdin?.end()
  } catch {
    // 已经是关闭状态的 stdin 不改变下面的范围归属。
  }
  child.terminate()
  try {
    await child.waitForExit()
  } catch (error) {
    throw new CodexRunFailure({
      stage: 'teardown',
      category: 'unknown',
      outcome,
    }, thrown(error))
  }
  await child.done.catch(() => {})
}

/**
 * 起真正的 `codex app-server --stdio` 子进程，并发布它的一次性 run。
 * @param request - 已解析的共享 subagent 请求。
 * @param spec - 工作目录、进程服务、诊断与线程表策略。
 * @returns 初始化与线程就绪之后发布的 run。
 */
async function startCodexRun(request, spec) {
  const texts = textTask(request.prompt)
  if (request.signal.aborted) {
    throw new Error(`${PREFIX}: request was aborted before app-server startup`)
  }

  const parentKey = parentThreadKey(request)
  const savedThreadId = parentKey === undefined ? undefined : (await loadThreads())[parentKey]

  let child
  try {
    child = spec.spawn({
      argv: codexArgv(),
      cwd: spec.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: spec.disposeGraceMs,
      env: spec.env,
    })
  } catch (error) {
    throw new CodexRunFailure({ stage: 'initialize', category: 'unknown' }, thrown(error))
  }

  const wire = new CodexAppServerWire(
    child.stdout,
    child.stdin,
    spec.permissionMode,
    spec.model,
    savedThreadId,
  )
  const onStderr = (chunk) => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    try {
      // 同步 fd 转发保住字节顺序，也不用自己维护背压队列。
      writeFileSync(process.stderr.fd, bytes)
    } catch {
      // Host stderr 是观察汇，不是子进程 run 的失败权威。
    }
  }
  const onStderrError = () => {
    // stderr 观察是辅助面：它自己失败时，JSON-RPC 与 child.done 仍是唯一终态权威。
  }
  child.stderr?.on('data', onStderr)
  child.stderr?.on('error', onStderrError)
  const disposeProcess = async () => {
    try {
      await disposeCodexChild(wire, child)
      // 让进程关闭前已经排队的 stderr 先到达 Host，再摘转发监听。
      await new Promise((resolve) => { setImmediate(resolve) })
    } finally {
      child.stderr?.off('data', onStderr)
      child.stderr?.off('error', onStderrError)
    }
  }

  let processFailureFacts
  const processFailure = child.done.then(
    (outcome) => {
      processFailureFacts = { stage: 'process', category: 'process', outcome }
      throw new CodexRunFailure(processFailureFacts)
    },
    (error) => {
      processFailureFacts = { stage: 'process', category: 'unknown' }
      throw new CodexRunFailure(processFailureFacts, thrown(error))
    },
  )
  // 正常的结果后 dispose 也会关进程；终态先到时把这个必然的迟到 rejection 标记为已观察。
  processFailure.catch(() => {})

  const runAbort = new AbortController()
  const requestCancel = () => {
    if (runAbort.signal.aborted) return
    runAbort.abort(new Error(`${PREFIX}: run cancelled locally`))
    wire.interrupt()
  }
  const onAbort = () => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  let startupStage = 'initialize'
  try {
    wire.start()
    await Promise.race([wire.initialize(request.signal), processFailure])
    startupStage = 'thread-start'
    await Promise.race([wire.openThread(spec.cwd, request.signal), processFailure])
  } catch (error) {
    request.signal.removeEventListener('abort', onAbort)
    const cancelledBeforeCleanup = runAbort.signal.aborted
    if (!(error instanceof CodexRunFailure) && !cancelledBeforeCleanup) {
      // Node 先报 stdout EOF，再报拥有该结果的 child close；给已经在退出的进程一个
      // I/O 回合把那些事实发布出来，然后才回滚。
      await new Promise((resolve) => { setImmediate(resolve) })
    }
    const failure = new CodexRunFailure({
      stage: startupStage,
      category: 'unknown',
      outcome: error instanceof CodexRunFailure
        ? error.facts.outcome
        : processFailureFacts?.outcome,
    }, thrown(error))
    try {
      await disposeProcess()
    } catch (disposeError) {
      const cleanupFailure = thrown(disposeError)
      throw new AggregateError(
        [failure, cleanupFailure],
        `${failure.message}; ${cleanupFailure.message}`,
      )
    }
    if (cancelledBeforeCleanup) {
      throw new Error(`${PREFIX}: request was aborted before run publication`)
    }
    try {
      request.signal.throwIfAborted()
    } catch {
      throw new Error(`${PREFIX}: request was aborted before run publication`)
    }
    throw failure
  }

  // 线程身份落盘：resume 命中也走这里（id 不变时 saveThreadId 直接跳过）。
  // 放在发布之前 await，是为了「线程已经存在但还没记账」这个窗口不跨过发布点。
  if (parentKey !== undefined) {
    const threadId = wire.currentThreadId()
    if (threadId !== undefined) await saveThreadId(parentKey, threadId)
  }
  const resumeNote = wire.resumeFallbackNote()
  if (resumeNote !== undefined) {
    spec.log?.(`Codex thread resume failed; started a fresh thread instead: ${resumeNote}`)
  }

  const collectOutput = () => wire.collectOutput()
  let diagnostic
  const recordFailureDiagnostic = (facts) => {
    const failure = failureDiagnostic(facts)
    const permission = wire.collectDiagnostic()
    diagnostic = permission === undefined
      ? failure
      : `${failure}\n${permission}`
    return diagnostic
  }
  const withProcessOutcome = (facts) => {
    const outcome = processFailureFacts?.outcome
    return outcome === undefined ? facts : { ...facts, outcome }
  }
  const publishedProcessFailure = processFailure.catch(
    async (error) => {
      // 已经在退出的 app-server 排队的帧仍然是权威；给一个 I/O 回合让它们结算，
      // 然后才由进程退出终结本轮。
      await new Promise((resolve) => { setImmediate(resolve) })
      throw error
    },
  )
  const result = settleRunResult({
    attempt: async () => {
      try {
        const terminal = await Promise.race([
          wire.runTurn(texts, runAbort.signal),
          publishedProcessFailure,
        ])
        if (terminal.stopReason === 'completed') return terminal
        // 让和终态帧一起排队的 stderr 先到 Host，再结算非 completed 结果。
        await new Promise((resolve) => { setImmediate(resolve) })
        const facts = withProcessOutcome(wire.collectFailure())
        return { ...terminal, diagnostic: recordFailureDiagnostic(facts) }
      } catch (error) {
        // 给已经排在 Node 里的 stderr 数据一个回合到 Host，然后才结算错误。
        await new Promise((resolve) => { setImmediate(resolve) })
        const endedBeforeTerminal = wire.endedBeforeTerminal()
        if (
          endedBeforeTerminal
          && processFailureFacts === undefined
          && !runAbort.signal.aborted
        ) {
          try {
            const exited = await child.waitForExit(
              AbortSignal.timeout(Math.ceil(spec.disposeGraceMs)),
            )
            if (exited) await child.done
          } catch {
            // 退出观察失败时，wire 失败仍是权威。
          }
        }
        const facts = error instanceof CodexRunFailure
          ? error.facts
          : endedBeforeTerminal && processFailureFacts !== undefined
            ? processFailureFacts
            : withProcessOutcome(wire.collectFailure())
        recordFailureDiagnostic(facts)
        throw error instanceof CodexRunFailure
          ? error
          : new CodexRunFailure(facts, thrown(error))
      }
    },
    collectOutput,
    collectDiagnostic: () => diagnostic,
    cancelled: () => runAbort.signal.aborted,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    // brandString 在运行时是恒等函数（dsh-brand 自述「compile-time brand」），故这里不引它。
    id: randomUUID(),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: disposeProcess,
  })
}

// —— provider（index.ts 的形态，去掉 Config）——

class CodexProvider {
  constructor(ctx) {
    this.name = 'codex'
    this.ctx = ctx
    this.capabilities = NO_START_CAPABILITIES
    this.inheritsParentContext = false
  }

  start(request) {
    const parentCwd = request.parent.session.header.cwd
    if (parentCwd === undefined) {
      throw new Error(
        `${PREFIX}: no working directory for the child — delegate from a parent session that has one`,
      )
    }
    let cwd
    try {
      cwd = resolveChildCwd(PREFIX, undefined, parentCwd)
    } catch (error) {
      if (request.signal.aborted) {
        throw new Error(`${PREFIX}: request was aborted before app-server startup`)
      }
      throw codexStartupFailure(error)
    }
    return startCodexRun(request, {
      cwd,
      permissionMode: PERMISSION_MODE,
      env: CHILD_ENV,
      disposeGraceMs: DISPOSE_GRACE_MS,
      spawn: spawnSpec => this.ctx.subprocess.spawn(spawnSpec),
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `${PREFIX} "${this.name}": child run failed (${stopReason}): ${error.message}`,
        )
      },
      log: (message) => {
        try {
          this.ctx.logger.info(`${PREFIX} "${this.name}": ${message}`)
        } catch {
          // 日志汇失败不影响分发。
        }
      },
    })
  }
}

export default {
  inject: ['subagents', 'subprocess'],
  apply(ctx) {
    // registerProvider 返回 disposer；注册即 effect，HMR/卸载时必须摘掉。
    const dispose = ctx.subagents.registerProvider(new CodexProvider(ctx))
    ctx.effect(() => () => { try { dispose() } catch (error) { /* best-effort */ } })
  },
}

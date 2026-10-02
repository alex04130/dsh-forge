// T8b 闸门：普通 preset 拒 team 工具；模型建队/加人、工具审批、提问镜像到 console-inbox。
// 静态插件在重启后接管；本进程仍由动态 inbx-22 热载。
import { teamOfSession, loadProjects } from './projects.mjs'
import { enqueueInbox, inboxLookup, inboxSupersede } from './team-org.mjs'

export const FORGE_TEAM_PRESETS = ['forge-team', 'forge-team-creative', 'forge-team-distill']

export function leafAgent(agent) {
  if (agent === undefined || agent === null) return { id: '', preset: '' }
  let id = ''
  let preset = ''
  try { if (typeof agent.id === 'string') id = agent.id } catch { id = '' }
  try {
    const session = agent.session
    const header = session !== undefined ? session.header : undefined
    if (header !== undefined && typeof header.agentPreset === 'string') preset = header.agentPreset
  } catch { preset = '' }
  return { id, preset }
}

export async function projectIdOfSession(sessionId) {
  try {
    const cfg = await loadProjects()
    const hit = teamOfSession(cfg, sessionId)
    if (hit && hit.project && hit.project.id) return hit.project.id
  } catch { /* fall through */ }
  return 'p-dsh-forge'
}

export function installConsoleGates(ctx) {
  const timer = ctx.get('timer')
  function later(fn, ms) {
    if (timer !== undefined && typeof timer.timeout === 'function') return timer.timeout(fn, ms)
    if (typeof ctx.timeout === 'function') return ctx.timeout(fn, ms)
    return undefined
  }
  async function waitDecision(id, projectId, timeoutMs, signal) {
    return await new Promise((resolve) => {
      const start = Date.now()
      if (signal !== undefined && signal !== null && typeof signal.addEventListener === 'function') {
        // 请求被上游取消时立即收摊，别继续轮询。
        if (signal.aborted === true) { resolve(''); return }
        signal.addEventListener('abort', () => resolve(''), { once: true })
      }
      const tick = async () => {
        try {
          const row = await inboxLookup(projectId, id)
          const st = row && row.status
          if (st === 'allowed') { resolve('allowed-once'); return }
          if (st === 'denied') { resolve('rejected'); return }
          // 已被别人（WebUI）答掉、或被标记为 superseded：停止轮询，别空转到 120 秒。
          if (st !== undefined && st !== null && st !== 'pending') { resolve(''); return }
        } catch { /* keep waiting */ }
        if (Date.now() - start > timeoutMs) { resolve(''); return }
        const handle = later(tick, 400)
        if (handle === undefined) resolve('')
      }
      const handle = later(tick, 400)
      if (handle === undefined) resolve('')
    })
  }

  ctx.on('approval/request', async (req, next) => {
    const info = leafAgent(req !== undefined ? req.agent : undefined)
    const projectId = await projectIdOfSession(info.id)
    const row = await enqueueInbox(projectId, {
      kind: 'tool-approval',
      title: '工具审批',
      toolName: req !== undefined ? String(req.toolName || '') : '',
      callId: req !== undefined && req.callId !== undefined ? String(req.callId) : '',
      sessionId: info.id,
      from: info.id,
      detail: req !== undefined ? String(req.reason || '') : '',
    })
    // WebUI 的审批弹窗优先：console 是并行的第二条答法，谁先答谁生效。
    // 不许在这里 await 等 console——等待期间下游拿不到请求，WebUI 的弹窗就出不来。
    const answered = Promise.resolve().then(() => next()).then(
      (value) => ({ accepted: true, value }),
      (error) => ({ accepted: false, error }),
    )
    if (!row || !row.id) {
      const only = await answered
      if (only.accepted) return only.value
      throw only.error
    }
    const decided = waitDecision(row.id, projectId, 120000, req !== undefined ? req.signal : undefined)
    return await new Promise((resolve, reject) => {
      let done = false
      const settle = (fn, value) => { if (!done) { done = true; fn(value) } }
      answered.then((r) => {
        if (!r.accepted) return
        settle(resolve, r.value)
        inboxSupersede({ id: row.id, actor: 'webui' }).catch(() => {})
      })
      decided.then((verdict) => {
        if (verdict === 'allowed-once' || verdict === 'rejected') { settle(resolve, verdict); return }
        // console 窗口关了（超时或被取消）：这条请求此后归下游（WebUI），
        // 把收件箱那行标掉，免得留下一条点了没人应的死待办。
        inboxSupersede({ id: row.id, actor: 'handed-to-webui' }).catch(() => {})
      })
      // 两边都没有结果：WebUI 交棒 + console 超时 → 把下游的失败原样抛出去。
      Promise.all([answered, decided]).then((pair) => {
        const r = pair[0]
        if (r.accepted) {
          settle(resolve, r.value)
          inboxSupersede({ id: row.id, actor: 'webui' }).catch(() => {})
        } else {
          inboxSupersede({ id: row.id, actor: 'no-answerer' }).catch(() => {})
          settle(reject, r.error)
        }
      })
    })
  })

  // 读回 console 里记下的真实选择。记录不可用时返回空 answers——绝不拿第一个选项顶替用户的选择。
  async function answerFromInbox(projectId, id) {
    let row = null
    try { row = await inboxLookup(projectId, id) } catch { row = null }
    const recorded = row !== null && Array.isArray(row.answers) ? row.answers : []
    return {
      answers: recorded.map((a) => ({
        id: a && a.id ? String(a.id) : '',
        selected: Array.isArray(a && a.selected) ? a.selected.map((s) => String(s)) : [],
      })),
    }
  }

  ctx.on('user-questions/request', async (request, next) => {
    const info = leafAgent(request !== undefined ? request.agent : undefined)
    const questions = request !== undefined && Array.isArray(request.questions) ? request.questions.map((q) => ({
      id: q && q.id ? String(q.id) : '',
      question: q && q.question ? String(q.question) : '',
      options: Array.isArray(q && q.options) ? q.options.map((o) => ({ label: String(o && o.label ? o.label : '') })) : [],
    })) : []
    const projectId = await projectIdOfSession(info.id)
    const row = await enqueueInbox(projectId, {
      kind: 'question',
      title: '队员提问',
      sessionId: info.id,
      from: info.id,
      questions,
    })
    // WebUI 优先：console 是并行的第二条答法，谁先答谁生效。
    // 不许在这里 await 等 console——等待期间下游（WebUI 提问框）拿不到请求，
    // 会话不在前台时就无框可点，WEB 会一直卡到超时。
    const answered = Promise.resolve().then(() => next()).then(
      (value) => ({ accepted: true, value }),
      (error) => ({ accepted: false, error }),
    )
    if (!row || !row.id) {
      const only = await answered
      if (only.accepted) return only.value
      throw only.error
    }
    const decided = waitDecision(row.id, projectId, 120000, request !== undefined ? request.signal : undefined)
    return await new Promise((resolve, reject) => {
      let done = false
      const settle = (fn, value) => { if (!done) { done = true; fn(value) } }
      answered.then((r) => {
        if (!r.accepted) return
        settle(resolve, r.value)
        // WebUI 赢了：把 console 里那条待办标记掉，别留着一条没人等的行。
        inboxSupersede({ id: row.id, actor: 'webui' }).catch(() => {})
      })
      decided.then(async (verdict) => {
        if (verdict === 'allowed-once') { settle(resolve, await answerFromInbox(projectId, row.id)); return }
        if (verdict === 'rejected') { settle(resolve, { answers: [] }); return }
        // console 窗口关了（超时或被取消）：这条提问此后归下游（WebUI），标掉收件箱那行。
        inboxSupersede({ id: row.id, actor: 'handed-to-webui' }).catch(() => {})
      })
      // 两边都没有结果：WebUI 交棒 + console 超时 → 把下游的失败原样抛出去，不猜一个答案。
      Promise.all([answered, decided]).then((pair) => {
        const r = pair[0]
        if (r.accepted) {
          settle(resolve, r.value)
          inboxSupersede({ id: row.id, actor: 'webui' }).catch(() => {})
        } else {
          // 两边都没有答者，提问本身失败了：收件箱那条也一并标记掉。
          inboxSupersede({ id: row.id, actor: 'no-answerer' }).catch(() => {})
          settle(reject, r.error)
        }
      })
    })
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const name = exec !== undefined ? String(exec.name || '') : ''
    const isTeam = name === 'teams' || name.indexOf('team_') === 0
    if (!isTeam) return next()
    const info = leafAgent(exec !== undefined ? exec.agent : undefined)
    let allowed = FORGE_TEAM_PRESETS.indexOf(info.preset) >= 0
    if (!allowed && info.id) {
      try {
        const cfg = await loadProjects()
        const hit = teamOfSession(cfg, info.id)
        const face = hit && hit.team && Array.isArray(hit.team.members)
          ? (hit.team.members.find((m) => m && m.sessionId === info.id) || {}).preset
          : ''
        if (FORGE_TEAM_PRESETS.indexOf(String(face || '')) >= 0) allowed = true
      } catch { /* keep header verdict */ }
    }
    if (!allowed) {
      return { kind: 'deny', reason: 'team 工具只给 forge-team / forge-team-creative / forge-team-distill' }
    }
    const args = exec !== undefined ? exec.arguments : undefined
    const op = args !== null && typeof args === 'object' ? String(args.op || '') : ''
    const isCreate = name === 'forge_team_create' || op === 'create'
    const isAdd = name === 'team_add_member' || name === 'forge_team_add_members' || op === 'add_member' || op === 'add_members'
    if (!isCreate && !isAdd) return next()
    const projectId = await projectIdOfSession(info.id)
    const row = await enqueueInbox(projectId, {
      kind: isCreate ? 'team-create' : 'team-add',
      title: isCreate ? '模型建队' : '模型加人',
      sessionId: info.id,
      from: info.id,
      toolName: name,
      payload: args && typeof args === 'object' ? args : undefined,
    })
    if (!row || !row.id) return next()
    const decided = await waitDecision(row.id, projectId, 120000)
    if (decided === 'rejected') return { kind: 'deny', reason: '控制台拒绝了建队/加人' }
    if (decided === '') return { kind: 'deny', reason: '控制台建队/加人待批超时' }
    return next()
  })
}

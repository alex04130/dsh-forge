// description: 子代理派发（spawn_model_subagent）：可选 provider/model/effort/模式，默认全继承父代理，提权自动问用户。
import { defineTool } from '@deepseek-ai/dsh-tools'
import { collectModelEscalations, collectPresetEscalations, collectSandboxEscalations, installChildPolicy, validateEffort } from './lib/subagent-policy.mjs'

function errText(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}
function jsonText(value) {
  return JSON.stringify(value, null, 2)
}

// ── spawn_model_subagent v2 ──────────────────────────────────────────────
// Subagent spawning with explicit mode / reasoning-effort / provider / model
// controls. Defaults INHERIT the parent (same provider, same model, same
// effort, same preset) so billing and capability never silently change:
//   - provider: only an EXPLICIT provider argument may switch the provider
//     (explicit model alone keeps the parent's provider — billing safety).
//   - model: explicit model wins; otherwise the parent's live route model.
//   - reasoningEffort: explicit value, else the parent's CURRENT effort
//     (snapshot at spawn; applies to every turn of the child).
//   - mode (agent preset): explicit preset id re-composes the child before
//     its first prompt assembly; otherwise the child inherits the parent's
//     composition as usual.
// Escalation policy (shared library, also used by switch_mode and
// team_add_member): any upgrade — a higher model tier in the same series, a
// cross-series model change, or a target preset whose plugin-row capability
// face is not a subset of the parent's — asks the user through the approval
// service (allowed-once). Equal or lower tiers / equal or fewer capabilities
// proceed without asking. No hard-coded preset ladders.
export default {
  inject: ['tools', 'subagents'],
  apply(ctx) {
    const subagents = ctx.subagents
    const presets = ctx.get('agentPresets')
    const approval = ctx.get('approval')
    const llm = ctx.get('llm')
    const sandboxPolicy = ctx.get('sandboxPolicy')

    const policy = installChildPolicy(ctx, presets)

    const tool = defineTool({
      name: 'spawn_model_subagent',
      description: '派发一个可续子代理会话，继承本会话的组合（相同工具、相同工作区），且默认继承父级的 `provider`/`model`/`reasoningEffort`/`mode`（agent preset），因此计费不会悄悄改变。显式传入其中任意一项只覆盖该维度：单独显式传 `model` 时仍保留父级 provider。提权——同系列内更高模型档位、跨系列换模型，或插件行能力面不是父级子集的目标模式——会请求用户审批，未获允许则取消；同档或更低档、能力相同或更少则直接执行，无需询问。可用 provider/model 组合见 `model_list`。返回的 childId 就是子会话 id：用户可在 GUI 中打开它并向它发截图/文本，子会话会把最终答案回报给本会话。',
      parameters: {
        prompt: { type: 'string', required: true, description: '子代理的完整任务（它看不到本对话的任何内容）。' },
        label: { type: 'string', description: '子会话的简短显示标签。' },
        provider: { type: 'string', description: '可选的子会话供应商路由；省略则继承父级供应商（推荐——计费保持在同一条路由上）。路由 id 见 `model_list`。' },
        model: { type: 'string', description: '可选的子会话模型 id；省略则继承父级当前模型。可用模型见 `model_list`。' },
        reasoningEffort: { type: 'string', description: '可选的子会话思考强度（供应商专属 id，如 "low"/"medium"/"high"）；省略则继承父级当前强度。' },
        mode: { type: 'string', description: '可选的子会话模式 id（如 "router-standard"、"cordis"）；省略则继承父级组合。' },
        sandbox: { type: 'string', description: '可选的子会话沙箱模式（"read-only" | "workspace-write" | "danger-full-access"）；省略则继承部署默认。比父级更宽的写权限会请求审批。' },
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: typeof value === 'string' ? value : String(value) }] },
      },
      async execute(args, exec) {
        try {
          const agent = exec !== undefined ? exec.agent : undefined
          if (agent === undefined) return jsonText({ ok: false, error: 'no calling agent; spawn_model_subagent must run inside a session' })
          const prompt = String(args.prompt ?? '')
          if (prompt.length === 0) return jsonText({ ok: false, error: 'prompt must not be empty' })
          const label = String(args.label ?? '').trim()
          const explicitProvider = typeof args.provider === 'string' && args.provider.trim() !== '' ? args.provider.trim() : undefined
          const explicitModel = typeof args.model === 'string' && args.model.trim() !== '' ? args.model.trim() : undefined
          const explicitEffort = typeof args.reasoningEffort === 'string' && args.reasoningEffort.trim() !== '' ? args.reasoningEffort.trim() : undefined
          const modeId = typeof args.mode === 'string' && args.mode.trim() !== '' ? args.mode.trim() : undefined
          const sandboxMode = typeof args.sandbox === 'string' && args.sandbox.trim() !== '' ? args.sandbox.trim() : undefined

          const route = policy.liveRoute(agent)
          const parentHeader = agent.session?.requestHeader?.()
          const parentPreset = presets !== undefined ? presets.composedPreset(agent.ctx) : undefined
          const parentModel = route.model ?? parentHeader?.config?.model
          const childModel = explicitModel ?? parentModel
          const childProvider = explicitProvider ?? route.provider
          const effort = explicitEffort ?? parentHeader?.config?.reasoningEffort
          let parentSandbox = undefined
          if (sandboxPolicy !== undefined && typeof sandboxPolicy.overrideOf === 'function') {
            try { parentSandbox = sandboxPolicy.overrideOf(agent.session) } catch (error) { parentSandbox = undefined }
          }
          if (parentSandbox === undefined) parentSandbox = sandboxPolicy !== undefined ? sandboxPolicy.defaultMode : undefined

          if (explicitEffort !== undefined && childProvider !== undefined && childModel !== undefined) {
            const check = await validateEffort(llm, childProvider, childModel, explicitEffort)
            if (check.ok === false) return jsonText({ ok: false, error: check.error })
          }

          const escalations = [
            ...collectModelEscalations(parentModel, childModel),
            ...(await collectPresetEscalations({ parentPreset, targetPreset: modeId, presets })),
            ...collectSandboxEscalations(parentSandbox, sandboxMode),
          ]

          if (escalations.length > 0) {
            if (approval === undefined) {
              return jsonText({ ok: false, error: 'this spawn escalates (' + escalations.join('; ') + ') but no approval service is mounted to confirm it' })
            }
            const outcome = await approval.request({
              agent,
              toolName: 'spawn_model_subagent',
              reason: 'subagent escalation: ' + escalations.join('; '),
              signal: exec !== undefined ? exec.signal : undefined,
            })
            if (outcome !== 'allowed-once') {
              return jsonText({ ok: false, cancelled: true, reason: 'the user did not allow this subagent escalation (approval outcome "' + String(outcome) + '"); nothing was spawned', escalations })
            }
          }

          const agentOptions = {}
          if (explicitProvider !== undefined) agentOptions.provider = explicitProvider
          if (explicitModel !== undefined) agentOptions.model = explicitModel

          // Stage mode/effort BEFORE the spawn: startContinuable dispatches
          // agent/created synchronously before resolving, so a post-await
          // register is always too late (see subagent-policy timing contract).
          const staged = policy.prepare({
            parentId: agent.id,
            ...(modeId !== undefined ? { mode: modeId } : {}),
            ...(effort !== undefined && typeof effort === 'string' ? { effort } : {}),
            ...(sandboxMode !== undefined ? { sandbox: sandboxMode } : {}),
          })

          let started
          try {
            started = await subagents.startContinuable({
              provider: 'spawn',
              label: label.length > 0 ? label : (childModel + ' 子代理'),
              request: {
                prompt: [{ type: 'text', text: prompt }],
                parent: agent,
                ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
              },
              signal: exec !== undefined ? exec.signal : undefined,
            })
          } catch (error) {
            staged.cancel()
            throw error
          }

          return jsonText({
            ok: true,
            childId: started.childId,
            messageId: started.messageId,
            route: { provider: childProvider, model: childModel, reasoningEffort: effort ?? null },
            ...(modeId !== undefined ? { mode: modeId } : {}),
            ...(sandboxMode !== undefined ? { sandbox: sandboxMode } : {}),
            ...(escalations.length > 0 ? { approvedEscalations: escalations } : {}),
            note: 'the child session inherits this session composition (same tools, same workspace); send it follow-up input by opening its session in the GUI',
          })
        } catch (error) {
          return jsonText({ ok: false, error: errText(error) })
        }
      },
    })
    const dispose = ctx.tools.register(tool)
    ctx.effect(() => () => { try { dispose() } catch (error) { /* best-effort */ } })
  },
}

// description: 持久技能管理：技能存储（registry.json）+ 启用/禁用/删除，技能面板与模型工具共用一份注册表。
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { isSkillName } from '@deepseek-ai/dsh-skill'

// dsh-skillmanager: durable runtime skill store + management service.
//
// This host plugin owns the PERSISTENT set of runtime skills (host/global
// layer): the durable store (~/.dsh/skillmanager/registry.json), the
// ctx.skills registrations (dispose = remove, register = re-enable), and the
// restart auto-restore. It registers NO model tools — the skillui dynamic
// plugin provides the tools (skill_list/skill_add/...) and the settings-page
// UI, and both reach this plugin through the `skillRegistry` service below.
// One owned Map, one store: the tools and the UI can never fight over the
// registry.
//
// Skill injection recap (verified against dsh-skill / dsh-tool-skill):
//   - registry : ctx.skills merges global + per-scope layers; nearest layer
//                wins a name. ctx.skills.register(skill) adds a RUNTIME skill
//                and returns a disposer; there is NO enable/disable API —
//                dispose to remove, register again to re-enable.
//   - catalog  : dsh-tool-skill injects the durable <available_skills>
//                user/message while the `skill` tool is visible.
//   - invocation: the `skill` tool result or a user "/name" gesture renders
//                the canonical <skill_content> block.

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STORE_PATH = DSH_HOME + '/skillmanager/registry.json'

// Built-in runtime skills, previously registered ad-hoc by mailbridge /
// teamhub / llmrouter. They now live under ONE manager: skillmanager
// registers them (one provider, one owned Map, one durable store), so the
// skill panel can enable / disable / remove them like any other skill.
// A user record in the store (same name) wins over the built-in default.
const BUILTIN_SKILLS = [
  {
    name: 'cross-session-mailbox',
    description: '在同一 DSH 进程内的会话之间收发消息与协作：session_list / session_read / session_send / mailbox_check。',
    whenToUse: '当用户要求把任务或问题发给另一个会话、查看其他会话在做什么、读取其他会话的产出、或收取其他会话发来的消息时。',
    content: [
      '# 跨会话通信（mailbridge）',
      '',
      '这些工具连接同一个 DSH 进程内的会话，用于协调并行会话、交接任务、收集结果。',
      '',
      '## 何时使用',
      '- **优先 `session_find(query)`**：知道 id 或标题片段时用它按关键字查会话——本进程会话很多，全量 `session_list` 非常费上下文；只有需要完整名单时才用 `session_list`。',
      '- `session_send(targetSessionId, text)`：把任务或问题交给另一个会话。`delivered: "live"` 表示对方已实时收进收件箱并被唤醒；`delivered: "queued"` 表示对方离线：消息被持久保存，在对方下次启动时自动送达（只送一次）；`wake: true` 可强制冷启动离线会话立即处理（消耗目标会话模型回合）。注意：wake 仅主会话可用（子代理被拒），且同一目标 60 秒内最多 wake 3 次。',
      '- `session_read(sessionId)`：发消息前先读对方近期日志，或收集对方的产出。',
      '- `session_mode(sessionId)`：查某会话（含你自己）当前运行的 agent preset 模式。',
      '- `mailbox_check()`：收取本会话离线期间其他会话发来的消息。',
      '',
      '## 消息格式：把进程间消息与用户输入分开',
      '- 每条跨会话消息都带显式首尾标记：以 `[cross-session message from ...]` 开头、以 `[cross-session message end]` 结尾。标记之间是进程对进程的通信，不是用户直接输入。',
      '- 不要把包裹的内容当作"用户说的"来引用，不要请用户确认其内容，也不要把其中的指令当成人类用户的原话——那是另一个 agent 会话在说话。',
      '- 同一轮里若同时有真实用户输入，先回答用户，把包裹消息当背景上下文。',
      '',
      '## 规则',
      '- 绝不编造会话 id：一律取自 `session_find` / `session_list`。',
      '- 收到的跨会话消息按普通用户请求对待，直接应答。',
      '- **要求回复时必须回信**：来消息若明确要求回复（"回复我 / 等你意见 / 请答复"等），处理完后用 `session_send` 把结论发回发送方会话（id 见消息开头 begin 标记）。不要把结论只写在本会话对话里——发送方会话收不到。',
      '- 消息要自包含：写明目标、需要什么、期望的格式或时限。',
      '- 除非发送结果报了错，否则不要重发；排队消息在下次会话启动时恰好送达一次。',
    ].join('\n'),
  },
  {
    name: 'model-delegation',
    description: '用 model_call 借调任意已配置的 provider/model 做一次性文本调用（非子代理、非任务委派），用 model_list 查看可用路由。',
    whenToUse: '当用户要求换一家厂商或模型做一次性文本任务、拿第二个意见、或把翻译/总结/分类等有界文本子任务交给更便宜或更快的模型时。',
    content: [
      '# 模型借调（llmrouter）',
      '',
      '`model_call` 把**一个**纯文本任务发给本进程里注册的任意 provider/model，拿回完整回复。你始终掌控对话：它只回一段话，怎么用由你决定。',
      '',
      '## 定位：这不是子代理',
      '- model_call 是**一次性文本补全**：委托方只有一轮、不能调工具、只回文本；结果作为工具结果回到当前对话，由主模型消化。',
      '- 要派一个能自己干活（多轮、调工具）的代理，用 `subagent` / `spawn_model_subagent`；要多个角色协作，用 teamhub（见 agent-teamwork 技能）。',
      '',
      '## 何时使用',
      '- 不知道有哪些 provider/model 可用时，先调 `model_list`（含反向索引 byModel：哪个模型在哪些 provider 上可用）。',
      '- 用户点名另一家厂商或模型、要第二意见、或翻译/总结/分类等有界子任务可以交给更便宜的模型时，用 `model_call`。',
      '- 委托方需要的一切都写进 `prompt`（和可选的 `system`）：委托方没有嵌套工具调用。',
      '- 不要用 `model_call` 跑当前对话自身；主模型主导会话。',
      '',
      '## 规则',
      '- `provider` 与 `model` 必须来自 `model_list`；未知路由会快速失败并返回可用列表。',
      '- 如实汇报委托结果（含 `finish` 与 `usage`），并说明是哪个 provider/model 产出的。',
      '- `ok: false` 时读 `failure`：换正确的路由重试或向用户解释；同一条路由不要重试超过两次。',
      '- provider 在设置（llm-pi-ai.providers）中启用：加配置零代码；API key 从凭据库解析。',
    ].join('\n'),
  },
  {
    name: 'agent-teamwork',
    description: '编排代理团队：队长 + 角色成员（可续子代理）+ 依赖任务板 + 成员间直接通信。',
    whenToUse: '当用户要求一个代理团队、多角色并行协作、或研究/审查/实现流水线需要多个子代理互相协调时，或需要多个会话围绕同一交付物协作时。',
    content: [
      '# 代理团队（teamhub）',
      '',
      'teamhub 工具在本进程会话之上实现 Claude Code 式代理团队。发起调用的会话成为队长（lead）；成员是持久可续的子代理会话。',
      '',
      '## 流程',
      '1. `team_create(name, goal, members?, tasks?)` —— 每个队长同时只能带一个团队（上限 16 人）。可用 `members` 数组在建队时一次添加多个成员（每项 memberId/role/prompt + 可选 provider/model/reasoningEffort/mode/sandbox），可用 `tasks` 数组一次建任务（依赖须先出现）；逐项独立审批与失败隔离。',
      '2. `team_add_member(memberId, role, prompt)` 补单个成员；`team_add_members(members[])` 批量补成员。成员继承队长组合，可选 provider/model/reasoningEffort/mode/sandbox 显式覆盖（提权自动请求审批）。',
      '3. `team_create_task` —— 把目标拆成任务；用 `dependencies` 声明依赖顺序，用 `assignee` 指派成员。',
      '4. 成员执行任务：`team_claim_task`（依赖未完成会被拒）、用自己的工具干活、再 `team_update_task(status, output)`（状态三级流转 claimed → in_progress → completed）。队长也可以认领/更新任务。',
      '5. `team_wait(memberId?, taskId?, timeoutSeconds?)` —— 暂停当前回合，等另一成员的消息或某任务完成（任一满足即唤醒）；等待不消耗额外步骤，消息/任务完成/队长消息都立即唤醒，超时（默认 600 秒）返回后可再等。用它替代轮询 team_status，别做重复劳动。',
      '6. `team_send_message(to, text)` —— 成员间或成员与队长间直接发消息，无需队长中转。在线的立即被唤醒；离线的下次会话启动时收到。',
      '7. `team_status()` —— 队长用它看成员活动、任务板状态和自己的收件箱；成员用它看自己的收件箱和任务。',
      '8. 目标交付后：向用户汇报，然后 `team_delete()` 停掉成员并归档团队。',
      '',
      '## 用团队还是普通子代理',
      '- 需要多个协调角色、成员之间要直接对话时，用团队。',
      '- 一个无需协调的有界任务，用普通 subagent/fork 调用即可。',
      '- 成员宁少勿多：团队放大 token 成本，也可能因缺少更新而停摆。',
      '',
      '## 规则',
      '- 先设计团队再 spawn：角色、任务清单、依赖关系。',
      '- 绝不编造成员 id：一律取自 `team_add_member` / `team_status`。',
      '- 按需沟通：任务分配与依赖用 team_send_message 发送，完成时汇报；不要刷屏。',
      '- 收到的团队消息带显式首尾标记：`[team message from ...]` … `[team message end]` —— 进程间对话，与用户直接输入区分开。',
      '- 读产出用 `team_status`（任务板），而不是反复追问成员。',
      '- 团队之外的跨会话通信仍可用：session_list / session_read / session_send / mailbox_check（见 cross-session-mailbox 技能）。',
    ].join('\n'),
  },
]

function mergeBuiltins(store) {
  if (store === null || typeof store !== 'object' || !Array.isArray(store.skills)) return
  for (const builtin of BUILTIN_SKILLS) {
    if (store.skills.some((s) => s !== null && typeof s === 'object' && s.name === builtin.name)) continue
    store.skills.push({
      name: builtin.name,
      description: builtin.description,
      whenToUse: builtin.whenToUse,
      modelInvocable: true,
      userInvocable: true,
      content: builtin.content,
      enabled: true,
    })
  }
}

function errText(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}

export default {
  inject: ['skills', 'systemPrompt'],
  apply(ctx) {
    const skills = ctx.skills
    const systemPrompt = ctx.systemPrompt
    if (skills === undefined) return
    const owned = new Map() // name -> { registration, dispose, enabled }

    let store = { version: 1, skills: [] }
    const storeReady = (async () => {
      try {
        const raw = await readFile(STORE_PATH, 'utf8')
        const data = JSON.parse(raw)
        if (data !== null && typeof data === 'object' && Array.isArray(data.skills)) {
          store = data
          mergeBuiltins(store)
        }
      } catch (error) {
        if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
          mergeBuiltins(store)
          return
        }
        console.error('[skillmanager] store unreadable, keeping in-memory:', errText(error))
      }
    })()

    let writeQueue = Promise.resolve()
    function persist() {
      const next = writeQueue.then(async () => {
        await mkdir(dirname(STORE_PATH), { recursive: true })
        const tmp = `${STORE_PATH}.tmp-${process.pid}`
        await writeFile(tmp, JSON.stringify(store, null, 2), 'utf8')
        await rename(tmp, STORE_PATH)
      })
      writeQueue = next.catch(() => {})
      return next
    }

    function registerStored(s) {
      if (owned.has(s.name)) return
      const registration = {
        name: s.name,
        description: s.description,
        ...(s.whenToUse !== undefined && s.whenToUse !== '' ? { whenToUse: s.whenToUse } : {}),
        invocation: {
          modelInvocable: s.modelInvocable !== false,
          userInvocable: s.userInvocable !== false,
        },
        content: s.content,
        source: 'runtime',
      }
      // Same-name first-wins: if another provider already registered this
      // name, keep OUR record's enabled state but never double-register.
      const dispose = skills.register(registration)
      const entry = { registration, dispose, enabled: s.enabled !== false, alwaysInject: s.alwaysInject === true, alwaysDispose: undefined }
      owned.set(s.name, entry)
      if (s.enabled === false) {
        try { dispose() } catch (error) { /* best-effort */ }
        entry.enabled = false
      } else if (entry.alwaysInject) {
        try { entry.alwaysDispose = registerAlwaysSection(s) } catch (error) { console.error('[skillmanager] always-inject section failed for', s.name, ':', errText(error)) }
      }
    }

    // ── shared management core ─────────────────────────────────────────────
    // One implementation serves BOTH the model-facing tools (registered by
    // the skillui dynamic plugin) and the skillui RPC bridge: a single owned
    // Map, a single durable store, no competing registries.

    // "Default-inject" mode: the skill's full content is also registered as a
    // system-prompt section (always present, no skill-tool round trip needed).
    // The section text carries a `<!-- forge-always-skill:<name> -->` marker
    // so the router-standard preset can suppress it on its minimal first turn.
    function registerAlwaysSection(s) {
      if (systemPrompt === undefined) throw new Error('systemPrompt service unavailable')
      return systemPrompt.section({
        name: 'forge-always-skill:' + s.name,
        order: 90,
        text: '<!-- forge-always-skill:' + s.name + ' -->\n<skill_content name="' + s.name + '">\n' + s.content + '\n</skill_content>',
      })
    }

    function stateSnapshot() {
      return {
        ok: true,
        storePath: STORE_PATH,
        skills: store.skills.map((s) => ({
          name: s.name,
          description: s.description,
          ...(s.whenToUse !== undefined && s.whenToUse !== '' ? { whenToUse: s.whenToUse } : {}),
          modelInvocable: s.modelInvocable !== false,
          userInvocable: s.userInvocable !== false,
          content: s.content,
          alwaysInject: s.alwaysInject === true,
          enabled: owned.get(s.name) !== undefined ? owned.get(s.name).enabled : (s.enabled !== false),
          managed: owned.has(s.name),
        })),
      }
    }

    async function addSkill(args) {
      const name = String(args.name ?? '').trim()
      if (!isSkillName(name)) return { ok: false, error: `invalid skill name "${name}"` }
      if (owned.has(name)) return { ok: false, error: `skill "${name}" is already managed by skillmanager` }
      const description = String(args.description ?? '').trim()
      const content = String(args.content ?? '')
      if (description === '' || content === '') return { ok: false, error: 'description and content are required' }
      const registration = {
        name,
        description,
        ...(args.whenToUse !== undefined && String(args.whenToUse).trim() !== '' ? { whenToUse: String(args.whenToUse).trim() } : {}),
        invocation: {
          modelInvocable: args.modelInvocable !== false,
          userInvocable: args.userInvocable !== false,
        },
        content,
        source: 'runtime',
      }
      const dispose = skills.register(registration)
      const entry = { registration, dispose, enabled: true, alwaysInject: args.alwaysInject === true, alwaysDispose: undefined }
      owned.set(name, entry)
      if (entry.alwaysInject) {
        try { entry.alwaysDispose = registerAlwaysSection({ name, content }) } catch (error) { console.error('[skillmanager] always-inject section failed for', name, ':', errText(error)) }
      }
      store.skills.push({
        name,
        description,
        ...(registration.whenToUse !== undefined ? { whenToUse: registration.whenToUse } : {}),
        modelInvocable: registration.invocation.modelInvocable,
        userInvocable: registration.invocation.userInvocable,
        content,
        alwaysInject: entry.alwaysInject,
        enabled: true,
      })
      await persist()
      return { ok: true, name, alwaysInject: entry.alwaysInject, note: 'registered at the host (global) layer' }
    }

    async function disableSkill(name) {
      const entry = owned.get(name)
      if (entry === undefined) return { ok: false, error: `skill "${name}" is not managed by skillmanager` }
      if (entry.enabled) {
        try { entry.dispose() } catch (error) { return { ok: false, error: errText(error) } }
        entry.enabled = false
      }
      if (entry.alwaysDispose !== undefined) {
        try { entry.alwaysDispose() } catch (error) { /* best-effort */ }
        entry.alwaysDispose = undefined
      }
      const rec = store.skills.find((s) => s.name === name)
      if (rec !== undefined) rec.enabled = false
      await persist()
      return { ok: true, name, enabled: false }
    }

    async function enableSkill(name) {
      const entry = owned.get(name)
      if (entry === undefined) return { ok: false, error: `skill "${name}" is not managed by skillmanager` }
      if (!entry.enabled) {
        entry.dispose = skills.register(entry.registration)
        entry.enabled = true
      }
      if (entry.alwaysInject && entry.alwaysDispose === undefined) {
        const rec = store.skills.find((s) => s.name === name)
        if (rec !== undefined) {
          try { entry.alwaysDispose = registerAlwaysSection(rec) } catch (error) { console.error('[skillmanager] always-inject section failed for', name, ':', errText(error)) }
        }
      }
      const rec2 = store.skills.find((s) => s.name === name)
      if (rec2 !== undefined) rec2.enabled = true
      await persist()
      return { ok: true, name, enabled: true }
    }

    async function removeSkill(name) {
      const entry = owned.get(name)
      if (entry === undefined) return { ok: false, error: `skill "${name}" is not managed by skillmanager` }
      if (entry.enabled) {
        try { entry.dispose() } catch (error) { return { ok: false, error: errText(error) } }
      }
      if (entry.alwaysDispose !== undefined) {
        try { entry.alwaysDispose() } catch (error) { /* best-effort */ }
        entry.alwaysDispose = undefined
      }
      owned.delete(name)
      store.skills = store.skills.filter((s) => s.name !== name)
      await persist()
      return { ok: true, name, removed: true }
    }

    async function setInject(name, alwaysInject) {
      const entry = owned.get(name)
      if (entry === undefined) return { ok: false, error: `skill "${name}" is not managed by skillmanager` }
      const rec = store.skills.find((s) => s.name === name)
      if (rec === undefined) return { ok: false, error: `skill "${name}" has no store record` }
      entry.alwaysInject = alwaysInject === true
      if (entry.alwaysDispose !== undefined) {
        try { entry.alwaysDispose() } catch (error) { /* best-effort */ }
        entry.alwaysDispose = undefined
      }
      if (entry.alwaysInject && entry.enabled) {
        try { entry.alwaysDispose = registerAlwaysSection(rec) } catch (error) { console.error('[skillmanager] always-inject section failed for', name, ':', errText(error)) }
      }
      rec.alwaysInject = entry.alwaysInject
      await persist()
      return { ok: true, name, alwaysInject: entry.alwaysInject }
    }

    // RPC bridge for the skillui dynamic plugin. Its host half injects this
    // service and forwards harness.handle calls here; the model tools it
    // registers call the same functions.
    ctx.provide('skillRegistry', {
      state: async () => stateSnapshot(),
      add: async (args) => addSkill(args ?? {}),
      disable: async (args) => disableSkill(String(args?.name ?? '')),
      enable: async (args) => enableSkill(String(args?.name ?? '')),
      remove: async (args) => removeSkill(String(args?.name ?? '')),
      setInject: async (args) => setInject(String(args?.name ?? ''), args?.alwaysInject === true),
    })

    // ── restart auto-restore ────────────────────────────────────────────────
    ctx.effect(() => {
      let restored = false
      const off = ctx.on('agent/session-start', () => {
        if (restored) return
        restored = true
        storeReady.then(() => {
          for (const s of store.skills) {
            if (s !== null && typeof s === 'object' && typeof s.name === 'string' && typeof s.content === 'string') {
              try { registerStored(s) } catch (error) { console.error('[skillmanager] restore failed for', s.name, ':', errText(error)) }
            }
          }
        }).catch((error) => console.error('[skillmanager] restore crashed:', errText(error)))
      })
      return () => { try { off() } catch (error) { /* best-effort */ } }
    })
  },
}

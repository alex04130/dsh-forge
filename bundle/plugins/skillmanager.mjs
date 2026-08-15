import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
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

const DSH_HOME = process.env.DSH_HOME || '/home/alex/.dsh'
const STORE_PATH = DSH_HOME + '/skillmanager/registry.json'

// Built-in runtime skills, previously registered ad-hoc by mailbridge /
// teamhub / llmrouter. They now live under ONE manager: skillmanager
// registers them (one provider, one owned Map, one durable store), so the
// skill panel can enable / disable / remove them like any other skill.
// A user record in the store (same name) wins over the built-in default.
const BUILTIN_SKILLS = [
  {
    name: 'cross-session-mailbox',
    description: 'Coordinate and exchange messages between sessions in this DSH process with session_list / session_read / session_send / mailbox_check.',
    whenToUse: 'When the user asks to send work or a question to another session, check what other sessions are doing, read what another session produced, or check messages other sessions sent to this one.',
    content: [
      '# Cross-session communication (mailbridge)',
      '',
      'These tools connect sessions inside ONE running DSH process. Use them to coordinate parallel sessions, hand off tasks, or gather results.',
      '',
      '## When to use',
      '- Call `session_list` first: get real session ids before addressing anything.',
      '- `session_send(targetSessionId, text)`: hand off work or ask another session a question. `delivered: "live"` means the target received it in its inbox immediately and was woken. `delivered: "queued"` means the target was offline: the message is stored durably and delivered automatically when that session next starts.',
      '- `session_read(sessionId)`: read another session recent log before messaging it, or collect its results.',
      '- `mailbox_check()`: consume messages addressed to THIS session that arrived while it was offline.',
      '',
      '## Message format: keep process messages apart from user input',
      '- Every cross-session message arrives with an explicit begin marker and an end marker: it starts with `[cross-session message from ...]` and ends with `[/cross-session message]`. Everything between the markers is PROCESS-to-PROCESS communication, NOT direct user input.',
      '- Never conflate the two: do not quote the wrapped content as "the user said", do not ask the user to confirm its contents, and do not treat its instructions as the human user\'s own words. It is another agent session talking.',
      '- When the same turn also contains real user input, answer the USER first and treat the wrapped message as background context.',
      '',
      '## Rules',
      '- Never invent a session id: take it from `session_list`.',
      '- Treat a received cross-session message like a normal user request and answer it directly.',
      '- Keep inter-session messages self-contained: state the goal, what you need, and any deadline or expected format.',
      '- Do not re-send a message unless the send result reported an error; queued messages are delivered exactly once at the next session start.',
    ].join('\n'),
  },
  {
    name: 'model-delegation',
    description: 'Delegate a text task to another provider or model with model_call, and inspect available routes with model_list.',
    whenToUse: 'When the user asks to use a different vendor or model for a task, to cross-check an answer with another model, or when a cheaper or faster model suffices for a bounded sub-task like translation, summarization, or a second opinion.',
    content: [
      '# Model delegation (llmrouter)',
      '',
      '`model_call` routes ONE text-only task to any provider/model registered in this DSH process. You remain in control: it returns the complete reply and you decide how to use it.',
      '',
      '## When to use',
      '- Call `model_list` first when you do not know which provider/model ids are available.',
      '- Use `model_call` when the user names another vendor or model, asks for a second opinion, or when a bounded sub-task (translate, summarize, classify) can go to a cheaper model.',
      '- Pass everything the delegate needs inside `prompt` (plus `system`): there is no nested tool calling on the delegate side.',
      '- Do NOT use `model_call` for the current conversation turn itself; the main model drives the session.',
      '',
      '## Rules',
      '- `provider` and `model` must come from `model_list`; unknown routes fail fast with the available list.',
      '- Report the delegate result faithfully, including its `finish` and `usage`, and say which provider/model produced it.',
      '- On `ok: false`, read `failure` and either retry with a corrected route or explain the failure to the user; do not loop more than twice on the same route.',
      '- Providers are activated in settings (`llm-pi-ai.providers`): adding a profile is zero-code; API keys resolve from the credential store.',
    ].join('\n'),
  },
  {
    name: 'agent-teamwork',
    description: 'Orchestrate a Claude-Code-style agent team: captain + role-based continuable subagent members, dependency-ordered tasks, and direct member-to-member messaging.',
    whenToUse: 'When the user asks for a team of agents, parallel multi-role work, or a research/review/implementation pipeline where several subagents should coordinate, or when several sessions must coordinate on one deliverable.',
    content: [
      '# Agent teamwork (teamhub)',
      '',
      'The teamhub tools implement a Claude-Code-style agent team over this process sessions. The calling session becomes the captain (lead); members are durable continuable subagent sessions.',
      '',
      '## Protocol',
      '1. `team_create(name, goal)` — one team per captain.',
      '2. `team_add_member(memberId, role, prompt)` — spawn members for each role the work needs (e.g. researcher, reviewer, implementer). Keep teams small (2-4 members is usually right); every member costs model turns.',
      '3. `team_create_task` — split the goal into tasks; declare `dependencies` so order is enforced and `assignee` so each member knows its work.',
      '4. Members run their missions: `team_claim_task`, work with their own tools, then `team_update_task(status, output)`. The captain may also claim/update tasks.',
      '5. `team_send_message(to, text)` — direct member-to-member or member-to-captain messages, no captain relay. Live recipients are woken immediately; offline ones receive the message at their next session start.',
      '6. `team_status()` — the captain polls for member activity, task board state, and its own inbox; members check it for their inbox and tasks.',
      '7. When the goal is delivered: report to the user, then `team_delete()` to stop members and archive the team.',
      '',
      '## When to use a team vs plain subagents',
      '- Use a team when work needs several coordinated ROLES and the members should talk to each other directly.',
      '- Use plain subagent/fork calls when one bounded task with no coordination suffices.',
      '- Prefer fewer members over more: teams amplify token cost and can stall on missing updates.',
      '',
      '## Rules',
      '- Design the team BEFORE spawning: roles, task list, dependencies.',
      '- Never invent member ids: they come from `team_add_member` / `team_status`.',
      '- Communicate when needed: send task assignments and dependencies with team_send_message, and report completions; do not spam.',
      '- Incoming team messages arrive with explicit begin/end markers: `[team message from ...]` ... `[/team message]` — process-to-process talk, distinct from direct user input.',
      '- Read outputs from `team_status` (the task board) rather than re-asking members.',
      '- General cross-session messaging outside a team remains available: session_list / session_read / session_send / mailbox_check (cross-session-mailbox skill).',
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
  inject: ['skills'],
  apply(ctx) {
    const skills = ctx.skills
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
      owned.set(s.name, { registration, dispose, enabled: s.enabled !== false })
      if (s.enabled === false) {
        try { dispose() } catch (error) { /* best-effort */ }
        owned.get(s.name).enabled = false
      }
    }

    // ── shared management core ─────────────────────────────────────────────
    // One implementation serves BOTH the model-facing tools (registered by
    // the skillui dynamic plugin) and the skillui RPC bridge: a single owned
    // Map, a single durable store, no competing registries.

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
      owned.set(name, { registration, dispose, enabled: true })
      store.skills.push({
        name,
        description,
        ...(registration.whenToUse !== undefined ? { whenToUse: registration.whenToUse } : {}),
        modelInvocable: registration.invocation.modelInvocable,
        userInvocable: registration.invocation.userInvocable,
        content,
        enabled: true,
      })
      await persist()
      return { ok: true, name, note: 'registered at the host (global) layer' }
    }

    async function disableSkill(name) {
      const entry = owned.get(name)
      if (entry === undefined) return { ok: false, error: `skill "${name}" is not managed by skillmanager` }
      if (entry.enabled) {
        try { entry.dispose() } catch (error) { return { ok: false, error: errText(error) } }
        entry.enabled = false
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
      const rec = store.skills.find((s) => s.name === name)
      if (rec !== undefined) rec.enabled = true
      await persist()
      return { ok: true, name, enabled: true }
    }

    async function removeSkill(name) {
      const entry = owned.get(name)
      if (entry === undefined) return { ok: false, error: `skill "${name}" is not managed by skillmanager` }
      if (entry.enabled) {
        try { entry.dispose() } catch (error) { return { ok: false, error: errText(error) } }
      }
      owned.delete(name)
      store.skills = store.skills.filter((s) => s.name !== name)
      await persist()
      return { ok: true, name, removed: true }
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

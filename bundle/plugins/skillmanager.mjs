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
        if (data !== null && typeof data === 'object' && Array.isArray(data.skills)) store = data
      } catch (error) {
        if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return
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

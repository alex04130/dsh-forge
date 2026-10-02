// description: 运行时插件注入（forge_dev_inject_plugin）：把本地插件包注入运行中的 profile，注册表在重启后自动恢复。
import { mkdir, symlink, readFile, rm, lstat } from 'node:fs/promises'
import { join, dirname, resolve, relative, isAbsolute } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { errText, jsonText, DSH_HOME, atomicWriteJson } from './lib/forge-common.mjs'
import { registerTool } from './lib/forge-tools.mjs'

// dsh-injector: runtime plugin injection layer (BepInEx-style).
//
// Philosophy (per dsh-super-injector): the official profile bundle/repository
// is the only "config = state" install path; this plugin owns the RUNTIME
// management surface on top — inject a local plugin package into a running
// web profile without touching patch / package.json / bundles, with a durable
// registry that re-injects after restart.
//
// Mechanism (verified against cordis-plugin-loader + dsh-client-modules):
//   1. symlink the plugin package into the profile's hoisted node_modules
//      (same resolution path pnpm uses for @local/* workspace packages);
//   2. `ctx.loader.create({ id, name, config })` imports the package and
//      builds its fiber (host tools), and the `internal/plugin` event makes
//      dsh-client-modules scan its `dsh.client` bundle automatically.
//
// Injected-package requirements (verified):
//   - tool `parameters` must be a full JSON Schema (`{ type: "object",
//     properties: {...} }`) — the bare `{}` shorthand is rejected by the tool
//     registry; composition plugins get this for free via `defineTool`, so
//     either import `@deepseek-ai/dsh-tools` (with a self-owned node_modules
//     link) or inline a minimal schema compiler.
//   - any `@deepseek-ai/*` import inside the package resolves from the
//     PACKAGE's own node_modules (the loader does not map it to the checkout),
//     so link those deps into the package dir before injecting.

const REGISTRY_PATH = DSH_HOME + '/injector/registry.json'
const NODE_MODULES = DSH_HOME + '/profiles/node_modules'
function slug(name) {
  return String(name).replace(/[^0-9a-zA-Z_.-]/g, '_')
}
function linkType() {
  return process.platform === 'win32' ? 'junction' : 'dir'
}

// ── featsw 联动：每个注入包一个通道 `inject.<name>`（默认开；关掉=不注入） ──
function featureIdOf(name) { return 'inject.' + String(name) }
function featswOf(ctx) { try { return ctx.get ? ctx.get('featsw') : undefined } catch (error) { return undefined } }
function declareInjectFeatures(ctx, names) {
  try {
    const f = featswOf(ctx)
    if (f === undefined || typeof f.declareFeatures !== 'function') return
    f.declareFeatures((Array.isArray(names) ? names : []).filter((n) => typeof n === 'string' && n !== '').map((n) => ({ id: featureIdOf(n), group: 'inject', label: '注入包：' + n })))
  } catch (error) { /* best-effort */ }
}
/** 该注入包当前是否被 featsw 放行（缺 featsw 时一律放行，保持向后兼容）。 */
function injectGateOpen(ctx, name) {
  try {
    const f = featswOf(ctx)
    if (f === undefined || typeof f.isGateOpen !== 'function') return true
    return f.isGateOpen(featureIdOf(name)) !== false
  } catch (error) { return true }
}

// npm-style package names only: optionally scoped, lowercase, no path segments.
const NAME_RE = /^(?:@[0-9a-z][0-9a-z._-]*\/)?[0-9a-z][0-9a-z._-]*$/

// 当前 profile 目录，在 apply() 里从 profileContext 解析。
// 此前硬编码 'web'，在任何其它 profile 下都会去读错的目录。
let PROFILE_DIR = DSH_HOME + '/profiles/web'
function runtimeProfileDir() { return PROFILE_DIR }
function resolveProfileDir(ctx) {
  const pc = ctx.get('profileContext')
  return pc !== undefined && pc !== null && typeof pc.dir === 'string' && pc.dir !== ''
    ? pc.dir
    : DSH_HOME + '/profiles/web'
}

function assertSafeName(name) {
  if (!NAME_RE.test(name) || name.split('/').some((seg) => seg === '.' || seg === '..' || seg === '')) {
    throw new Error(`unsafe package name: ${JSON.stringify(name)}`)
  }
}

// Resolve a package name to its symlink target and refuse anything that
// escapes NODE_MODULES (guards against `..` traversal in a hostile name).
function nodeModulesTarget(name) {
  assertSafeName(name)
  const target = join(NODE_MODULES, ...name.split('/'))
  const rel = relative(NODE_MODULES, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`package name escapes node_modules: ${JSON.stringify(name)}`)
  }
  return target
}

// ── plugin self-description discovery ──────────────────────────────────────
// Standard (forge): packages carry their description in package.json
// (`description`, the npm convention the dsh-plugin community follows); loose
// .mjs plugins carry it in a machine-readable header comment on the first
// lines: `// description: <one-line summary>`.

async function descriptionOf(moduleName) {
  const spec = String(moduleName ?? '')
  if (spec.startsWith('./') || spec.startsWith('../')) {
    // Loose .mjs plugin living beside the profile patch. Resolve against the
    // ACTIVE profile, not a hardcoded 'web' — otherwise this reads the wrong
    // directory under any other profile.
    const pc = runtimeProfileDir()
    const file = resolve(pc, spec)
    try {
      const text = await readFile(file, 'utf8')
      const m = /^\/\/\s*description:\s*(.+)$/m.exec(text.slice(0, 4096))
      return m === null ? undefined : m[1].trim()
    } catch (error) {
      return undefined
    }
  }
  if (spec.startsWith('@deepseek-ai/') || spec.startsWith('@local/') || NAME_RE.test(spec)) {
    try {
      const pkg = JSON.parse(await readFile(join(NODE_MODULES, ...spec.split('/'), 'package.json'), 'utf8'))
      return typeof pkg.description === 'string' && pkg.description.trim() !== '' ? pkg.description.trim() : undefined
    } catch (error) {
      return undefined
    }
  }
  return undefined
}

function registerDescriptionsRoute(webServer, loader) {
  if (webServer === undefined || typeof webServer.register !== 'function' || loader === undefined) return
  const dispose = webServer.register({
    kind: 'exact',
    path: '/dsh-forge/plugin-descriptions',
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405)
        res.end()
        return
      }
      try {
        const entries = []
        for (const entry of loader.entries()) {
          const moduleName = typeof entry.options?.name === 'string' ? entry.options.name : ''
          if (moduleName === '') continue
          const description = await descriptionOf(moduleName)
          entries.push({ entryId: entry.id, moduleName, ...(description !== undefined ? { description } : {}) })
        }
        const body = JSON.stringify({ ok: true, entries })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(body)
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: errText(error) }))
      }
    },
  })
  return () => { try { dispose() } catch (error) { /* best-effort */ } }
}

// Remove only the injector's own symlink; never `rm -rf` a real dependency.
async function removeLinkOnly(target) {
  try {
    const st = await lstat(target)
    if (!st.isSymbolicLink()) throw new Error(`refusing to remove non-symlink: ${target}`)
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return
    throw error
  }
  await rm(target, { recursive: true, force: true })
}

export default {
  inject: ['tools', 'loader', 'webServer'],
  apply(ctx) {
    PROFILE_DIR = resolveProfileDir(ctx)
    const loader = ctx.loader

    // Plugin-injection management is a host-control surface: restrict the
    // management tools to non-subagent sessions (a prompt-injected subagent
    // must not be able to load arbitrary code — security review t7-H1).
    function isMainSession(exec) {
      if (exec === undefined || exec.agent === undefined) return false
      let header = undefined
      try { header = exec.agent.session !== undefined ? exec.agent.session.header : undefined } catch (error) { header = undefined }
      const origin = header !== undefined ? header.origin : undefined
      const parent = header !== undefined ? header.parentSession : undefined
      if (origin === 'subagent' || (typeof parent === 'string' && parent.length > 0)) return false
      return true
    }

    // Self-description lookup for the plugin-manager panel (plugmgr fetches
    // /dsh-forge/plugin-descriptions and renders each plugin's own summary).
    ctx.effect(() => registerDescriptionsRoute(ctx.webServer, loader) ?? (() => {}))

    let registry = { version: 1, plugins: [] }
    const registryReady = (async () => {
      try {
        const raw = await readFile(REGISTRY_PATH, 'utf8')
        const data = JSON.parse(raw)
        if (data !== null && typeof data === 'object' && Array.isArray(data.plugins)) registry = data
      } catch (error) {
        if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return // true first run
        console.error('[injector] registry unreadable, keeping in-memory:', errText(error))
      }
    })()

    // Serialize every read-modify-write of the registry and write atomically
    // (tmp + rename) so concurrent inject/uninject cannot drop an update and a
    // crash cannot truncate the file.
    let writeQueue = Promise.resolve()
    function mutateRegistry(mutator) {
      const next = writeQueue.then(async () => {
        await registryReady
        mutator()
        await atomicWriteJson(REGISTRY_PATH, registry)
      })
      writeQueue = next.catch(() => {})
      return next
    }

    async function readPackageName(dir) {
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
      const name = typeof pkg.name === 'string' && pkg.name.length > 0 ? pkg.name : ''
      if (name === '') throw new Error('plugin directory has no package.json name')
      assertSafeName(name)
      return name
    }

    async function linkPackage(dir) {
      const name = await readPackageName(dir)
      const target = nodeModulesTarget(name)
      await mkdir(dirname(target), { recursive: true })
      await removeLinkOnly(target)
      await symlink(resolve(dir), target, linkType())
      return name
    }

    async function unlinkPackage(name) {
      await removeLinkOnly(nodeModulesTarget(name))
    }

    // 0.2.0-rc.2: `loader.create` is `Omit<EntryOptions, 'id'>` — it mints its own
    // 8-hex entry id via `ensureId()`, so the historical `id: slug(name)` was
    // ignored. That silently broke both the "already online" dedup and
    // `loader.remove(slug(name))`. Address entries by their module name instead.
    function findEntryIdByName(name) {
      for (const entry of loader.entries()) {
        if (entry.options?.name === name) return entry.id
      }
      return undefined
    }

    function liveModuleNames() {
      const names = new Set()
      for (const entry of loader.entries()) {
        const n = entry.options?.name
        if (typeof n === 'string') names.add(n)
      }
      return names
    }

    async function inject(dir) {
      const name = await linkPackage(dir)
      let entryId
      try {
        const entry = await loader.create({ name, config: {} })
        entryId = entry?.id ?? findEntryIdByName(name)
      } catch (error) {
        await unlinkPackage(name).catch(() => {}) // roll back the orphan symlink
        throw error
      }
      await mutateRegistry(() => {
        if (!registry.plugins.some((p) => p !== null && typeof p === 'object' && p.name === name)) {
          registry.plugins.push({ name, dir: resolve(dir) })
        }
      })
      // 2026-09-11：装包的同时登记 featsw 通道（原来只在自动恢复里登记，手工注入就丢了通道）。
      declareInjectFeatures(ctx, [name])
      return { ok: true, name, id: entryId, dir: resolve(dir) }
    }

    /** 只卸 fiber，不动注册表与符号链接 —— featsw 关闸用；重新打开必须还能装回来。 */
    async function unloadFiber(name) {
      assertSafeName(name)
      try { loader.remove(findEntryIdByName(name) ?? slug(name)) } catch (error) { /* 已离线=幂等成功 */ }
      return { ok: true, name, keptInRegistry: true }
    }

    async function uninject(name) {
      assertSafeName(name)
      const id = findEntryIdByName(name) ?? slug(name)
      const problems = []
      try {
        loader.remove(id)
      } catch (error) {
        // An entry already gone (e.g. restore hasn't run yet) is an idempotent success.
        if (!/cannot resolve entry/.test(errText(error))) problems.push(`loader: ${errText(error)}`)
      }
      try {
        await unlinkPackage(name)
      } catch (error) {
        problems.push(`unlink: ${errText(error)}`)
      }
      await mutateRegistry(() => {
        registry.plugins = registry.plugins.filter((p) => p !== null && typeof p === 'object' && p.name !== name)
      })
      return { ok: problems.length === 0, name, ...(problems.length > 0 ? { problems } : {}) }
    }

    async function reload(name) {
      try { loader.remove(findEntryIdByName(name) ?? slug(name)) } catch (error) { /* absent is fine */ }
      const entry = await loader.create({ name, config: {} })
      return { ok: true, name, id: entry?.id ?? findEntryIdByName(name), note: 're-created the entry; ESM module cache is NOT cleared yet' }
    }

    registerTool(ctx, 'forge_dev_inject_plugin',
      '把本地插件包运行时注入到正在运行的 web profile（无需重启，不改 patch/打包产物）。`dir` 必须包含一个带 `name` 和 `dsh`/bundle 声明的 package.json；Host 工具和客户端 UI 都会生效。仅主会话可用（子代理拒绝）。',
      { dir: { type: 'string', required: true, description: '插件包目录的绝对路径。' } },
      async (args, exec) => {
        if (!isMainSession(exec)) return jsonText({ ok: false, error: 'restricted to the main session (subagents cannot manage plugin injection)' })
        const dir = String(args.dir ?? '').trim()
        if (dir.length === 0) return jsonText({ ok: false, error: 'dir is required' })
        return jsonText(await inject(dir))
      })

    registerTool(ctx, 'forge_dev_uninject_plugin',
      '取消注入一个运行时注入的插件包：fiber 被释放、符号链接移除、注册表条目删除。无需重启。仅主会话可用（子代理拒绝）。',
      { name: { type: 'string', required: true, description: '插件包名（或其子串）。' } },
      async (args, exec) => {
        if (!isMainSession(exec)) return jsonText({ ok: false, error: 'restricted to the main session (subagents cannot manage plugin injection)' })
        const name = String(args.name ?? '').trim()
        if (name.length === 0) return jsonText({ ok: false, error: 'name is required' })
        await registryReady
        const isRec = (p) => p !== null && typeof p === 'object' && typeof p.name === 'string'
        const match = registry.plugins.find((p) => isRec(p) && p.name === name)
          ?? registry.plugins.find((p) => isRec(p) && p.name.includes(name))
        if (match === undefined) return jsonText({ ok: false, error: 'no injected plugin matches "' + name + '"' })
        return jsonText(await uninject(match.name))
      })


    registerTool(ctx, 'forge_dev_reload_package',
      '重建一个注入的插件条目（释放 fiber + 重新导入）。注意：Node ESM 模块缓存尚未清除，因此编辑过的文件内容可能要到加载器清掉缓存后才生效。仅主会话可用（子代理拒绝）。',
      { name: { type: 'string', required: true, description: '插件包名。' } },
      async (args, exec) => {
        if (!isMainSession(exec)) return jsonText({ ok: false, error: 'restricted to the main session (subagents cannot manage plugin injection)' })
        const name = String(args.name ?? '').trim()
        if (name.length === 0) return jsonText({ ok: false, error: 'name is required' })
        return jsonText(await reload(name))
      })

    registerTool(ctx, 'forge_dev_plugin_status',
      '显示注入器注册表以及每个在线 loader 条目（id + 名称 + 禁用状态）。',
      {},
      async () => {
        await registryReady
        const entries = [...loader.entries()].map((entry) => ({
          id: entry.id,
          name: entry.options?.name,
          disabled: entry.disabled === true,
        }))
        return jsonText({ ok: true, injected: registry.plugins, loaderEntries: entries })
      })

    // ── restart auto-restore ────────────────────────────────────────────────
    // Runs once when this effect is set up, i.e. at plugin load. 0.2.0-rc.2 has
    // no process-level "startup once" event: agent/created fires per entered
    // agent and app-boot/config-reload fires on every profile reconcile, so a
    // process-scoped restore belongs on the Cordis lifecycle instead.
    ctx.effect(() => {
      let cancelled = false
      registryReady.then(async () => {
        if (cancelled) return
        const live = liveModuleNames()
        const snapshot = [...registry.plugins] // stable snapshot vs concurrent mutation
        const results = []
        declareInjectFeatures(ctx, snapshot.map((p) => (p && typeof p === 'object' ? p.name : undefined)))
        for (const p of snapshot) {
          if (p === null || typeof p !== 'object' || typeof p.name !== 'string' || typeof p.dir !== 'string') continue
          if (live.has(p.name)) continue // already online
          if (injectGateOpen(ctx, p.name) === false) { results.push({ name: p.name, ok: false, skipped: 'featsw-closed' }); continue }
          try {
            const r = await inject(p.dir)
            results.push({ name: p.name, ok: true })
          } catch (error) {
            results.push({ name: p.name, ok: false, error: errText(error) })
          }
        }
        console.log('[injector] restore finished:', JSON.stringify(results))
      }).catch((error) => {
        console.error('[injector] restore crashed:', errText(error))
      })
      return () => { cancelled = true }
    })

    // ── featsw 联动：开关关闭→卸载该注入包；打开→装回来（就地生效，不用重启） ──
    ctx.effect(() => {
      const f = featswOf(ctx)
      if (f === undefined || typeof f.onChange !== 'function') return () => {}
      let busy = false
      async function reconcile() {
        if (busy) return
        busy = true
        try {
          await registryReady
          const live = liveModuleNames()
          for (const p of [...registry.plugins]) {
            if (p === null || typeof p !== 'object' || typeof p.name !== 'string' || typeof p.dir !== 'string') continue
            const want = injectGateOpen(ctx, p.name)
            const online = live.has(p.name)
            try {
              if (want === false && online) await unloadFiber(p.name)
              else if (want !== false && !online) await inject(p.dir)
            } catch (error) { console.error("[injector] featsw reconcile failed for", p.name, errText(error)) }
          }
        } catch (error) {
          console.error("[injector] featsw reconcile crashed:", errText(error))
        } finally { busy = false }
      }
      const offChange = f.onChange(() => { reconcile().catch(() => {}) })
      return () => { try { offChange() } catch (error) { /* best-effort */ } }
    })
  },
}

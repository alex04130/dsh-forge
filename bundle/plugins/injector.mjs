// description: 运行时插件注入（dev_inject_plugin）：把本地插件包注入运行中的 profile，注册表在重启后自动恢复。
import { mkdir, symlink, readFile, writeFile, rename, rm, lstat } from 'node:fs/promises'
import { join, dirname, resolve, relative, isAbsolute } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

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

const DSH_HOME = process.env.DSH_HOME || '/home/alex/.dsh'
const REGISTRY_PATH = DSH_HOME + '/injector/registry.json'
const NODE_MODULES = DSH_HOME + '/profiles/node_modules'

function errText(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}
function jsonText(value) {
  return JSON.stringify(value, null, 2)
}
function slug(name) {
  return String(name).replace(/[^0-9a-zA-Z_.-]/g, '_')
}
function linkType() {
  return process.platform === 'win32' ? 'junction' : 'dir'
}

// npm-style package names only: optionally scoped, lowercase, no path segments.
const NAME_RE = /^(?:@[0-9a-z][0-9a-z._-]*\/)?[0-9a-z][0-9a-z._-]*$/

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
    // loose .mjs plugin relative to the profile directory
    const file = resolve(DSH_HOME, 'profiles', 'web', spec)
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

function registerDescriptionsRoute(webServer) {
  if (webServer === undefined || typeof webServer.register !== 'function') return
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
  inject: ['tools', 'loader'],
  apply(ctx) {
    const loader = ctx.loader

    // Self-description lookup for the plugin-manager panel (plugmgr fetches
    // /dsh-forge/plugin-descriptions and renders each plugin's own summary).
    ctx.effect(() => registerDescriptionsRoute(ctx.get('webServer')) ?? (() => {}))

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
        await mkdir(dirname(REGISTRY_PATH), { recursive: true })
        const tmp = `${REGISTRY_PATH}.tmp-${process.pid}`
        await writeFile(tmp, JSON.stringify(registry, null, 2), 'utf8')
        await rename(tmp, REGISTRY_PATH)
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

    async function inject(dir) {
      const name = await linkPackage(dir)
      const id = slug(name)
      try {
        await loader.create({ id, name, config: {} })
      } catch (error) {
        await unlinkPackage(name).catch(() => {}) // roll back the orphan symlink
        throw error
      }
      await mutateRegistry(() => {
        if (!registry.plugins.some((p) => p !== null && typeof p === 'object' && p.name === name)) {
          registry.plugins.push({ name, dir: resolve(dir) })
        }
      })
      return { ok: true, name, id, dir: resolve(dir) }
    }

    async function uninject(name) {
      assertSafeName(name)
      const id = slug(name)
      const problems = []
      try {
        await loader.remove(id)
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
      const id = slug(name)
      await loader.remove(id)
      await loader.create({ id, name, config: {} })
      return { ok: true, name, note: 're-created the entry; ESM module cache is NOT cleared yet' }
    }

    function registerTool(name, description, parameters, execute) {
      const tool = defineTool({
        name,
        description,
        parameters,
        output: {
          schema: { type: 'string' },
          render(_args, value) { return [{ type: 'text', text: typeof value === 'string' ? value : String(value) }] },
        },
        async execute(args, exec) {
          try { return await execute(args, exec) } catch (error) { return jsonText({ ok: false, error: errText(error) }) }
        },
      })
      const dispose = ctx.tools.register(tool)
      ctx.effect(() => () => { try { dispose() } catch (error) { /* best-effort */ } })
    }

    registerTool('dev_inject_plugin',
      'Runtime-inject a local plugin package into the running web profile (no restart, no patch/bundles change). `dir` must contain a package.json with a `name` and a `dsh`/bundle declaration; Host tools and client UI both take effect.',
      { dir: { type: 'string', required: true, description: 'Absolute path to the plugin package directory.' } },
      async (args) => {
        const dir = String(args.dir ?? '').trim()
        if (dir.length === 0) return jsonText({ ok: false, error: 'dir is required' })
        return jsonText(await inject(dir))
      })

    registerTool('dev_uninject_plugin',
      'Uninject a runtime-injected plugin package: fiber disposed, symlink removed, registry entry dropped. No restart needed.',
      { name: { type: 'string', required: true, description: 'Plugin package name (or a substring of it).' } },
      async (args) => {
        const name = String(args.name ?? '').trim()
        if (name.length === 0) return jsonText({ ok: false, error: 'name is required' })
        await registryReady
        const isRec = (p) => p !== null && typeof p === 'object' && typeof p.name === 'string'
        const match = registry.plugins.find((p) => isRec(p) && p.name === name)
          ?? registry.plugins.find((p) => isRec(p) && p.name.includes(name))
        if (match === undefined) return jsonText({ ok: false, error: 'no injected plugin matches "' + name + '"' })
        return jsonText(await uninject(match.name))
      })

    registerTool('dev_injected_list',
      'List every runtime-injected plugin package (name + source directory).',
      {},
      async () => {
        await registryReady
        return jsonText({ ok: true, count: registry.plugins.length, plugins: registry.plugins })
      })

    registerTool('dev_reload_package',
      'Re-create an injected plugin entry (dispose fiber + re-import). NOTE: the Node ESM module cache is not cleared yet, so edited file content may not change until the loader clears its cache.',
      { name: { type: 'string', required: true, description: 'Plugin package name.' } },
      async (args) => {
        const name = String(args.name ?? '').trim()
        if (name.length === 0) return jsonText({ ok: false, error: 'name is required' })
        return jsonText(await reload(name))
      })

    registerTool('dev_plugin_status',
      'Show the injector registry plus every live loader entry (id + name + disabled state).',
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
    ctx.effect(() => {
      let restored = false
      const off = ctx.on('agent/session-start', () => {
        if (restored) return
        restored = true
        registryReady.then(async () => {
          const live = new Set([...loader.entries()].map((entry) => entry.id))
          const snapshot = [...registry.plugins] // stable snapshot vs concurrent mutation
          const results = []
          for (const p of snapshot) {
            if (p === null || typeof p !== 'object' || typeof p.name !== 'string' || typeof p.dir !== 'string') continue
            if (live.has(slug(p.name))) continue // already online
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
      })
      return () => { try { off() } catch (error) { /* best-effort */ } }
    })
  },
}

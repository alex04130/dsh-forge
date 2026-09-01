// capmgr 宿主半部 v2.0（+运行能力启停/质粒配置/模型 tab/订阅登录）：能力管理（插件/技能/MCP 三合一）。
// 插件域 = plins 原样移植（plinst/* RPC + dev_stop_dyn_plugin 工具）；
// 技能域 = sklui 原样移植（skill_* 六个模型工具 + skillui/* RPC）；
// MCP 域 = 新写 v1 只读清单（capmgr/mcp.list 读 loader.entries）。
// RPC 前缀全部保留，client 侧零改名；helper 去重一份（errText/jsonText）。
const errText = libErrText
const jsonText = libJsonText
const textOf = libTextOf
// plinst host half: community plugin market + installer.
// Downloads GitHub repos (topic dsh-plugin), classifies their shape
// (npm package / dynamic manifest / preset / bundle), and installs them into
// ~/.dsh: npm packages become runtime-injected plugins (symlink + injector
// registry + best-effort immediate loader.create), dynamic manifests merge
// into auto-plugins.json, presets copy into .agent-presets. All file and
// network work goes through the shell service; the sandbox has no fs/require.

let DSH_HOME = null
const API = 'https://api.github.com'

function repoArg(raw) {
  const s = String(raw ?? '').trim()
  let m = s.match(/^(?:https?:\/\/)?github\.com\/([A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,64})(?:\.git)?\/?$/)
  if (m !== null) return m[1]
  m = s.match(/^([A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,64})$/)
  return m === null ? '' : m[1]
}
function queryArg(raw) {
  const s = String(raw ?? '').trim().replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 64)
  return s
}
function slug(name) {
  return String(name).replace(/[^0-9a-zA-Z_.-]/g, '_')
}


return {
  inject: ['skills', 'skillRegistry', 'settings', 'agentDefaultModel', 'llm', 'tools'],
  apply(ctx) {
    // ── 插件域（plins 移植） ──
    function plinsHalf(ctx) {
      const shell = ctx.get('shell')
      if (shell === undefined) return
      const loader = ctx.get('loader')

      async function sh(command, timeoutMs, maxBytes) {
        const spec = shell.resolve({ command, timeoutMs: timeoutMs ?? 30000, stdoutMaxBytes: maxBytes ?? 524288 })
        const r = await shell.run(spec)
        return { exitCode: r.exitCode, text: textOf(r.stdout), err: textOf(r.stderr) }
      }
      function q(script) {
        return "node -e '" + script + "'"
      }
      async function ensureEnv() {
        if (DSH_HOME !== null) return DSH_HOME
        const cmd = "node -e 'console.log(JSON.stringify({home: process.env.DSH_HOME || require(\"path\").join(require(\"os\").homedir(), \".dsh\"), platform: process.platform}))'"
        const r = await sh(cmd, 8000)
        try {
          const env = JSON.parse(r.text.trim())
          if (env !== null && typeof env === 'object' && typeof env.home === 'string' && env.home.length > 0) DSH_HOME = env
          else throw new Error('bad env')
        } catch (error) {
          throw new Error('cannot resolve DSH home')
        }
        return DSH_HOME
      }
      async function shJson(command, timeoutMs) {
        const r = await sh(command, timeoutMs)
        if (r.exitCode !== 0) return undefined
        try { return JSON.parse(r.text) } catch (e) { return undefined }
      }
      const guard = (fn) => async (args) => {
        try { return await fn(args ?? {}) } catch (error) { return { ok: false, error: errText(error) } }
      }

      // ── browse: GitHub topic dsh-plugin search ──────────────────────────────
      async function browse(args) {
        const q = queryArg(args.query)
        const query = q === '' ? 'topic:dsh-plugin' : 'topic:dsh-plugin+' + encodeURIComponent(q).replace(/%20/g, '+')
        const env = await ensureEnv()
        const CURL = env.platform === 'win32' ? 'curl.exe' : 'curl'
        const data = await shJson(CURL + ' -s -H "Accept: application/vnd.github+json" "' + API + '/search/repositories?q=' + query + '&sort=stars&order=desc&per_page=15"', 20000)
        if (data === undefined) return { ok: false, error: 'GitHub 搜索失败（网络或限流），请稍后重试' }
        const items = Array.isArray(data.items) ? data.items : []
        return {
          ok: true,
          total: data.total_count ?? items.length,
          repos: items.map((r) => ({
            repo: r.full_name,
            name: r.name,
            owner: r.owner?.login ?? '',
            description: typeof r.description === 'string' ? r.description : '',
            stars: r.stargazers_count ?? 0,
            topics: Array.isArray(r.topics) ? r.topics.slice(0, 5) : [],
            homepage: typeof r.html_url === 'string' ? r.html_url : '',
          })),
        }
      }

      // ── installed: local community-plugins + injector registry snapshot ────
      async function installed() {
        const env = await ensureEnv()
        const DSH = env.home
        const COMMUNITY = DSH + '/community-plugins'
        const REGISTRY = DSH + '/injector/registry.json'
        const dirs = await sh(q('console.log((()=>{const fs=require("fs");try{return fs.readdirSync(' + JSON.stringify(COMMUNITY) + ').filter(f=>!f.startsWith(".")).join("\n")}catch(e){return ""}})())'), 8000)
        const names = dirs.text.split('\n').map((s) => s.trim()).filter((s) => s.length > 0)
        let registry = []
        const reg = await shJson(q('console.log((()=>{const fs=require("fs");try{return JSON.stringify(JSON.parse(fs.readFileSync(' + JSON.stringify(REGISTRY) + ',"utf8")).plugins||[])}catch(e){return "[]"}})())'), 8000)
        if (Array.isArray(reg)) {
          for (const p of reg) {
            const entry = { name: p.name, dir: p.dir }
            if (typeof p.dir === 'string' && p.dir.length > 0) {
              try {
                const pkg = await shJson(q('console.log(require("fs").readFileSync(' + JSON.stringify(p.dir + '/package.json') + ',"utf8"))'), 8000)
                if (pkg !== null && typeof pkg === 'object' && typeof pkg.description === 'string' && pkg.description.trim() !== '') entry.description = pkg.description.trim()
              } catch (error) { /* no package.json / unreadable: keep name + dir only */ }
            }
            registry.push(entry)
          }
        }
        return { ok: true, dirs: names, registry }
      }

      // ── install: clone + classify + act ────────────────────────────────────
      async function install(args) {
        const env = await ensureEnv()
        const DSH = env.home
        const COMMUNITY = DSH + '/community-plugins'
        const REGISTRY = DSH + '/injector/registry.json'
        const AUTOPLUGINS = DSH + '/auto-plugins.json'
        const NODE_MODULES = DSH + '/profiles/node_modules'
        const repo = repoArg(args.repo)
        if (repo === '') return { ok: false, error: '仓库格式无效：请用 owner/repo 或 https://github.com/owner/repo' }
        const dir = COMMUNITY + '/' + repo.split('/')[1]

        const mkdirOut = await sh(q('require("fs").mkdirSync(' + JSON.stringify(COMMUNITY) + ',{recursive:true})'))
        if (mkdirOut.exitCode !== 0) return { ok: false, error: '无法创建插件目录' }
        const exists = await sh(q('console.log((()=>{const fs=require("fs");try{return fs.statSync(' + JSON.stringify(dir) + ').isDirectory()?"yes":"no"}catch(e){return "no"}})())'), 8000)
        if (exists.text.trim() === 'yes') {
          const pull = await sh('git -C ' + JSON.stringify(dir) + ' pull --ff-only', 30000)
          const list = await sh(q('console.log((()=>{const fs=require("fs");try{return fs.readdirSync(' + JSON.stringify(dir) + ').slice(0,30).join("\n")}catch(e){return ""}})())'), 8000)
          return { ok: true, repo, updated: true, dir, note: '已存在，执行 git pull 更新', pull: pull.text.slice(-400), files: list.text.trim() }
        }

        const clone = await sh('git clone --depth 1 https://github.com/' + repo + '.git ' + JSON.stringify(dir), 60000)
        if (clone.exitCode !== 0) return { ok: false, error: 'clone 失败：' + (clone.text.trim() || clone.err).slice(-600) }

        const listOut = await sh(q('console.log((()=>{const fs=require("fs");try{return fs.readdirSync(' + JSON.stringify(dir) + ').slice(0,40).join("\n")}catch(e){return ""}})())'), 8000)
        const files = listOut.text.trim()
        const has = (name) => files.split('\n').some((f) => f === name)

        // 1) bundle shape FIRST (a bundle package.json with a valid name was
        //    previously mis-detected as an npm package, then loader.create
        //    failed and left a broken registry entry on every boot restore).
        // 2) npm package shape
        if (has('package.json')) {
          const pkg = await shJson(q('console.log(require("fs").readFileSync(' + JSON.stringify(dir + '/package.json') + ',"utf8"))'), 8000)
          if (pkg !== null && typeof pkg === 'object') {
            const isBundle = pkg.dsh !== null && typeof pkg.dsh === 'object' && pkg.dsh.bundle !== undefined
            if (isBundle === true) {
              return { ok: true, repo, kind: 'bundle', dir, note: '这是 dsh bundle 包。运行：dsh plugin --profile web add ' + dir + ' 然后重启 DSH' }
            }
            const name = typeof pkg.name === 'string' && /^(?:@[0-9a-z][0-9a-z._-]*\/)?[0-9a-z][0-9a-z._-]*$/.test(pkg.name) ? pkg.name : ''
            const dshDecl = pkg.dsh !== null && typeof pkg.dsh === 'object' ? Object.keys(pkg.dsh).join(',') : ''
            if (name !== '') {
              // symlink into profile node_modules + registry + best-effort loader
              const target = NODE_MODULES + '/' + name
              const mk = await sh(q('require("fs").mkdirSync(' + JSON.stringify(target.slice(0, target.lastIndexOf('/'))) + ',{recursive:true})'), 8000)
              const link = await sh(q('(()=>{const fs=require("fs");fs.rmSync(' + JSON.stringify(target) + ',{force:true});fs.symlinkSync(' + JSON.stringify(dir) + ',' + JSON.stringify(target) + ',process.platform==="win32"?"junction":"dir")})()'), 8000)
              if (link.exitCode !== 0) return { ok: false, error: 'symlink 失败：' + link.text.trim() }
              const regOut = await sh(q('(()=>{const fs=require("fs");const p=' + JSON.stringify(REGISTRY) + ';let d={version:1,plugins:[]};try{d=JSON.parse(fs.readFileSync(p,"utf8"))}catch(e){};d.plugins=(d.plugins||[]).filter(x=>x.name!==' + JSON.stringify(name) + ');d.plugins.push({name:' + JSON.stringify(name) + ',dir:' + JSON.stringify(dir) + '});fs.mkdirSync(require("path").dirname(p),{recursive:true});const tmp=p+".tmp";fs.writeFileSync(tmp,JSON.stringify(d,null,2));fs.renameSync(tmp,p)})()'), 8000)
              if (regOut.exitCode !== 0) return { ok: false, error: '写入注入注册表失败' }
              let live = 'restart'
              if (loader !== undefined && typeof loader.create === 'function') {
                try {
                  await loader.create({ id: slug(name), name, config: {} })
                  live = 'live'
                } catch (error) { /* falls back to restart restore */ }
              }
              return {
                ok: true, repo, kind: 'package', name, dsh: dshDecl, live, dir,
                note: live === 'live'
                  ? '已注入运行（host 工具立即生效；客户端 UI 在页面刷新后加载）'
                  : '已 symlink 并写入注入注册表；重启 DSH 后自动注入（或刷新页面后看客户端）',
              }
            }
          }
        }

        // 2) dynamic manifest shape
        const manifest = has('manifest.json') ? 'manifest.json' : has('plugins.json') ? 'plugins.json' : ''
        if (manifest !== '') {
          const man = await shJson(q('console.log(require("fs").readFileSync(' + JSON.stringify(dir + '/' + manifest) + ',"utf8"))'), 8000)
          const entries = man !== null && typeof man === 'object' ? (Array.isArray(man.plugins) ? man.plugins : Array.isArray(man) ? man : []) : []
          const added = []
          for (const entry of entries) {
            if (entry === null || typeof entry !== 'object' || typeof entry.idPrefix !== 'string') continue
            const merge = await sh(q('(()=>{const fs=require("fs");const p=' + JSON.stringify(AUTOPLUGINS) + ';let d={version:1,plugins:[]};try{d=JSON.parse(fs.readFileSync(p,"utf8"))}catch(e){};const e=' + JSON.stringify(JSON.stringify(entry)) + ';d.plugins=(d.plugins||[]).filter(x=>x.idPrefix!==e.idPrefix);if(e.disabled!==true)e.disabled=true;d.plugins.push(e);const tmp=p+".tmp";fs.writeFileSync(tmp,JSON.stringify(d,null,2));fs.renameSync(tmp,p)})()'), 8000)
            if (merge.exitCode === 0) added.push(entry.idPrefix)
          }
          return { ok: true, repo, kind: 'dynamic', added, dir, note: added.length > 0 ? '已合并进 auto-plugins.json（默认 disabled，防第三方代码直接跑）；重启 DSH 后在能力管理里启用' : '清单中没有可用条目（缺少 idPrefix）' }
        }

        // 3) preset shape
        if (has('agent.cordis.yml') || has('preset.yml')) {
          const presetName = slug(repo.split('/')[1])
          const presetDir = DSH + '/.agent-presets/' + presetName
          const cp = await sh(q('(()=>{const fs=require("fs"),p=require("path");const src=' + JSON.stringify(dir) + ',dst=' + JSON.stringify(presetDir) + ';fs.mkdirSync(dst,{recursive:true});for(const f of fs.readdirSync(src)){fs.cpSync(p.join(src,f),p.join(dst,f),{recursive:true})}})()'), 15000)
          if (cp.exitCode !== 0) return { ok: false, error: '复制 preset 失败：' + cp.text.trim() }
          return { ok: true, repo, kind: 'preset', presetId: presetName, dir: presetDir, note: '已复制到 .agent-presets/' + presetName + '；重启 DSH 后在会话中选择该模式' }
        }

        // 4) bundle shape
        const bundlePkg = await shJson(q('console.log(require("fs").readFileSync(' + JSON.stringify(dir + '/package.json') + ',"utf8"))'), 8000)
        const isBundle = bundlePkg !== null && typeof bundlePkg === 'object' && bundlePkg.dsh !== null && typeof bundlePkg.dsh === 'object' && bundlePkg.dsh.bundle !== undefined
        if (isBundle) {
          return { ok: true, repo, kind: 'bundle', dir, note: '这是 dsh bundle 包。运行：dsh plugin --profile web add ' + dir + ' 然后重启 DSH' }
        }

        return { ok: true, repo, kind: 'unknown', dir, files, note: '无法自动识别插件形态。根目录文件：' + files.split('\n').slice(0, 12).join(', ') + '。可尝试手动安装（如 dsh plugin --profile web add ' + dir + '）' }
      }

      // ── uninstall: remove an injected npm package (symlink + registry + dir) ─
      async function uninstall(args) {
        const env = await ensureEnv()
        const DSH = env.home
        const COMMUNITY = DSH + '/community-plugins'
        const REGISTRY = DSH + '/injector/registry.json'
        const NODE_MODULES = DSH + '/profiles/node_modules'
        const name = String(args.name ?? '').trim()
        if (!/^(?:@[0-9a-z][0-9a-z._-]*\/)?[0-9a-z][0-9a-z._-]*$/.test(name)) return { ok: false, error: '无效的插件名' }
        const dir = String(args.dir ?? '').trim()
        if (!dir.startsWith(COMMUNITY + '/') || dir.indexOf('..') !== -1 || dir.length <= COMMUNITY.length + 1) return { ok: false, error: '无效的插件目录' }
        const target = NODE_MODULES + '/' + name
        const linkOut = await sh(q('require("fs").rmSync(' + JSON.stringify(target) + ',{force:true})'), 8000)
        if (linkOut.exitCode !== 0) return { ok: false, error: '删除符号链接失败' }
        const regOut = await sh(q('(()=>{const fs=require("fs");const p=' + JSON.stringify(REGISTRY) + ';let d={version:1,plugins:[]};try{d=JSON.parse(fs.readFileSync(p,"utf8"))}catch(e){};d.plugins=(d.plugins||[]).filter(x=>x.name!==' + JSON.stringify(name) + ');const tmp=p+".tmp";fs.writeFileSync(tmp,JSON.stringify(d,null,2));fs.renameSync(tmp,p)})()'), 8000)
        if (regOut.exitCode !== 0) return { ok: false, error: '更新注入注册表失败' }
        const dirOut = await sh(q('require("fs").rmSync(' + JSON.stringify(dir) + ',{recursive:true,force:true})'), 8000)
        return {
          ok: true, name, dir,
          note: '已移除符号链接与注入注册表记录' + (dirOut.exitCode === 0 ? '，插件目录已删除' : '（插件目录删除失败，请手动清理）') + '；当前进程内已运行的实例将在重启 DSH 后完全移除',
        }
      }

      // ── emergency stop tool: stop a dynamic plugin by id prefix (used to
      //    rescue the sidebar when a crashing client half is still running) ──
      const runner = ctx.get('dynamicCordisRunner')
      if (runner !== undefined && typeof runner.inventory === 'function') {
        const stopTool = harness.defineTool({
          name: 'dev_stop_dyn_plugin',
          description: 'Emergency stop for a running dynamic plugin by pluginId prefix (e.g. "sklui"). Stops its Host and Client halves. Use when a dynamic plugin client crashes the UI.',
          parameters: { prefix: { type: 'string', required: true, description: 'pluginId 前缀，如 "sklui"' } },
          output: {
            schema: { type: 'string' },
            render(_args, value) { return [{ type: 'text', text: typeof value === 'string' ? value : String(value) }] },
          },
          async execute(args) {
            try {
              const prefix = String(args !== null && typeof args === 'object' ? args.prefix ?? '' : '')
              if (!/^[a-z0-9]{3,12}$/.test(prefix)) return jsonText({ ok: false, error: 'invalid prefix' })
              const inv = await runner.inventory()
              const rows = Array.isArray(inv) ? inv : (inv !== null && typeof inv === 'object' && Array.isArray(inv.value) ? inv.value : [])
              const row = rows.find((r) => r !== null && typeof r === 'object' && String(r.pluginId ?? '').startsWith(prefix))
              if (row === undefined) return jsonText({ ok: false, error: 'no plugin with prefix "' + prefix + '"' })
              const agents = ctx.get('agents')
              const agent = agents !== undefined && typeof agents.get === 'function' ? agents.get(row.agentId) : undefined
              if (agent === undefined) return jsonText({ ok: false, error: 'owner agent "' + String(row.agentId) + '" is not live; cannot stop "' + row.pluginId + '" from here' })
              const stopped = await runner.stopFromPanel(agent, row.pluginId)
              return jsonText(Object.assign({ ok: true, stopped: row.pluginId, agentId: row.agentId }, typeof stopped === 'object' && stopped !== null ? { detail: stopped } : {}))
            } catch (error) {
              return jsonText({ ok: false, error: errText(error) })
            }
          },
        })
        libRegisterGuarded(harness, ctx, stopTool)
      }

      harness.handle('plinst/browse', guard(browse))
      harness.handle('plinst/preview', guard(async (args) => {
        // P1-4：安装前预览——只查 GitHub repo 元数据（来源/许可证/star），不 clone 不落地；
        // 客户端展示【来源信息卡】+ 确认/取消，确认才调 plinst/install。
        const repo = repoArg(args.repo)
        if (repo === '') return { ok: false, error: '仓库格式无效：请用 owner/repo 或 https://github.com/owner/repo' }
        const env = await ensureEnv()
        const CURL = env.platform === 'win32' ? 'curl.exe' : 'curl'
        const data = await shJson(CURL + ' -s -H "Accept: application/vnd.github+json" "' + API + '/repos/' + repo + '"', 20000)
        if (data === undefined) return { ok: false, error: 'GitHub 查询失败（网络或限流），请稍后重试' }
        return {
          ok: true,
          repo,
          name: typeof data.full_name === 'string' ? data.full_name : repo,
          owner: data.owner?.login ?? '',
          description: typeof data.description === 'string' ? data.description : '',
          license: data.license?.name ?? '',
          stars: data.stargazers_count ?? 0,
          homepage: typeof data.html_url === 'string' ? data.html_url : '',
          risk: '第三方代码将获得 DSH 进程权限（与官方插件同权）；请确认来源可信后再安装。',
        }
      }))
      harness.handle('plinst/installed', guard(installed))
      harness.handle('plinst/install', guard(install))
      harness.handle('plinst/uninstall', guard(uninstall))

    }
    // ── 技能域（sklui 移植；model tools + RPC bridge，状态归 skillRegistry 服务） ──
    function skluiHalf(ctx) {
      const skills = ctx.get('skills')
      const registry = ctx.get('skillRegistry')

      // Skill-management tools mutate the global prompt/registry surface:
      // restrict them to non-subagent sessions (security review t7-H2 — a
      // prompt-injected subagent must not plant a persistent prompt-level
      // backdoor or remove safety skills). Read-only tools stay open.
      function isMainSession(exec) {
        if (exec === undefined || exec.agent === undefined) return false
        let header = undefined
        try { header = exec.agent.session !== undefined ? exec.agent.session.header : undefined } catch (error) { header = undefined }
        const origin = header !== undefined ? header.origin : undefined
        const parent = header !== undefined ? header.parentSession : undefined
        if (origin === 'subagent' || (typeof parent === 'string' && parent.length > 0)) return false
        return true
      }

      function registerTool(name, description, parameters, execute, timeoutMs) {
        libDefineJsonTool(harness, ctx, name, description, parameters, execute, timeoutMs)
      }

      if (skills !== undefined) {
        registerTool('skill_list',
          '列出调用方代理可见的技能（名称、provider、模型/用户可调用性、描述）。',
          {},
          async (_args, exec) => {
            const lookup = exec !== undefined && exec.agent !== undefined ? { scope: exec.agent, cwd: exec.agent.session?.header?.cwd, signal: exec.signal } : {}
            const list = await skills.list(lookup)
            return jsonText({
              ok: true,
              count: list.length,
              skills: list.map((s) => ({
                name: s.name,
                provider: s.provider,
                model: s.invocation.modelInvocable,
                user: s.invocation.userInvocable,
                description: s.description,
              })),
            })
          })

        registerTool('skill_show',
          '显示一个技能的完整 Markdown 正文。',
          { name: { type: 'string', required: true, description: '确切技能名。' } },
          async (args, exec) => {
            const name = String(args !== null && typeof args === 'object' ? args.name ?? '' : '').trim()
            if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return jsonText({ ok: false, error: 'invalid skill name "' + name + '"' })
            const lookup = exec !== undefined && exec.agent !== undefined ? { scope: exec.agent, cwd: exec.agent.session?.header?.cwd, signal: exec.signal } : {}
            const skill = await skills.get(name, lookup)
            if (skill === undefined) return jsonText({ ok: false, error: 'unknown skill "' + name + '"' })
            return jsonText({ ok: true, name: skill.name, provider: skill.provider, content: skill.content })
          })
      }

      if (registry !== undefined) {
        registerTool('skill_add',
          '添加一个持久的运行时技能（host/全局层）。重启后仍保留。仅主会话可用（子代理拒绝）。',
          {
            name: { type: 'string', required: true, description: '技能名：/^[a-z0-9]+(-[a-z0-9]+)*$/。' },
            description: { type: 'string', required: true, description: '一行路由描述。' },
            content: { type: 'string', required: true, description: 'Markdown 指令正文。' },
            whenToUse: { type: 'string', description: '可选的何时使用该技能的指引。' },
            modelInvocable: { type: 'boolean', description: '允许模型通过 skill 工具加载它（默认 true）。' },
            userInvocable: { type: 'boolean', description: '允许用户用 "/name" 手势注入它（默认 true）。' },
            alwaysInject: { type: 'boolean', description: '始终默认注入：把完整内容注入系统提示词（true），而非通过 skill 工具渐进式披露（false，默认）。常驻规则（如编辑/git 协议）用 true。' },
          },
          async (args, exec) => { if (!isMainSession(exec)) return jsonText({ ok: false, error: 'restricted to the main session (subagents cannot manage skills)' }); return jsonText(await registry.add(args)) })

        registerTool('skill_disable',
          '禁用本管理器添加的一个技能（释放；可用 skill_enable 恢复）。仅主会话可用（子代理拒绝）。',
          { name: { type: 'string', required: true, description: '确切技能名。' } },
          async (args, exec) => { if (!isMainSession(exec)) return jsonText({ ok: false, error: 'restricted to the main session (subagents cannot manage skills)' }); return jsonText(await registry.disable(args)) })

        registerTool('skill_enable',
          '重新启用本管理器先前禁用的技能。仅主会话可用（子代理拒绝）。',
          { name: { type: 'string', required: true, description: '确切技能名。' } },
          async (args, exec) => { if (!isMainSession(exec)) return jsonText({ ok: false, error: 'restricted to the main session (subagents cannot manage skills)' }); return jsonText(await registry.enable(args)) })

        registerTool('skill_remove',
          '永久移除本管理器添加的一个技能（释放 + 从存储中删除）。仅主会话可用（子代理拒绝）。',
          { name: { type: 'string', required: true, description: '确切技能名。' } },
          async (args, exec) => { if (!isMainSession(exec)) return jsonText({ ok: false, error: 'restricted to the main session (subagents cannot manage skills)' }); return jsonText(await registry.remove(args)) })
      }

      // ── RPC for the client panel ───────────────────────────────────────────
      const guard = (fn) => async (args) => {
        try {
          return await fn(args ?? {})
        } catch (error) {
          return { ok: false, error: errText(error) }
        }
      }
      if (registry !== undefined) {
        harness.handle('skillui/state', guard(async () => {
          const base = await registry.state()
          const managedNames = new Set()
          if (base !== null && typeof base === 'object' && Array.isArray(base.skills)) {
            for (const s of base.skills) {
              if (s !== null && typeof s === 'object' && typeof s.name === 'string') managedNames.add(s.name)
            }
          }
          const others = []
          if (skills !== undefined) {
            try {
              const visible = await skills.list({})
              for (const s of (Array.isArray(visible) ? visible : [])) {
                if (s === null || typeof s !== 'object' || typeof s.name !== 'string' || managedNames.has(s.name)) continue
                others.push({
                  name: s.name,
                  provider: s.provider,
                  model: s.invocation !== null && typeof s.invocation === 'object' ? s.invocation.modelInvocable !== false : true,
                  user: s.invocation !== null && typeof s.invocation === 'object' ? s.invocation.userInvocable !== false : true,
                  description: typeof s.description === 'string' ? s.description : '',
                })
              }
            } catch (error) { /* best-effort visible-skill snapshot */ }
          }
          return Object.assign({}, base, { others })
        }))
        harness.handle('skillui/add', guard((args) => registry.add(args)))
        harness.handle('skillui/disable', guard((args) => registry.disable(args)))
        harness.handle('skillui/enable', guard((args) => registry.enable(args)))
        harness.handle('skillui/remove', guard((args) => registry.remove(args)))
        harness.handle('skillui/setInject', guard((args) => registry.setInject(args)))
      }

    }
    // ── MCP 域 v1（只读清单：列出 loader 中全部 dsh-mcp-client 实例） ──
    function mcpHalf(ctx) {
      const guard = (fn) => async (args) => {
        try { return await fn(args ?? {}) } catch (error) { return { ok: false, error: errText(error) } }
      }
      // ── web 搜索 provider 切换（k3 UI 挂点：capm 模型 tab「网页搜索」小节） ──
      // 写 ~/.dsh/web-search.provider.json（web-search-select.mjs 重启恢复读同一文件）；
      // 运行时立即生效 = ctx.get('web') 直设（若动态沙箱允许）；不允许则仅落盘，重启由 select.mjs 应用。
      harness.handle('capmgr/webSearch.get', guard(async () => {
        const home = await home3()
        const r = await sh3(q3('console.log((()=>{try{return JSON.stringify(JSON.parse(require("fs").readFileSync(' + JSON.stringify(home + '/web-search.provider.json') + ',"utf8")))}catch(e){return "{}"}})())'), 8000)
        let saved = {}
        try { saved = JSON.parse(r.text) } catch (e) { /* default */ }
        const web = ctx.get('web')
        const current = (web !== undefined && typeof web.searchProviderId === 'string' && web.searchProviderId.length > 0)
          ? web.searchProviderId
          : (typeof saved.provider === 'string' ? saved.provider : '')
        const providers = [
          { id: 'deepseek-official', name: 'DeepSeek（官方搜索，用余额）', available: true },
          { id: 'kimi-coding', name: 'kimi-coding（订阅搜索，KIMI_CODING_API_KEY）', available: true },
        ]
        return { ok: true, current, providers, note: current === '' ? '未指定 source（多 provider 并存时可能 AMBIGUOUS）：请选择。' : '' }
      }))
      harness.handle('capmgr/webSearch.set', guard(async (args) => {
        const provider = String(args?.provider ?? '').trim()
        if (provider === '') return { ok: false, error: 'provider required' }
        if (provider !== 'deepseek-official' && provider !== 'kimi-coding') return { ok: false, error: 'unknown provider ' + provider }
        const home = await home3()
        const script = 'const fs=require("fs");const p=' + JSON.stringify(home + '/web-search.provider.json') + ';const d={provider:' + JSON.stringify(provider) + ',updatedAt:Date.now()};'
          + 'try{const tmp=p+".tmp";fs.writeFileSync(tmp,JSON.stringify(d,null,2));fs.renameSync(tmp,p)}catch(e){console.error(e.message)};console.log("ok")'
        const w = await sh3(q3(script), 8000)
        if (w.exitCode !== 0 || w.text.trim() !== 'ok') return { ok: false, error: '写盘失败: ' + (w.err.trim() || w.text.trim()).slice(0, 200) }
        // 运行时直设（best-effort：动态沙箱允许则立即生效）
        let live = false
        const web = ctx.get('web')
        if (web !== undefined && web !== null) {
          try { web.searchProviderId = provider; live = true } catch (error) { /* falls back to restart */ }
        }
        return { ok: true, provider, live, note: live ? '已切换（立即生效）' : '已写盘（重启后生效；select.mjs 重启自动恢复）' }
      }))
      harness.handle('capmgr/tools.inventory', guard(async () => {
        const tools = ctx.get('tools')
        if (tools === undefined || typeof tools.entries !== 'function') return { ok: false, error: 'tools service unavailable' }
        const rows = []
        try {
          const map = tools.entries()
          const iterable = map !== null && typeof map === 'object' && typeof map[Symbol.iterator] === 'function' ? map : []
          for (const [name, def] of iterable) {
            if (name === undefined || name === null) continue
            const d = def !== null && typeof def === 'object' ? def : {}
            rows.push({
              name: String(name),
              description: typeof d.description === 'string' ? d.description : '',
              hasSchema: d.schema !== undefined || d.parameters !== undefined,
            })
          }
        } catch (error) { /* best-effort */ }
        return { ok: true, count: rows.length, tools: rows }
      }))

      harness.handle('capmgr/mcp.list', guard(async () => {
        const loader = ctx.get('loader')
        if (loader === undefined || typeof loader.entries !== 'function') return { ok: false, error: 'loader service unavailable' }
        const servers = []
        for (const entry of loader.entries()) {
          const opts = entry !== null && typeof entry === 'object' ? entry.options : undefined
          if (opts === null || opts === undefined || opts.name !== '@deepseek-ai/dsh-mcp-client') continue
          const cfg = opts.config !== null && typeof opts.config === 'object' ? opts.config : {}
          const args = Array.isArray(cfg.args) ? cfg.args.map((a) => (typeof a === 'string' ? a : (a !== null && typeof a === 'object' && typeof a.__jsExpr === 'string' ? '$(' + a.__jsExpr + ')' : JSON.stringify(a)))).join(' ') : ''
          servers.push({
            id: String(entry.id ?? ''),
            serverName: String(cfg.serverName ?? ''),
            transport: String(cfg.transport ?? ''),
            command: (String(cfg.command ?? '') + ' ' + args).trim(),
            disabled: entry.disabled === true,
          })
        }
        return { ok: true, servers }
      }))
    }

    // ── v2 运行能力域：dynboot/injector 启停（disabled 翻转，重启生效）+ 热停 + 质粒配置 ──
    function capsHalf(ctx) {
      const shell = ctx.get('shell')
      if (shell === undefined) return
      const runner = ctx.get('dynamicCordisRunner')
      const guard = (fn) => async (args) => {
        try { return await fn(args ?? {}) } catch (error) { return { ok: false, error: errText(error) } }
      }
      async function sh3(command, timeoutMs) {
        const spec = shell.resolve({ command, timeoutMs: timeoutMs ?? 30000, stdoutMaxBytes: 524288 })
        const r = await shell.run(spec)
        return { exitCode: r.exitCode, text: textOf(r.stdout), err: textOf(r.stderr) }
      }
      function q3(script) { return "node -e '" + script + "'" }
      let homeCache = null
      async function home3() {
        if (homeCache !== null) return homeCache
        const r = await sh3("node -e 'console.log(process.env.DSH_HOME || require(\"path\").join(require(\"os\").homedir(), \".dsh\"))'", 8000)
        const home = r.text.trim()
        if (home === '') throw new Error('cannot resolve DSH home')
        homeCache = home
        return home
      }
      async function readJson3(path) {
        const r = await sh3(q3('console.log((()=>{try{return JSON.stringify(JSON.parse(require("fs").readFileSync(' + JSON.stringify(path) + ',"utf8")))}catch(e){return "null"}})())'), 10000)
        if (r.exitCode !== 0) return undefined
        try { return JSON.parse(r.text) } catch (e) { return undefined }
      }
      async function writeJson3(path, obj) {
        // hex 走 stdin（避 ARG_MAX）；备份 + 写 + 回读校验，任一失败非零退出
        const hex = JSON.stringify(obj).split('').map((ch) => ch.charCodeAt(0).toString(16).padStart(4, '0')).join('')
        const script = 'const fs=require("fs");const p=' + JSON.stringify(path) + ';let hex="";'
          + 'process.stdin.on("data",(c)=>hex+=c);process.stdin.on("end",()=>{'
          + 'const data=JSON.parse(hex.match(/[0-9a-f]{4}/g).map((s)=>String.fromCharCode(parseInt(s,16))).join(""));'
          + 'try{fs.writeFileSync(p+".bak-capmgr",fs.readFileSync(p,"utf8"))}catch(e){}'
          + 'fs.writeFileSync(p,JSON.stringify(data,null,2));'
          + 'JSON.parse(fs.readFileSync(p,"utf8"));console.log("ok")})'
        const spec = shell.resolve({ command: q3(script), timeoutMs: 15000, stdoutMaxBytes: 524288, stdin: hex })
        const r = await shell.run(spec)
        const out = { exitCode: r.exitCode, text: textOf(r.stdout), err: textOf(r.stderr) }
        if (out.exitCode !== 0 || out.text.trim() !== 'ok') throw new Error('write failed: ' + (out.err.trim() || out.text.trim()).slice(0, 300))
      }

      harness.handle('capmgr/caps.list', guard(async () => {
        const home = await home3()
        const auto = await readJson3(home + '/auto-plugins.json')
        const reg = await readJson3(home + '/injector/registry.json')
        let runningIds = []
        if (runner !== undefined && typeof runner.inventory === 'function') {
          try {
            const inv = await runner.inventory()
            const rows = Array.isArray(inv) ? inv : (inv !== null && typeof inv === 'object' && Array.isArray(inv.value) ? inv.value : [])
            runningIds = rows.map((r) => String(r !== null && typeof r === 'object' ? r.pluginId ?? '' : '')).filter((s) => s !== '')
          } catch (error) { /* inventory best-effort */ }
        }
        let loaderNames = []
        const loader = ctx.get('loader')
        if (loader !== undefined && typeof loader.entries === 'function') {
          try { loaderNames = loader.entries().map((e) => String(e !== null && typeof e === 'object' ? (e.name ?? e.id ?? '') : '')).filter((s) => s !== '') } catch (error) { /* best-effort */ }
        }
        const dynboot = (auto !== null && typeof auto === 'object' && Array.isArray(auto.plugins) ? auto.plugins : []).map((r) => {
          const id = String(r !== null && typeof r === 'object' ? r.idPrefix ?? '' : '')
          return {
            kind: 'dynboot',
            id,
            name: String(r !== null && typeof r === 'object' ? r.name ?? '' : ''),
            purpose: String(r !== null && typeof r === 'object' ? r.purpose ?? '' : ''),
            disabled: r !== null && typeof r === 'object' && r.disabled === true,
            running: id !== '' && runningIds.some((pid) => pid === id || pid.startsWith(id + '-')),
          }
        }).filter((r) => r.id !== '')
        const injector = (reg !== null && typeof reg === 'object' && Array.isArray(reg.plugins) ? reg.plugins : []).map((r) => {
          const name = String(r !== null && typeof r === 'object' ? r.name ?? '' : '')
          // 2026-09-01 名字归一化：loader 条目名会被前缀化（_dsh-forge_plasmid-live），注册表名是 @dsh-forge/plasmid-live；
          // 去非字母数字后小写比较，两边可配上（修状态误报）
          const norm = (v) => String(v).toLowerCase().replace(/[^a-z0-9]+/g, '')
          const nname = norm(name)
          return {
            kind: 'injector',
            id: name,
            name,
            dir: String(r !== null && typeof r === 'object' ? r.dir ?? '' : ''),
            disabled: r !== null && typeof r === 'object' && r.disabled === true,
            running: name !== '' && loaderNames.some((n) => n === name || norm(n) === nname),
          }
        }).filter((r) => r.id !== '')
        return { ok: true, dynboot, injector, hotStopAvailable: runner !== undefined }
      }))

      harness.handle('capmgr/caps.setDisabled', guard(async (args) => {
        const kind = String(args.kind ?? '')
        const id = String(args.id ?? '')
        const disabled = args.disabled === true
        if (id === '') return { ok: false, error: 'id required' }
        const home = await home3()
        if (kind === 'dynboot') {
          const path = home + '/auto-plugins.json'
          const data = await readJson3(path)
          if (data === undefined || data === null || !Array.isArray(data.plugins)) return { ok: false, error: 'auto-plugins.json unreadable' }
          const row = data.plugins.find((r) => r !== null && typeof r === 'object' && r.idPrefix === id)
          if (row === undefined) return { ok: false, error: 'no dynboot row with idPrefix ' + id }
          if (disabled) row.disabled = true
          else delete row.disabled
          await writeJson3(path, data)
          return { ok: true, restartNeeded: true }
        }
        if (kind === 'injector') {
          const path = home + '/injector/registry.json'
          const data = await readJson3(path)
          if (data === undefined || data === null || !Array.isArray(data.plugins)) return { ok: false, error: 'injector registry unreadable' }
          const row = data.plugins.find((r) => r !== null && typeof r === 'object' && r.name === id)
          if (row === undefined) return { ok: false, error: 'no injector entry named ' + id }
          if (disabled) row.disabled = true
          else delete row.disabled
          await writeJson3(path, data)
          return { ok: true, restartNeeded: true }
        }
        return { ok: false, error: 'unknown kind: ' + kind }
      }))

      harness.handle('capmgr/caps.hotStop', guard(async (args) => {
        const id = String(args.id ?? '')
        if (runner === undefined || typeof runner.inventory !== 'function') return { ok: false, error: 'dynamicCordisRunner 服务缺席，热停不可用' }
        const inv = await runner.inventory()
        const rows = Array.isArray(inv) ? inv : (inv !== null && typeof inv === 'object' && Array.isArray(inv.value) ? inv.value : [])
        const row = rows.find((r) => r !== null && typeof r === 'object' && String(r.pluginId ?? '') !== '' && (String(r.pluginId) === id || String(r.pluginId).startsWith(id + '-')))
        if (row === undefined) return { ok: false, error: '没有运行中的实例：' + id }
        const agents = ctx.get('agents')
        const agent = agents !== undefined && typeof agents.get === 'function' ? agents.get(row.agentId) : undefined
        if (agent === undefined) return { ok: false, error: '属主 agent 不在线，无法热停 ' + String(row.pluginId) }
        await runner.stopFromPanel(agent, row.pluginId)
        return { ok: true, stopped: String(row.pluginId) }
      }))

      // 质粒配置抽屉：白名单字段校验 + 保留未知键 + 备份写
      const PLASMID_DEFAULTS = {
        'inject.enabled': true, 'inject.topK': 3, 'inject.minRelevance': 0.25, 'inject.matcher': 'lexical',
        'nudge.enabled': true, 'nudge.perTaskPerPlasmid': 1,
        'broadcast.enabled': true, 'broadcast.globalByDefault': false,
      }
      const MATCHERS = ['lexical', 'llm', 'vector']
      function validatePlasmidField(key, value) {
        if (!(key in PLASMID_DEFAULTS)) return 'unknown field: ' + key
        if (key === 'inject.topK') return Number.isInteger(value) && value >= 0 && value <= 10 ? null : 'topK 须为 0-10 的整数'
        if (key === 'inject.minRelevance') return typeof value === 'number' && value >= 0 && value <= 1 ? null : 'minRelevance 须在 0-1 之间'
        if (key === 'inject.matcher') return MATCHERS.includes(value) ? null : 'matcher 须为 lexical/llm/vector'
        if (key === 'nudge.perTaskPerPlasmid') return Number.isInteger(value) && value >= 1 && value <= 5 ? null : 'perTaskPerPlasmid 须为 1-5 的整数'
        return typeof value === 'boolean' ? null : '须为布尔值'
      }
      harness.handle('capmgr/plasmid.config.get', guard(async () => {
        const home = await home3()
        const data = await readJson3(home + '/plasmids/config.json')
        const cfg = data !== undefined && data !== null && typeof data === 'object' ? data : {}
        const values = {}
        for (const key of Object.keys(PLASMID_DEFAULTS)) {
          const seg = key.split('.')
          const v = cfg[seg[0]] !== null && typeof cfg[seg[0]] === 'object' ? cfg[seg[0]][seg[1]] : undefined
          values[key] = v !== undefined ? v : PLASMID_DEFAULTS[key]
        }
        return { ok: true, values }
      }))
      harness.handle('capmgr/plasmid.config.set', guard(async (args) => {
        const patch = args !== null && typeof args === 'object' && args.values !== null && typeof args.values === 'object' ? args.values : null
        if (patch === null) return { ok: false, error: 'values required' }
        for (const key of Object.keys(patch)) {
          const bad = validatePlasmidField(key, patch[key])
          if (bad !== null) return { ok: false, error: bad }
        }
        const home = await home3()
        const path = home + '/plasmids/config.json'
        const existing = await readJson3(path)
        const cfg = existing !== undefined && existing !== null && typeof existing === 'object' ? existing : {}
        for (const key of Object.keys(patch)) {
          const seg = key.split('.')
          if (cfg[seg[0]] === null || typeof cfg[seg[0]] !== 'object') cfg[seg[0]] = {}
          cfg[seg[0]][seg[1]] = patch[key]
        }
        await writeJson3(path, cfg)
        return { ok: true, restartNeeded: true }
      }))
    }

    // ── v2 模型域：provider 只读清单 + 订阅登录（authorization 桥）+ 默认模型 ──
    function modelHalf(ctx) {
      const settings = ctx.settings
      const defModel = ctx.agentDefaultModel
      const llm = ctx.llm
      const guard = (fn) => async (args) => {
        try { return await fn(args ?? {}) } catch (error) { return { ok: false, error: errText(error) } }
      }
      const flights = {}

      harness.handle('capmgr/model.state', guard(async () => {
        const providers = llm.listProviders().map((p) => ({ id: String(p !== null && typeof p === 'object' ? p.id ?? '' : ''), name: String(p !== null && typeof p === 'object' && typeof p.name === 'string' && p.name !== '' ? p.name : p.id ?? '') })).filter((p) => p.id !== '')
        let piCfg = {}
        try {
          const got = settings.get('llm-pi-ai')
          const val = got !== null && typeof got === 'object' && 'value' in got ? got.value : got
          piCfg = val !== null && typeof val === 'object' && val.providers !== null && typeof val.providers === 'object' ? val.providers : {}
        } catch (error) { /* settings best-effort */ }
        const auth = ctx.get('authorization')
        const flows = auth !== undefined ? auth.list() : []
        const out = providers.map((p) => {
          const pc = piCfg[p.id]
          const obj = pc !== null && typeof pc === 'object' ? pc : {}
          const flow = flows.find((f) => f !== null && typeof f === 'object' && f.key === 'llm-pi-ai/' + p.id)
          return {
            id: p.id,
            name: p.name,
            baseURL: typeof obj.baseURL === 'string' ? obj.baseURL : '',
            apiKeyEnv: typeof obj.apiKeyEnv === 'string' ? obj.apiKeyEnv : '',
            modelsCount: Array.isArray(obj.models) ? obj.models.length : 0,
            authKey: flow !== undefined ? String(flow.key) : '',
            authLabel: flow !== undefined ? String(flow.label ?? '') : '',
            inFlight: flow !== undefined && flow.inFlight === true,
          }
        })
        let def = null
        try {
          const sel = defModel.currentSelection()
          if (sel !== null && typeof sel === 'object' && typeof sel.provider === 'string') def = { provider: sel.provider, model: String(sel.model ?? '') }
        } catch (error) { /* best-effort */ }
        return { ok: true, providers: out, def }
      }))

      harness.handle('capmgr/model.catalog', guard(async (args) => {
        const pid = String(args.provider ?? '')
        if (pid === '') return { ok: false, error: 'provider required' }
        const infos = await llm.listModels(pid)
        return { ok: true, models: (Array.isArray(infos) ? infos : []).map((m) => ({ id: String(m !== null && typeof m === 'object' ? m.id ?? '' : ''), name: String(m !== null && typeof m === 'object' && typeof m.name === 'string' && m.name !== '' ? m.name : m.id ?? '') })).filter((m) => m.id !== '') }
      }))

      harness.handle('capmgr/model.setDefault', guard(async (args) => {
        const provider = String(args.provider ?? '')
        const model = String(args.model ?? '')
        if (provider === '' || model === '') return { ok: false, error: 'provider and model required' }
        const infos = await llm.listModels(provider)
        const hit = (Array.isArray(infos) ? infos : []).some((m) => m !== null && typeof m === 'object' && m.id === model)
        if (hit === false) return { ok: false, error: provider + ' 目录里没有模型 ' + model }
        await defModel.saveSelection({ provider, model })
        return { ok: true, note: '默认模型已更新（新会话生效；现有会话用输入框旁的选择器切换）' }
      }))

      harness.handle('capmgr/auth.begin', guard(async (args) => {
        const key = String(args.key ?? '')
        const auth = ctx.get('authorization')
        if (auth === undefined) return { ok: false, error: 'authorization 服务缺席' }
        const desc = auth.describe(key)
        if (desc === undefined) return { ok: false, error: '没有该 provider 的登录 flow：' + key }
        if (flights[key] !== undefined && flights[key].phase !== 'done') return { ok: false, error: '该 provider 已有登录流程进行中', code: 'in-flight' }
        const slot = { phase: 'starting', url: '', code: '', status: '', error: '' }
        flights[key] = slot
        const method = Array.isArray(desc.methods) && desc.methods.length > 0 && desc.methods[0] !== null && typeof desc.methods[0] === 'object' ? String(desc.methods[0].id ?? 'oauth') : 'oauth'
        const interaction = {
          notify(notice) {
            try {
              const url = notice !== null && typeof notice === 'object' ? String(notice.url ?? notice.verificationUri ?? '') : ''
              const code = notice !== null && typeof notice === 'object' ? String(notice.code ?? notice.userCode ?? '') : ''
              if (url !== '') { slot.url = url; slot.code = code; slot.phase = 'url' }
            } catch (error) { /* 呈现失败不中断轮询 */ }
          },
          prompt() { throw new Error('此登录方式需要交互输入，能力面板暂不支持') },
        }
        Promise.resolve(auth.begin({ key, method, interaction })).then((outcome) => {
          slot.phase = 'done'
          slot.status = outcome !== null && typeof outcome === 'object' ? String(outcome.status ?? 'unknown') : 'unknown'
        }, (failure) => {
          slot.phase = 'done'
          slot.status = 'error'
          slot.error = errText(failure)
        })
        return { ok: true, started: true }
      }))

      harness.handle('capmgr/auth.status', guard(async (args) => {
        const key = String(args.key ?? '')
        const slot = flights[key]
        return { ok: true, ...(slot === undefined ? { phase: 'idle' } : { phase: slot.phase, url: slot.url, code: slot.code, status: slot.status, error: slot.error }) }
      }))

      harness.handle('capmgr/auth.cancel', guard(async (args) => {
        const key = String(args.key ?? '')
        const auth = ctx.get('authorization')
        if (auth !== undefined) { try { auth.cancel(key) } catch (error) { /* best-effort */ } }
        const slot = flights[key]
        if (slot !== undefined) { slot.phase = 'done'; slot.status = 'cancelled' }
        return { ok: true }
      }))
    }

    plinsHalf(ctx)
    skluiHalf(ctx)
    mcpHalf(ctx)
    capsHalf(ctx)
    modelHalf(ctx)
  },
}

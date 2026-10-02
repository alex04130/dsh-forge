// forge 工具半部 —— 2026-10-02 UI 大改后唯一存活的部分。
//
// 原 `forge-ui.host.js`（1475 行）同时装着七个面板域的 RPC 与 7 个模型可见工具：
//   面板域：功能壳 / 已归档 / 质粒 / 插件安装 / 技能管理 / 能力 / 模型
//   工具：  skill_list / skill_show / skill_add / skill_disable / skill_enable / skill_remove
//           forge_dev_stop_dyn_plugin（客户端半部崩了时用它止损）
// 面板与整个客户端半部已整批删除，这里只留工具，因此：
//   - 本文件**没有任何 `harness.handle`**（原来有 ~50 个）；
//   - auto-plugins.json 里的这一行**没有 clientFile**。
// 技能状态仍归 skillRegistry 服务，本文件不持有。
return {
  inject: ['skills', 'skillRegistry', 'dynamicCordisRunner'],
  apply(ctx) {
    const jsonText = libJsonText
    const errText = libErrText

    // ── 技能域（原 skluiHalf 的模型工具半边） ──
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
    }

    // ── 急停工具 ──
      // ── emergency stop tool: stop a dynamic plugin by id prefix (used to
      //    rescue the sidebar when a crashing client half is still running) ──
      const runner = ctx.get('dynamicCordisRunner')
      if (runner !== undefined && typeof runner.inventory === 'function') {
        const stopTool = harness.defineTool({
          name: 'forge_dev_stop_dyn_plugin',
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

    skluiHalf(ctx)
  },
}

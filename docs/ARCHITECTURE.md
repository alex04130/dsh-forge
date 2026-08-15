# DSH 扩展套件架构文档

> 本文档记录 `/home/alex/.dsh` 下自建扩展套件的架构决策、注入方式对比、分层规则与已知风险。
> 最后更新：2026-08-15。作者：cordis 会话 + 编辑模式会话。

## 1. 注入方式对比（八种，按"该用哪个"排序）

DSH 至少有八种把代码塞进运行时的路径。它们的持久性、热更新、是否被 npm 覆盖、适合放什么，差别很大：

| # | 方式 | 载体 | 热更新 | 被 npm 覆盖 | 适合放什么 | 我们用它干嘛 |
|---|------|------|--------|-------------|-----------|-------------|
| 1 | 官方 bundle/patch | `dsh.profile.bundles` + `dsh.bundle`（package.json + cordis.yml） | 重启 | 否（用户层） | 官方产品插件 | 不碰 |
| 2 | **Host composition patch** | `profiles/web/cordis.patch.yml` + `./plugins/*.mjs` | 重启 | 否 | **我们的持久能力主层** | mailbridge/teamhub/modsub/injector/skillmanager/modelroute 等 |
| 3 | **Dynamic Cordis** | `auto-plugins.json`（内嵌 hostCode+clientCode）+ `dynboot.mjs` 恢复 | 重启（dynboot） | 否 | 内联代码、带 RPC+客户端 UI | gitdk(已禁用)/modpk/modlpk/imgsub |
| 4 | **Dual-face `@local/*` 包** | `packages/<pkg>/` + `package.json` 的 `dsh.client` | 重启 | 否 | host 半部 + client bundle 半部 | dsh-plugmgr / dsh-dynrestore |
| 5 | **Agent preset** | `.agent-presets/<id>/agent.cordis.yml` + 相对 `.mjs` | 仅挂载时读一次 | 否 | 每个会话的组合（工具/提示词段） | router-standard |
| 6 | **Runtime injector** | symlink 到 `profiles/node_modules` + `ctx.loader.create` + `~/.dsh/injector/registry.json` | ~1.5s 热加载 | 否 | 运行时注入本地插件包 | 我们的 injector（BepInEx 式） |
| 7 | **Context 注入** | AGENTS.md / CLAUDE.md（`dsh-agent-instructions`） | 即时 | — | 仓库级指路 | 首轮被 router 抑制 |
| 8 | UI 注入 / 服务包装 | `webServer.register` / slots / 替换 service | 客户端 HMR 视情况 | 视情况 | 客户端 UI、桥接 | plugmgr 设置页、imgsub-bridge |

**核心取舍**：#2（host composition）是唯一"配置即状态 + 用户层可持久 + 全局工具"的主层；#6（injector）是唯一能"不重启就把新包加载进来"的运行时层；#3（dynamic）是唯一能"一段 JSON 同时带 host 工具 + 客户端 UI + RPC"的层。

## 2. 分层规则（什么放哪一层）

### 2.1 Host 平面（`cordis.patch.yml`，进程单例）
放：**注册表本身**（tools / sessions / agents / subagents / skills）、沙箱与审批栈、持久化、模型路由、web server、以及任何"跨会话、进程全局"的服务。

关键判断：**"注入服务"的行属于 host 平面**——因为 `inject` 在会话存在之前就解析，没有 agent 可 key。我们 12 个 host 插件全在这一层。

### 2.2 Preset 平面（`agent.cordis.yml`，每会话组合）
放：每个会话的**工具面 + 提示词段**（persona、shell、filesystem、plan-mode、delegation、router）。preset 里的 service 行必须放在带 `isolate` 的 `cordis:group` 里，否则会 publish 到 root realm 变成进程全局、同名互撞，`dsh-agent-presets` 挂载时直接拒绝。

preset 的 `.mjs` 相对行从**用户主目录**解析裸 specifier，所以 `@deepseek-ai/*` 在用户主目录不可用——router 因此零外部依赖。

### 2.3 Dynamic 平面（`auto-plugins.json`，内联代码）
放：带客户端 UI 的临时/内联插件。host 半部通过 `harness.handle('x', async args => {})` 暴露 RPC，`ctx.get('...')` 能看到 host 服务；client 半部 `inject:['slots']` + `styles.insert` + `host.call('x', args)`。gitdk/modpk/modlpk/imgsub/sklui 全是这个模式。

**动态沙箱边界（`dsh-cordis-host-runner` createSandbox / nodeApiTraps）**：
- `require`/`fs`/`process`/`fetch`/定时器全是 trap（throw 并给出替代指引）；可用：`console`、`harness`、`btoa/atob`、`TextEncoder/Decoder`。文件 I/O 必须通过 cordis 服务（`inject:['fs']`，或让 host 插件提供自己的服务）。
- host 半部是**函数体**（包在 `(async () => {…})()` 里 eval），没有 import 语句；`vm` context 执行，有 `vmTimeoutMs`。
- **工具 DSL 更严**：`harness.defineTool` + `harness.registerTool(ctx, tool)`；`parameters` 是 property-map（属性名数组做 `required`，object 根 `additionalProperties` 必须 true 或省略）。照抄 gitdk 的 `registerTool` 包装最稳。
- **同名工具/服务 "already registered" 会 throw**（`startHostHalf` 把 fiber 建在 `rootCtx.plugin({name:"cordis-dynamic"})` group 下——**根作用域，工具全局可见**，不是 per-agent）。所以收敛功能时只能有一个注册者。
- `host.call(method, args)`：args 默认 **null**（handler 要容 null）；handler 抛错/方法不存在会 reject，handler 返回 JSON 则 resolve。

**RPC + 工具 + UI 收敛模式（skillui 示例）**：持久化在 host 插件（`skillmanager.mjs` 纯服务壳：store + `ctx.provide('skillRegistry', {state/add/disable/enable/remove})`，**不注册任何工具**）；动态插件 `sklui` host 半部 `inject:['skills','skillRegistry']`，工具（skill_list/…/skill_remove）和 `harness.handle('skillui/*')` RPC 都转发到同一服务——工具与 UI 永远共享一份 owned Map / 一个 store，不会互抢 registry。

**禁用机制**：entry 加 `"disabled": true`，`dynboot.mjs` 里 `if (entry.disabled === true) continue`。

### 2.4 谁不该放哪
- **别在 host 平面放"每会话状态"**——host 行解析时没有 agent。
- **别在 preset 平面放"进程单例注册表"**——subagent/workflow/skill 的注册表是 process singleton，放 preset 会重复注册或互相遮蔽。
- **别用 monkey-patch 改 npm 包**——见 §5。

## 3. 首轮锚定规则（router-standard）

这是本套件的灵魂。目标：首条消息就把会话锁进 spec（先计划）/ react（直接干）/ weak（模型自路由）三条行为带之一。

### 3.1 分类（`router-core.mjs`）
- `classifyTask(text)`：命中 REACT_RE 关键词多 → 1（react）；SPEC_RE 多 → 0（spec）；打平/无命中 → `'weak'`。
- `bandOf(mode)`：`[0,0.2)`=spec，`[0.2,0.5)`=transition(陷阱，别用)，`[0.5,1]`=react，`'weak'`=weak。
- `personaFor`：spec=`"You are a helpful software engineer assistant."`；react=hands-on doer；weak=按模型选 WEAK_PRO/WEAK_FLASH。

### 3.2 关键时序坑（踩过两次，务必记住）
1. **`session/event` 不会分发到 preset 作用域**——路由器里 `ctx.on('session/event')` 永远收不到子代理/会话事件（弱模式引导从来没注入过就是证据）。
2. **assemble 早于 user/message append**：agent loop 的 `preStep` 顺序是 `inbox.claim → systemPrompt.assemble → … → session.append("user/message")`。所以首轮 assemble 时 `session.events` 里**只有** `agent/inbox/spliced`（消息进收件箱时落的），没有 `user/message`。
3. **正确取首条消息**：`sessionMode()` 先 `events.find(user/message && source.kind==='user')`，找不到就遍历 `agent/inbox/spliced` 的 `inserted[]` 里 `source.kind==='user'` 的第一条。**不要**用 `ctx.on('session/event')`。

### 3.3 首轮极简
`system-prompt/assemble` 首轮只返回 `[persona, plan:policy(若激活)]`，把 contexts 清空、工具收窄到 `coreFor(mode)` + 平台 shell。首个 `tool/call` 之后恢复完整 boilerplate + 全量工具。**否则 6000+ 字符的 DSH 说明会稀释锚定**（standard 只有 91，minimal persona+2 tools 是 99/96）。

**锚定适用性（2026-08-15 新增，重要）**：首轮锚定/工具收窄/persona 路由是 **deepseek-v4 过拟合与 RL 对齐问题的缓解方案**，只应对 deepseek 系列模型生效。非 deepseek 模型（kimi/claude/gpt/…）从未按 react↔spec 行为带测量过，锚定对它们是纯损失（例：kimi 视觉子代理首轮被收窄到核心工具集，连 read_image 都看不到）。实现：`router-bootstrap.mjs` 的 `anchorApplies(agent)` 按 `agent.options.model` 判定（默认 `/^deepseek/i`，`config.anchorModels` 可配 regex 或模型 id 数组）；不适用时 `system-prompt/assemble` 原样返回完整组装（不换 persona、不清 contexts、不收窄工具），`agent/pre-step` 抑制与弱模式近场引导同样跳过，`dev_router_status` 显示 `router BYPASSED`。

### 3.4 首轮抑制基线注入
`agent/pre-step` 用 `{prepend:true}`（最外层，`next()` 已含内层注入）过滤到首个 tool/call 之前：
- `source.kind === 'agent-instructions' && baseline === true`（AGENTS.md/CLAUDE.md）
- `source.kind === 'skill-catalog'`（`<available_skills>` 提醒）
- `source.kind === 'skill-invocation'`（`/name` 手势注入的 `<skill_content>`）

首轮不注入这些大段 persona，避免把任务路由进 ambiguous/mixed 带。

## 4. Cache 规则（模型侧 prompt cache）

1. **静态文本放前面，动态文本放尾部**——保持前缀稳定，最大化 prompt cache 命中。
2. **绝不把动态内容 concat 进 system 段**——system 变了整段 cache 失效。动态内容（上下文快照、搜索/工具结果）只进 messages。
3. **首轮极简本身也是 cache 友好**：首轮 system 短且稳定，后续恢复完整 boilerplate 时前缀仍是 persona（我们的 `applyPersona` 把 persona 段放末尾 order 0，恢复后尾部 persona 不变）。
4. **近场引导 > 远场 persona**：弱模式的 GUIDE 引导是往 inbox 追加 user/message（近场），而不是塞进 system。

## 5. npm 升级风险清单（不可 patch 的部分）

`/usr/lib/node_modules/@deepseek-ai/dsh/` 是 **root-owned + npm 覆盖**。任何直接改它下面文件的行为：① 会被 EACCES 拦；② 就算改成功，`npm i` 一升级就没了。所以我们的策略是**只在 `~/.dsh` 用户层做扩展，绝不 monkey-patch npm 包**。

以下是"想改但不能改、只能绕"的关键 npm 位置：

| npm 包 / 文件 | 我们在绕什么 | 绕法 |
|---|---|---|
| `dsh-subagent` `resolveChildAgentOptions` | 继承的是父**创建** options，不是 live route | modelroute 的 agent/request 钳制 |
| `dsh-host-apiproxy` `selectionFor` | 新鲜子代理回退全局默认模型 → 升级 bug | modelroute `{prepend:true}` agent/request |
| `dsh-subagent` `submit`/`sendReport` | send_message/report 走 followup 不打断 | 自研 subagent 的动机（远期） |
| `dsh-agent-loop` `preStep` | assemble 早于 user/message append | router 直接读 inbox-splice |
| `dsh-system-prompt` `assemble` | complete:true 在 waterfall 之后才折叠 | router 首轮自己 return minimal sections |
| `dsh-tool-skill` catalog handler | skill-catalog 每 pre-step 注入 | router 首轮 prepend 过滤 |
| `dsh-tools` `defineTool`/register | 参数 schema 编译 | injector 里内联 schema 编译器 |
| `cordis` waterfall | prepend=unshift(最外层)、默认=push(内层) | 依赖这个顺序装钳制 |

**升级时的存活清单**：`~/.dsh/profiles/web/cordis.patch.yml`、`~/.dsh/auto-plugins.json`、`~/.dsh/.agent-presets/**`、`~/.dsh/injector/registry.json`、`~/.dsh/skillmanager/registry.json` 都在用户主目录，npm 升级**不碰**。唯一要担心的是我们依赖的 npm 内部行为（上面表格）被上游改动。

## 6. 已实现清单

### Host 插件（`profiles/web/cordis.patch.yml`，12 行）
mailbridge（跨会话）、llmrouter（模型委派）、modeswitch（切 preset）、teamhub（团队）、modsub（指定模型子代理）、**injector**（运行时注入）、**skillmanager**（skill 管理）、**modelroute**（模型路由策略）、dynboot（动态插件恢复）、imgsub-bridge、@local/dsh-dynrestore、@local/dsh-plugmgr。

### Preset
`.agent-presets/router-standard/`：agent.cordis.yml + router-bootstrap.mjs + router-core.mjs（改编自 dsh-router-standard / dsh-anchored-standard，MIT，见 NOTICE）。

### 动态插件（`auto-plugins.json`）
gitdk（disabled）、modpk、modlpk、imgsub、**sklui**（skill 管理器：6 个模型工具 + `skillui/*` RPC + 侧栏设置面板；持久化经 `skillRegistry` 服务桥转发到 skillmanager.mjs）。

### 客户端面板（UI 层）
- `@local/dsh-plugmgr`（插件市场）：**自主发现**——host/注入/官方三类经 `remote.pluginInventory.list()`（loader 条目：`entryId/moduleName/enabled/fiberPhase`）按模块名前缀分类（`./`、`@local/` = 本地；`@deepseek-ai/`、`cordis:` = 官方；其余 = 注入），不再硬编码。
- **sidebar.footer.action 同行坑（终局方案）**：官方 foot 结构 = `footArea(column) > [footerActions(row) + settingsArea]`；所有 action 与 cordis-panel 挤在 footerActions 一个 row 里，Settings 在独立容器。**绝对不要在 useEffect 里把 DOM 节点搬出 React 插槽容器**——三个面板都做"搬到 settings 之后"时互相 insertBefore 引用失效，NotFoundError 拖垮整个 sidebar slot（侧栏全白）。正确解法是纯 CSS 改容器方向：`[class$="_footerActions"] { flex-direction: column; align-items: stretch; gap: 2px; }`——按钮在官方容器内竖排（cordis → 技能 → 插件 → 市场 → Settings），零 DOM 操作、React 无感知。
- **停运行中的动态插件**：`dynamicCordisRunner.stopFromPanel(agent, pluginId)` 第一参数是 **Agent 对象**（经 `ctx.get('agents').get(sessionId)` 解析），不是 sessionId 字符串——传字符串静默无效。dynboot 的 define 是一次性快照，改 auto-plugins.json 不覆盖内存中的旧 package；须 stop 旧实例，重启后 dynboot 用新代码重新 define。
- `@local/*` client.js 改动后：client-hmr 会 re-hash bundle，**刷新页面**即可生效（无需重启）；skillui 这类 `auto-plugins.json` 条目需重启 DSH（dynboot 恢复）。

### 软打断
`session_send` / `team_send_message` 对 live 会话用 `agent.steer()`（next-step 注入，不打断在途调用）；`Agent.followup`（next-turn 队列）/ `Agent.inject`（next-step 不唤醒）语义见 dsh-agent。

## 7. 关键机制备忘

- **Agent 投递**：`followup`=队列下一轮；`steer`=注入当前 turn 下一步（软打断）；`inject`=注入但不唤醒。shipped `session.prompt`：`mode==='steer' ? agent.steer : agent.followup`。
- **模型选择**：`installModelSelection(agent.ctx, selection)` 在 `agent/request` 覆盖 provider/model；UI 选择在 `dsh-host-apiproxy` 的 `selections`（进程内 picked），落盘在 `request/header`。
- **工具注册**：`defineTool` 把 property-map 编译成 JSON Schema；raw `ctx.tools.register` 要求 `parameters` 是完整 `{type:'object',properties:{}}`，不能 `{}`。
- **注入包解析**：`loader.create` 用 `ctx.loader.internal.import(name)` 从 `profiles/node_modules` 解析裸名；包内 `@deepseek-ai/*` 从包自己的 node_modules 解析（需 self-link）。

## 8. 已知 open issue

- ~~「用户输入在系统提示词之前注入」~~ **已关闭**：数据面无串位——首轮 system 极短（183/48 字符）是观感问题；两个 `system=[{}]` 空 request/header 已确认是 `dsh-agent-loop` `buildRequest` 的 seed 占位（`requestHeaderLogged=false` 时先 append 由 `{provider,model,reasoningEffort,maxTokens}` 派生的 initial header，此时 system 尚未组装，`canonicalHeader` 拿到空占位；claim 用户消息 + `system-prompt/assemble` 之后才 append 带真实 system 的 change header）。
- **upstream：侧栏 Settings 行与 Cordis/自定义行原生不对齐**（2026-08-15 实测）：Settings 是独立组件，labelX 42 vs 40、按钮高 34 vs 49、左缘 x 8 vs 12。按"系统零接触"原则不修，归 DSH upstream（配合 #17 反转路线的终局方案）。
- **backlog：非法 reasoningEffort 值静默失败**（sync #40 验证时发现）：spawn/team 显式传非法 effort（如 `low`，deepseek 枚举只有 off/high/max）导致子代理无输出静默失败——待加 effort 合法性校验 + fail-loud（明确报错而非静默）。

## 9. 验证记录（2026-08-15）

- **坑 #3 分类修复生效**（进程 02:40 启动晚于 router-core 02:27 修改，无需重启）：spawn 子代理（任务含"审查/bug"），其首个 `request/header` 的 system 为 48 字节 spec persona（`You are a helpful software engineer assistant.`）；首个 tool/call 后第二个 header 恢复 6415 字节完整 boilerplate，尾部 persona 不变；skill-catalog 在首个 tool/call 后恢复注入。全部符合预期。
- gitdk 保持 `disabled:true`；modelroute P1 修复随进程加载。

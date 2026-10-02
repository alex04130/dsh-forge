# 0.2.0-rc.2 适配：已定决策与在办计划

> 建立：2026-10-02。基线：DSH **0.2.0-rc.2**（Windows 官方桌面版）。
> 代码基线：WSL 部署 `\\wsl$\Ubuntu-24.04\home\alex\.dsh`（`profiles/web/plugins/*.rN.mjs` 等），
> **不是**仓库 dev 的旧快照。
> 验证设施：独立测试 profile `~/.dsh/profiles/forge-test/`（`DSH_PROFILE=forge-test node scripts/install.mjs`）。

---

## 1. 已定决策（2026-10-02，用户确认）

### D1 codex 子代理：自建持久线程版

**决定**：不用官方 `@deepseek-ai/dsh-subagent-codex`（它每次派发都开一个**临时** Codex 线程、
用完即弃），自己实现一个**持有持久 Codex 线程**的 provider。

**理由（用户）**：官方那个「完全不支持接入一个长久会话」，而 Codex API 支持。

**先更正一个事实**：该包**就在 harness 仓里**（`packages/subagent/subagent-codex/`），
不是第三方附加包。但它**不属于** `dsh-base` / `dsh-web-app` 组合包
（`packages/bundle/base/tests/base.spec.ts` 断言 base manifest 不依赖它），
所以 **profile 必须自己声明这个依赖**，否则那一行启动即 `failed to import`。

**官方为什么只能 one-shot（四条硬证据）**：
1. provider 直接 `capabilities = NO_START_CAPABILITIES`（五项全 false）；
2. `wire.ts` 把 `thread/start` 写死 `ephemeral: true`，且**断言**线程必须是 ephemeral；
3. wire 只实现 `initialize` / `thread/start` / `turn/start` / `turn/interrupt`，
   **从不调用 `thread/resume`**；
4. 缺可选方法 `prepareContinuable`（**方法存在性本身就是能力标志**）。

### ⚠️ 关键：只加 `prepareContinuable` 拿不到 Codex 线程续接

这是 rc.2 契约的**结构性限制**，不是 codex 包的问题：

- continuable child 的 Agent 由 **continuation manager 自己 in-process 组合**
  （`continuation-activation.ts` 里 `agents.create({...})`），turn 由子 Agent 自己的
  inbox / agent-loop 排序。
- provider 的**唯一**参与是 `prepareContinuable(request) => { seed? }`。
  `types.ts` 逐字：*"a provider never sees the child's Agent, handle, turns, or teardown"*。
- 冷恢复时逐字：*"The descriptor supplies every reconstruction input; no subagent provider
  is dispatched."*
- 官方 Dev Note 自己点了这个缺口（`subagent/README.md`）：
  *"Continuable ACP children — requires persisting the remote session id and a per-child
  continuation advertisement."* —— 即**进程外 provider 的可续会话 rc.2 未实现**。

**所以有三条路线：**

| 路线 | 做法 | 得到什么 | 要改上游吗 |
|---|---|---|---|
| **1'（推荐，rc.2 契约内）** | 自建 provider，`backgroundMode: one-shot`，但 `start()` 内部**持有/复用持久 Codex 线程**：首次 `thread/start`（**不带** `ephemeral: true`）并保存 `thread.id`，之后 `thread/resume{thread_id}` + `turn/start`（活跃 turn 用 `turn/steer`）。线程按父会话或显式 label 键控。 | **长期 Codex 线程**：跨多次派发累积上下文，正是"接入一个长久会话" | **不用** |
| ~~1''~~ ❌ **不可行** | ~~在 1' 之上再实现 `prepareContinuable()`，并把 preset 行改成 `backgroundMode: continuable`~~ | ❌ **方向相反**：continuable 子会话的 Agent 由 manager **自己 in-process 组合**，provider 的 **`start()` 根本不会被调用**（`prepareContinuable` 只贡献 `{seed?}`）。改成 `continuable` 会**直接丢掉 Codex 后端** —— 子会话变成走父级 LLM 路由的普通 DSH agent。**所以 codex provider 必须留在 `one-shot`**：代价是 DSH 侧子会话不可续，但 **Codex 线程本身是持久的**（那才是 1' 要的东西） | — |
| **2（真·进程外续接）** | 让 `ContinuableCreateSpec` 能携带远端会话句柄并跨冷恢复持久化，`continuation-activation` 支持 provider 驱动 turn 的路径，`SubagentProvider` 新增 turn 级方法 | DSH 的 continuable 子会话**本身就是那个 Codex 线程** | **要** |

**为什么 1' 成立**：`start(request): Promise<SubagentRun>` 在 `one-shot` 模式下
**完全由 provider 拥有** —— 返回 `{ id, localAgent, result, dispose }` 即可，
`localAgent` 允许是 `undefined`。契约只约束"发布即所有权转移"，不约束 provider 内部
用哪个 Codex 线程。官方 provider 之所以每次都是新线程，纯粹是因为它自己写死了
`ephemeral: true` 且从不调 `thread/resume`（见上文四条证据）。

**缺口在 DSH 这一侧，不在 Codex 那一侧** —— OpenAI 官方文档已证实
`thread/resume{thread_id}` / `thread/start{ephemeral}` / `turn/start` / `turn/steer` /
`turn/interrupt` 都存在（[app-server 文档](https://learn.chatgpt.com/docs/app-server)、
[协议源码 `v2/thread.rs`](https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)，
其中 `ThreadResumeParams` 的逐字注释：*"Prefer using thread_id whenever possible."*）。

**建议走 1'（需要的话叠加 1''）** —— 不需要任何上游改动就能拿到"长久会话"。

**实现清单（逐字签名，来自 rc.2 原文）**：

```ts
export interface SubagentProvider {
  readonly name: string
  readonly capabilities: SubagentCapabilities
  readonly inheritsParentContext: boolean
  readonly agentRouteDefaults?: Readonly<{ provider: string; model: string }>
  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun>
  prepareContinuable?(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>
}
export interface SubagentCapabilities {
  readonly agentOptions: boolean
  readonly outputSchema: boolean
  readonly depthLimit: boolean
  readonly toolFilter: boolean
  readonly persona: boolean
}
export interface SubagentRun {
  readonly id: SessionId
  readonly localAgent: Agent | undefined
  readonly result: Promise<SubagentResult>
  dispose(): Promise<void>
}
```

注册：`ctx.subagents.registerProvider(provider)`（返回 disposer，别丢）。
插件形状：**具名导出** `name` / `inject` / `Config` / `apply(ctx, config)`，**无 default export**。

工具行必须写：
```yaml
config:
  provider: codex
  toolName: subagent_codex
  backgroundMode: continuable     # 只有 provider 有 prepareContinuable 时才合法
  maxDepth: provider-managed      # capabilities.depthLimit === false 时写字面数字会在 load 时抛错
```

`tool-subagent` 的 mount 断言（`assertSubagentProviderConfiguration`）：
`continuable` ⇔ provider 必须有 `prepareContinuable`；`depthLimit === false` ⇒ `maxDepth`
只能 `'provider-managed'`；`agentOptions === false` ⇒ 不能设 `config.agentOptions`，
也不能 `modelSelectionSettings: true`。

**可直接复用的官方工具**：`subagent/src/out-of-process.ts` 导出了
`NO_START_CAPABILITIES`、`assertPositiveFinite`、`assertUsableCwd`、`validateConfiguredCwd`、
`resolveChildCwd`、`settleRunResult`、`subprocessRunHandle`。

**现状**：`bundle/cordis.patch.yml` 仍有一条指向官方包的 `subagent-codex` 行 ——
换成本地实现前，它是测试 profile 启动时**唯一**的激活失败项。**不要**图省事直接删掉，
否则全新安装会彻底失去 codex 子代理。

旧文档 `docs/SUBAGENT-PROVIDER.md` 的基准是 **0.1.0-rc.6**，其 §3.2 列的 `reportFrom`
在 0.2.0-rc.2 **已不存在**，不能照抄；但 §3.1 的接口与本文一致。

### D2 「按项目分组」：接受 fork 代价，但写成注册表

**决定**：shadow `sidebar.workspaces`（`priority < 0`），**接受整块 fork 官方工作区浏览器的代价**；
但分组模式要写成**注册表 / 可扩展 union**的形式，新增一档是加一条，而不是再 fork 一次。

**理由（用户）**：「直接按照注册表或者可活动 union 的方式编写，也就是一劳永逸，除非上游更改」。

**已查明的约束**（见 §3.1）：
- rc.2 **没有**分组模式扩展点：`SessionGroupBy` 是闭合联合 `'workspace' | 'workspace-tree' | 'flat'`，
  菜单是 `WorkspaceBrowser.tsx` 里的硬编码数组，状态在**浏览器 localStorage**
  （`dsh.workspace.view.v5`），**不是 Host 设置**。
- shadow 是唯一能改这一层 UI 的缝：`single` 槽「lowest live entry renders」，所以必须 `priority < 0`
  （ui-workspace 占 priority 0；同 priority 会抛 `single slot ... already has a registration at priority 0`）。
- **child slot 不能重声明**：`slots.register` 对已声明 key 抛 `already declared`，而 `renderSlot`
  只能渲染自己声明的 children。ui-workspace 的 entry 仍存活并占着
  `sidebar.workspaces.session.menu.item`、`.row.action`、`sidebar.session.row.leading`、`.hover`、
  `sidebar.workspaces.directoryFlow` 的声明权。
  **后果：shadow 会连带丢掉官方的行菜单、行 hover 按钮、行前导/hover 座位与目录选择流**，
  必须在自己的 key 下重建等价物。
- 「项目」在 rc.2 里**就是 Workspace 的同义词**：`workspaceRecord` 只有
  `path/title/sessionIds/createdAt/updatedAt`，**无任何 parent/group 层级字段**。
  所以「按项目」这一档必须由 forge 的 `~/.dsh/projects.json` 索引提供项目归属。

**长期代价**：fork 意味着**要跟上游改动**。rc.2 的 `AGENTS.md` 自述
*"Public APIs are pre-stable; update every consumer."* —— 每次升级都要重新对一遍被 fork 的那部分。

### D3 集群中心形态：未定，需要一次完整调研

**决定（用户）**：「目前还没考虑好，我可能要完整调研一下」。

**但已明确约束**：**完整的控制 api 记得带上** —— 控制端点要覆盖管理台可能做的每一件事，
而不是只做只读观测。

**在办**：官方**全部可被远程驱动的业务方法**枚举（11 个能力域）+ `@Remote` 已暴露清单 +
「必须排除」清单。调研在办。

**已知的形态选项**（等调研后定）：
- 中心是**独立服务**（可持有全部节点凭据做统一鉴权；但要防中心自身成为单点）
- 中心由**某个常驻节点兼任**（省一个进程；但要防主节点被攻破即全网沦陷）

### D4 控制面协议：自签 token

**决定（用户）**：「自签 token，兼容性比较好吧我记得」。

**已查明的正交事实**：
- `ctx.webServer.register({ kind: 'exact' | 'prefix', path, handler })` 可以挂自己的 HTTP 路由，
  但官方 README 自述 *"the server carries no TLS, authentication, or origin policy of its own"*
  —— **鉴权必须自带**。官方先例是 `@deepseek-ai/dsh-webhook-github`：自注册 `exact` 路由 +
  自验 `X-Hub-Signature-256` HMAC；generic 包自述 *"provider authentication belongs to adapter packages"*。
- 官方 `/api` + `ctx.typertGateway` 那条路有现成鉴权（authority 绑定 HMAC cookie，跨重启有效），
  但 **Windows 桌面版拿不到 launch token**（它不打印 `dsh web: http://...?token=` 那行），
  所以自签 token 对「节点含桌面版」的集群是更兼容的选择。
- `ctx.typertGateway.invoke({ namespace, method, args })` 是 **public 且进程内可调** ——
  自建路由的 handler 可以在内部复用它，从而拿到与浏览器同一套 descriptor 校验与业务方法。

**结论**：控制端点 = 自有 HTTP 路由（`ctx.webServer`）+ 自签 token + handler 内部先走
`ctx.typertGateway.invoke()`，拿不到 descriptor 的能力再直接调宿主服务。

### 4.1 控制面 verb 表的设计约束（2026-10-02 全量审计结论）

**已实现并实测通过**（`bundle/plugins/control.mjs`，`/forge-control`）：
`health`（含节点自报的 `address`）、`capabilities`（服务在位探测）、`settings.describe`。
无 token → 401；全程不用 cookie，是真正的机器对机器。

**四条硬约束**：

1. **官方 `@Remote` 面是「同源浏览器 BFF」，不是节点管理面** —— `/api/remote.mux` 靠浏览器
   信任认证（`stream-server.ts`），不是节点间 token。所以**任何 `@Remote` 方法都不能 1:1
   透传到自己的端点**；正确姿势是**逐 verb 白名单**，在 token 鉴权之后调用宿主服务。
2. **官方自己演示了"秘密不上远程"**：`accountController` 把 12 个方法里的 11 个搬上远程，
   恰好剔除了返回秘密的 4 个；`credentialsController` 的 JSDoc 逐字
   *"Secret values cross in one direction only — no method here returns one."*。
   **`credentialsController.set(ref, value)` 是官方唯一的秘密写入口（单向、无读回路）** ——
   这是 verb 表里**唯一**该保留的 writes-secret verb。
3. **沙箱放宽的远程可达性 = 0，且刻意如此**：`sandboxPolicy` 全 4 方法无 `@Remote`；写路径是
   普通导出函数 `setSandboxMode()`（不是服务方法）；同时改写 `sandbox/mode` 与
   `approval/policy` 的 `permissionPresets.set` 也没有 `@Remote`。三条独立护栏指向同一红线。
4. **`settingsController` 读侧强制 redact，写侧却可无条件写**：远程读走
   `describe({redactSecrets:true})`（逐字 *"a `role('secret')` field cannot ride a response"*），
   但写侧 `expectedRevision` 可为 `undefined` = 无条件写，`replace` 还是 wholesale 语义。
   → **verb 层必须自己加 ns 白名单 + 强制 revision**，不能只靠官方 redact 保护读方向。

**30 条硬红线（一律不包装）**：凭证明文读（`credentials.resolve/readRecord/modifyRecord/
deleteRecord`、`deepseekAccount.getPlatformSession/resolveToken/rejectToken`、
`getDeviceIdentity`）；沙箱与审批放宽；任意代码/插件装载（`pluginManager.installBundle/
setPluginEnabled/setBundleEnabled/removeBundle/setVersionExemption`、
`dynamicCordisRunner.invoke/runHostHalf/getClientCode/stopFromPanel/undefineFromPanel`、
`loader.create/update/remove`、`agentPresets.register/recompose/mount`、`skills.register`）；
节点主机副作用（`openWorkspacePath`、`openSettingsDocument`、`terminalController.*`、`fs.*`、
`subprocess.*`、`ssh.*`、`workspaceFiles.*`、`sessionController.attachment`）；输入注入
（`commands.execute`、`userQuestions.answer`、`subagents.prompt/interruptByParent`、
`agentTeams.sendMessage/spawnTeammate/updateTask/interrupt`）；账号外联
（`accountController.startSignIn/signOut`、`pluginRegistryProbe.fastest`）。

两个高危细节：`dynamicCordisRunner.runHostHalf` 在 `requestId === null` 时**自建 attempt
并自动批准 Client 包**；`pluginManager.installBundle` 的 spec 契约含"注册名、**绝对路径、
git 地址或 tarball**"，且 `approvedBuilds` 会执行构建脚本。

**16 项官方缺口（必须自造或 CLI/SSH 兜底）**，最要紧四项：
① **批准/拒绝待批审批** —— `approval.request` 是服务侧发起的水位线，**没有 approve/deny/settle**；
必须自造，且**仅限节点本地面板，不得远程**。
② **删除会话** —— `SessionController` 全类无 `delete`，`SessionStore` 也没有删除方法。
③ **导出会话** —— `exportSession`/`sessionExport`/`toMarkdown`/`exportTranscript` 全零命中。
④ **节点监听地址** —— 没有任何服务方法返回它，只能插件自报（已实现为 `health.address`）。

其余：token/成本统计、团队 roster/board/mailbox 远程写、技能注册/注销与正文远程读、
预设结构化工具面（唯一 `@Remote` 的 `readDocument` 返回 YAML 且标注 "for viewing only"，
要结构化得自己解析 YAML）、工作区 unary 列表、已归档会话集合独立读取，以及
`fs`/`shell`/`subprocess`/`ssh`/`web`/`timer`/`loader` 的远程化。

**审计全文**（11 张域表 + 140 处 `@Remote` 逐文件行号 + 逐字签名）：
`%USERPROFILE%\.dsh\_rc2_control_api_audit.md`。

---

## 2. 已完成（本轮之前）

| 项 | 状态 |
|---|---|
| 部署基线导入 + 顶层插件名规范化 | ✅ 19 host 插件 / 12 lib / 2 @local 包 / 11 动态件 / 3 preset |
| `lib/` 的 `.rN` 是承重名，**不可去后缀** | ✅ 已从部署逐字节恢复（15 文件，哈希校验一致） |
| 工具名统一 `forge_*` | ✅ 部署本就满足；补了漏网的 `forge_dev_stop_dyn_plugin` |
| `forge-team-creative` 重写 | ✅ preset + `skills/cordis-plugin-development/SKILL.md`（420→404 行） |
| `present` 行补齐 | ✅ 三个 preset |
| compat 基线重建 | ✅ 30 服务 / 47 方法，`dshBaseline: 0.2.0-rc.2`，新增 L0 自建服务断言 |
| `cordisinspect-shim` 摘除 | ✅ 上游已把 inspect providers 移到 profile 平面，撞名结构上不可能 |
| 官方 Web 搜索设置页挂载 | ✅ `ui-settings-web-search`（包本就在 app.asar 里，只是没挂过） |
| `web-search-kimi` → Schemastery Config | ✅ 端到端验证：`settings/describe()` 返回 `autoGenerate: true` |
| mailbridge 投递形态 + source 重写 | ✅ 官方 `resolveAgent` → `steer`/`followup` → `sessions.flush` |
| 自定义投递卡片 | ✅ `bundle/packages/dsh-mailbridge-card/`（自有 ChatNodeKind + keyed renderer） |
| `install.mjs` 两个真 bug | ✅ 不复制 `lib/`、不复制 `dynplugins/` |
| `hotmgr` / `injector` 硬编码 profile | ✅ 改从 `ctx.profileContext.dir` 解析 |

### 2.1 实机启动状态（`forge-test`）

```
dsh web: http://127.0.0.1:<port>/?token=...
dsh: warning: 1 entry did not activate
  subagent-codex: failed to import      ← D1 要替换掉的
```

其余全部加载成功。两个**仍未处理**的部署自身缺陷：

- **`console` 硬编码 3081** —— 与任何另一个 DSH 实例的 console 撞端口
  （`listen EADDRINUSE: address already in use 127.0.0.1:3081`）。退役它时把路由迁到
  `ctx.webServer.register` 并自带鉴权。
- **`console-web/` 在仓库里不存在** —— console 的静态站只存在于部署，全新安装本来就是空的。

### 2.2 两个纠正（2026-10-02 实机查证）

**`plugmgr` 根本没有上场。** goal ⑤ 写的「plugmgr→`sidebar.panellist`」前提不成立：
仓库与部署的 `cordis.patch.yml` 里**都没有 `plugmgr` 行**（`@local` 只有 `dynrestore`）。
`dsh-plugmgr` 的包被安装、符号链接都在，但**没有任何 patch 行挂载它**，
所以它的客户端半部不进 shell 的模块表，面板不出现。
→ 结论：它已被**官方插件页**取代。要么正式删掉这个包，要么把它当成"给插件管理一个左栏座位"
的新需求重做（官方插件页目前在 Settings 里，不在左栏）。

**自定义投递卡片确认上线。** 从运行中的 shell 抓 index 的 boot 数据，模块表里含
`@local/dsh-mailbridge-card` 与 `@local/dsh-dynrestore`（`@local/dsh-plugmgr` 不在，
与上一条一致）。即 `bundle/packages/dsh-mailbridge-card/` 的静态客户端包**已被浏览器侧注册**，
不只是文件躺在磁盘上。

**`subagent-codex` 的依赖要求。** 它是**独立发布的 npm 包**，不属于 `dsh-base` /
`dsh-web-app` 组合包；**profile 必须自己声明这个依赖**，否则该行在启动时 `failed to import`
（部署的 `profiles/web/package.json` 声明了 `"@deepseek-ai/dsh-subagent-codex": "^0.0.1-rc.1"`）。
已在 patch 行上写明，并注明**不要**在图省事时直接删掉该行 —— 那会让全新安装彻底失去 codex 子代理。

---

## 3. 在办 / 待办

### 3.1 在办调研

1. **subagent provider 契约（rc.2）** + `@deepseek-ai/dsh-subagent-codex` 的真实形态 +
   Codex API 的续会话机制 → 支撑 D1。
2. **完整控制 API 面**：11 个能力域的官方服务方法逐字签名 + `@Remote` 清单 + 安全排除项 → 支撑 D3/D4。

### 3.2 待办

| 项 | 说明 |
|---|---|
| codex 可续子代理 provider | D1。最小接口 = `name` + `capabilities` + `inheritsParentContext` + `start` + **`prepareContinuable`** |
| 按项目分组 fork | D2。注册表式，`priority < 0` shadow `sidebar.workspaces`，重建被连带丢掉的 5 个 child seat |
| 控制端点 | D3/D4。`ctx.webServer` 路由 + 自签 token + 完整 verb 表 + `typertGateway.invoke` 内部复用 |
| console 退役 | 路由迁 `ctx.webServer`，鉴权迁 `credentials`，去掉硬编码 3081 |
| kimi 配置页 | 宿主侧已生效，但官方 README 说 *"no shipped client does so yet"* —— 需要客户端贡献（`plugins.item` / `plugins.bundle.config` / `plugins.row.config`，用 `ctx.configForms.whileServed([NS], ...)`） |
| ~~`forge-team-distill` 重写~~ | ✅ **已关闭（2026-10-02）**：用户确认「只要能用就不用改了」——此前以为它的功能不可用。逐行审计也确实没找到 rc.2 结构性断裂（引用的 `forge_mailbridge_export` / `forge_memory_put` / `forge_team_status` 全存在，包名与官方 `standard` 逐字一致）；本轮只补了 `present` 行 |
| 文档清理 | README 行数口径、`router-standard` 残留、`dev_stop_dyn_plugin` 改名后的 5 处引用、`docs/*.zh.md` 里大量指向已退役插件的行 |

---

## 4. 验证设施备忘

```powershell
$env:DSH_PROFILE='forge-test'
node scripts/install.mjs                      # 装机
node scripts/check.mjs                        # 结构与语法门
node scripts/check.mjs --compat               # L0/L1/L2 断言

$env:DSH_CLI='%USERPROFILE%\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
& $env:DSH_CLI --profile forge-test --no-open --port 0     # serve 是默认命令，不要再给 `web`
```

**注意**：`dsh web` 里的 `web` 是 **profile 简写**（`dsh web` == `dsh --profile web`），
所以不能再传 `--profile`，否则报 `too many arguments`。

**桌面 profile 的运行时断言不可用**：打包的 `dsh` 拒绝操作 Electron 独占管理的 profile
（`error: profile "desktop" is managed exclusively by the Electron application`）。
所有运行时验证都要在 `forge-test` 这类独立 profile 上做。

**官方 RPC 探针**（supervisor 范式，用于验证宿主侧状态）：
1. 从 stdout 抓 `dsh web: http://<authority>/?token=<43字符>`
2. `GET` 该 URL 换 authority 绑定 cookie
3. `POST http://<authority>/api/<namespace>/<method>`，body
   `{"type":"client-request","rpcId":"1","method":"<ns>/<method>","payload":{"args":{}}}`

---

## 5. 交接状态（2026-10-02）

### 验收证据链（最近一次全绿）

| # | 命令 | 结果 |
|---|---|---|
| 1 | `node scripts/check.mjs` | 全部通过 |
| 2 | `node scripts/check.mjs --compat` | 基线 0.2.0-rc.2；L0 自建服务 5/5；运行时 `dump-config` 可取（48,833 字节） |
| 3 | `cd tests/codexsub && node driver.mjs` | `[selftest] 全部通过` |
| 4 | `dsh --profile forge-test --no-open --port 0` | **未激活条目 0** |
| 5 | 控制端点 19 个 verb 逐一调用 | ok 15 / 正确拒绝 4 / **挂起 0** |

### 剩余工作（按性价比）

> **接下来要做的（用户 2026-10-02 排期）**
>
> 0. **⚠️ 尚未做：merge 到部署。** 本次适配**只装进了 `forge-test`**；
>    `profiles/desktop` 与 WSL 的 `\\wsl$\Ubuntu-24.04\home\alex\.dsh` **都没被碰过**。
>    所以现在重启 DSH **不会有任何变化**。合并路径：① 另开会话把本仓库同步入仓
>    （本工作副本**未提交、未 push**）② 在目标机器上 `DSH_PROFILE=<目标 profile> node scripts/install.mjs`
>    ③ 再重启那台机器的 DSH。
>    **WSL 同步时的硬约束**：部署 `lib/` 里 `team-org.mjs` / `.r1` / `.r2` 是**三个同时被引用的不同模块**，
>    **绝不要**做"去 `.rN` 后缀"的规范化，否则会覆盖在用的模块（本轮已犯过并修复）。
> 1. **验 `codexsub` 能否 spawn codex**（等系统重启后）—— 它先解析 `@openai/codex` 包
>    （与官方一致），失败才回退 PATH `codex`；**PATH 回退在 Windows 上未验证**，
>    而用户主要在 Linux 用 CLI、Windows 上用 ChatGPT app 的 Codex。
>    首选装法：给目标 profile 声明依赖 `@openai/codex`。
> 2. **D2 按项目分组 fork**（用户已排期，**不紧急**）—— 已拍板「接受 fork 代价，但写成注册表 / 可扩展 union 式」。
>    约束见 §D2：必须 `priority < 0` shadow `sidebar.workspaces`；会**连带丢掉官方 5 个 child seat**
>    （行菜单 / 行 hover 按钮 / 行前导 / 行 hover 座位 / 目录选择流），要在自己的 key 下重建；
>    「项目」在 rc.2 只是 Workspace 的同义词，项目归属得由 forge 的 `projects.json` 索引提供。
> 3. 其余见下方编号项。

1. **kimi 客户端表单（延后，不是阻塞）** —— 宿主侧已**完成并验证**：`web-search-kimi` 已迁到
   声明式 Schemastery Config，官方设置面实测返回 `autoGenerate: true`、schema 含
   `role: secret` / `role: credential-ref` 与全部默认值、`value` 已填且 `apiKey` 被剥离、
   `secrets: {path:["apiKey"],set:false}`。**缺的只是 UI 入口**：官方 README 自述
   *"no shipped client does so yet"* —— rc.2 的 Plugins 页只在有客户端注册的地方渲染配置
   （`plugins.item` / `plugins.bundle.config` / `plugins.row.config`）。
   **本格的精确阻塞**：`ctx.configForms` 的 API（`get(ns)` 返回什么、`whileServed(nss, fn)` 签名）
   与官方卡片怎么写 secret 凭证通道，需要对着
   `_rc2_src/packages/client/ui-settings-web-search/src/client/*` 逐行读出来；
   派出去实现的那个子代理在深挖 5 轮后无产出，已中断。
   **接线待办**（包做完后）：`bundle/cordis.patch.yml` 加一行；`install.mjs` / `check.mjs`
   **不用改**（已改成扫描 `bundle/packages/*`，新包自动纳入）。
2. **D2 按项目分组** —— 你已拍板「接受 fork 代价，但写成注册表/可扩展 union 式」。
   约束见 §D2：必须 `priority < 0` shadow `sidebar.workspaces`，且**会连带丢掉官方 5 个 child seat**
   （行菜单 / 行 hover 按钮 / 行前导 / 行 hover 座位 / 目录选择流），要在自己的 key 下重建。
3. **D1 codex「束缚最少」增量** —— (a) 常驻进程 + 多线程复用、(c) `turn/steer`、(d) rollout 清理
   与同父会话并发串行化。**(b) `prepareContinuable` 已确认不该做**（会让 continuable 子会话绕过
   provider 的 `start()`，从而丢掉 Codex 后端）。
4. **D3 中心形态** —— 你未定；素材已齐（`_rc2_control_api_audit.md`）。
5. **⑦ 文档剩余** —— npm-bundle 那一节（README 已加"未在新基线验证"横幅）、
   `docs/ARCHITECTURE.md`（已加权威横幅，行号级重写未排期）、
   `docs/tools-reference.zh.md` / `tools-registry.md` / `tool-descriptions.zh.md`（仍描述已死工具）。

### 阻塞项（需要你定）

- **装不装 Codex**：不装则 `codexsub` 只能被 `tests/codexsub` harness 验证协议行为，
  **真派发一定在 spawn 阶段失败**（诊断安全、不崩）。两种装法：给 profile 加依赖
  `@openai/codex`，或全局 `npm i -g @openai/codex`。

### 环境事实（踩过的坑，别再踩）

- `dsh web` 里的 `web` 是 **profile 简写**，不能再叠 `--profile`。
- 打包的 `dsh` **拒绝操作 Electron 独占管理的 profile** → 所有运行时验证都必须在
  `forge-test` 这类独立 profile 上做。
- `lib/` 里的 `.rN` 是**承重名**（三个不同的 `team-org` 模块同时在用），**不可去后缀**。
- 本机 PowerShell 是 **5.1**：无 `??` 运算符；`ConvertFrom-Json` 读 UTF-8 无 BOM 文件会乱码（显示问题，非文件问题）。

---

## 6. 桌面部署实况（2026-10-02，按**确定性分级**）

### 6.8 一句话总结（先读这个）

> **宿主层装好了、在跑**（24 行全活，有活实例证据）。
> **UI 的问题已经定因并修好了**：`auto-plugins.json` 里的相对路径被当成相对 CWD
> （桌面版 CWD = profile 目录），四个动态件全部 ENOENT、一个都没挂上；
> `resolveDynPath()` 一改，活实例上当场挂上（§6.4）。
> **preset 仍装错机制**（目录形态 rc.2 已不再读，§6.3）。
> **静态插件改动必须重启才生效**（`hotmgr` 就地覆写、不换名、不破模块缓存，§6.5）。
> 重启后若动态件仍不出现，第一件事是看 `runner.inventory()` 是否为空。

### 6.1 已安装到什么

`DSH_PROFILE=desktop node scripts/install.mjs` 已跑过。

| 路径 | 内容 |
|---|---|
| `~/.dsh/profiles/desktop/plugins/` | 21 个顶层 `.mjs` + `lib/` 15 个 |
| `~/.dsh/profiles/desktop/packages/` | 3 个 `@local` 包 |
| `~/.dsh/profiles/desktop/cordis.patch.yml` | 已合并（**原文件备份在 `cordis.patch.yml.pre-forge`**） |
| `~/.dsh/dynplugins/` | 11 个动态件（+ 近 200 个 `.bak-`，见 §6.5） |
| `~/.dsh/auto-plugins.json` | 4 条 |
| `~/.dsh/.agent-presets/` | 3 个 preset 目录 —— **⚠️ rc.2 不读这里，见 §6.3** |

桌面 profile 的**原 5 行全部保留**（`agent-default-model` / `ui-settings-account` / `ui-chat` /
`ui-settings` / `subagent-model-selection-settings`）。合并后组合树里 forge 24 行 + 原 5 行都在，
`--dump-config` 的 exit=0、无 error、无 did-not-activate。

> **验证手法**：打包 `dsh` 拒绝操作 Electron 独占的 profile，所以我把 profile
> **复制一份改名**再跑 `--dump-config`（`./plugins/…` 相对路径随之解析），校验完删除副本。

**回滚一条命令**：
```powershell
Copy-Item "$HOME\.dsh\profiles\desktop\cordis.patch.yml.pre-forge" "$HOME\.dsh\profiles\desktop\cordis.patch.yml" -Force
```

### 6.2 宿主层 —— ✅ **确定**正常

**证据**：在**活着的桌面实例**上调用 `forge_dev_plugin_status`（forge 自己的工具），
loader 清单里有 forge 的 **24 行、全部 `disabled: false`**：

```
include:featsw           → file:///.../profiles/desktop/plugins/featsw.r1.mjs
include:mailbridge       → .../mailbridge.r1.mjs
include:control          → .../control.r1.mjs
include:mailbridge-card  → @local/dsh-mailbridge-card
include:dynrestore       → @local/dsh-dynrestore
include:plasmid          → disabled: true        ← 符合设计
```

同一实例的 `127.0.0.1:19387/forge-control/health` 也应答 `{"profile":"desktop",…}` ——
`control` 是 forge 的插件，这独立证明 host 层在跑（**桌面实例的 launch token 拿不到，
但 `control` 用自签 bearer token，所以这条路可用**）。

### 6.3 preset —— ❌ **确定**坏，根因已定位

**实测**：`POST /forge-control {op:"presets.list"}` 只返回官方 4 个
（`standard` / `ptc` / `minimal` / `cordis`），forge 三个不在名册里。

**根因**（官方原文，逐字，`_rc2_src/packages/preset/agent-preset/skills/editing-cordis-compositions/SKILL.md`）：

> *"**Before** declaration rows, a user preset **was** a directory `$DSH_HOME/.agent-presets/<id>/`
> holding `preset.yml` … and `agent.cordis.yml` … **Nothing reads that directory any more.**
> To migrate one, create a **bundle** whose **declaration** takes `id` from the directory name,
> `name`, `description`, `order` from `preset.yml`, and `plugins` from `agent.cordis.yml` verbatim;
> check each plugin name against `cordis-composition-reference` because **packages renamed since
> the preset was written fail at activation**. Install it, verify the row, then delete the legacy directory."*

**即 `install.mjs` 第 6 步装到了一个 rc.2 不读的目录。** 要改成 **declaration rows**：

```yaml
- insert:
    - id: preset-forge-team            # 名册行 id（官方是 preset-<id>）
      name: <bundle 模块>
      config:
        id: forge-team                 # ← 原目录名
        name: <preset.yml 的 name>
        description: <preset.yml 的 description>
        order: 1                       # ← preset.yml 的 order
        plugins: [ … ]                 # ← agent.cordis.yml 逐字
```

并做成 **bundle**（走 `plugin_manager install_bundle`），不是目录。

**必须一并做的复查**：文档点名「*packages renamed since the preset was written fail at activation*」——
preset 里引用的包名（`@deepseek-ai/dsh-tool-subagent`、`@deepseek-ai/dsh-tool-cordis`、
`@deepseek-ai/dsh-compaction-basic`、`@deepseek-ai/dsh-tool-ralph` 等）要**逐个对着 rc.2 核**。

**顺带**：`~/.dsh/.agent-presets/` 迁完后应删除（官方说 "then delete the legacy directory"）。

### 6.4 UI —— ✅ **已解决（2026-10-02 当天定因 + 修复 + 活体验证）**

用户重启后的截图：设置侧栏**没有「功能开关」**（`featui` 客户端半部）、
自定义 preset 区**没有 forge 三个**、侧栏底部**没有 forge 面板**。

- 「没有 forge preset」由 §6.3 解释 ✓
- 「没有功能开关 / 面板」= **动态插件一个都没挂上**，根因见下。

#### 根因：清单里的相对路径被当成了相对 CWD

`dynamic/auto-plugins.json` 把代码路径写成 **相对 `DSH_HOME`** 的
`"dynplugins/modpk.host.js"`（为了让清单换机可移植），
但 `dynboot.mjs` / `forgeboot2.mjs` 当时是
`await readFile(entry.hostFile, 'utf8')` —— **原样交给进程 CWD**。

**桌面版 host 进程的 CWD 不是 `DSH_HOME`，而是 profile 目录。**
探针在活实例里实测：

```
cwd = %USERPROFILE%\.dsh\profiles\desktop
dynplugins/modpk.host.js                             → ENOENT   ← dynboot 实际读的那条
%USERPROFILE%\.dsh\dynplugins\modpk.host.js → OK (6534 bytes)
cwdHasDynplugins = ENOENT
dynamicCordisRunner.inventory() = []                 ← 四个件一个都没挂
```

`forgeboot2` 的路由把错误原文也吐了出来（修复前）：

```
POST /dsh-forge/forgeboot
{"ok":true,"agent":"session-d7663e34-…","results":[
  {"idPrefix":"modpk","ok":false,"error":"ENOENT: … open
   'C:\\Users\\Administrator\\.dsh\\profiles\\desktop\\dynplugins\\modpk.host.js'"} …×4]}
```

路径正是 `profileDir/dynplugins/…` —— **决定性证据**。

> **WSL 之所以一直正常**：那边的 `auto-plugins.json` 钉死了
> `/home/alex/.dsh/dynplugins/…` **绝对路径**，`readFile` 原样能开。
> 本仓库为了可移植改成相对路径，却没同步教 `dynboot` 去拼 `DSH_HOME` ——
> 清单里那句 "dynboot resolves them" 在当时是**不成立的**。

**修复**（`lib/forge-common.mjs` 新增，`dynboot` 与 `forgeboot2` 同时改用）：

```js
export function resolveDynPath(path) {
  if (typeof path !== 'string' || path.length === 0) return path
  return isAbsolute(path) ? path : join(DSH_HOME, path)
}
```

绝对路径原样放行 → **旧 WSL 部署清单不需要任何改动**。

**回归门**：`scripts/check.mjs` 新增「动态插件代码路径」一节，逐条断言
`hostFile/clientFile` 在仓库里解析得到真文件（仓库放 `dynamic/dynplugins/`，
运行时放 `$DSH_HOME/dynplugins/`，由安装器第 3 步搬运）。

#### 活体验证（无需重启，链路每一环都有实证）

在运行中的桌面实例里注入一次性探针，用 `agents.currentInitiator()` 取真实 agent，
按修好的路径跑一遍 `define` + `runHostHalf`：

| idPrefix | 读到的字节 | define | runHostHalf |
|---|---|---|---|
| `modpk` | host 6534 / client 12765 | `modpk-1` / `pkg-1` | `ok: true`, `run-1` |
| `steer` | host 2052 / client 6888 | `steer-2` / `pkg-2` | `ok: true`, `run-2` |
| `forge` | host 84045 / client 197425 | `forge-3` / `pkg-3` | `ok: true`, `run-3` |
| `featui` | host 5873 / client 10426 | `featui-4` / `pkg-4` | `ok: true`, `run-4` |

`inventory()`：`[]` → `[modpk-1, steer-2, forge-3, featui-4]`。
**并且工具表当场多出了 `forge_dev_stop_dyn_plugin` 与整套 `skill_*`** ——
它们只定义在 `dynamic/dynplugins/forge-ui.host.js` 里，是宿主半部真正跑起来的独立证据。
随后客户端半部也送达浏览器并开始渲染（§6.10 那次渲染报错即来自浏览器侧，反证客户端半部到场）。

#### 排查手法备忘（省下几个来回）

- **注入的探针包必须改名才能重新加载**：`forge_dev_inject_plugin` 走 `loader.create` + ESM，
  同一个包名重复注入会命中模块缓存、拿到**上一版**模块 —— 表现为"改了文件但探针输出没变"。
  每轮换 `package.json` 的 `name`，并用新的入口文件。
- **`inject: [...]` 会让 `apply` 不跑**：依赖没就位时 fiber 停在 pending，`apply` 根本不执行，
  而注入器仍报 `ok: true`。探针改用 `ctx.get(name)` 读服务即可绕开。
- **客户端渲染错误会回传到会话**：形如
  `Cordis Client UI forge-3/pkg-3 (run-3) failed while rendering Slot "…"` 的系统消息
  就是浏览器侧的真报错（带 React 栈）—— 不必抓 index、不必开 DevTools。
- **桌面实例抓不了 index**（`GET /` 带 `control` 的 bearer token 得 **401**，要 launch token），
  但 **`POST /dsh-forge/forgeboot` 是通的** —— 这是对活实例操作动态件的正门。
- `pluginManager.listPlugins()` 条目的字段是 `entryId` / `moduleName` / `enabled` / `fiberPhase`，
  **不是 `id`**（上次按 `id` 提取，215 条零匹配，是误判）。
- **`runner.inventory()` 是判断动态件挂没挂的唯一权威**（loader 清单里看不到动态件，这是正常的）。

### 6.5 ⚠️ `hotmgr` 就地覆写 loader 指向的那个 `.rN.mjs`，**不换名** → 改了不生效

§6.2 暴露一件事：**loader 加载的不是 `plugins/X.mjs`，而是 `plugins/X.r1.mjs`**。

**2026-10-02 实测把机制钉死了**（这是本节最有价值的一条）：

1. `install.mjs` 覆写 `plugins/forgeboot2.mjs`（新内容 6129 B，旧内容 6081 B）；
2. 十几秒内 `hotmgr` 把**新内容写进了 loader 正指着的 `forgeboot2.r1.mjs`**
   （`.r1` 从 6081 → 6129），`.r2` / `.r3` 仍是旧内容，**没有产生 `.r4`**；
3. 但 `forge_dev_plugin_status` 里该行的 URL 依旧是
   `file:///…/forgeboot2.r1.mjs`，**没有加任何缓存破坏参数**；
4. 随后 `POST /dsh-forge/forgeboot` 返回的错误里，路径仍是
   `…\profiles\desktop\dynplugins\…`（旧代码的相对 CWD 行为），
   而不是修复后的 `…\.dsh\dynplugins\…`。

→ **结论：`hotmgr` 的"版本化换名"在"loader 已钉在某个 `.rN`"之后就退化成原地覆写，
模块 URL 不变、ESM 缓存不破，运行中的宿主继续跑旧代码。**

> ⚠️ **2026-10-02 晚些时候的复核：机制归属要放软。**
> 后来发现**安装器的 patch 合并步骤本身就会把 `./plugins/X.mjs` 改写成当时的
> `./plugins/X.rN.mjs`**（不只 hotmgr 在做这件事），而且 hotmgr 之后确实把某行升到了
> `.r2`。所以"就地覆写、绝不换名"这个**因果**我说得过硬了。
> **站得住的只有现象**：那次 `install.mjs` 覆写 `forgeboot2.mjs` 之后，
> 运行中的宿主仍在跑旧代码（由 `POST /dsh-forge/forgeboot` 回的旧路径反证），
> 而磁盘上 `.r1` 的时间戳与内容都是新的。
> **可操作的结论不变**：改静态宿主插件后**必须重启**才可信，别信"装完就热生效"。

> **2026-10-02 round 12：机制查实了（不只是"缓存不破"）。**
> 想用 injector 把新写的 `projapi` 活注入进桌面实例（省掉重启），注入报了 `ok: true`
> 但路由一直 404。做隔离探针（先确认 `apply` 跑没跑，再确认那条 `file://` 动态导入成不成）后拿到真错：
>
> ```
> SyntaxError: The requested module './lib/projects.mjs'
>              does not provide an export named 'projectsLoadError'
> ```
>
> `projapi` 依赖的 `projectsLoadError` 是**第 7 轮（BOM 修复）**才加进 `projects.mjs` 的。
> 磁盘上的文件是新的（实测有该导出），但**运行中的进程在启动时就把旧版 `projects.mjs`
> 缓存住了** —— 于是任何**新导入**的代码只要依赖新导出，就会在 **import 阶段**直接炸。
>
> 这条比"hotmgr 不破缓存"更具体：**进程握着的是模块实例，不是文件。**
> 推论有两条实用价值：
> ① 往运行中的实例注入任何依赖新版 lib 的代码都是徒劳 —— 别再试；
> ② 部署侧磁盘与运行中进程可能长期不一致，**排查时别只看文件**。

**后果**：

- 我后续每次 `install.mjs` 覆写的是 `X.mjs`，而真正被加载的是 `.rN` 副本 →
  **"改了但没生效"**，且从文件时间戳上完全看不出来（`.rN` 的时间戳是新的）。
- **任何静态宿主插件的改动都必须重启 DSH 才可信**；不要相信"装完就热生效"。
- `~/.dsh/dynplugins/` 累积了近 **200 个 `.bak-` 文件**（`backup()` 每跑一次留一整套，
  17 轮 × 11 文件）—— 安装器的卫生问题，值得改成"每文件只留最近一份"或加 `--no-backup`。

**建议**：动 UI 相关代码前先把 `hotmgr` 那行 `disabled` 掉，让 loader 直接指向 `X.mjs`
（这样安装即生效、路径也唯一），排查完再决定是否恢复。

### 6.6 本轮修的一个真 bug：profile 根 manifest 缺 `version`

**症状**：装 forge 到 desktop 后，**整条 `deepseek-official` 路由全部失败**，
表现为 `REQUEST_EXTENSION`（请求在 HTTP 之前就挂），kimi 路由不受影响。

**链路**：官方 `plugin-package-inventory-deepseek` 在每条 deepseek 请求前枚举活跃 Loader 条目 →
`plugins/*.mjs` 这类松散模块向上找**最近的** `package.json` 时命中
`~/.dsh/profiles/desktop/package.json` → 它有 `name` 但**没有 `version`** →
官方硬失败「must declare non-empty name and version」。

**修复（已落盘）**：`install.mjs` 末尾新增 `ensureProfileManifest()` —— 读 `profiles/<p>/package.json`，
`name` 或 `version` 缺失/为空就补齐（`name` → `dsh-profile-<p>`，`version` → `"0.0.0"`），
已具备则 no-op。**幂等**，实测通过。

**纠正一处判断**：WSL 的 `\\wsl$\...\profiles\web\package.json` **有** `version: "0.1.0"`，
**没有**这个隐患；真正缺 `version` 的是 **Windows 的 `%USERPROFILE%\.dsh\profiles\web\package.json`**
（已被新步骤覆盖）。

**这不是 forge 独有的问题**：profile 根 manifest 由启动器生成时就不带 `version`，
任何往这类 profile 放松散模块的插件都会中招 —— 可考虑上报上游。

### 6.7 与另一个会话的协作

`session-d7663e34-e6b9-4997-8e01-50daad039c77` 定位了 §6.6 的 REQUEST_EXTENSION 根因，
并补了 `desktop/package.json` 的 `version`。我已把修复与纠正回发
（`forge_mailbridge_send`，`delivered: live`）。

### 6.9 下一次动手的建议顺序

1. **重启 DSH** —— 让 §6.4 的路径修复和 §6.10 的客户端修复真正上场
   （§6.5：静态件不重启不生效）。重启后先看 forge 面板与设置里的「功能开关」在不在；
   不在就 `POST /dsh-forge/forgeboot` 看 `results`，或查 `runner.inventory()`。
2. **停 hotmgr 版本化**（把它那行禁掉）→ 之后每次安装都直接生效，省掉"改了没生效"的排查
3. **改 §6.3 的 preset 机制**（declaration rows + bundle + 包名复查），删掉 legacy 目录
4. 清掉 `~/.dsh/dynplugins/` 的近 200 个 `.bak-`，并给 `backup()` 加保留策略
5. 再谈 D2（按项目分组 fork）与 D3/D4 的后续

---

### 6.10 本轮修的两个 rc.2 客户端断裂

动态件挂上之后，`forge-ui` 的**客户端半部**立刻暴露出 0.1.x → 0.2.0-rc.2 的接口漂移。
这类错误会以系统消息回传，可直接看到：

#### (1) `subagentsByParent` 已被删除（`forge-3` 渲染即崩）

```
Cordis Client UI forge-3/pkg-3 (run-3) failed while rendering Slot
"conversation.session.header.actions" …
TypeError: Cannot read properties of undefined (reading 'session-eb61ae99-…')
```

**rc.2 的 session store 形状**（`packages/api/session-controller/src/client/sessions/service.ts`）：

```ts
export interface SessionListState {
  ids: SessionId[]
  byId: Record<SessionId, SessionSummary>          // ✅ 仍在
  phase: SessionListPhase
  projectionsBySession: Readonly<Record<SessionId, SessionProjectionSnapshot>>
}
```

`subagentsByParent` **在 rc.2 源码里只剩一处测试桩**，真身已经搬到
**会话投影**：`projectionsBySession[parentId].values.subagentCatalog`
（**扁平数组**，元素 `{ id, createdAt, mode, label }`），读取态是同层的 `.state`。
原代码 `catalogs[sessionId]` 直接对 `undefined` 取键 → 整个 header 条目退位。

**修复**：`forge-ui.client.js` 里加两个适配函数
（`catalogEntriesOf` / `catalogsOf`），把 rc.2 的投影读回渲染层当初写定的
`{ state, entries: [{ kind:'child', … }] }`，三处取 `catalogs` 的地方统一改用它。
**改完重新挂载后不再有渲染报错。**

> 这是**第一处确认的 rc.2 客户端断裂**，`forge-ui.client.js`（≈200 KB，2600 行）里
> 很可能还有同类：凡是读 0.1.x 客户端 store 字段、或调 `sessions.*` 已删方法的地方。
> 已知同类残留：`sessions.refreshSubagents` / `setSubagentCatalogOpen` / `openSubagent`
> 在 rc.2 命中数为 0，目前**全靠 `typeof === 'function'` 守卫兜住**（不崩，但静默失效）。
> 建议下次专门过一遍这个文件里的 `sessions.` / `useXxx((s) => s.…)` 全部调用点。

#### (2) 探针包重注入命中 ESM 缓存（排查工具本身的坑）

见 §6.4「排查手法备忘」第一条 —— 同名包重注入会拿到旧模块，必须换名。

---

### 6.11 UI 大改：已拍板的方向与第一版落地（2026-10-02）

#### 用户拍板（逐条，都是原话口径）

| 岔口 | 决定 |
|---|---|
| 砍哪些 | 功能壳 / 能力 / 市场 / 质粒 / 技能管理 / 已归档 / 会话头子代理目录按钮 —— **直接删代码** |
| 功能开关 | **要，但不在这边**：按**官方插件配置面**来写 |
| 形态 | 先别定死，**照官方「自动化任务」那个侧栏入口的形态**做一个 forge 侧栏 |
| 目标 | 侧栏太挤/和官方重复 · 按项目分组(D2) · 集群控制台(D4) · 管理入口收拢 · 尽量交回官方扩展点 |
| 实现层 | **一并改成静态持久插件包** |
| 节奏 | 先搭 forge 页壳 + 砍东西，静态化随后 |
| tab 命名 | 项目 → `forge-project`（这类命名不容易打架）；管理 → 叫 `forge`；**项目点开的视角就是集群控制台功能的落点** |

#### 「自动化任务」是怎么做的（这是我们要照抄的形态）

活体 Slot 查询证实，它只是两个配对注册：

```
sidebar.panellist   list  root  "Global panel icons. 每个 list id 对应同名的 main 面板"
  mf/plugins    order 0     ← 官方
  mf/schedules  order 10    ← 官方，就是「自动化任务」
main                keyed root  "Central panel selected by sidebar entry id"
  mf/plugins / mf/conversation / mf/schedules
```

`sidebar.panellist` 注册只要 `{ id, order, label }`；**侧栏自己拥有按钮**并从注册元数据解析
label（`label` 可以是 thunk，每次投影重读，所以本地化不用重注册）；
单元格组件只拿到 `{ size, active }` 两个 owner prop 画图标。
`main` 用**同一个 id 当 `key`** 就能对上。

> **坑**：复用官方 id（`plugins` / `schedules`）会"进入那一格并替换它"。
> forge 必须用全新 id —— 选了 `forge`。

`main` 的 `standardProps` 自带 `useSessions` / `useWorkspaces` / `useResource` /
`usePanelInfo` / `useSessionStatus` —— 会话与工作区数据不用自己接。

#### 第一版已落地：`bundle/packages/dsh-forge-ui/`

静态客户端包（`package.json` + `lib/index.js` 空宿主 + `lib/client.js`）：

```js
window.__ModuleLoader__.load({ id: '@local/dsh-forge-ui', factory: (require) => {
  const React = require('react')          // ← 静态包才有 require
  return {
    inject: ['slots', 'locale'],
    apply(ctx) {
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
        { name: 'sidebar.panellist', id: 'forge', order: 20, locale: NS, label: () => t('panel') }, ForgeIcon))
      ctx.slots.inject('main', () => ctx.slots.register(
        { name: 'main', key: 'forge', locale: NS, inject: () => ({ t }) }, ForgePage))
    },
  }
}})
```

**为什么必须是静态包**：动态 client 半部的沙箱只给 React/console/styles/host，
**没有 `require`** —— 拿不到官方 ui-primitives 图标，也拿不到 `ctx.remote`（调不了官方 `@Remote`）。
静态包两样都有，而且**宿主半部可以是空的**（`dsh-plugmgr` 就是空宿主 + `appCtx.remote.*` 直连官方）。

> **静态化的真正收益（推翻我上一轮的估算）**：不是"把 104 KB 宿主搬过去"，
> 而是**把 88 KB 的 `forge-ui.host.js` 整个删掉** —— 它绝大部分只是"把官方服务转发给客户端"，
> 客户端直连官方 remote 就不需要这一层了。这正对上"尽量少自造"。

**落地证据（没有再重启）**：装完包 + 加一行 patch（`- id: forge-ui / name: '@local/dsh-forge-ui'`）后，
活体查询 `sidebar.panellist` 立刻变成 `mf/plugins(0) · mf/schedules(10) · mf/forge(20)`，
`active: true` —— 客户端模块扫描（hotmgr 的 "rescans changed client bundles"）直接捡起了新包。

**v1 边界（诚实标注）**：只有「项目」tab 接了真数据 ——
`useWorkspaces` 给权威项目列表（`WorkspaceView { workspaceId, path, title, sessionIds[] }`），
`useSessions` 给 `byId` 行；项目详情列出该项目的会话（运行中用绿点）。
「集群」「Forge」两个 tab 是骨架，页面里写明了下一步接哪个官方面。

> `SessionSummary` **没有 `workspaceId`** —— 项目→会话的归属只能走
> `WorkspaceView.sessionIds`，别去 summary 上找。

#### 下一个卡点：`plugins.row.config` 要求 forge 是官方 bundle

`plugins.row.config` 的定义是 **"a bundle declares 的一行的配置"**，
key 格式 `<package name>#<row id>`，而且活体查询显示它的 `keyDomain` 是
**"none are taken yet"（一个都没被占）**。

但 featsw 现在是 profile 里的一条**松散插件行**，不归任何 bundle。
所以"功能开关落到 featsw 那一行的 config"这一步，**前提是先把 forge 打包成官方 bundle**
（走 `plugin_manager install_bundle`）—— 这跟 §6.3 的 preset 迁移是同一条路：
**declaration rows + bundle**。两件事应该合并成一次动作做。

---

### 6.12 「项目」到底是什么 —— 用户澄清 + rc.2 权限模型的硬约束

#### 用户的澄清（原话）

> 项目包含了**多个目录里面的多个会话**，这些会话之间联系紧密，作为一个项目，
> 这样就不需要每次都批准工作区外或者完整权限了。

所以「项目」不是 workspace 分组，而是一个**授权边界**：
一个项目 = N 个目录 + M 个会话 + **一份共享的批准范围**。
我 §6.11 的 v1 把它做成"workspace → 会话列表"，**理解错了**。

#### rc.2 的权限模型（逐字读出来的，不是猜的）

三个**整值旋钮事件**，折叠进一个 `permissions` 会话投影
（`packages/interaction/permission-presets/src/types.ts`）：

```
permission/preset · sandbox/mode · approval/policy
effective = 投影状态 ?? 部署默认        （重放即可跨重启保留）
```

**`sandbox/mode` 的唯一写路径**（`packages/sandbox/sandbox-policy/src/session-mode.ts`）：

```ts
setSandboxMode(session, mode)   // = session.append('sandbox/mode', { mode })
// 只有三个值：'read-only' | 'workspace-write' | 'danger-full-access'
```

**策略解析**（`sandbox-policy/src/index.ts`，`ctx.sandboxPolicy.resolve()`）：

```ts
mode:          request.mode（已批准的升级）?? 会话最后一次 sandbox/mode ?? 部署默认
workspaceRoot: session.header.cwd ?? 配置的 fallback
```

**「权限预设」就是一个 `{sandbox, approval}` 对**
（`permission-presets/src/index.ts`，Config 里 `presets: Record<string, PresetSpec>`）：

```ts
interface PresetSpec { sandbox: SandboxMode; approval: 'ask' | 'never'; name?; description? }
// 内置的那个默认预设： { sandbox: 'danger-full-access', approval: 'ask' }
```

#### ⚠️ 硬约束：「多个目录」在 rc.2 **没有对应表达**

- `workspaceRoot` **就是 `session.header.cwd` 这一个目录**，而且是**不可变的**
  （`session.header.cwd` / "its immutable cwd becomes the workspace boundary"）。
- `workspace-write` 只覆盖**这一个**根，**没有任何多根白名单 / allowed-paths 列表**。
- 想写第二个目录，只有两条路：
  1. 该会话改用 `danger-full-access`（等于完全不设限）；
  2. **升级批准**（`SandboxPolicyRequest.mode` 是"an explicit approved mode override,
     which outranks session policy"）—— 也就是现在每次都要点的那个批准。

另外：`sandboxPolicy` 的 4 个方法**全都没有 `@Remote`**，`setSandboxMode` 也只是普通导出函数
（不是服务方法）—— 这是**刻意护栏**（§4「30 条硬红线」第 3 条），
所以"项目授权"这件事**必须在宿主侧做**，不能从浏览器面推。

#### 于是有三种可选的落法

| 方案 | 做法 | 代价 |
|---|---|---|
| **A. 项目 = 一个官方权限预设** | 在 `permission-presets` 的 `presets` 里为每个项目声明一条 `{sandbox, approval}`；会话进项目时 append 三个旋钮事件 | 用官方扩展点，零自造。但 `workspace-write` 仍然只覆盖一个 cwd；要"多目录 + 不再问"就得选 `danger-full-access` + `approval: 'never'`，即**整个项目对所有文件不设限** |
| **B. 项目 cwd = 多个目录的最近公共祖先** | 把项目内会话的 cwd 定成所有目录的公共父目录，于是 `workspace-write` 天然覆盖全部 | 保留沙箱，多目录可写。**只在目录同属一棵树时成立**；cwd 变宽后，那个祖先下的**其它**目录也一并可写 |
| **C. forge 自造多根白名单** | 绕开 `sandboxPolicy` 自己包一层 | 踩审计红线，且 enforcing 的 fs/bash/terminal 后端各自读 `sandboxPolicy`，绕过等于三条后端全要重做。**不建议** |

> ⚠️ **这一整节（6.12 的权限部分）已被用户当场否掉，保留它只为记录我走错的那一步。**
> 见下面的「用户第二次澄清」。

---

#### 用户第二次澄清（2026-10-02 稍后）：项目根本不做授权

> **不需要做授权**，因为这个多目录下的不同会话之间**直接传递消息**，
> 就可以天然在多个目录下协作。比如我把你和一个专门 push GitHub 的目录的会话拉进一个，
> 这样你改完以后由他审查和合并代码并提交，这样不同目录下能作为同一个项目推进。

所以「项目」是 **通信域**，不是授权边界。A/B/C 三个方案全部作废。

#### 项目真身：forge 早就自建好了，只是没有 UI

`~/.dsh/projects.json` 是权威真值（`bundle/plugins/lib/projects.mjs`，
`docs/roadmap.md` 里也写着「项目 = 信任域 + 通信域 + 策略域 + 归档域，**可含多个目录**」）。
`normalizeProject()` 逐字给出的记录形状：

```js
{
  id, name,
  cwds: string[],                     // ← 多个目录（复数），这就是"多目录"的落点
  memory: 'project-memory/<id>/README.md',
  wake:      { windowMs, perTarget, projectTotal },   // 唤醒预算闸
  crossTeam: { windowMs, perTarget, projectTotal },   // 跨队预算闸
  distillSessionId?,                  // 蒸馏岗会话
  teams: [{
    teamId, name, projectId,
    members: [{ sessionId, memberId, role, preset? }],   // ← 跨目录的会话在这
    tasks:   [{ id, title, status, assignee, description, output }],
    stale:   [{ sessionId, note }],
  }],
  archivedTeams: [...],
}
```

还有两条关键事实：

- **`implicitProject(cwd)`**：没登记的 cwd 也会隐式成一个项目（`id: 'cwd:<path>'`，无队）。
  所以 UI 必须能把"隐式项目"和"已登记项目"分开呈现。
- **同项目成员可以互唤**：`skillmanager.mjs` 里逐字写着
  「同项目成员可互唤（`~/.dsh/projects.json` 预算闸）；跨项目 wake 仍仅主会话」。
  —— 这正是用户说的"不同目录下作为同一个项目推进"的**已实现机制**。

**这台 Windows 机器上 `~/.dsh/projects.json` 还不存在**（`Test-Path` 为假），
所以 `forge_memory_list` 之前回的是「projects.json 里没有项目」——
索引在代码里齐全，只是这台机器还没登记过任何项目。

#### 项目 tab 的正确设计（替代 §6.11 的 v1）

> **用户追加拍板（2026-10-02）：多 team 不用了。**
> 一个项目 = **一组目录 + 一组成员 + 一块看板**，中间那层 `teams[]` 在 UI 上抹平。
> 数据面继续认 `teams[]`（旧 `projects.json` 里可能有多条，`normalizeProject` 也还在读），
> 但 forge 的写面与 UI 一律按"**一个项目只维护一个队**"来做：
> - 读：把 `teams[]` 拍平成一个成员集合与一块看板；`archivedTeams` 只在"归档后未重建"时出现。
> - 写：`teamId` 从 `projectId` 派生（沿用 `normalizeProject` 迁移分支里的 `team-<id>-…` 命名），
>   UI 永远不问"哪个队"。

```
项目 tab
  ├ 已登记项目（读 ~/.dsh/projects.json）
  │   每个项目一行：name · cwds 数 · 成员数 · 看板彩灯（有未完成任务=绿，否则灰）
  │   点进去：
  │     ├ 目录       cwds[]（多个）
  │     ├ 成员       跨目录的会话，带 role / preset，可点开发消息（mailbridge）
  │     ├ 看板       tasks[] 的 id/title/status/assignee/output
  │     ├ 记忆       project-memory/<id>/ 的文件
  │     └ 预算       wake / crossTeam 闸
  └ 隐式项目（implicitProject：有会话但没登记的 cwd）
      提供"登记为项目"的动作 —— 这就是用户说的"把两个会话拉进一个"
```

**动作面**（都是 forge 已有的能力，UI 只是把它们露出来）：
登记/改名项目、改 `cwds`、把会话拉进项目 / 移出、建队（`forge_team_create`）、
给成员发消息（`forge_mailbridge_send`）、看板推进（`forge_team_task`）。

---

### 6.13 目标存档 + 下一步：把 team 与 project 合并

#### 存档：旧 goal（`goal-7c97d4b4-e276-46eb-8110-c439950dfcae`）

**目标**：大改 forge 的 UI（新静态包 + 砍旧动态件 + 功能开关迁官方配置面）。

| | 状态 |
|---|---|
| 新建静态客户端包 `@local/dsh-forge-ui`（`sidebar.panellist` 的 `forge` 入口 + `main` 的 `forge` 页） | ✅ 已上线并活体验证 |
| 砍掉旧 `forge-ui` 动态件的全部面板与客户端半部，只留 7 个模型可见工具 | ✅ `forge-tools.host.js`，0 个 `harness.handle` |
| 安装器 `auto-plugins.json` 合并改为 `_managed` 记账（就地更新 + 淘汰） | ✅ 并清掉了残留的 `forge` 行 |
| 门禁 | ✅ `check` / `check --compat` 全绿 |
| 项目 tab 按 `~/.dsh/projects.json` 重做 | ⬜ 未做（下面这条合并要先落） |
| 集群 tab / Forge tab | ⬜ 骨架 |
| forge 打包成官方 bundle（preset 迁 declaration rows + 功能开关落 `plugins.row.config`） | ⬜ 未做 |
| 清理 `~/.dsh/dynplugins` 的近 200 个 `.bak-`；复核 §6.5 | ⬜ 未做 |

**本 goal 暂停（paused/disarmed），工作内容全部在本文件 §6.4–§6.12 里，可随时续。**

#### 新决定（用户 2026-10-02）：「project 就是 team，team 就是 project」

> 把 team 和 project 直接合并，project 就是 team，team 就是 project。

**为什么这件事比看起来便宜**：全部组织面消费者都只经过 `lib/projects.mjs` 一个枢纽，
而它**已经**带着拍平助手（`sameProject` / `sameTeam` / `teamOfSession` /
`allTeamMembers(project)` / `findTeam` / `lampOfTeam`）。

依赖图（仓库内实测，`.rN` 是不可归一的独立模块）：

| 消费者 | 依赖 |
|---|---|
| `console.mjs` | `agent-teams-file.r1.mjs` · `team-org.r2.mjs` |
| `teamhub.mjs`（1060 行，`forge_team_*` 全家族） | `teams-file.mjs` · `projects.mjs` |
| `projmem.mjs` | `projects.mjs` · `agent-teams-file.mjs` |
| `compdist.mjs` | `projects.mjs` · `team-org.r2.mjs` |
| `console-gates.mjs` | `projects.mjs` · `team-org.mjs` |
| `mailbridge.mjs` | `projects.mjs` · `team-org.r2.mjs` |
| `memory-cli.mjs` | `projects.mjs` · `agent-teams-file.mjs` |
| `meminject.mjs` | `projects.mjs` |
| `teams-file.mjs` | `projects.mjs` · `team-org.mjs` |
| `agent-teams-file.mjs` / `.r1` | `projects.mjs` · `team-org.r2.mjs` |

**合并方案（保持"队视图"作为派生形状，消费者零改动）**：

1. `projects.json` 拍平：项目自带 `members[] / tasks[] / stale[]`，**删掉 `teams[]` 这一层**。
2. `projects.mjs` 里保留 `teamOfSession()` / `findTeam()` / `lampOfTeam()` 等**返回队形状对象**
   （`{ teamId, name, projectId, members, tasks, stale }`），但令 **`teamId === projectId`**。
   → 上面所有消费者不用改。
3. **读兼容**：`normalizeProject()` 继续认旧 `teams[]`；多条队就**并集**成一条
   （成员并集、任务并集、`archivedTeams` 保留在只读侧）——这就是"多 team 抹平"。
4. **写收敛**：`saveProjects()` 一律写平形状；`defaults()` 的 `version` 升到 3。
   文件在第一次写的时候自然迁移，不写专门的迁移脚本。
5. 写面（`team-org.mjs` / `.r1` / `.r2`、`teams-file.mjs`）里所有 `cfg.projects[].teams[]`
   的增删改，改成直接落在项目上；`teamId` 参数接受 projectId（新）或旧 teamId（读兼容）。
6. `teams-file.mjs` 的 `openTeamsFile()` 是 `teamhub.mjs` 的入口，跟着一起收敛。

**收益**：`forge_team_*` 与项目变成同一件事，UI 只需要一个「项目」概念，
`~/.dsh/projects.json` 也只有一层。

---

### 6.14 定案：存储层不存在 team（破坏性变更）

用户 2026-10-02 口径（原话）：

> 直接整理代码，所有 team 一律换成 project（**工具里面肯定还是显式 team 和团队的**），
> 只是说**数据存储里面不要进行区分了**。到时候作为**破坏性变更**发布。
> 以及提供文档指引到底怎么迁移老 project-team 到现在纯 project。
> 也就是**不存在 team 这个概念了**。

三条边界，别越：

1. **存储层**：`project.teams[]` 这一层消失，项目自带 `members/tasks/stale/archived`。
   `projects.json` 的 `version` → **3**。
2. **工具层**：`forge_team_*` 的**名字与描述一字不改**，仍然说 team / 团队 ——
   变的是它底下操作的是项目（`teamId === projectId`）。
3. **迁移**：不写迁移脚本；`saveProjects()` 只写 normalize 之后的 v3，
   所以**第一次写就完成迁移**。给人看的指引在
   [`docs/MIGRATION-projects-v3.md`](MIGRATION-projects-v3.md)。

#### 本轮已落：`lib/projects.mjs` 重写（枢纽）

- `PROJECTS_VERSION = 3`；`defaults()` / `seedFromCwds()` / `implicitProject()` 都不再有 `teams`。
- `normalizeProject()` 拍平 v2：多队 members/tasks/stale **按 id 去重并集**，
  `archivedTeams[]` → `project.archived[]`（归档快照带 `at`）。
  **"项目自己有就用项目自己的"** —— 手工迁到一半的文件里，项目上的那份赢。
- 新增 `teamView(project)`：对外仍给「队形状」`{ teamId, name, projectId, members, tasks, stale, archived }`，
  且 **`teamId === projectId`** → 10 个消费者不必同时改。
- `findTeam()` **删掉了旧 teamId 兜底**。原来那段注释声称读兼容，但 `normalize` 早已把
  `teams[]` 丢掉，兜底永远搜不到 —— 注释在说谎。按破坏性变更的口径删掉，而不是塞一个 team 味的迁移字段。
- 自测（node 直接跑，已过）：v2 两支队 → `members=s1,s2` / `tasks=t1,t2`（按 id 去重）/
  `stale=s9` / `archived=1` / **输出里没有 `teams` 字段** / `teamView.teamId === projectId` 为真 /
  `version=3`；v3 直接读原样通过。

#### 写面收敛：已完成（2026-10-02）

`.teams` 写入点原为 **9 个文件约 41 处**，现在全部落项目：

| 文件 | 改法 |
|---|---|
| `team-org.mjs` / `.r1` / `.r2` | `hit.team.X` → `hit.project.X`；`createTeam` 拒绝在已有团队的项目上再建；`archiveTeam` 重写为**内层归档**（压 `project.archived[]` 快照 + 清空 members/tasks/stale）；`restoreTeam` 恢复最近一轮 |
| `agent-teams-file.mjs` / `.r1` | 新增 `teamCardsOf(p, extra)`（0 或 1 张卡）；`archivedTeams` 改为从 `p.archived` 出轮次；`teamView` 改名 `projectTeamView` 导入（**本模块自己就导出 `teamView`**，直接导入会 `Identifier 'teamView' has already been declared`） |
| `teams-file.mjs` | `loadAll` 从项目出 team/archive 表（archive 键 `projectId#轮次`）；`putRecord('team')` 直接写 `project.members`/`name`/`tasks`；`deleteRecord('team')` → `archiveTeam(hit.project.id)` |
| `mailbridge.mjs` | `explicitProjectRecord()` 不再遍历 `project.teams`，直接读 `members`/`stale`/`ownedSessions` |
| `console.mjs` / `featsw.mjs` / `featui.*` | **不动** —— 命中的是 `teamhub.teams` 这个 feature id 与「团队工具」这种**工具措辞**（用户口径：工具里仍显式说 team） |

**故意保留的 `.teams`**：`projects.mjs` 里的 v2 读兼容路径（`normalizeProject` 读旧 `teams[]` /
`archivedTeams[]`，`allTeamMembers` 的旧形状兜底）；以及 `agent-teams-file` 输出的
`teams:` / `archivedTeams:` 两个**卡片字段名** —— 它们是给 teamhub（工具层）看的，跟着工具措辞走。

#### 三个改的时候挖出来的坑（都会静默出错）

1. **`teamView()` 的 `members` / `tasks` 是和项目同一份数组引用。**
   于是 `hit.team.members.push(...)` 会**侥幸生效**，而
   `hit.team.members = ...filter(...)` 这种**重新赋值静默失效**（只改到派生视图）。
   半边能用的最危险 —— 所以全部改成显式落 `hit.project`，不依赖别名。
2. **`boardPath()` 必须继续走 `slugTeam()`。** 旧看板落在
   `boards/<projectId 去掉 p- 前缀>.jsonl`；`teamId` 现在等于 `projectId`，
   直接拿 id 当文件名会让**历史看板整片读不到**。
3. **`agent-teams-file.mjs` 自己导出 `teamView`**，与 `projects.mjs` 新增的同名视图撞名。
   必须 `teamView as projectTeamView` 导入。

#### 离线 harness：`tests/projects-v3/driver.mjs`（46 项，全过）

用**临时 `DSH_HOME`**（`mkdtempSync` + 在动态 import 之前设 `process.env.DSH_HOME`，
因为 `forge-common.mjs` 在模块加载期就定了常量），所以**绝不碰真实的 `~/.dsh/projects.json`**。
覆盖：多队拍平并集 / 项目自有字段优先 / normalize 幂等 / v3 直通 /
`teamView` 契约（`teamId === projectId`）/ 旧 teamId **必须**找不到 /
落盘无 `teams`、无 `archivedTeams` / `createTeam` 拒绝已有团队的项目 /
`archiveTeam` 轮次与快照 / `restoreTeam` 往返 / `writeTask` 落项目。

```
node tests/projects-v3/driver.mjs   →   [projects-v3] 全部通过（46 项）
```

#### 还欠的（下一轮）：活实例回归清单

`dynplugins` 之外的都是**静态宿主插件**，改了不重启不生效（§6.5）。
这台机器上 `~/.dsh/projects.json` **还不存在**，所以先给它一条记录再验
（用**新建 forge 项目页**建，或临时手写一条 —— 注意 Windows 路径要双反斜杠）：

```json
{ "version": 3, "projects": [{
  "id": "p-regress", "name": "回归测试",
  "cwds": ["C:\\Users\\Administrator\\.dsh\\dsh-forge"],
  "memory": "project-memory/p-regress/README.md",
  "wake": { "windowMs": 60000, "perTarget": 3, "projectTotal": 8 },
  "crossTeam": { "windowMs": 60000, "perTarget": 3, "projectTotal": 8 },
  "members": [], "tasks": [], "stale": [], "archived": []
}]}
```

重启后照单执行（每条都写清**期望**，不写"看起来正常"）：

| # | 调用 | 期望 |
|---|---|---|
| 1 | `forge_team_status` | `inTeam: false`（还没有队），不抛错 |
| 2 | `forge_team_create({ name:'regress', members:[] })` | ok；且 `projects.json` 里 `p-regress` 多出 `captain` = 本会话 id，**没有** `teams` 键 |
| 3 | `forge_team_status` | `inTeam: true`，`teamId` **等于** `p-regress` |
| 4 | `forge_team_create` 再来一次 | **失败**：`you already lead team "regress"` —— 这正是零成员队那个洞的闸 |
| 5 | `forge_team_delete` | 内层归档：`archived.length === 1`，`members` / `tasks` 清空 |
| 6 | `forge_memory_list` | 返回 `p-regress`（projmem 不回归） |
| 7 | `forge_mailbridge_list` | 正常返回（mailbridge 的 `explicitProjectRecord` 不回归） |
| 8 | 落盘检查 | `version === 3`，任何项目都**没有** `teams` / `archivedTeams` 键 |

> 第 4 条是这轮新补的闸，**最容易漏**：拍平之后零成员的队一度在 `loadAll` 里不出现，
> `getTeam(captain)` 找不到它，于是可以反复建空队。修法是给项目加 `captain` / `goal`，
> 并把"有 captain 就算开过队"作为可见性条件。离线 harness 第 8 节锁住了这条。

#### 阻塞：活实例回归需要重启（第 3 个连续轮次卡在同一条件）

**2026-10-02 round 5 实测确认**：服务 `127.0.0.1:19387` 的 host 进程 **pid 64060 启动于 01:55:23**，
比我全部改动（最后一次装机 02:47:21）都早 —— **没有重启过**，活宿主跑的是旧 `lib/`。
我无法自行重启（那是承载本会话的桌面应用本体）。

**在重启之前能做到的最后一项验证**（round 5 已做）：

```
全新 Node 进程 import 部署侧 lib/ 的 13 个文件   →   全部 ok
  projects.mjs · team-org.{mjs,r1,r2} · agent-teams-file.{mjs,r1}
  teams-file.mjs · forge-common.mjs · console-gates.mjs · compdist.mjs
  meminject.mjs · memory-cli.mjs
```

`memory-cli.mjs` 会打印 `{"ok":false,"error":"unknown op "}` —— 它是 CLI，import 即执行，正常。

> ⚠️ **别把这个 smoke 的插件层结果当成失败**。同一测试里
> `teamhub.r1.mjs` / `mailbridge.r1.mjs` / `projmem.r1.mjs` / `featsw.r1.mjs` 报了
> `Cannot find package '@deepseek-ai/dsh-tools'` —— 查过 `~/.dsh/profiles/node_modules`
> 与 `profiles/desktop/node_modules`，**那里根本不存在这个包**。
> 也就是说 profile 里的裸 import 是**靠 loader 自己的解析拦截**（指向 app.asar 检出）完成的，
> **裸 node 复现不了**。所以这 4 个 FAIL 不说明任何问题，别据此改代码。

**恢复条件**：用户在桌面端重启一次 DSH，然后照上面那张 8 条清单执行即可。

#### 活实例回归结果（2026-10-02，用户重启后实测）

**重启确认**：服务 `127.0.0.1:19387` 的 host 变成 **pid 11792，启动 02:49:36**，
晚于我最后一次装机（02:47:21）→ 新代码确实上场了。

| # | 调用 | 结果 |
|---|---|---|
| 1 | `forge_team_status` | ✅ `inTeam: false`，不抛错 |
| 2 | `forge_team_create({name:'regress'})` | ✅ ok；落盘 `version: 3`、**无 `teams` 键**、**无 `archivedTeams`**、`captain` = 本会话、`name`/`goal` 落到项目上、`members: 0` |
| 3 | `forge_team_status` | ✅ `inTeam: true`，**`teamId: "p-regress"`**（不是那个随机 id）→ `teamId === projectId` 与**零成员队可见性**双双成立 |
| 4 | 再 `forge_team_create` | ✅ 被挡：`you already lead team "regress"` |
| 5 | `forge_team_admin({op:'delete'})` | ⚠️ 首轮**发现真 bug**（归档不清 `captain`/`goal`）→ 已修 → **第二次重启后复验 ✅**（快照留 captain/goal、项目上清掉、**能开第二轮**） |
| 6 | `forge_memory_list({projectId:'p-regress'})` | ✅ `{ok:true, name:'regress'}`（projmem 不回归） |
| 7 | `forge_mailbridge_list` | ✅ `{ok:true, count:19}`（mailbridge 不回归） |
| 8 | 落盘检查 | ✅ `version === 3`，无 `teams` / `archivedTeams` |

> 第 5 条实际暴露的名字是 **`forge_team_admin`**（`op: 'delete'`，`cleanup: 'archive'`），
> 不是清单里写的 `forge_team_delete` —— 模型可见的工具名与 teamhub 内部的 `OPS` 键不同名。
> 归档返回 `{ok:true, archived:"p-regress", note:"team archived; members archived"}`。

#### 活实例抓出的两个 bug（离线 harness 抓不到：它测形状，不测流程）

**① 归档不清 `captain` / `goal` → 「归档当前队员、开新一轮」永远走不通。**

归档后落盘：`archived.length === 1`、快照带 `at`/`name`、`members`/`tasks`/`stale` 都清了 ✓
—— **但 `captain` 还在**。再调 `forge_team_create`：

```
{"ok":false,"error":"you already lead team \"regress\"; use forge_team_delete first"}
```

根因是我在 round 4 自己引入的耦合：为了让**零成员的队**可见，把
`typeof p.captain === 'string'` 当成了"这一轮开过队"的标记；
而 `archiveTeam()` 只清了 `members`/`tasks`/`stale`，**没清 `captain`/`goal`** →
归档后项目看起来仍然"有队"，闸永远关着。

修法：归档时把 `captain`/`goal` **一起写进快照**再从项目上 `delete`；
`restoreTeam()` 从快照还原；`normalizeArchive()` 相应多带这两个字段。

**② `createTeam()` 不设 `captain`，与 `legacyFromHit` 的算法不一致。**

`legacyFromHit` 算队长用 `members[0].sessionId`，而 `createTeam()` 建完项目不写 `captain`
—— 两条路造出来的状态对不上（写 harness 第 6 节时暴露）。
修法：`createTeam()` 里 `if (added.length > 0) project.captain = added[0].sessionId`。

> 两个都是**流程级**问题：形状对、单函数对，串起来才错。
> 离线 harness 扩到 **63 项**（新增第二轮往返、captain 进出快照、归档后能开新一轮）。

#### 回归时踩到的环境坑：`projects.json` 带 BOM 会静默变成"没有项目"

我用 PowerShell 5.1 的 `Out-File -Encoding utf8` 造种子文件，**它写 BOM**（`EF BB BF`）。
`JSON.parse` 在 BOM 上直接抛 → `loadProjects()` 的 `catch` 吞掉 → 返回 `defaults()` →
`forge_team_create` 回 **`no project to attach team`**，而文件看起来完全正常。

这不是产品 bug（forge 自己用 `atomicWriteJson` 写，不带 BOM），
**但迁移指引正好教人手工编辑这个文件**，Windows 上不少编辑器默认带 BOM。
**待定**：要不要在 `loadProjects()` 里 parse 前 `replace(/^\uFEFF/, '')`。
改的话要再重启一次才生效 —— 所以先记下来，等定。

#### 待办已清：两个修复复验通过（2026-10-02 第二次重启后）

用户第二次重启（host **pid 24824，启动 07:09:25**）后复验：

| 步骤 | 结果 |
|---|---|
| 建队 `round-1` | ✅ ok |
| 归档 | ✅ `archived.length === 1`；快照里**留住了** `captain` 与 `goal`；项目上的 `captain` / `goal` **变为 undefined**；`members` / `tasks` 清空；无 `teams` 键 |
| **再建队 `round-2`** | ✅ **成功** —— 这正是修复前必定失败的那一步（`you already lead team "regress"`） |
| `forge_team_status` | ✅ `inTeam: true`、`teamId: "p-regress"`、`name: "round-2"`，第二轮正确绑定 |

**8 条清单现在全部通过。** 回归留下的 `~/.dsh/projects.json` 已删除 —— 回归前这台机器上本来就没有这个文件，状态已复原。

#### 顺带修的一个门禁脆弱点：git 环境问题会让 `check.mjs` 整片崩掉

第二次复验时 `check.mjs` 报了未捕获异常。查出来**不是代码改动引起的**，是环境变了：
仓库属主是 `BUILTIN/Administrators`，当前用户是 `XTZJ-20220407EK/Administrator`
→ git 拒绝服务（`fatal: detected dubious ownership`）→
`check.mjs` 那步 `execFileSync('git', ['log', …])` 抛出 →
**整个门禁以 Node 崩溃结束，而不是报告一项失败**。

两件事都做了：

1. **环境**：`git config --global --add safe.directory C:/Users/Administrator/.dsh/dsh-forge`
   （Windows 上这个报错的标准补救；写进全局 `.gitconfig`，对其它仓库无影响）。
2. **加固 `check.mjs`**：把 git 调用包进 `try/catch`，失败时打印跳过原因 + 补救命令后继续。
   实测把豁免摘掉后门禁**照样全绿**，并输出
   `· 跳过：git 不可用 — fatal: detected dubious ownership…`；
   正常时仍断言 `✓ #77–#106 连续无缺口`。

> 为什么"跳过"是安全的：编号台账是辅助检查，`subjects` 为空时下面本来就走
> "尚无 ≥#77 的同步号（基线前状态，跳过）"分支。所以只需兜住 git 调用本身，不改判定逻辑。

### 6.16 关键结论：外部插件**拿不到**浏览器可达的 `@Remote` 命名空间

这一版 UI 的成败点，先验它。结论是**目标第 (1) 条的假设不成立**，需要你选路。

#### 官方机制（逐字读出来的）

宿主侧：服务类 `extends TypertRemoteService`，构造时 `super(ctx, '<serviceName>', { namespace: '<ns>' })`，
方法上标 `@Remote('method')`（`packages/api/session-controller/src/index.ts` L99/L136）。
装饰器来自 `@deepseek-ai/dsh-typert-protocol`，`remoteMethods(service)` 从**原型**上收集标记。

浏览器侧：**命名空间不是运行时发现的，而是一份硬编码清单**。
`packages/api/remotes/src/client/index.ts` 的 `apply()` 里：

```js
for (const contribution of [
  productAnalyticsRemote, agentPresetsRemote, commandsRemote, settingsControllerRemote, accountRemote,
  goalsRemote, llmRemote, dynamicRemote, scheduleRemote, pluginInventoryRemote, pluginManagerRemote,
  … 共约 25 个 …
  permissionPresetsRemote, subagentsRemote, sessionRemote, jobRemote, workspaceRemote, workspaceFilesRemote,
  terminalRemote, officeToPdfRemote, userQuestionsRemote,
]) disposers.push(await ctx.remote.$mount(contribution))
```

每个 contribution 来自各 api 包的 **`/remote` 子路径导出**
（`import sessionRemote from '@deepseek-ai/dsh-api-session-controller/remote'`），
而那是**构建期由 `packages/typert/generator` 生成的产物**。

**所以外部插件加不进这个清单** —— 除非改 `@deepseek-ai/dsh-api-remotes`（在 app.asar 里）。

#### 三条可选路

| 方案 | 做法 | 成本 / 风险 |
|---|---|---|
| **A. 跑官方 typert generator** | 用 `_rc2_src` 的 `packages/typert/generator` 对 forge 的宿主服务生成一份 `/remote` 产物，打进 forge 的包 | 把官方**构建链**变成 forge 的运行时依赖；产物还要在运行时解析 `@deepseek-ai/dsh-typert-protocol`。重、脆，且 `_rc2_src` 未必装了 node_modules |
| **B. 手写一份 contribution** | 自己拼出 `$mount()` 能吃的那种描述符 | 先要摸清它的形状。而**产物在 app.asar 里，PowerShell 读不进去**（asar 是打包归档；之前命令行里出现的 `app.asar\dsh\…` 只是字符串，不是可遍历目录）。形状未知 → 不可估 |
| **C. 干脆不用 `ctx.remote`** ⭐ | forge 在自己的 webServer 上注册路由（**`forgeboot2` 已经这么干了**：`/dsh-forge/forgeboot`），静态客户端包 `fetch()` 它 | 零 codegen、零 app.asar 改动、用本项目**已验证**的缝。代价：本地 HTTP 路由的鉴权要自己定 |

#### 选 C 的话有两个必须处理的技术细节

1. **跨源**。桌面版页面 origin 是 `dsh-app://app`（见浏览器回传的 React 栈里的模块 URL），
   而宿主 HTTP 在 `http://127.0.0.1:19387` —— 这是**跨源**，响应要带 CORS 头，
   或者让 Electron 的自定义协议把它当同源处理。**这一条没验，是 C 的前置。**
2. **鉴权**。`control` 用的是自签 bearer token（机器对机器，浏览器没有）；
   浏览器侧要另想办法。可行做法：要求自定义头（如 `X-Forge-Client: 1`）+
   校验 `Origin` / `Sec-Fetch-Site`，挡掉"网页被诱导访问 localhost"这类现实威胁，
   并在文档里**诚实标注**它是本地信任而非强鉴权。

**在 (1) 验通之前不铺 UI 代码** —— 否则写出来的是调不通的空壳。

> 目标第 (1) 条原话是"给 forge 开一个官方 typert @Remote 命名空间"。
> 现在验出来**这条路对外部插件走不通**，所以停下来找你定，而不是硬钻。

---

### 6.17 A / B / C 实测对比（用户要求"先测一遍区别在哪、局限在哪"）

#### A. 跑官方 typert generator —— ❌ **不可行（有据）**

生成器**吐的东西本身没问题**（`packages/typert/generator/src/emitter.ts` L258-267）：

```js
export const TYPERT_REMOTE = {
  package: '<包名>',
  descriptors: [ { id, service, namespace, method, invocation: { kind: 'direct' } }, … ],
}
```

问题在**送达浏览器**这一环，两道门都关着：

1. 客户端命名空间清单**硬编码**在 `@deepseek-ai/dsh-api-remotes`（`apply()` 里那 25 个 `*Remote`），
   而它在 **app.asar** 里 —— 外部插件加不进去。
2. forge 的静态包**只能 require `PLATFORM_MODULES` 那 8 个 key**
   （`react` / `react-dom` / `@deepseek-ai/cordis` / `dsh-client-store` / `dsh-client-ui-slots` /
   `dsh-client-ui-primitives` / `dsh-client-ui-dockkit`），
   `@deepseek-ai/dsh-typert-protocol` 与 `api-gateway/client` **都不在**，
   而 `PRELOADED_CLIENT_EXTERNALS` 是**空数组**。
   活证据：`dsh-mailbridge-card` 里 `try { require('@deepseek-ai/dsh-session/surface') }` 必然失败，走内联兜底。

→ **A 要闭环必须改官方包（app.asar）。排除。**

#### B. 手写 contribution + 宿主 TypertRemoteService —— ⚠️ **可行（形状已知），两处没验**

形状就是上面那个纯数据对象；**`direct` 型方法连 codec 都不需要**（emitter 只对 `kind:'context'` 才生成 codec）。

| 环节 | 状态 |
|---|---|
| 客户端 `ctx.remote.$mount(contribution)` | 这是 `dsh-api-remotes` 暴露的 cordis 服务 → forge 静态包可 `inject: ['remote']`。**没验** |
| 宿主 `extends TypertRemoteService` + `super(ctx, name, {namespace})` | 官方写法清楚（session-controller L99/L136） |
| 方法标 `@Remote('m')` | `@Remote` 是 **TS 装饰器**，纯 JS 要手动套 `Remote('m')(proto, 'm', desc)`。**没验** |
| 宿主侧是否也需要一份生成产物 | **未知** |

**好处**：走官方 RPC 通道（浏览器信任认证、流式、类型），**不用自己发 CORS、不用自己定鉴权**。
**风险**：descriptor 格式是 pre-stable，rc 升级可能变；且依赖手写的两半保持一致。

#### C. 自注册 HTTP 路由 —— ✅ **服务器侧已实测通过**，浏览器侧待验

已写好 `bundle/plugins/projapi.mjs`（11 个 op：list / create / addCwd / removeCwd /
archiveProject / unarchiveProject / archiveRoster / memberAdd / memberRemove / taskWrite），
在**独立 forge-test 实例**上实测（`dsh --profile forge-test --no-open --port 0`）：

```
GET  + Origin: dsh-app://app + x-forge-client: 1
  → 200
    Access-Control-Allow-Origin: dsh-app://app
    Access-Control-Allow-Methods: GET,POST,OPTIONS
    Access-Control-Allow-Headers: content-type,x-forge-client
    Access-Control-Max-Age: 600
    body: {"ok":true,"version":3,"problem":null,"projects":[]}
OPTIONS 预检        → 204 + 同一套 CORS 头
不带 x-forge-client → 403
Origin: https://evil.example → 403
```

**独有的一条实现要点**（踩过）：官方 `webServer` **不处理 OPTIONS**，
预检会直接落到你的处理器上 → 默认 405。必须自己回 204 + CORS 头。

**局限**（要诚实说）：

1. **自己定鉴权**。现在是"Origin 白名单 + 自定义头"，是**本地信任**，不是强鉴权 ——
   本机任何进程都能伪装这两个头。对单用户桌面可接受，但别把它当安全边界。
2. **没有流式、没有类型**，每个 op 自己校验入参（已经这么做了）。
3. **与官方 RPC 并行成第二条数据面** —— 官方哪天给外部插件开命名空间，这套要重写。
4. **浏览器侧还没验**：`dsh-app://app` 页面能否真读到这个跨源响应，需要客户端探针。

另外顺手修掉一个我自己引入的 bug：`projapi` 的 patch 行**漏了 `name:`**，
loader 拿 `undefined` 去 `startsWith` → **整行被禁用**：

```
dsh: disabling profile plugin row "projapi": its declared peer dependencies
     cannot be validated: Cannot read properties of undefined (reading 'startsWith')
```

#### B 的进一步实测：卡在 **strict codec**（2026-10-02 续查）

`$mount()` 确实吃手写数据对象，`validateContribution()` 的规则也读清楚了。但**每个 descriptor 都要过
`requireStrictInputs()`**（`packages/api/gateway/src/client/index.ts` L790）：

```js
for (const parameter of descriptor.parameters) requireStrictCodec(parameter.codec, …)
if (descriptor.uplink !== undefined) requireStrictCodec(descriptor.uplink.codec, …)
if (descriptor.invocation.kind === 'context') requireStrictCodec(descriptor.invocation.codec, …)
// requireStrictCodec: codec.mode 必须是 'strict'，否则
//   "client api: generated Remote <ns>/<m> field <f> has no strict codec"
```

而 `TypertCodec` 的 strict 形态（`packages/typert/protocol/src/types.ts` L270-289）：

```ts
{ readonly mode: 'strict'
  readonly typeSymbol: string
  readonly create: () => TypertSchema        // ← 函数：运行时物化 schema
  readonly decode?: (value: unknown) => unknown
  readonly encode?: (value: unknown, writeBytes) => unknown }
```

**两个后果**：

1. 更简单的 `{ mode: 'src-json' }` 变体**过不了验证** —— 必须是 strict。
2. 手写 cost 不是"写几个字段名"，而是**每个方法的每个参数**都要给
   `typeSymbol` + `create(): TypertSchema`（外加二进制字段的 `encode`/`decode`）。

**这直接决定 B 是不是真的划算**，取决于 `TypertSchema` 的形状 —— 那是我还没读的一个文件：

- 若是**小数据结构**（就是字段名 + 类型标签）→ 手写可行，B 仍是最优（官方通道、不必自造鉴权与 CORS）。
- 若是**重型 builder**（要组装校验/序列化逻辑）→ 手写 = 自己重写 codegen，
  那 B 就退化成了 A 的代价，只是把"跑生成器"换成"人肉生成器"。

**下一轮第一件事**：读 `TypertSchema`，然后写一个**只含 1 个方法**的最小 B 探针
（宿主一个 `TypertRemoteService` + 客户端一个 `$mount`），用实测而不是推理定案。

#### B 的定性结论：**可行**（2026-10-02 续查二）

我上一轮说"要看 `TypertSchema` 的形状才能定性" —— 读完了，**它是通的**：

```ts
// packages/typert/protocol/src/types.ts L259-267
/** Minimal runtime-schema capability carried by strict generated codecs. */
export interface TypertSchema<Output = unknown> {
  parse(value: unknown): Output
}
```

**只有一个成员。** 所以手写 strict codec 就是：

```js
{ mode: 'strict', typeSymbol: 'ForgeCreateArgs', create: () => ({ parse: (v) => 校验并返回(v) }) }
```

**"人肉 codegen" 的担心不成立** —— codec 就是个 `parse()` 校验器，
而 forge 的入参校验逻辑本来就已经写在 `projapi.mjs` 的 `OPS` 里了（搬家即可）。

宿主侧：`TypertRemoteService` 在 `packages/typert/protocol/src/index.ts` L166：

```ts
export abstract class TypertRemoteService<out T = never> extends Service<T> {
  readonly typertRemote: TypertGatewayBinding<this>
}
```

生成器的 fixture 里能看到宿主侧的绑定写法：`readonly typertRemote = bindTypertRemote(this, 'goals')`。

#### ⭐ 最关键的一点：**B 的客户端半部不需要 import 任何 typert 东西**

contribution 是**纯数据**（`{ package, descriptors: [...] }`），
而 `$mount` 是 `ctx.remote` 上的方法 —— `ctx.remote` 是 `dsh-api-remotes` 提供的 **cordis 服务**，
forge 的静态包 `inject: ['remote']` 就拿到了。

所以**"PLATFORM_MODULES 只有 8 个 key、没有 typert-protocol"这件事，对 B 不构成限制** ——
它限制的只是 A（因为 A 要 import 生成的产物）。codec 里的 `create()` 闭包和 `typeSymbol`
全部由 forge 自己写，一个 import 都不需要。

**B 剩下的细节**（都是小项，实测时一起定）：

| 项 | 待定 |
|---|---|
| `bindTypertRemote` 从哪导出、是否必须显式绑定 | 从 fixture 看像是生成器的产物；若 protocol 包也导出就能直接用 |
| `parameters[].wire` 的取值域 | 生成器按类型推导，手写要挑对 |
| `descriptor.id` 的格式约定 | 生成器有约定；手写要与宿主 dispatch 对上 |
| 宿主侧是否也需要一份 descriptor（含 codec） | **未知** —— 但 `remoteMethods()` 只回 `{method, invocation}`（协议测试 L116/160），**不含 codec**，所以很可能宿主不需要 codec，只按 id 派发 |

→ **B 从"两处小不确定"变成"四个小细节"，全部可以在一个最小探针里一并验掉。**

#### B 的宿主侧探针：**三轮未打通**（2026-10-02，实测）

写了个一次性探针（`bundle/plugins/forgeprobe.mjs`，跑在一次性 `forge-test` 实例上，结果读 stdout；
验完已拆掉）。三轮的实测结果：

**第 1 轮 —— protocol 包导出什么：**

```
protocol 导出 (13):
  Remote, RemoteError, RemoteScope, TYPERT_OWNED_VALUE, TypertRemoteService,
  bindTypertRemote, isRemoteJsonValue, isRemoteUplinkItem, isTypertOwnedValue,
  isTypertRemoteSegment, remoteErrorOf, remoteMethods, typertOwnedValue
```

四样需要的**全有** ✓。而且 `new ForgeProbe(ctx)` 之后 `instance.typertRemote` **已经是 object**
—— 基类在构造时就绑好了，不用手动 `bindTypertRemote`。
`bindTypertRemote(inst, 'forgeProbe')` 也能单独调，返回 `{service, serviceKey, namespace}`。

**第 2 轮 —— 手动套装饰器（legacy 形态）：** 抛错

```
typert-protocol: Remote decorators require a public instance method with a string name
```

三参 `(proto, key, desc)` 与两参都不行 —— 那是 **TC39 stage-3** 装饰器的措辞（第二参是 context 对象）。

**第 3 轮 —— stage-3 context 形态 + 手动跑 initializer：**

```js
const inits = []
Remote('ping')(ForgeProbe.prototype.ping, {
  kind:'method', name:'ping', static:false, private:false,
  addInitializer(fn) { inits.push(fn) },
})
// → 捕获到 initializer 数 = 1        （装饰器确实登记了）
for (const fn of inits) {
  fn.call(ForgeProbe)             // 以类为 this   → 类和原型上 symbol 数均为 0
  fn.call(ForgeProbe.prototype)   // 以原型为 this → 原型上 symbol 数仍为 0
}
remoteMethods(instance) 长度 = 0 []
```

**所以卡在这里**：装饰器登记了 initializer，但跑完之后
**类和原型上都没有任何 symbol**，`remoteMethods()` 恒为 `[]`。
标记具体怎么写、写到哪，我没找到 —— 官方包靠的是**编译过的 TS 装饰器语法**，
纯 JS 里我没能复现出等价效果。

**这是 B 目前唯一的、也是决定性的障碍。** 它意味着 B 的宿主侧要么
① 找到那条注册路径（未知工作量），要么
② 把 forge 的宿主半部也过一遍 TS 编译（引入构建链 —— 那就退回到 A 的代价）。

#### C 定案：浏览器侧跨源**已实测通过**（2026-10-02 round 6）

探针从**桌面浏览器**里回传（经 C 自己的路由落盘）：

```json
{ "location": "dsh-app://app",
  "probes": [
    { "label": "sink+header", "ok": true,  "status": 200,
      "body": "{\"ok\":true,\"version\":3,\"problem\":null,\"projects\":[]}" },
    { "label": "sink-nohdr",  "ok": true,  "status": 403,
      "body": "{\"ok\":false,\"error\":\"missing x-forge-client header\"}" },
    { "label": "desktop-19387", "ok": false, "error": "Failed to fetch" }
  ] }
```

三条结论：

1. **`dsh-app://app` 页面能跨源读到 forge 路由的响应**（200 + 完整 body）—— C 的最后一环通了。
2. **鉴权守卫在浏览器侧同样生效**（缺自定义头 → 403，且浏览器读得到这个 403 的 body）。
3. **`desktop-19387` 那句 `Failed to fetch` 是对照组**：桌面实例的 `/dsh-forge/forgeboot`
   不带 CORS 头，被浏览器拦掉 —— **正好反证 CORS 头就是决定性的那一步**。

**宿主 HTTP origin 的来源**（这一条解决了"客户端怎么知道往哪打"）：

```ts
// packages/client/connection/src/client/index.ts L105-106
/** HTTP origin of a shell-owned Host when its WebSocket uses a different page origin. */
streamBaseUrl?: string
```

它挂在页面全局 `window.__DSH_TRANSPORT__` 上 —— 官方**专门为"页 origin 与宿主 HTTP origin 不同"
这种情况留的字段**，而桌面版正是这种（页 `dsh-app://app`，宿主 `http://127.0.0.1:<port>`）。
取不到时退回相对路径。

> 顺带澄清：`ctx.remote.$host` **不含**宿主地址，只有 `{"home":"…","isLoopback":true}`。

#### UI 第一版已落（2026-10-02 round 8）

`bundle/packages/dsh-forge-ui/lib/client.js` 从骨架换成**真数据层 + 左栏真实项目列表**：

- **传输**：`baseUrl()` = `__DSH_TRANSPORT__.streamBaseUrl`（兜底相对路径）；`call(op, args)` POST 到
  `/dsh-forge/projects`，带 `x-forge-client`
- **左栏**：已登记 / 未登记(`implicit`，即 `cwd:` 前缀) / 已归档(`dormant`=`archivedAt` 有值) 三组，
  每行 = 状态点 + 名字 + `成员数/看板数`；**行 hover 出 `[归档]`**（外层归档 = 写 `archivedAt`），
  已归档行出 `[取消归档]`；底部固定 `[+ 新建项目]`（行内输入框，回车创建）
- **状态点**：绿=有未完成看板条目 / 黄=有 stale / 灰=其余，左栏行复用同一套
- **右栏**：标题（未登记项目显示「未登记」，否则显示「成员」）+ 三张卡（目录 / 成员 / 看板，当前只读）
  + `[归档团队]`（内层归档 = 压 `archived[]` 快照）/ 未登记项目显示 `[登记为项目]`
- **错误可见**：`projects.json` 有问题时左栏顶部出一条黄条（复用 `projectsLoadError()` 的 `problem` 字段），
  调用失败出红字 —— 不留静默失败

**踩到并修掉**：`ProjectDetail` 里 cwds 那张卡的 JSX 收尾少一个 `)`，
报错落在整个函数最后一行（`missing ) after argument list`），而真正的缺口在前面 ——
是按行统计 `(` / `)` 数量才定位到的。

**还没做**：右栏三张卡的写动作（`[+ 添加目录]` / `[+ 新建队员]` / 看板点状态循环 /
行内 `[发消息]` / `[减员]`）；集群 tab 与 Forge tab 仍是骨架。临时探针与接收端已拆。

#### 写动作已接（2026-10-02 round 11）

`ProjectDetail` 从只读换成可写（客户端 438 行）：

| 卡片 | 动作 | 底层 op |
|---|---|---|
| 目录 | 行内 `[移除]`；底部输入框 + `[添加]`（回车也行） | `removeCwd` / `addCwd` |
| 成员 | 行内 `[减员]`；底部表单 = 队员名 + 目录下拉（项目 cwds）+ 角色 + preset 三档 + `[+ 新建队员]` | `memberAdd` / `memberRemove` |
| 看板 | 状态钮点一下循环 `待办→进行中→完成`；点标题展开 `description` 与 `output`；底部输入框 + `[添加]` | `taskWrite` |
| 页脚 | `归档轮次 N` + `captain` | — |

**`[+ 新建队员]` 的两步**（这一版的关键）：

```js
props.createSession(cwd, preset)        // → ctx.remote.session.create({cwd, agentPreset})
  .then((sessionId) => act('memberAdd', { projectId, sessionId, memberId, role, preset }))
```

即**一步建会话并入队** —— 不用先去官方侧栏开会话再回来挑。建会话走的是**官方已挂载**的
`session` 命名空间（`dsh-api-remotes` 的 25 个之一），**不是** forge 自造的路由；
forge 自己的项目数据才走 `/dsh-forge/projects`。

> **信封坑**：`ctx.remote.<ns>.<method>()` 返回的**不是**业务值，而是
> `{ok:true, value}` / `{ok:false, error}`。不拆就会把信封当业务值用 ——
> `createSession` 里显式拆了，并且校验 `value.sessionId` 是字符串。

**还没接的两条**（都需要新的宿主 op，下一轮）：

- `[发消息]` —— 要去调 mailbridge 的发送逻辑，但那是**模型工具**，浏览器调不了工具。
  得在 `projapi` 加一个 op 去调 `team-org.r2.mjs` 的 `talkSend(...)`；
  而 `talkSend` 的契约**尚未读**（`mailbridge.mjs` 会给它 `bindTalkRuntime`），
  所以**不确定它能否脱离工具层单独调**。若不能，得换个实现。
- `[从已有会话挑选]` —— 需要一个"列出未被占用的会话"的 op（`listFreeSessions` 在 `team-org` 里，
  但没经 `projapi` 暴露）。

文案键（zh/en）已补齐 10 个；客户端语法门、`check`、`check --compat` 全绿。

#### 三方案最终对照

| | 状态 |
|---|---|
| A | ❌ 要改 app.asar |
| B | ⚠️ 客户端半部理论可行（codec 只是个 `parse()`，且不需要 import typert），**宿主侧卡在装饰器注册**，三轮未通 |
| **C** | ✅ **服务器侧 + 浏览器侧双向实测全通** → 走这条 |

**不再在 B 上丢轮次。** 走 C —— 它的数据面已经写好并跑通
（`projapi.mjs`，11 个 op，200 + 完整 CORS / OPTIONS 204 / 两个 403）。
B 的所有实测证据留在本节，哪天官方给外部插件开了口子，可以照这条路径回来。

#### 早先的建议（已被上面的实测取代，保留以见判断演进）

原先我说"B 的两处不确定很小"——**那话说早了**。现在 B 的真实门槛是 **strict codec 的手写代价**，
而它取决于 `TypertSchema` 的形状，尚未读。

调整后的建议：

1. **先花一步读 `TypertSchema`**（一个文件），这一步就能把 B 定性。
2. 然后**写 1 个方法的最小 B 探针**实测 —— 别再推理。
3. **B 通 → 用 B**：官方通道、不必自造鉴权与 CORS、不必维护第二条数据面。
   **B 若退化成"人肉 codegen" → 用 C**：服务器侧已经全部实测通过
   （200 + 完整 CORS / OPTIONS 204 / 两个 403），只差一个浏览器探针。
4. 两条路都能走通，所以**不会再出现"卡住"**；现在的选择只是"哪条更值"。

#### 已决：BOM 剥掉，坏文件必须可见（用户 2026-10-02 拍板）

> 好问题，我的建议是，**至少要让错误可以知道，不允许静默错误**。

所以不是"顺手 strip 一下就完事"，而是两件事一起做：

**① 剥 BOM** —— 带 BOM 的 UTF-8 是**合法文件**，编辑器默认行为，不该当成坏文件。
`JSON.parse(text.replace(/^\uFEFF/, ''))`。实测带 BOM 的文件能正常读出，且 `projectsLoadError()` 为 null。

**② 坏文件绝不静默** —— 文件存在但解析不了，是**坏文件**，不是"没有项目"。
新增 `projectsLoadError()`（模块级，`loadProjects()` 每次读文件时更新）：

- **文件不存在**（`ENOENT`）→ **不算错误**。第一次用这个功能就是这个状态，返回空项目表即可。
- **读不动 / 解析失败** → 记下错误，并 `console.error` 一条**写明路径、原因、以及"这不是正常状态"**的日志：

```
[forge/projects] C:\…\projects.json 解析失败：Expected property name or '}' in JSON at position 2
  —— 已按"没有项目"继续，但这不是正常状态，请修好这个文件或删掉它。
```

- `teams-file.mjs` 的 `putRecord('team')` 在找不到项目时**先查这个错误** ——
  修掉那句误导人的 `no project to attach team`：文件坏了就直说"projects.json 读不出来，所以挂不上团队：<原因>"，
  真的一个项目都没有时才说"先建一个项目"。

> 这一条是**回归时真踩到的**：我造的种子文件带 BOM，`JSON.parse` 抛 → 旧代码 `catch` 吞掉 →
> 报出来的是 `no project to attach team`，把我往"团队挂载逻辑坏了"的方向引了十几分钟。
> **错误信息把人引错方向，比没有错误信息更糟。**

harness 第 9 节锁住这三条：BOM 合法可读、坏文件留下可见错误（含路径与"解析失败"字样）、文件不存在不算错。
现在 **71 项**全过。

#### 本轮补的一个真回归（零成员队）

`forge_team_create` 允许 `members: []`。旧实现里队记录无论有没有人都存在，
`getTeam(captain)` 能拦住"你已经带了一支队"；**拍平后空队不满足
`members.length > 0 || tasks.length > 0`，所以在 team 表里根本不出现** → 可以反复建。

修了三处：

1. `teams-file.mjs` 的 `putRecord('team')` 把 `captain` / `goal` 落到**项目**上
   （`normalizeProject` 早就透传这两个字段，只是没人写）。
2. `loadAll` 的可见性条件加上 `typeof p.captain === 'string'`。
3. `legacyFromHit` 的 captain 优先读 `project.captain` —— **这条是必须的**：
   team 表是按 captain 做键的，而空队的 `members[0]` 不存在，会退化成 `team.teamId`
   （= project.id），于是 `getTeam(调用方)` 永远找不到它，闸照样失效。
   `agent-teams-file.*` 的 `teamCardsOf` 也同步认 captain。

#### 审计：lib 之外没有漏掉的破坏点

全仓 grep `.teams` / `archivedTeams` / `team.teamId` / `hit.team`，lib 之外只有三处，**都已兼容**：

- `teamhub.mjs` L693/763/765/891/893 —— 读的是派生视图（`team.teamId === projectId`）。
  L272 那个自造的 `makeId('team')` 只会被 `findTeam` 判空、然后走"挂到调用方项目"那条分支，
  **随机 id 不会落盘**（harness 第 8 节断言了这点）。副作用只是模板描述里的
  `tpl-p-dsh-fo` / `捕获自团队 p-regress` 换了文本，可接受。
- `console-gates.mjs` L196-197 —— 读 `hit.team.members`，派生视图里就是 `project.members`。
- `team-org.*` L220/L338 —— `a.team.teamId` 比较，`teamId === projectId` 后语义等价。



`archiveTeam()` 的语义也要跟着定：team 没了之后，"归档当前队、再开新队"变成
**往 `project.archived[]` 压一份快照并把项目自己的成员/看板清空**。
工具层仍然叫"归档团队"，但归档的是项目里的那一轮。

#### 用户补的 UX 分层（2026-10-02，原话）

> 比如说 forge 从项目点到一个具体项目的**标题就可以改成团队**，所以问题不大。
> 而且我觉得很直观，也就是**外层显示几个项目，点进去看看单独的团队构成**。
> 现在的归档**如果在进去里面点归档就是归档目前所有的队员**。
> **如果在外面则是归档对应项目**。这也契合 **UI 本身也在传递信息**的概念。

**术语分层**（存储只有 project，但界面分两层说）：

| 层级 | 叫什么 | 显示什么 |
|---|---|---|
| 外层（forge 页的项目 tab） | **项目** | 有几个项目、每个项目几个目录 / 几个人 / 看板彩灯 |
| 内层（点进一个项目） | **团队** | 这一个项目的团队构成：成员、看板、归档轮次 |

标题文案随层级变（内层标题写「团队」），所以"存储里没有 team"和"界面上有团队"不矛盾。

**归档的两级语义**（同一句话的两个作用域，靠 UI 位置区分）：

| 在哪点 | 归档什么 | 落在哪 |
|---|---|---|
| 内层（项目详情） | **当前的队员**（这一轮团队） | `project.archived[]` 压一份快照，然后清空项目的 members（看板一起归档），项目留着开下一轮 |
| 外层（项目列表） | **整个项目** | `project.archivedAt`（ISO 串；有值即已归档），项目本身保留在文件里，UI 过滤 |

`implicitProject()` / `seedFromCwds()` 不写 `archivedAt` —— 缺席即存活。

---

### 6.15 《项目》UI/UX 重构方案（用户授权完全重构，不必沿用旧结构）

用户 2026-10-02 授权：**UI 完全重构，按你觉得好看、好用的方式规划《项目》这个功能。**

#### 先想清楚用户要干的活

> 我把你和一个专门 push GitHub 的目录的会话拉进一个，你改完以后由他审查和合并代码并提交。

所以这一页要在一眼之内回答五个问题：
**① 我有几个项目、哪个在动？② 这个项目里有谁、在哪个目录？③ 看板上还剩什么、谁在做？
④ 怎么把人拉进来 / 派活 / 传话？⑤ 出什么事了吗（消息、待批、蒸馏）？**

#### 布局：两栏主从（不是"列表 → 整页替换"）

```
┌ Forge ────────────────────────────────────────────────────────────────────┐
│  [ 项目 ]  [ 集群 ]  [ Forge ]                              ← tab bar      │
├────────────────────┬──────────────────────────────────────────────────────┤
│ 项目                │  团队                              [归档团队] [ ⋯ ]  │
│                    │  dsh-forge                                            │
│ ● dsh-forge        │  ~/.dsh/dsh-forge · ~/gh-pusher          ← 项目名+路径 │
│   2 目录 · 3 人     │                                                       │
│   看板 4/7         │  ┌ 目录 (2) ──────────────────────────────────────┐   │
│                    │  │ ~/.dsh/dsh-forge          2 会话   [新开会话]  │   │
│ ● 集群运维          │  │ ~/gh-pusher               1 会话   [新开会话]  │   │
│   1 目录 · 1 人     │  └────────────────────────────────────────────────┘   │
│   看板 0/2         │  ┌ 成员 (3) ──────────────────────────────────────┐   │
│                    │  │ ● me       队长   ~/.dsh/dsh-forge  [发消息]   │   │
│ ── 未登记 ──        │  │ ● gh-bot   审查   ~/gh-pusher       [发消息]   │   │
│ ○ cwd:~/scratch    │  │ ○ offline  队员   ~/.dsh/dsh-forge  [减员]     │   │
│   [登记为项目]      │  └────────────────────────────────────────────────┘   │
│                    │  ┌ 看板 (7) ───────────────────────────────────────┐  │
│ ── 已归档 ──        │  │ ▸ 适配 rc.2       进行中   me                  │  │
│   旧项目 A          │  │ ✓ 砍旧面板        完成     me                  │  │
│                    │  │   推 GitHub       待办     gh-bot               │  │
│ [ + 新建项目 ]      │  └────────────────────────────────────────────────┘  │
└────────────────────┴──────────────────────────────────────────────────────┘
```

**为什么主从而不是整页切换**：这一页的核心是"几个人在几个目录里干同一件事"，
切项目时不该丢掉"我刚才在看谁"；而且左栏始终在，扫一眼就知道别的项目有没有在动。

**为什么内层标题是「团队」而不是项目名**：项目名放在下面一行和路径一起。
这样"存储里没有 team、界面上有团队"读起来是自然的 ——
外层是项目，点进去是**这个项目的团队**。

#### 三块卡片 = 用户心智的三个问题

| 卡片 | 回答什么 | 每行的动作 |
|---|---|---|
| **目录** | 哪几个目录 | `[+ 添加目录]`（**直接写路径**，不必先有会话）/ 行内 `[在此新建队员]` / `[移除]` |
| **成员** | 谁、什么角色、在哪个目录 | `[发消息]`（内联展开输入框，回车发）/ `[减员]`；**卡片底部 `[+ 新建队员]`** |
| **看板** | 还剩什么、谁在做 | 点标题展开描述与 output；点状态循环 待办→进行中→完成 |

#### 加成员：**直接新建队员**，不再"先建会话再加入"

用户 2026-10-02 定：*"之前的步骤是先新建对应会话再加入团队的，应该直接新建对应队员。"*

旧流程（`createTeam` / `addMember` 现在仍然要求 `'队员必须已有会话'`）要人先去官方侧栏开一个会话、
再回到这一页从列表里挑 —— 两步且容易挑错。新流程一步到位：

```
[+ 新建队员]  →  填三样：目录 · memberId · 角色  （preset 默认 forge-team，可改三档）
              →  ctx.remote.session.create({ cwd: <目录>, agentPreset: <preset> })
              →  拿到 { sessionId }
              →  写进 project.members: { sessionId, memberId, role, preset }
              →  行内出现这名队员，可直接 [发消息] 派活
```

**这件事完全用官方扩展点**，不需要自造会话创建面 —— `sessionController.create`
在 rc.2 是 **`@Remote('create')`**，宿主侧与客户端都能调：

```ts
export interface SessionCreateRequest {
  readonly workspaceId?: WorkspaceId
  readonly cwd?: string           // ← 选哪个目录
  readonly sessionId?: SessionId
  readonly agentPreset?: string   // ← forge-team / forge-team-creative / forge-team-distill
}
export interface SessionCreateValue { readonly sessionId: SessionId; readonly agentPreset?: string }
```

`agentPreset` 恰好就是 forge 那三个 preset 名（`FORGE_TEAM_PRESETS`）。

> **一个必须记住的时机约束**：`create({ agentPreset })` 是**建的时候**定 preset，这条合法；
> 而 `ctx.agentPresets.select` 在会话**开过 turn 之后**会抛 `agent-preset/locked`
> （见 `scripts/check.mjs` 的 L3 冒烟清单）。所以"换 preset"只能在**没跑过 turn 前**做，
> 之后要换得走 modeswitch 那套自研 recompose —— 别在这里自己发明第三条路。

**次要入口保留**：`[从已有会话挑选]`（列出 `listFreeSessions()` 里没被占用的会话）
—— 用于"把已经在跑的那个会话拉进来"，也就是用户最早描述的那个场景。


#### 状态语言：一个点，到处复用

`●` 绿=进行中 · 灰=空闲 · 黄=有消息待批 · 红=出错。
**同一套点在左栏项目行里也用** → 扫一眼就知道哪个项目在动，不用点进去。
（左栏那行顺带把「看板 4/7」这种进度写成 `4/7` 的紧凑计数，不写整句。）

#### 归档的两级，靠位置区分（用户已定）

| 在哪 | 动作 | 效果 |
|---|---|---|
| 左栏项目行 hover | `[归档]` | 归档**整个项目** → `project.archivedAt`，行移进「已归档」折叠区 |
| 内层标题右侧 | `[归档团队]` | 归档**当前全部队员** → 压一份 `project.archived[]` 快照，成员/看板清空，项目留着开下一轮 |

内层如果已有归档轮次，成员卡片底部出一行 `已归档 2 轮 ▸`，点开只读看历史轮次的成员与看板。

#### 两种必须处理好的"非正常"项目

1. **隐式项目**（`id` 以 `cwd:` 开头、`implicit: true`）——单独一组放左栏，
   标灰、不显示看板，唯一动作是 `[登记为项目]`。
   **这是用户说的"把两个会话拉进一个"的入口**：登记时预填这个 cwd，
   再让他把另一个目录的会话加进成员表。
2. **空态**：一个项目都没有时，左栏不放空白 ——
   直接给 `[ + 新建项目 ]`，并且**默认用当前会话的 cwd 预填**，一键就有第一个项目。

#### 动作面（都接 forge 已有能力，UI 只是露出来）

| 动作 | 底层 |
|---|---|
| 新建项目 / 登记隐式项目 / 改目录集合（含 `[+ 添加目录]`） | `projects.json` 写面 |
| **`[+ 新建队员]`** | `ctx.remote.session.create({ cwd, agentPreset })` → 再写 `project.members` |
| 从已有会话挑选入队 / 减员 / 改角色 | 同上（`listFreeSessions()` + 成员表写面） |
| 发消息给某个成员 | `forge_mailbridge_send` |
| 看板推进 | 等价 `forge_team_update_task` |
| 归档团队 / 归档项目 | `archiveTeam`（内层）/ 写 `archivedAt`（外层） |
| 项目记忆 | `project-memory/<id>/` 的文件列表，只读预览 + 跳转编辑 |
| 预算闸 | `wake` / `crossTeam` 显示成团队卡片底部一行只读元信息 |

#### 视觉规范（沿用已经在跑的那套，不新造）

- 只用官方 theme token（`--dsw-alias-*`），不写死颜色 → 自动跟亮/暗
- 12px 圆角卡片、1px 弱边框；hover 只提升边框色，不做位移
- 字号：区块标题 12/650 大写、卡片标题 14/600、正文 13、路径等宽 11、元信息 12
- 图标用官方 `ui-primitives` 的 SVG（静态包能 `require` 到，这是当初选静态包的原因之一）
- 成员/看板/目录三张卡片之间用 18px 间距分段，卡片内部 7px 行距

#### 与旧做法的区别（明确不沿用的部分）

| 旧 | 新 | 为什么 |
|---|---|---|
| 底部一串图标（功能壳 + 已归档 + 能力 + 市场 + 质粒） | 侧栏**一个** forge 入口 → 整页 | 底部那串和官方设置面重复，且挤 |
| 列表 → 整页替换 | 两栏主从 | 切项目不丢上下文 |
| 项目 = workspace 分组 | 项目 = `projects.json` 的通信域 | 用户两轮纠正后的定案 |
| 能力/市场/质粒/技能管理各自一个面板 | 收进 Forge tab 的「管理」区 | 官方已有对应面，少自造 |








## 6.19 preset 迁移完成：旧的 .agent-presets 目录 → bundle declaration rows（2026-10-02）

### 官方规则（原文，别自己发明）

`@deepseek-ai/dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md`：

> Before declaration rows, a user preset was a directory `$DSH_HOME/.agent-presets/<id>/` holding
> `preset.yml` (display `name`, `description`, `order`) and `agent.cordis.yml` (the plugin entry list).
> **Nothing reads that directory any more.** To migrate one, create a bundle as above whose declaration
> takes `id` from the directory name, `name`, `description`, and `order` from `preset.yml`, and
> `plugins` from `agent.cordis.yml` **verbatim**; **check each plugin name against
> `cordis-composition-reference` because packages renamed since the preset was written fail at
> activation.** Install it, verify the row, then delete the legacy directory.

declaration row 的 `config` 字段：`id`（必填，小写字母/数字/连字符）、`plugins`（必填的 Cordis entry 列表），
可选 `name` / `description` / `order`。Loader 行 id 约定为 `preset-<id>`。

### 落地做法

`bundle/forge-presets/`（bundle = 一个目录，两份文件）：

```
package.json          { "name": "@local/dsh-forge-presets", "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
cordis.patch.yml      - insert: [ preset-forge-team, preset-forge-team-creative, preset-forge-team-distill ]
```

`scripts/install.mjs` 的 6/6 由「拷进 `.agent-presets/`」改成 `syncPresetBundle()`：
**从 `presets/*` 重新生成** bundle patch（`plugins:` 逐字取自 `agent.cordis.yml`，整体缩进 10 格），
再检查 profile 的 package.json 有没有链进这个 bundle，没装就打印官方装法（不替它做）。

安装走官方 `plugin_manager` `action: install_bundle`、target = bundle 绝对路径。
它自己跑 pnpm（`link:` 进 profile）并重组 entry 列表 —— **实测不需要审批、也不需要重启**。

### 踩到的坑：bundle patch 是**独立文档**，顶层必须第 0 列

第一版生成时我按"嵌在 forge 的 `- insert:` 里"写了 **4 空格缩进**，结果被解析成
**三条带 id、没有 insert 的行** = override 目标 → 命中不了任何行 → 按参考文档那句
*"targets that match no row are warned about and skipped"* **静默跳过**。
`list_bundles` 里看得一清二楚：

```json
{ "name": "@local/dsh-forge-presets", "enabled": true, "installed": true,
  "rows": [],                       // ← 空
  "overrides": ["preset-forge-team", "preset-forge-team-creative", "preset-forge-team-distill"] }
```

补上第 0 列的 `- insert:` 头（原 4 空格缩进正好成为它的子项）后即正常。
**排查提示：`rows` 空而 `overrides` 里出现你的 id，就是这个坑。**

### 包名核对（官方警告的那步，必须做）

三份 preset 共引用 **28 个 specifier**。对 `cordis-composition-reference/references/packages.md`
（513 行）逐个核：26 个直接命中；剩 2 个是**子路径**（`@deepseek-ai/dsh-plugin-manager/tools`、
`@deepseek-ai/dsh-tool-subagent-control/list-agents`），基包都在清单里，且在活实例 loader 中
三个条目（含 `include:tool-subagent-list-agents`）都在 → **无改名的包，激活不会炸**。

> 注意：`cordis-composition-reference/SKILL.md` 本身只有 2806 字节，是**指针**；
> 真正的清单在它旁边的 `references/packages.md`。我第一次对错文件，28 个全"找不到"。

### 验证证据

`Config.listConfigs`（host，`name: '@deepseek-ai/dsh-agent-preset'`）**total = 7**：
官方 `preset-standard` / `preset-ptc` / `preset-minimal` / `preset-cordis`
＋ forge `preset-forge-team` / `preset-forge-team-creative` / `preset-forge-team-distill`。

loader 相位（`plugins.list`）：

```
include:preset-forge-team            enabled=True  fiberPhase=active
include:preset-forge-team-creative   enabled=True  fiberPhase=active
include:preset-forge-team-distill    enabled=True  fiberPhase=active
```

旧的 `$DSH_HOME/.agent-presets/` 已按官方最后一步删除。


## 6.20 Windows 桌面版沙箱（workspace-write）修好了：装 PowerShell 7（2026-10-02）

### 症状与旧规避

本会话的 `pwsh` 工具在 `workspace-write` 下**每一次调用**都以 `0xC0000142`
（`STATUS_DLL_INIT_FAILED`）死掉（当时试了 4 次）。规避办法是**把整个会话挂到
`danger-full-access`** —— 那等于**放弃沙箱**，不是修复。

同时另一个一直在折磨人的副作用：输出中文全是乱码。

### 根因（三层证据）

**① 工具解析到的可执行文件是 5.1。**
`packages/shell/pwsh-local/src/resolve.ts` 的 `candidatePwshPaths` 顺序是：

```
<ProgramFiles>\PowerShell\7\pwsh.exe   →   PATH 里各项的 pwsh.exe   →   System32\WindowsPowerShell\v1.0\powershell.exe
```

这台机器**没装 PowerShell 7**（三处候选全不存在，`where pwsh` 为空），于是退到 **5.1**。

**② 官方包自己的"已验证边界"记着 0xC0000142 的两个独立成因**
（`sandbox-windows-acl/README.zh.md`）：

> 保活组（登录 SID + Everyone）在两种模式下都存在：**没有它，早期 DLL 初始化会以
> `0xC0000142` 死亡**、CNG 会让 pwsh 以 `0xE0434352` 崩溃。

> **控制台隔离不可用。** 以 `CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE` 创建的子进程在 DLL
> 初始化期间以 `STATUS_DLL_INIT_FAILED`（`0xC0000142`）死亡；**子进程共享宿主控制台**。

第一个成因包已自行解决（保活组在）。**桌面宿主是"无控制台启动"**，于是走的是第二条。

**③ 进程创建刻意不加 `CREATE_NO_WINDOW`**（`subprocess/win32-process/src/process.ts:454`）：

```ts
// Preserve console inheritance: CREATE_NO_WINDOW can fail restricted-token DLL initialization.
```

它靠**继承父进程的控制台** —— 而桌面宿主没控制台，没得继承。

### 上游同一族问题（本轮查实，共 6 个）

| # | 主题 | 与我们的关系 |
|---|---|---|
| #810 | 沙箱化 pwsh 在无控制台宿主下必死 0xC0000142 | **就是本问题** |
| #1344 | 沙箱子进程闪出可见控制台窗口；`STARTF_USESHOWWINDOW`+`SW_HIDE` 可修且不触发 0xC0000142 | 同一层代码（`dwCreationFlags`），不同 flag |
| #8675 | 受限沙箱下 PTY shell 必现失败：ConPTY 子进程三个标准句柄为 NULL，而 runner 要求全部有效 | rc.2 上的姊妹问题；**只有 `minimal` preset 挂 PTY 工具**，`standard`/`ptc`/`cordis` 不受影响 |
| #1913 | 同一错误串，根因不同（极简 Linux 缺 `/bin/bash`） | 无关 |
| #3428 | Windows + 极简模式 shell 失败（进程检查器） | 旁支 |
| #2851 | node-pty 版本变化打断 Windows 持久 PTY shell | 旁支 |

**#8675 的决定性内容**：它在 rc.2 上把 **受限令牌 / 完整性级别 / ACL 逐项排除**，并写明
*"在该令牌下 PowerShell 7.6.6、CNG、`X509Store`、`certutil` 以及子进程继承全部正常"*，
且 `standard` preset 暴露的**非 PTY `pwsh` 工具在同一受限模式下工作正常**。
→ **差别就在 5.1 vs 7。**

### 修法（无需管理员）

这台账户**不是管理员**，写不进 `C:\Program Files\PowerShell\7\`（解析器的首选位置）。
但解析器**也扫 PATH 项**，所以：

1. 下载 `PowerShell-7.6.6-win-x64.zip`（101 MB）解压到 `%USERPROFILE%\pwsh7`
2. 把该目录**追加到用户 PATH**（幂等）
3. **重启 DSH** —— 运行中的宿主进程 env 在启动时就固定了

### 验收（实测，不是推断）

工具在 `workspace-write` 下跑通，且身份正确：

```
PSVersion : 7.6.6
Edition   : Core
ExePath   : %USERPROFILE%\pwsh7\pwsh.exe
中文输出测试：赋能、深耕、聚焦 —— 不该乱码      ← 5.1 的 OEM 代码页乱码问题一并消失
```

**并且确认沙箱真的在拦**（避免"能跑 = 沙箱悄悄失效"这种假成功）：

| 测试 | 结果 |
|---|---|
| 写工作区内 | ✓ 成功 |
| 写 `C:\Windows\` | ✓ 被拒 |
| 写 `%USERPROFILE%\.ssh\` | ✓ 被拒 |
| 写 `C:\` 根 | ✓ 被拒 |
| 读工作区外 | ✓ 可读（符合官方"读不限、写受限"） |

### 结论

**Windows 桌面版此前"沙箱不可用、只能挂 Full access"是被 PowerShell 5.1 造成的**，
不是沙箱机制本身的问题。装 PowerShell 7 后 `workspace-write` **真正可用且真正在拦**。

**可操作的排查经验**：以后遇到 `0xC0000142`，先看 `(Get-Process -Id $PID).Path`
—— 是 5.1 就先装 7，别急着怀疑 ACL/令牌。


### 6.20.1 沙箱一修好，就照出 forge 自己的一个不兼容（同日）

沙箱真正生效后第一件事：`node scripts/check.mjs` **45 项全红**，全是同一个错：

```
✗ bundle/plugins/<每个文件>.mjs: spawnSync C:\Program Files\nodejs\node.exe EPERM
```

**这不是回归，是沙箱按规定在拦**：受限模式下进程**不能开命名管道**，而 `check.mjs` 用
`execFileSync(..., { stdio: 'pipe' })`（Node 默认）去抓子进程的 stderr → 直接 EPERM。

**也就是说：修好沙箱之前，forge 的语法门在受限模式里根本跑不了**，而这一点被
"挂 Full access" 长期掩盖了 —— 又一个"静默失效"的例子。

**改法**：子进程的 stdout/stderr 落到**文件句柄**而不是管道。语法检查本来就只需要退出码，
文件句柄既不是命名管道（沙箱允许），又留得住报错原文：

```js
const logPath = join(CHECK_LOG_DIR, 'check-' + (checkLogSeq++) + '.err')
fd = openSync(logPath, 'w')
execFileSync(process.execPath, ['--check', path], { stdio: ['ignore', fd, fd] })
// catch 里 readFileSync(logPath) 取第一行非空报错
```

改完在 `workspace-write` 下：`[check] 全部通过` / `check --compat 全部通过` /
`gen-npm-bundle.mjs --check 一致`。

> **教训（这轮我自己犯的）**：我用字符串拼接往 `install.mjs` / `check.mjs` 里塞代码时，
> 锚点用 `\n` 而仓库是 **CRLF**，替换**全部没命中**，而我的脚本**无条件打印了成功**。
> 两次。都是靠 `Select-String` / `readFileSync` 回读才发现的。
> **"没验证就报成功"和静默错误是同一类东西** —— 凡是写盘脚本，改完必须回读核对。

## 6.21 featsw 改走官方设置：调查结论与拍板（2026-10-02）

### 拍板

操作员：**"featsw 基本上只需要全局就行。我觉得不需要每 session。所以可以不做。"**
→ **删掉 `overrides`（session 覆盖）**，开关只保留全局一层。

### 为什么敢删：session 覆盖是**读得到、没人写**的死功能

全仓 + 部署侧三遍扫描（`.mjs` / `.js` / `profiles/desktop`）的结论：

- **没有任何代码写 `overrides`**。仅有的写是 `featsw.mjs:84` 的防御性归一化 `state.overrides = {}`。
- **两个活调用方连 `sessionId` 都不传**：`forge-tools.mjs:13` 是 `featsw.isGateOpen(feature)`、
  `console.mjs:160` 是 `featsw.isGateOpen('console.web')` → `profileOf(cfg, undefined)`
  **永远落到全局 profile，session 那一维在活路径上从未被走到**。
- 运行时 `~/.dsh/features.json` 里 `"overrides": {}`、`profiles` 只有 `full`。
- 两处看着像写入方的命中是**假命中**：`spawn-model-subagent.mjs:53` 与 `teamhub.mjs:131` 都是
  `sandboxPolicy.overrideOf(agent.session)` —— 那是**沙箱模式**的 session 覆盖（官方旋钮），与本插件无关。
- `featui` 面板（`dynamic/dynplugins/featui.host.js`）只动 `profile.off`，从不碰 `overrides`。

FR-5 原本要它做的「子代理继承」，实际上**已由既有机制覆盖，只是不含 feature gate 这一维**：

| 维度 | 继承机制 | 状态 |
|---|---|---|
| 沙箱模式 | `sandboxPolicy.overrideOf(session)` + `collectSandboxEscalations` | ✓ |
| preset | `presets.composedPreset(ctx)` + `collectPresetEscalations` | ✓ |
| 模型/供应商/effort | `route` + `parentHeader.config` + `collectModelEscalations` | ✓ |
| feature gate | — | ✗（已知缺口，记在此处） |

### 官方「设置功能」的确切通道（这才是「用 bundle 的设置功能做」）

`ctx.settings`（host Service，实测签名）：

```
configure({auto?}, owner?)                 注册本插件的设置页策略（auto 默认 true = 按 schema 自动生成）
describe({redactSecrets?})  → SettingsDescriptor[]    读活跃插件 schema 与**当前值**
update(ns, patch, expectedRevision?)       把可编辑字段**合并**进某条目的 config
replace(ns, section, expectedRevision?)    先重置再设（普通 config 保留）
mutate(ns, ops, expectedRevision?)         有序字段编辑，不必重述被脱敏的密钥
prepareDocument()           → 路径         定位 profile patch 供原生编辑
```

`SettingsDescriptor` 关键字段：

```ts
{ ns, autoGenerate, schema, value, revision, base?, user?, applies: 'live', secrets? }
```

- **`ns` = profile entry id**（我们那种 loose 插件的行 id，形如 `include:featsw`）
- **`applies: 'live'`** —— **配置改动当场生效，不需要重启**
- `base` 来自 patch 的 `config`，`user` 是叠加在上面的用户编辑
- `revision` 供乐观并发

`settings/README.md` 的原话：*"The active profile patch stores edits, and Loader applies them.
Plugins read their own volatile references."*

### 活更新（不 remount）的机制

`vendor/loader/README.md` 的 *Volatile configuration* 一节 + 两份源码：

```ts
// vendor/cosmokit/src/volatile.ts
export interface Volatile<T> { get(): VolatileSnapshot<T> }    // 稳定引用；值由拥有者就地更新
export function createVolatile<T>(value: T): Volatile<T>

// vendor/loader/src/config/diff.ts:18
if (schema?.meta?.volatile) return true        // volatile 字段被排除出比较
```

判定条件：**Config 字段的 Schemastery schema 带 `meta.volatile`**。此时改动只触发
`_commitVolatile` —— 把新值提交进运行中的引用 + 给 fiber 发 `loader/volatile-update`，
**不 remount**；普通字段一变就走常规 remount。

### 实施计划与三个待验未知

计划：

1. `featsw.mjs` 声明 `Config`（Schemastery），开关值取自 `apply(ctx, config)`；活的字段走 `Volatile.get()`
2. `ctx.settings.configure({auto: true})` → 官方 Settings 自动出表单
3. 删 `overrides`；`~/.dsh/features.json` 只作迁移来源，迁完不再读写
4. `featui` 面板改为读 `describe()`、写 `update(ns, …)`，不再直接写文件

**三个未知（必须先实测，不许猜）**：

- **A.** loose 插件（`profiles/<p>/plugins/*.mjs`）能否 import `@deepseek-ai/schemastery`
  —— loader 会给 profile 插件映射 `@deepseek-ai/*`（mailbridge 引 `dsh-tools` 是通的），但 schemastery 没验过
- **B.** Schemastery 里 volatile 那个 meta 怎么标（源码只显示**读** `schema.meta.volatile`，没找到写的地方）
- **C.** volatile 的 plumbing 对 loose 插件是否同样生效（官方都是编译过的包）

顺带：官方 SKILL 明说 *"Do not write the profile's `package.json` or `cordis.patch.yml` … `install_bundle`
performs those steps"* —— 而 `install.mjs` 现在正是手写 profile patch。**部署割接到 bundle 是同一批工作。**

### 6.21.1 A/B/C 三个未知：**全部实测通过**，并撞出一个决定性事实（同日）

探针插件跑在一次性 `forge-test` 实例上（`bundle/plugins/schemaprobe.mjs`，验完已拆）。

**A. loose profile 插件能否 import `@deepseek-ai/schemastery`？ ✓ 能**

静态 `import z from '@deepseek-ai/schemastery'` 在 `profiles/<p>/plugins/*.mjs` 里正常加载。
导出：`ValidationError, extend, resolve, from, lazy, natural, percent, date, regExp,
arrayBuffer, is, any, never, const, string, number, boolean, bitset, function, array,
dict, tuple, object, union`。

**B. volatile 怎么标？ ✓ 用 Schema 原型上的 `.volatile()`**

枚举 `Object.getPrototypeOf(z.boolean())` 的全部方法：

```
~standard, toJSON, set, push, i18n, extra, required, disabled, collapse, hidden,
loose, deprecated, experimental, pattern, simplify, toString, role, default, link,
comment, description, max, min, step, volatile          ← 就在这儿
```

- `.set('volatile', true)` → **抛错** `Cannot set properties of undefined (setting 'volatile')`
- 手工给 `.meta` 赋 `{volatile:true}` → 读得到 `meta.volatile = true`，但**必须赋在最终那个字段 schema 上**。
  第一版探针把它赋在一个游离 schema 上，回读实际字段 `Config.dict.flags.meta.volatile === undefined` —— **等于没标**。
- **正确做法：`z.object({...}).default({...}).volatile()`**；回读 `Config.dict.flags.meta.volatile === true` ✓

**C. volatile 的 plumbing 对 loose 插件生效吗？ ✓ 生效**

```
C) apply 收到 config.flags：typeof = object，typeof flags.get = function，keys = get
C) flags.get() = {"probeFlag":false}
```

**到达 `apply` 的不是值，是一个 `Volatile` 引用**（`{get()}`），用 `.get()` 取当前快照 —— 与
`vendor/cosmokit/src/volatile.ts` 的 `interface Volatile<T> { get(): VolatileSnapshot<T> }` 完全对得上。

官方设置面也在：

```
settings.describe() 条目数 = 22
属于本插件的 ns = ["schemaprobe"]        ← ns **就是 profile entry id**
descriptor: revision=0  applies=live  autoGenerate=true
descriptor.value = {"flags":{"probeFlag":false}}
```

`applies: 'live'` ✓、`autoGenerate: true` ✓（会自动出表单）、`revision` ✓（乐观并发）。

### ★ 决定性发现：`settings.update()` 拒绝写「由 profile patch 拥有的 config」

唯一失败的一步：

```
settings.update(ns, patch, revision) → Error:
  Configuration for "schemaprobe" is overridden by a home patch or command-line overlay
```

**原因**：`install.mjs` 把 forge 的行**手工合并进了 `profiles/<p>/cordis.patch.yml`**（home patch）。
该层**压过**插件自身的 config，于是官方设置面认为这份配置不由它管，**拒绝编辑**。

**后果（这条比风格问题硬得多）**：

- 只要 forge 还靠 `install.mjs` 手写 profile patch，**官方 Settings 就改不动 forge 的任何 config**
  —— featsw 搬上官方设置这件事**根本做不成**。
- 反过来，若 forge 以 **bundle** 形态安装，行来自 **bundle 层**，profile patch / 用户设置层压在它**上面**
  → 可编辑 ✓。

**所以「部署割接到 `install_bundle`」不是顺手美化，而是 featsw 走官方设置的前置条件。**
官方 SKILL 那句 *"Do not write the profile's `package.json` or `cordis.patch.yml` … `install_bundle`
performs those steps"* 到这里有了机制层面的理由，不再只是约定。

### 结论：featsw 改造的可行性已确认

| 需要的能力 | 状态 |
|---|---|
| loose 插件声明 Schemastery `Config` | ✓ 实测 |
| 标记 volatile 字段（`.volatile()`） | ✓ 实测 |
| `apply(ctx, config)` 拿到 `Volatile` 引用并 `.get()` | ✓ 实测 |
| 官方 Settings 自动出表单（`autoGenerate`） | ✓ 实测 |
| 改动 live 生效（`applies:'live'`） | ✓ 实测 |
| **让官方 Settings 真的能写** | ✗ **要先完成 bundle 割接** |

## 6.22 部署割接到 bundle：**成功**，并纠正我上一轮的错判（2026-10-02）

### 结论

**forge 的宿主插件现在以 bundle 形态装载，割接成立。** 实测证据（重启后）：

```
include:featsw   moduleName = .../profiles/desktop/node_modules/@dsh-forge/bundle/plugins/featsw.mjs
include:console  moduleName = .../bundle/plugins/console.mjs
include:projapi  moduleName = .../bundle/plugins/projapi.mjs

profiles/desktop/cordis.patch.yml   里 ./plugins 行数 = 0（只剩操作员自己的 34 行设置）
profiles/desktop/package.json       dsh.profile.bundles 含 @dsh-forge/bundle
```

**行为变化**：`bundle/package.json` 的 `dsh.bundle.patch` 从 `cordis.npm.yml` 改为 `cordis.patch.yml`
（相对路径版），客户端包改为 `link:` 依赖，`files` 加上 `packages/`；`install.mjs` 仍负责把文件同步进
profile（它现在只服务于"松散副本"这条备用路径）。

### 纠正：我上一轮判"bundle 那条路堵了"是**错的**

我第一次割接拿到 `application: failed` + 12 条 `failed to import`，据此宣布"路堵了、得换机制"。**错了。**

- 我第一版源码判读也错：`findInterceptionLayer` 看似按前缀判断，但 `resolver.ts:178` 是
  `linkedPaths: linkedRoots.flatMap(root => prefixes(root.realPath))` —— **用的就是 realPath**，
  符号链接的真实目标是被算进去的。
- 真正原因是：**拦截层在"启动时"才安装**（`worker-bootstrap.ts` → `installRuntimeInterception`）。
  `install_bundle` 在**运行中**新增一个 root 时，那一层还不存在 → 导入失败；**重启后就有了**。
- 重启后实测：当初失败的一批里 `featsw / mailbridge / llmrouter / injector / skillmanager / projmem`
  **全部 `phase=active`** ✓

与官方那句吻合：*"Installing a new bundle can activate through HMR; **replacing an installed package
requires restart to load a fresh JavaScript module generation**."*

**教训**：`application: failed` 不总等于"装不上"——要区分**装载时机**与**装载能力**。
判死刑前先问："这会不会只是缺一次重启？"

### 未解：6 行在 bundle 里 `enabled=true` 但 `fiberPhase=null`

`modeswitch, teamhub, modsub, modelroute, codexsub, web-search-kimi` —— 启用但 fiber 未活，
loader 行上**不带错误详情**（只有 `entryId/moduleName/enabled/fiberPhase/patchId`），
这次重启**也没留下 startup 日志**（`~/.dsh/logs/` 里最新那份是 09:24 的，
内容是**我自己**跑 schemaprobe 时的 `EADDRINUSE 49793`，与本问题无关）。

**临时处置（已生效）**：把这 6 行用 home patch 同 id 覆盖回 `./plugins/*.mjs`（patch 层同 id 会覆盖
bundle 行，模块解析到 profile 里的副本）→ **6 行全部 `phase=active`，实时生效无需重启**。

代价：这 6 行重新变成"归 home patch 所有"，因此**它们的 config 又会不可被官方设置编辑**。
featsw 不在其中（它走 bundle）✓，所以不影响下一步。

**待查**（下一轮）：为什么恰好这 6 个。可疑方向：这 6 个是否都 `inject` 了某个在 bundle 行顺序下
尚未就绪的服务（`provide()` 时序），而不是导入失败 —— 因为若是导入失败，重启后应当与其余 6 个一样恢复。

### 重启同时生效的另外两项

- `projapi` 的新报错文案已上线（实测：`客户端没给出当前会话（from 为空）…`）
- `probeReport` 探针已真正拆除（`probeReport`/`writeFile`/`DSH_HOME` 计数均为 0）

### 客户端 `from` 取值的根因（操作员实测撞到）

操作员在 forge 面板点发送，回 `from/to 不能为空`。根因：`SessionListState` **没有 `current` 字段**，
我写的 `props.useSessions((x) => x.current)` 恒为 `undefined` → 服务端 `str()` 成空串。
官方取法（`ui-workspace/src/client/tree.ts:38` 的 `mainSessionId`）是从 `byId` 里挑
`retainedBy.mainView > 0` 的那个。已按此改写。

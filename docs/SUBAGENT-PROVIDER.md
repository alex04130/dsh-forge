# 自研 subagent provider（设计文档）

> 状态：设计阶段 / 独立里程碑（未排期）。
> 对照基准：接口签名以 `@deepseek-ai/dsh` **0.1.0-rc.6** 为准（dsh-subagent /
> dsh-subagent-*-driver / dsh-tool-cordis 同为 0.1.0-rc.6）。
> 过渡补丁：`dynamic/auto-plugins.json` 的 `subflt` 已演进到 v2——① 包装
> `subagents.reportFrom`，父会话忙碌时把 report 改走 steer（与结算通知同策略；
> 父不可解析或 steer 被拒时回落官方 followup 转发）；② 在父会话 pre-step 做
> **同轮去重**：仅丢弃「同轮已有同一 child 结算通知」的重复 report，中途进度
> 报告保留。本文档描述的终态实现上线后，`subflt` 应被摘除。

## 1. 背景与问题

官方 `dsh-subagent` 对子代理的产出采用**双投递**语义：

1. **结算通知（settlement notice）**：父会话忙碌时通过 steer 投递，携带子代理的收尾
   消息（closing message）——父会话在**当前轮**就能看到。
2. **排队转发报告（relay report）**：`"Background subagent X reported:"` 经由
   `followup` 排入父会话 inbox——落在**之后的某一轮**，内容与结算通知重复。

后果：同一次子代理产出跨轮出现两次，时间线混乱（尤其多子代理并行时交叠）。
subflt v1 的过滤虽然去掉了重复，但也把**中途进度报告**一并过滤掉了——官方语义下
子代理 turn 未结束时投递的 progress report 同样走 report 通道。现行 v2 已改为
同轮去重（只丢与结算通知重复的 report），中途汇报得以保留；但「report 与
settlement 合并为一次投递」的终态语义仍未实现，见 §2。

## 2. 目标语义

自研 provider 替换官方 report/结算投递语义，核心三条：

- **合并（merge）**：report 与 settlement 合并为**一次 steer 投递**。子代理结束时，
  无论原始内容由 reportFrom 还是结算路径产生，父会话只收到一条通知。
- **去重（dedup）**：同一 child 的内容按稳定标识（childId + 产出标识）幂等合并；
  已随结算投递过的 report 不再重复排队。
- **可中途汇报（mid-flight progress）**：turn 未结束的进度报告保留并按调度预设
  投递**一次且仅一次**；父会话忙碌时的排队策略显式定义（见 §6 开放问题）。

不变量：**父会话的任意一轮中，同一 child 的未读投递至多一条**。

## 3. 官方契约面（对齐依据）

自研实现必须遵守宿主已公开的契约，才能被工具层无缝替换。

> 本节接口引用官方 `@deepseek-ai/dsh-*` 包的内部实现，对照基准版本见文头声明；
> 每次升级后按 §5 的验收清单逐条复查。

### 3.1 SubagentProvider（provider 注册面）

```ts
export interface SubagentProvider {
  readonly name: string
  readonly capabilities: SubagentCapabilities
  readonly inheritsParentContext: boolean
  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun>
  prepareContinuable?(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>
}
```

注册途径：`SubagentRuntime.registerProvider(provider)`（cordis service），
注册后触发 `'subagent/provider-added'` 事件。

### 3.2 SubagentRuntime（结算/投递服务面）

```ts
startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>
followup(parent, childId, content, options): Promise<MessageId>
interrupt(targetSessionId, authority): void
reportFrom(child, content, options): Promise<MessageId>
registerContinuableSetup(contribution: ContinuableSetupContribution): () => void
drainContinuableDescendants(parents: readonly Agent[]): Promise<void>
listChildren(parentSessionId, signal?): Promise<SubagentListEntry[]>
listDescendants(rootSessionId, signal?): Promise<SubagentDescendantListEntry[]>
```

关键既有语义（改动前须逐条确认不破坏）：

- **inbox 是唯一队列**：`followup` 接受的每条消息有且仅有一个可观测顺序。
- **reportFrom 不结束 turn、不改变 Activation 生命周期**：仅做授权 + 父会话投递。
- **waking-send 记账窗口**：注册消息 id 先于 send，防止 continuation 管理的父会话
  在 `followup()` 到接收微任务之间被误判 quiescent。
- **interrupt 异步生效**：`Agent.cancel(cause, { keepInbox: true })`，已认领的工作不
  重新排队。

## 4. Activation 生命周期管理

官方 runtime 对 continuable 子代理的活性建模，自研 provider 复用同一模型：

| 状态 | 投递行为 |
| --- | --- |
| `running` | `followup` 直接入队（enqueue） |
| `waiting` | 唤醒同一个 Agent（wake） |
| 缺席（absent） | 从持久化 Session 冷启动新 Activation（cold-resume） |

要点：

- Activation 句柄 **process-local、永不持久**；持久真相只有 Session 与 inbox。
- `startContinuable` 在 inbox 接受前失败必须回滚（dispose handle + 回滚 Activation
  与父归属）；接受后管理器独立持有 Activation。
- 关停路径：关闭准入 → 等待全部已准入的 materialization 走完 publication 或
  rollback → 子树先序释放句柄；单支失败不阻断其余分支，聚合只在全部结束时 reject。
- `closingScopes` 防止宿主 teardown 期间同名 id 重新准入。

## 5. 兼容与迁移

- **工具层不动**：`dsh-tool-subagent` / `dsh-tool-subagent-report` /
  `dsh-subagent-spawn-in-process` / `dsh-subagent-fork-in-process` 等继续走
  `SubagentRuntime` 公共面；自研 provider 只替换 provider 注册与投递语义。
- **过渡期**：`subflt` v2 继续做 report 通道 steer 化与同轮去重；自研 provider 的
  merge/dedup 生效后，按子代理类型逐步摘除这些规则，最终整体移除 `subflt`。
- **既有插件**：`modsub.mjs`（spawn_model_subagent）、`teamhub.mjs` 通过
  `startContinuable` 建立子代理，迁移不应改变它们拿到的 `childId`/`messageId`
  形状与 inbox 语义。
- **npm 升级风险**：官方 `@deepseek-ai/dsh-*` 包升级可能覆盖契约注释语义，升级后
  须重跑本仓库 `npm run check` 与运行时验收（见 `docs/ARCHITECTURE.md` 升级清单）。

## 6. 里程碑拆分（独立里程碑，未排期）

- **M1 观测**：运行时侧打点统计双投递行为（settlement vs relay report 的到达轮次、
  内容重叠度），为 merge/dedup 提供基线。
- **M2 最小 provider**：实现 `start` + `prepareContinuable`，先覆盖 spawn 场景
  （对齐 modsub 的用法）；注册进 `SubagentProvider` 并与官方 provider 并存。
- **M3 新投递语义**：merge + dedup + 中途汇报；定义父会话忙/闲时的调度预设
  （steer vs wake vs 队列），实现"任意一轮同一 child 至多一条"不变量。
- **M4 替换与摘除**：将既有 spawn/fork 子代理切到自研 provider，验证时间线唯一性
  后移除 `subflt`，回归 `dev_plugin_status` / 多子代理并行场景。

每步验证点：父会话时间线截图（同一 child 只出现一次产出）、中断语义
（interrupt 后不重排队）、冷启动 resume、宿主关停 drain 不悬挂。

## 7. 风险与开放问题

- **R1**：合并后，依赖 report 内容做中断/重定向决策的既有会话行为会变化——
  需要在 M3 前盘点受影响会话。
- **R2**：官方包升级可能直接改 report/结算实现，subflt 的过滤锚点
  （`source.kind === 'subagent-report'`）随时可能失配——升级后必须立刻验证。
- **O1**：dedup 依据尚未定稿——childId + 消息 id？childId + 轮次？是否需要跨
  restart 的幂等键？
- **O2**：中途汇报的节流与合并窗口（同一 turn 多次 progress report 是否折叠、
  折叠窗口多长）。
- **O3**：自研 provider 与官方 provider 并存期间，不同子代理来源的投递语义不一致
  是否可接受（建议 M3 起只对自研 provider 管辖的子代理启用新语义）。

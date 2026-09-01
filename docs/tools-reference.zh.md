# dsh-forge 工具参考：逐个工具的详细定义（草稿）

## 说明：权威源与更新机制

- **权威源是运行时侧**（`~/.dsh` 运行时目录），不是仓库里的副本。本文档依据以下文件逐行读取生成：

  1. `~/.dsh/profiles/web/plugins/mailbridge.mjs`
  2. `~/.dsh/profiles/web/plugins/llmrouter.mjs`
  3. `~/.dsh/profiles/web/plugins/modeswitch.mjs`
  4. `~/.dsh/profiles/web/plugins/teamhub.mjs`
  5. `~/.dsh/profiles/web/plugins/modsub.mjs`
  6. `~/.dsh/profiles/web/plugins/injector.mjs`
  7. `~/.dsh/profiles/web/plugins/modelroute.mjs`
  8. `~/.dsh/profiles/web/plugins/lib/subagent-policy.mjs`（共享库：能力面判定 / 提权审批 / mode+effort 注入的行为核心）
  9. `~/.dsh/auto-plugins.json`（动态插件清单；`plugins[]` 中 `idPrefix` 为 `sklui` / `plins` / `sfind` 三条的 `hostCode` 字段）
  10. `~/.dsh/profiles/web/plugins/archive.mjs`
  11. `~/.dsh/profiles/web/plugins/verify.mjs`
  12. `~/.dsh/profiles/web/plugins/plasmid.mjs`
  13. 补充只读参考（非权威清单，仅用于确认语义要点 6 的报错行为）：`~/.dsh/profiles/web/plugins/skillmanager.mjs`（`skillRegistry` 服务的实现者）

- **更新机制**：运行时侧改动经 dsh-forge「同步清单」（编号 #N 递增）同步到仓库时，必须同步更新本文件。改动运行时侧任何工具行为后，先跑一遍本文件对应小节，对不上的行号与语义以运行时代码为准改文档。
- **行号约定**：文中括号注明源文件与行号（如 `(mailbridge.mjs:192)`），行号以本次生成时读取的文件为准；`auto-plugins.json` 的 `hostCode` 是 JSON 字符串，行号指该字符串按 `\n` 展开后的行号（即文中 `hostCode L41` 表示该插件 hostCode 内容的第 41 行）。
- **标注约定**：凡代码行为与描述/预期不一致、或代码里没有依据的细节，一律标注「（待审校确认）」；不编造代码里没有的行为。
- **通用约定（所有工具）**：
  - 全部工具的注册/输出口径见速查表（当前 52 个 = 49 个机器索引 + 3 个作者工具：switch_mode / session_mode / spawn_model_subagent）。输出均为**一个 pretty-print 的 JSON 字符串**（`jsonText` = `JSON.stringify(value, null, 2)`），不是结构化对象。
  - 每个工具都包了一层统一异常处理（各插件的 `registerTool` 包装或 `defineTool` 内的 try/catch）：`execute` 抛出的任何异常转为 `{"ok": false, "error": "<message>"}`。
  - 除 `dev_inject_plugin` 与 plasmid 系列（`plasmid_submit` / `gap_report` 的接受/拒绝形态用 `accepted` + `gate`、`plasmid_search` 无 `ok` 外壳，见 plasmid 一节）外，各工具明确失败路径均返回 `ok: false` 并带 `error`（或 `cancelled`）字段，见各小节「边界与失败」。
  - 注册形态分两种：composition 插件（mailbridge / llmrouter / teamhub / injector / modelroute / modsub / modeswitch / archive / verify / plasmid）直接用 `defineTool` 注册；auto-plugins 动态插件（4a 迁移后代码外置 dynplugins/，hostFile/clientFile 路径引用）用 `harness.defineTool` + `harness.registerTool(ctx, tool)` 或薄桥守卫 `libRegisterGuarded` 注册（见附录）。

- 每个工具小节新增「**工具提示词（模型可见的 description，原文）**」字段：收录该工具注册时传给 `defineTool` 的 `description` 原文（即模型看到的工具提示词）；参数级提示词见各参数表的「说明」列（已尽量原文收录）。

---

## 工具清单速查（插件 × 工具，共 49 个（含 gitdk 已退役工具；不含 modeswitch/modsub 的作者工具面））

| 插件 | 工具 | 一句话用途 |
| --- | --- | --- |
| mailbridge | `session_list` | 列出本进程会话（id / 标题 / 在线状态），默认 50、上限 200 |
| mailbridge | `session_read` | 只读另一会话近期消息日志（默认 20 条、上限 500） |
| mailbridge | `session_send` | 给另一会话发消息：在线即时投递，离线持久排队，可 `wake:true` 冷启动 |
| mailbridge | `session_archive` | 归档本主会话下辖的子会话（含子子会话；主代理不可被归档） |
| mailbridge | `session_unarchive` | 捞出（取消归档）本主会话下辖的已归档子会话（含子子会话） |
| mailbridge | `session_list_archived` | 列出本主会话下辖的已归档子会话（含子子会话；已从默认结果隐藏，文件仍在） |
| mailbridge | `session_export` | 把会话（默认=调用方自己）递归导出为明文：连同其下辖全部子会话一并导出 |
| mailbridge | `mailbox_check` | 收取并消费排给本会话的离线消息 |
| gitdock | `git_status` | Show the git working tree status of the session workspace |
| gitdock | `git_log` | Show the recent git commit history of the session workspace |
| gitdock | `git_show` | Show one git commit in detail: full message, file stat, and patches |
| gitdock | `git_diff` | Show the git diff of the session workspace: unstaged changes |

> ⚠️ gitdock（v8）已随"gitdk 默认不加载"（2026-09-01）退役，工具保留在册待移除。
| llmrouter | `model_list` | 列出所有 provider 路由、模型清单与 byModel 反向索引 |
| llmrouter | `model_call` | 一次性纯文本模型借调（非子代理），流式取回完整回复 |
| modeswitch | `switch_mode` | 会话中途切换 agent preset，能力增加时先审批 |
| modeswitch | `session_mode` | 查询任意会话当前生效的模式（在线读组合，离线读日志） |
| teamhub | `team_create` | 以调用方为队长创建团队（每队长至多一个；可随队批量加成员/建任务） |
| teamhub | `team_add_member` | 派发可续子代理成员，提权先审批，上限 16 人 |
| teamhub | `team_add_members` | 批量派发成员：逐项独立审批与失败隔离 |
| teamhub | `team_create_task` | 拆任务，可声明依赖与指派人 |
| teamhub | `team_claim_task` | 认领任务（依赖须全部完成；队长可代认领） |
| teamhub | `team_update_task` | 推进任务状态（六状态机，限 assignee / 队长） |
| teamhub | `team_wait` | 挂起当前回合，等成员消息或任务完成（默认 600s，上限 3600s） |
| teamhub | `team_send_message` | 给队长或成员发消息（在线投递 / 离线排队） |
| teamhub | `team_status` | 团队全貌：成员在线状态、任务板、收件箱 |
| teamhub | `team_delete` | 打断成员并归档团队 |
| modsub | `spawn_model_subagent` | 派发可续子代理，默认全继承父级，提权（含 sandbox 拓宽）先审批 |
| injector | `dev_inject_plugin` | 运行时注入本地插件包（symlink + loader.create + 注册表） |
| injector | `dev_uninject_plugin` | 取消注入（释放 fiber、移除 symlink、删注册表条目） |
| injector | `dev_injected_list` | 列出所有已注入插件包（名称 + 源目录） |
| injector | `dev_reload_package` | 重建注入条目（fiber 释放 + 重新导入） |
| injector | `dev_plugin_status` | 注入注册表 + 每个 loader 条目（id / 名称 / 禁用态） |
| modelroute | `model_taxonomy` | 显示模型系列/档位分类并可对一个模型 id 归类 |
| modelroute | `model_route_status` | 显示当前代理路由；子代理显示被钳制到的父级 live 路由 |
| sklui | `skill_list` | 列出调用方可见技能（名称/provider/可调用性/描述） |
| sklui | `skill_show` | 显示一个技能的完整 Markdown 正文 |
| sklui | `skill_add` | 添加持久运行时技能（host/全局层） |
| sklui | `skill_disable` | 禁用本管理器添加的技能（可恢复） |
| sklui | `skill_enable` | 重新启用本管理器禁用的技能 |
| sklui | `skill_remove` | 永久移除本管理器添加的技能 |
| plins | `dev_stop_dyn_plugin` | 按 pluginId 前缀应急停止动态插件（宿主+客户端两半） |
| sfind | `session_find` | 按关键字查会话（id/标题），优先于 session_list 省上下文 |
| archive | `archive_read_event` | 按 sessionId+seq 精确读事件及上下文窗口（证据句柄的权威读取端） |
| archive | `archive_list_events` | 列会话事件索引（seq/type/time/surface），快速扫一眼 |
| archive | `archive_filter_events` | 会话内按类型/关键字过滤（字面量匹配，不区分大小写、忽略多余空白） |
| archive | `archive_trace` | 追踪祖先链与后代树（谁派生了谁） |
| verify | `verify_claim` | 言行一致验货：git commit / 文件存在 / 文本条目，返回 evidence 原文 |
| plasmid | `plasmid_submit` | 自荐制质粒提交：四道闸（格式/证据/密钥/查重）全自动，只可新增/更新、不可删除 |
| plasmid | `plasmid_search` | 拉取制检索：按相关度+适用度排序返回摘要列表 |
| plasmid | `plasmid_get` | 按 id 拉取一条质粒完整文本 |
| plasmid | `plasmid_report` | 用后反馈 worked/failed，fitness 滑动窗口跌破 0.3 降级 idea |
| plasmid | `gap_report` | 缺口报告进待办：outlet 出口三选一，共用质粒管道 |

---

## mailbridge（跨会话消息桥）

**插件级说明**：让同一 DSH 进程内的会话互相收发消息。持久邮箱用 `storage` 的 `json` 后端 + kv 面，单元名 `agent_mailbox`、表 `msg`、`hasGlobal:false`（`mailbridge.mjs:91-94`）；打不开则所有依赖邮箱的操作报 `mailbox storage unit failed to open: …`。插件监听 `agent/session-start` 事件：把排队给该会话的消息逐条 `followup` 投递，投递成功才删除记录、失败保留待下次再试（`mailbridge.mjs:305-330`）。四个工具均引 `cross-session-mailbox` 技能作为完整工作流。

### session_list

- **所属插件**：mailbridge
- **一句话用途**：列出本 DSH 进程中的会话（在线与已持久化），含 id、标题与在线状态。

- **工具提示词（模型可见的 description，原文）**：
  > 列出本 DSH 进程中的会话（在线与已持久化），含 id、标题和在线状态。只要知道 id 或标题片段就优先用 `session_find`——大进程中完整名册很耗上下文；只有确实需要完整名册时才用 `session_list`。完整工作流见 `cross-session-mailbox` 技能。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | limit | number | 否 | 50（上限 200） | 最大返回会话数；非法/非正数回落默认，超过 200 截断为 200 |

- **输出**：`{"ok": true, "count": <返回条数>, "sessions": [{"sessionId": "...", "title": "..."|null, "live": true|false, "persisted": true, "createdAt": null}]}`。`title` 来自投影缓存，缺失为 `null`；`persisted` 恒为 `true`、`createdAt` 恒为 `null`（字段为占位，`mailbridge.mjs:148-149`）。
- **语义**：
  - 遍历 `DSH_HOME/sessions/<workspace>/<sessionId>` 目录结构收集会话 id（`listSessionIds`，`mailbridge.mjs:36-51`；任何一层读不到就静默跳过）。
  - 标题从投影缓存 `DSH_HOME/storages/session_projcache.json` 的 `tables.sessions[id].rows.title.val` 读取，best-effort（`readTitles`，`mailbridge.mjs:53-68`）。
  - `live` 由内存会话注册表判定（`sessions.get(id)` 是否存在，`mailbridge.mjs:147`）；会话目录与缓存取交集前的顺序即目录遍历顺序。
  - 描述明确要求：知道 id/标题片段时优先用 `session_find`，大进程里全量名册很耗上下文（`mailbridge.mjs:137`）。
- **边界与失败**：
  - sessions 根目录不可读、缓存缺失时**不报错**，返回 `ok: true` 且列表相应为空/标题为 null。
  - 结果截断到 `limit`（默认 50、上限 200），没有分页游标。
  - 目录里存在但投影缓存无标题的会话依然会出现（title 为 null）。
- **关联**：`session_find`（sfind，优先替代）、`session_read`、`session_send`；技能 `cross-session-mailbox`。

### session_read

- **所属插件**：mailbridge
- **一句话用途**：读取另一会话的近期消息日志（仅精确读取，用户/助手/工具三类），发消息前摸底或收集结果用。

- **工具提示词（模型可见的 description，原文）**：
  > 读取另一会话的近期消息日志（仅精确读取）：用户、助手和工具消息及其文本，按时间从旧到新。用于给某会话发消息前了解它在做什么，或收集它的结果。完整工作流见 `cross-session-mailbox` 技能。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | sessionId | string | 是 | — | 目标会话 id（来自 session_list） |
  | maxEvents | number | 否 | 20（上限 500） | 最大返回事件数 |

- **输出**：`{"ok": true, "sessionId": "...", "count": <事件条数>, "events": [{"type": "user"|"assistant"|"tool", "time": <ts>, "text": "..."}]}`。事件按时间从旧到新，返回**最后** `maxEvents` 条（`events.slice(-cap)`，`mailbridge.mjs:189`）。
- **语义**：
  - 通过 `sessionPersistence.inspect(sessionId)` 取快照（`mailbridge.mjs:166`）。
  - 只映射三种事件：`user/message`、`assistant/message`、`tool/result`；其余事件类型被跳过。`tool/result` 只取 `message.content[0]` 里嵌套的 text block（`mailbridge.mjs:179-182`）。
  - 每条 `text` 超 4000 字符截断并追加 ` ...(truncated)`（`mailbridge.mjs:185`）。
- **边界与失败**：
  - `sessionPersistence` 服务缺失 → `{"ok": false, "error": "sessionPersistence service is not available in this deployment"}`（`mailbridge.mjs:163`）。
  - `inspect` 抛错 → `{"ok": false, "error": "failed to read session: <原因>"}`（`mailbridge.mjs:168`）。
  - 快照事件为空数组时不报错，返回 `count: 0`。
- **关联**：`session_send`、`session_find`、`session_list`；技能 `cross-session-mailbox`。

### session_send

- **所属插件**：mailbridge
- **一句话用途**：向另一会话发消息——在线即时投递并唤醒；离线持久排队、下次会话启动时送达；`wake:true` 强制冷启动离线目标。

- **工具提示词（模型可见的 description，原文）**：
  > 向本 DSH 进程中的另一会话发送消息。在线目标会立即在收件箱收到并醒来；否则消息持久排队，在该会话下次启动时送达。`wake: true` 时离线目标立即冷启动（加载其已持久化日志，会话重启并立刻处理该消息），而不是等它下次手动启动——用于强制睡眠中的会话现在就干活；会消耗目标会话的模型回合。wake 仅主会话可用（子代理被拒），同一目标 60 秒内最多 3 次。接收方看到的文本带 `[cross-session message from <session name> (<sessionId>)]` 前缀。完整工作流见 `cross-session-mailbox` 技能。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | targetSessionId | string | 是 | — | 目标会话 id（来自 session_list） |
  | text | string | 是 | — | 消息正文，禁止空串 |
  | wake | boolean | 否 | false | 强制唤醒离线目标：冷启动其已持久化日志并立即送达（消耗目标会话模型回合）；仅主会话可用（子代理被拒），同一目标 60 秒内最多 3 次 |

- **输出**（三种成功形态 + 三种失败形态）：
  - 在线投递：`{"ok": true, "delivered": "live", "targetSessionId": "...", "messageId": "...", "from": "..."|null, "fromName": "..."|null}`（`mailbridge.mjs:231`）
  - 排队：`{"ok": true, "delivered": "queued", ...同 live 字段}`（`mailbridge.mjs:280`）
  - 唤醒投递：`{"ok": true, "delivered": "woken", ..., "agentOptions": {"provider": "...", "model": "..."}|null}`（`mailbridge.mjs:259`）
  - 失败：空正文（`mailbridge.mjs:231`）；wake 守卫两条——`{"ok": false, "error": "wake is restricted to the main session (subagents cannot cold-start sessions)"}` 与 `{"ok": false, "error": "wake rate limit exceeded for this target (3 per 60s); wait before waking again"}`（`mailbridge.mjs:105-116, 264-265`）；`{"ok": false, "error": "wake failed: <原因>", "targetSessionId"}`（`mailbridge.mjs:308`）；`{"ok": false, "error": "unknown session id \"...\"; use session_list to see available sessions"}`（`mailbridge.mjs:314`）
- **语义**：
  - **消息包裹（begin/end 标记）**：正文以 `[cross-session message from <发送方标题> (<发送方 id>)]` 开头、`[cross-session message end]` 结尾；发送方未知时标签为 `unknown`（`mailbridge.mjs:203-217`）。正文尾部的旧式结束标记（`[/cross-session message]`、`[cross-session message end]`）先用正则剥掉，避免标记叠加（`mailbridge.mjs:209`）。
  - **回复指引**：当能确定发送方 id 时，包裹末尾附中文提示——若消息要求回复，处理后须用 `session_send` 把结论发回给发送方会话而不是只写在本地（`mailbridge.mjs:214-216`）。
  - **双路径投递**：目标在内存注册表（`agents.get`）时即时投递——`status === 'running'` 走 `steer`，否则走 `followup`（`mailbridge.mjs:226-230`）；投递抛错则**静默降级**到持久排队（`mailbridge.mjs:232`）。
  - **wake:true 冷启动**：从目标已持久化日志**倒序**找最近一条 `request/header` 事件里的 `config.provider`/`config.model`，带着这份 `agentOptions` 调 `agents.resume({resumeSessionId})`，让唤醒回合按目标上次的路由计费而不是全局默认（`mailbridge.mjs:234-252`）；resume 成功后同样 steer/followup 投递。只带 provider/model 不带 reasoningEffort 是**有意为之**（运行时侧审校确认）：① `ResumeAgentOptions.agentOptions` 类型只有 provider/model/maxTokens 三个字段，没有 effort；② `agents.resume` 会加载持久化日志，effort 从该会话的 request/header 历史自然恢复；显式带 provider/model 是防全局默认覆盖的双保险。
  - **离线排队**：先 best-effort 校验会话 id 存在（不存在则报 unknown session id），再经写串行队列 `enqueue` 把 `{id, from, fromName, to, text: wrapped, ts}` 写入邮箱 `msg` 表（`mailbridge.mjs:266-279`）。投递发生在目标下次 `agent/session-start` 的监听器里（`mailbridge.mjs:305-330`），成功后删除、失败保留重试。
- **边界与失败**：
  - `text` 为空串直接失败；wake 与排队路径互斥（wake 成功即返回）。
  - **wake 守卫（安全评审 t7-H3）**：`wake: true` 仅主会话可用（按会话头 origin/parentSession 判定，子代理被拒），且同一目标滑动窗口 60 秒内最多 3 次；守卫不通过直接报错返回，不进排队（`mailbridge.mjs:90-116, 264-265`）。
  - wake 时 `agents.resume` 不可用 → 落到普通排队路径（`mailbridge.mjs:263` 条件不满足即跳过）。
  - **在线 steer/followup 抛错后降级排队**：存在投递半成功也进队列、目标最终收到两份的风险（已对代码确认：降级 catch 里没有去重逻辑，`mailbridge.mjs:261`）。
  - **woken 路径投递失败的回退（sync #37 + P0-2 已修）**：原先 catch 注释声称「message still queued below if delivery fails」但 catch 后无条件 `return 'woken'`、排队代码不可达（丢消息 bug）。现行为：steer/followup 失败 → 重试一次 `followup`（steer 可能与唤醒回合竞争）→ 仍失败 → 落下方持久队列，不谎报 woken；resume 成功但代理未注册时同样**落到持久队列**收尾而不是报错（`mailbridge.mjs:284-306`：每条路径都以在线投递或持久队列结束，不丢消息）。
  - 存在性检查读目录失败时被吞掉，消息仍会照常排队（`mailbridge.mjs:270`）。
- **关联**：`session_list` / `session_find`（取 id）、`mailbox_check`（收取端）、`session_read`；技能 `cross-session-mailbox`；队列投递依赖 mailbridge 的 `agent/session-start` 监听器。

### mailbox_check

- **所属插件**：mailbridge
- **一句话用途**：检查并消费排给本会话的跨会话消息（本会话离线期间发来的），用户问「其他会话有没有发消息」时调用。

- **工具提示词（模型可见的 description，原文）**：
  > 检查并消费排给本会话的跨会话消息（本会话不在线期间发来的消息）。返回消息并从持久队列中移除；用户问其他会话是否发过什么时调用。完整工作流见 `cross-session-mailbox` 技能。
- **参数**：无。
- **输出**：`{"ok": true, "sessionId": "<调用方 id>", "count": <条数>, "messages": [{"id", "from"|null, "fromName"|null, "to", "text", "ts"}]}`（`mailbridge.mjs:302`）。`messages` 是邮箱记录的原始形态，`text` 是已包裹 begin/end 标记的完整文本。
- **语义**：
  - 先解析调用方会话 id（`exec.agent.id`，否则 `agents.currentInitiator()`；`mailbridge.mjs:30-35`）。
  - 在写串行队列里 `loadAll` 邮箱、过滤 `to === 本会话` 的记录、逐条 `deleteRecord` 后再返回（先取后删，消费语义；`mailbridge.mjs:290-301`）。
- **边界与失败**：
  - 调用方 id 解析不出 → `{"ok": false, "error": "cannot determine the calling session id"}`（`mailbridge.mjs:288`）。
  - 邮箱打开失败 → `ok: false` + 打开错误（`requireUnit`，`mailbridge.mjs:97-101`）。
- **关联**：`session_send`（发送端）、`session_read`；技能 `cross-session-mailbox`；与 `team_status` 的 inbox 不同——mailbox 是消费式的，team inbox 只读展示。

---

## llmrouter（模型委派）

**插件级说明**：把一次性文本任务交给任意已配置的 provider/model 并取回完整结果。依赖 `llm` 服务；`llm` 不存在时整个插件静默不注册（`llmrouter.mjs:22`）。引 `model-delegation` 技能。

### model_list

- **所属插件**：llmrouter
- **一句话用途**：列出本进程注册的每条 LLM 供应商路由、其模型清单，以及 byModel 反向索引。

- **工具提示词（模型可见的 description，原文）**：
  > 列出本 DSH 进程中注册的每条 LLM 供应商路由及其提供的模型，外加一个反向索引（byModel：每个模型 id 由哪些供应商提供）。用于为 `model_call` 或 `spawn_model_subagent` 挑选 `provider`/`model` 组合，或检查某供应商/模型是否已配置。供应商通过 llm-pi-ai 设置项配置（baseURL/api/apiKeyEnv/models）；API 密钥按请求从凭据存储解析。用法规则见 `model-delegation` 技能。
- **参数**：无。
- **输出**：`{"ok": true, "providers": [{"id", "name"}], "models": {"<providerId>": [{"id", "name", "description"|null}] | {"error": "..."}}, "byModel": {"<modelId>": ["<providerId>", ...]}}`（`llmrouter.mjs:69`）。
- **语义**：
  - `llm.listProviders()` 取全部路由，逐个 `llm.listModels(provider.id)`（`llmrouter.mjs:50-55`）。
  - 单个 provider 枚举失败不整体失败：该 provider 的 `models` 值变成 `{"error": ...}`（`llmrouter.mjs:56-58`）。
  - `byModel` 反向索引只由**成功枚举**的数组构建（`llmrouter.mjs:60-68`）。
- **边界与失败**：顶层没有失败路径（单 provider 错误内联）；无 providers 时三个字段均为空。
- **关联**：`model_call`、`spawn_model_subagent`（选 provider/model 组合用）；技能 `model-delegation`。

### model_call

- **所属插件**：llmrouter
- **一句话用途**：以一次性、纯文本补全的方式借调另一（或同一）供应商的模型并取回完整回复；不是任务委派、不是子代理。

- **工具提示词（模型可见的 description，原文）**：
  > 以一次性、纯文本补全的方式调用另一供应商（或同一供应商）的模型，并把它的完整回复作为本次工具调用的结果返回。这不是任务委派，也不是子代理：被借调模型只得到一个回合，不能调用工具，只返回文本；主模型始终掌控并消化回复。用于有边界的文本任务（翻译、摘要、分类、第二意见）。通过 `model_list` 挑选 `provider`/`model`。不支持嵌套工具调用：把被借调模型需要的一切都放进 prompt 和 system 文本里。用法规则见 `model-delegation` 技能。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | provider | string | 是 | — | 供应商路由 id（见 model_list） |
  | model | string | 是 | — | 该供应商上的模型 id |
  | prompt | string | 是 | — | 给被借调模型的任务文本 |
  | system | string | 否 | 无 | 可选系统指令 |
  | history | array | 否 | 无 | 先前回合 `[{role: "user"|"assistant", text}]` |
  | maxTokens | number | 否 | 无 | 输出 token 上限（向下取整） |
  | reasoningEffort | string | 否 | 无 | 供应商专属 effort id（思考强度） |

  - 工具超时 `timeoutMs: 600000`（10 分钟，`llmrouter.mjs:152`）。
- **输出**：
  - 成功：`{"ok": true, "provider", "model", "finish": <原因字符串>, "text": "...", "reasoning": "..."|null, "usage": {"inputTokens", "outputTokens", "cacheReadTokens"|null, "cacheWriteTokens"|null, "reasoningTokens"|null}|null}`（`llmrouter.mjs:150`）。`reasoning` 只在非空时返回，否则 null；`usage` 从未收到 usage chunk 时为 null。
  - 流失败：`{"ok": false, "provider", "model", "finish": "error"|"aborted"|"stream-failed", "failure": {"code"|null, "message"}, "partialText": "..."|null}`（`llmrouter.mjs:147-149`）。
- **语义**：
  - 校验 provider/model/prompt 非空（`llmrouter.mjs:87`）；provider 不在注册表 → 立即失败并在 error 里列出可用路由（`llmrouter.mjs:88-89`）。
  - `history` 逐条规范化：role 只区分 `assistant` / 其他一律当 `user`，空文本条目跳过；最后把 `prompt` 作为一条 user 消息追加（`llmrouter.mjs:90-102`）。
  - `system` / `maxTokens` / `reasoningEffort` 仅在提供且有效时写入 options；`exec.signal` 透传用于取消（`llmrouter.mjs:104-107`）。
  - 流式消费 `llm.stream(options)`：累加 `text-delta` 与 `reasoning-delta`，采集 `usage` chunk，`finish` chunk 的原因按四类归一化（error/aborted → 提取 `failure{code,message}`；字符串直接用；带 kind 的对象用 kind；其余 `String(reason ?? 'done')`，`llmrouter.mjs:114-142`）。
  - 流本身抛异常 → `failure = {code: "stream-failed", message}` 且 `finish = "stream-failed"`（`llmrouter.mjs:143-146`）。
- **边界与失败**：
  - `finish ∈ {error, aborted, stream-failed}` 时统一返回 `ok: false` **并附带 `partialText`**（已收到的文本片段，可能为 null）。
  - 被借调模型不能调工具、只有一轮；需要的一切都放 prompt/system。
  - `finish` 为 `"done"` 等正常原因时返回 `ok: true`。
- **关联**：`model_list`（必须先查路由）；`spawn_model_subagent`（多轮/工具型任务的替代）；技能 `model-delegation`。

---

## modeswitch（会话模式切换）

**插件级说明**：会话中途切换 agent preset。能力面比对走共享库 `lib/subagent-policy.mjs` 的 `collectPresetEscalations`。依赖 `agentPresets` 服务，缺失则不注册（`modeswitch.mjs:20`）。

### switch_mode

- **所属插件**：modeswitch
- **一句话用途**：把本会话切换到另一个模式（agent preset），从下一步生效；新增能力时先弹审批，同级或降级直接切。

- **工具提示词（模型可见的 description，原文）**：
  > 会话中途把本会话切换到另一个模式（agent preset）；切换从下一步生效，届时新模式提供工具目录和提示词。切换到授予当前模式所缺能力（权限增加）的模式会请求用户确认，未获允许则取消；能力相同或更少则直接执行，无需询问。目标模式必须存在且能干净挂载，否则调用失败且一切不变。注意事项：此前记录的工具调用只有在新模式定义了相同工具时才保持可读；计划模式状态不会延续。本工具挂在主机组合中，切换后依然可用。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | presetId | string | 是 | — | 目标模式 id，如 "cordis"、"code"、"standard" 或用户自建模式 id |

- **输出**：
  - 同模式：`{"ok": true, "switchedTo": "<presetId>", "unchanged": true}`（`modeswitch.mjs:75`）
  - 成功：`{"ok": true, "switchedTo": "<实际 preset.id>", "added": [<新增能力行名>], "note": "Takes effect from the next step: …"}`（`modeswitch.mjs:103`）
  - 失败：无调用上下文（`modeswitch.mjs:72`）；无审批服务（`modeswitch.mjs:82`）；`{"ok": false, "cancelled": true, "reason": "the user did not allow this preset switch (approval outcome \"...\"); nothing changed"}`（`modeswitch.mjs:91`）；`{"ok": false, "error": "recompose failed: ..."}`（`modeswitch.mjs:98`）
- **语义**：
  - 读取当前组合模式 `presets.composedPreset(agent.ctx)`；等于目标则 `unchanged: true` 返回（`modeswitch.mjs:74-75`）。
  - **能力面比对**（共享库 `lib/subagent-policy.mjs`）：把当前与目标两个 preset 的 composition 文本解析成插件行名集合，目标**新增**的行即为提权（详见共享库一节）。`added` 非空时必须走审批：`approval.request({toolName: 'switch_mode', reason: <列出至多 12 个新增能力>})`，结果必须是 `allowed-once`，否则取消且一切不变（`modeswitch.mjs:80-93`）。
  - 审批通过后 `presets.recompose(agent.ctx, presetId)` 重组合（抛错即失败，一切不变）；随后 best-effort 向会话日志追加 `agent-preset/selected` 事件做持久记录（`modeswitch.mjs:94-102`）。
  - 切换从**下一步**生效（新 preset 提供工具目录与提示词）；此前记录的工具调用只有在新模式定义了相同工具时才可读；计划模式状态属于旧 preset，不延续（`modeswitch.mjs:103` 的 note 与 `modeswitch.mjs:61` 描述）。
- **边界与失败**：
  - 必须运行在会话内（无 `exec.agent` 即失败）。
  - 当前模式为 null/undefined 时跳过能力比对、不审批（`modeswitch.mjs:77-79`）。
  - **能力面解析失败 → 保守审批**：两个 preset 之一读不到或解析不了时，`collectPresetEscalations` 返回「preset capability face unknown …; treated as an upgrade」，进入审批（`subagent-policy.mjs:62-64`）。
  - 审批服务未挂载且需要审批时直接失败。
  - `agent-preset/selected` 事件追加失败不影响切换结果（best-effort，`modeswitch.mjs:101-102`）。
- **关联**：`session_mode`；共享库 `lib/subagent-policy.mjs`（collectPresetEscalations）；同策略使用者 `spawn_model_subagent`、`team_add_member`。

### session_mode

- **所属插件**：modeswitch
- **一句话用途**：显示某会话当前运行的模式（agent preset）——在线读组合结果，离线从日志读最近一次选择事件。

- **工具提示词（模型可见的 description，原文）**：
  > 显示某会话当前运行的模式（agent preset）。在线会话从自身上下文读取组合后的模式；已持久化的离线会话从其日志读取最近一次 agent-preset/selected 事件。用于确认本会话、某个子代理或任何其他会话当前处于什么模式。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | sessionId | string | 否 | 调用方会话 id | 目标会话 id；省略则查询调用方 |

- **输出**：
  - 在线：`{"ok": true, "sessionId", "live": true, "preset": "<组合后的 preset id>"|null}`（`modeswitch.mjs:40`）
  - 离线：`{"ok": true, "sessionId", "live": false, "preset": "<最近一次 agent-preset/selected 事件>"|null}`（`modeswitch.mjs:48`）
  - 失败：`{"ok": false, "error": "no session id and no calling agent context"}`（`modeswitch.mjs:36`）；`{"ok": false, "error": "session not found (or no persistence to inspect): <id>"}`（`modeswitch.mjs:50`）
- **语义**：
  - 目标 id 缺省时取 `exec.agent.id`（`modeswitch.mjs:35`）。
  - 在线：`agents.get(targetId)` 命中则 `presets.composedPreset(live.ctx)`（`modeswitch.mjs:37-41`）。
  - 离线：`sessionPersistence.inspect` 后取**最后一条** `agent-preset/selected` 事件的 `data.agentPreset`（`modeswitch.mjs:42-49`）；既不在线也无持久化服务 → 报 not found。
- **边界与失败**：`composedPreset` 结果可能为 null（preset 为 null 时如实返回）；离线无选择事件时 `preset: null`。
- **关联**：`switch_mode`；`spawn_model_subagent`/`team_add_member`（它们用同一套 preset 组合体系）。

---

## teamhub（代理团队）

**插件级说明**：队长 + 角色成员（可续子代理）+ 依赖任务板 + 成员间直接通信。持久层为 `json` kv 后端单元 `agent_teams`，表 `team`（以队长 id 为 key）、`archive`（归档）、`mail`（成员消息队列）（`teamhub.mjs:50-53`）。成员派发与 `spawn_model_subagent` 共用同一委托策略：`installChildPolicy` + 提权审批（`teamhub.mjs:43-46`）。引 `agent-teamwork` 技能。

**任务状态机（代码常量，`teamhub.mjs:23-31`）**：

- 状态全集 `TASK_STATUSES`：`pending / claimed / in_progress / completed / failed / cancelled`。
- 合法流转 `TASK_TRANSITIONS`：

  | 当前状态 | 允许流转到 |
  | --- | --- |
  | pending | claimed、cancelled |
  | claimed | in_progress、pending、cancelled |
  | in_progress | completed、failed、cancelled |
  | completed | （终态，无流转） |
  | failed | （终态，无流转） |
  | cancelled | （终态，无流转） |

- **claim 规则**（`team_claim_task`，`teamhub.mjs:296-307`）：所有依赖任务必须 `completed`；队长可为任何成员认领（claimant 必须是成员）；成员只能为自己认领；认领即置 `status = claimed` 并写 `assignee`。「取消认领」不是 claim 工具做的——它通过 `team_update_task` 的 `claimed → pending` 流转实现（claim 工具描述提及但实现不包含，`teamhub.mjs:306`）。
- **update 权限**（`team_update_task`，`teamhub.mjs:343`）：仅任务的 assignee 或队长可更新。

### team_create

- **所属插件**：teamhub
- **一句话用途**：以调用方为队长创建团队；一个队长同一时间只能带领一个团队；可随队批量添加成员与任务。

- **工具提示词（模型可见的 description，原文）**：
  > 创建一个以你（调用会话）为队长的代理团队；一个队长同一时间只带领一个团队。可用 `members` 数组在建队时一次添加多个成员（每项含 memberId/role/prompt 及可选的 provider/model/reasoningEffort/mode，与 `team_add_member` 同策略：默认继承队长、提权逐项审批），可用 `tasks` 数组在建队时按数组序创建任务（每项含 title/description/assignee/dependencies；依赖引用的任务必须先出现在本数组或已存在于团队）。之后用 `team_add_member` 补成员、`team_add_members` 批量补成员、`team_create_task` 补任务、`team_send_message` 与成员交流。编排团队前先加载 agent-teamwork 技能：它涵盖团队设计、工作流和何时该沟通。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | name | string | 是 | — | 团队名，1-64 字符 |
  | goal | string | 否 | 空串 | 一行团队目标，送达各成员 |
  | members | array | 否 | [] | 建队时一次添加的成员数组（至多 16 项）；每项 `{memberId, role, prompt, provider?, model?, reasoningEffort?, mode?, sandbox?}`，与 `team_add_member` 同策略，逐项独立审批与失败隔离 |
  | tasks | array | 否 | [] | 建队时按数组序创建的任务；每项 `{title, description?, assignee?, dependencies?}`，依赖引用的任务必须先出现在本数组或已存在于团队 |

- **输出**：`{"ok": true, "team": {"teamId", "name", "goal", "captain", "members", "tasks", "nextTask", "createdAt"}, "memberResults"?: [...], "taskResults"?: [...]}`（`teamhub.mjs:336-341`）；传了 members/tasks 时分别附逐项结果（每项 `{ok, memberId|taskId, ...}` 或 `{ok: false, error}`）。
- **语义**：以调用方会话 id 为 key 在 `team` 表建记录（队长即 key）；已带队再建直接抛错。先建空团队记录，再逐个走共享 `addMember` 路径派发成员（单项提权被拒或失败只影响该项），最后按数组序建任务（依赖只接受"本数组先出现"或"已存在"的任务 id）。
- **边界与失败**：
  - 调用方 id 解析不出 → `ok: false`（`teamhub.mjs:123`）。
  - 名称空或超 64 字符 → `{"ok": false, "error": "team name must be 1-64 characters"}`（`teamhub.mjs:125`）。
  - 已带队 → `{"ok": false, "error": "you already lead team \"...\"; use team_delete first"}`（`teamhub.mjs:129`）。
- **关联**：`team_add_member`、`team_delete`；技能 `agent-teamwork`。

### team_add_member

- **所属插件**：teamhub
- **一句话用途**：派发一个带角色与任务提示词的可续子代理成员；提权（模型档位/系列、模式能力面、sandbox 拓宽）先审批；上限 16 人。

- **工具提示词（模型可见的 description，原文）**：
  > 添加团队成员：派发一个带指定角色和任务提示词的可续子代理会话（成员继承本会话的组合，包括团队工具）。你选的成员 id 就是 `team_send_message` 发给它的地址。与 `spawn_model_subagent` 一样，可选的 `provider`/`model`/`reasoningEffort`/`mode` 覆盖默认继承队长；任何提权（更高的模型档位、跨系列换模型，或插件行能力面不是队长子集的模式）都会请求用户审批。完整工作流见 agent-teamwork 技能。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | memberId | string | 是 | — | 成员 id/名字，`[0-9a-zA-Z._-]` 且 ≤48（`cleanId`，`teamhub.mjs:95-100`） |
  | role | string | 是 | — | 角色描述，1-120 字符 |
  | prompt | string | 是 | — | 成员初始任务（作为其第一条消息送达） |
  | provider | string | 否 | 继承队长 | 成员供应商路由 |
  | model | string | 否 | 继承队长当前模型 | 成员模型 id |
  | reasoningEffort | string | 否 | 继承队长当前强度 | 成员思考强度 |
  | mode | string | 否 | 继承队长组合 | 成员模式 id（如 "router-standard"、"cordis"） |
  | sandbox | string | 否 | 继承部署默认 | 成员沙箱模式（"read-only" \| "workspace-write" \| "danger-full-access"）；比队长更宽的写权限会请求审批 |

- **输出**：`{"ok": true, "member": {"id", "sessionId", "role"}, "mode"?, "approvedEscalations"?: [...]}`（`teamhub.mjs:226`）；提权审批通过时附 `approvedEscalations`。
- **语义**：
  - 父级基准：`policy.liveRoute(agent)`（共享库，取 `requestHeader().config` 或创建选项）得到父路由；`parentModel = route.model ?? header.config.model`；成员 `model = 显式 ?? 父模型`；`effort = 显式 ?? 父 header 的 reasoningEffort`；父沙箱取 `sandboxPolicy.overrideOf(session)`，缺省回退部署默认（`teamhub.mjs:157-168`）。
  - **effort 校验（fail-loud）**：显式 `reasoningEffort` 先过共享库 `validateEffort`——目标路由未声明该值直接报错返回（'unsupported reasoningEffort "…" for \<provider\>/\<model\>; supported: …'），不再让子代理静默无输出（`teamhub.mjs:170-173`，见共享库一节）。
  - **提权审批（共享库）**：`collectModelEscalations(parentModel, childModel)`（同系列更高档位 / 跨系列换模型）+ `collectPresetEscalations`（目标模式能力面非父级子集）+ `collectSandboxEscalations`（sandbox 写权限比队长更宽，含未知 sandbox 值）；任一命中 → `approval.request({toolName: 'team_add_member'})`，结果必须是 `allowed-once`，否则 `{"ok": false, "cancelled": true, "reason": "the user did not allow this member escalation …", "escalations": [...]}`（`teamhub.mjs:175-193`）。注意：**仅换 provider（模型不变）不触发审批**（模型比较只看 id）。
  - 构造成员 persona 提示词：声明成员身份、团队目标、工作协议（只认领自己的任务、完成后 `team_update_task completed`、用 `team_send_message` 沟通、行动前查 `team_status`），后接队长任务（`teamhub.mjs:195`）。
  - `subagents.startContinuable({provider: 'spawn', label: "<memberId> (<role>)", request: {prompt, parent: agent, agentOptions?}})` 派发；显式 provider/model 写入 `agentOptions`（`teamhub.mjs:196-223`）。
  - `policy.prepare({parentId, mode?, effort?, sandbox?})`：spawn **之前**预登记（`startContinuable` 同步分发 `agent/created`，之后登记永远太迟），spawn 失败用 `staged.cancel()` 撤回；mode 在子代理**首次 pre-step 前**重组合、effort 钉在每个模型请求上、sandbox 以 `sandbox/mode` 事件落日志（共享库 `installChildPolicy`，`subagent-policy.mjs:226-262, 314-333`）。
- **边界与失败**：
  - 无调用上下文 / 无 agent 上下文、memberId/role 非法、无团队、成员已存在、超过 16 人上限（'team member limit (16) reached'，`teamhub.mjs:149`）分别报 `ok: false`。
  - 需审批但审批服务未挂载 → `{"ok": false, "error": "adding this member escalates (…; …) but no approval service is mounted to confirm it"}`（`teamhub.mjs:190`）。
  - 能力面解析失败 → 保守审批（同 switch_mode，见共享库）。
  - 成员是**可续子代理会话**：`sessionId` 即子会话 id，用户可在 GUI 打开继续对话。
- **关联**：`spawn_model_subagent`（同策略）、`team_status`、`team_send_message`；共享库 `lib/subagent-policy.mjs`；`modelroute.mjs` 对成员（子代理）路由的隐式钳制（见 model_route_status）；技能 `agent-teamwork`。

### team_add_members

- **所属插件**：teamhub
- **一句话用途**：批量添加团队成员：一次传入多个成员数组，逐项独立审批与失败隔离。

- **工具提示词（模型可见的 description，原文）**：
  > 批量添加团队成员：一次传入多个成员数组（每项含 memberId/role/prompt 及可选的 provider/model/reasoningEffort/mode）。逐项独立审批与失败隔离：某个成员提权被拒绝或 spawn 失败只影响该项，其余继续。与 `team_add_member`（单个）同策略。完整工作流见 agent-teamwork 技能。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | members | array | 是 | — | 成员数组；每项 `{memberId, role, prompt, provider?, model?, reasoningEffort?, mode?, sandbox?}`，字段约束同 `team_add_member` |

- **输出**：`{"ok": true, "teamName", "results": [...]}`（`teamhub.mjs:413`）；`results` 逐项对应该成员的 `addMember` 结果（`{ok: true, member: {...}, mode?, approvedEscalations?}` 或 `{ok: false, memberId, error}`）。
- **语义**：逐项走与 `team_add_member` 完全相同的共享 `addMember` 路径（校验、effort 校验、提权审批、spawn、`policy.prepare` 登记）；某项提权被拒或抛错只记入该项结果，其余项继续（`teamhub.mjs:393-415`）。
- **边界与失败**：
  - 无调用上下文 / 无 agent 上下文 → `ok: false`；`members` 为空数组 → `{"ok": false, "error": "members must be a non-empty array"}`（`teamhub.mjs:399`）；无团队 → `ok: false`。
  - 单项失败不中断整体——逐项的失败原因在 `results` 里。
- **关联**：`team_add_member`（单项版）、`team_create`（建队时可随队批量加）、`team_status`；技能 `agent-teamwork`。

### team_create_task

- **所属插件**：teamhub
- **一句话用途**：把团队工作拆成任务，可选声明依赖（须先完成的任务 id）与指派人。

- **工具提示词（模型可见的 description，原文）**：
  > 把团队工作拆成一个任务；可选声明依赖（必须先完成的任务 id）和指派人（成员 id；未指派的任务留在可认领池里等待）。完整工作流见 agent-teamwork 技能。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | title | string | 是 | — | 任务标题，1-160 字符 |
  | description | string | 否 | 空串 | 任务要求与验收标准 |
  | assignee | string | 否 | null（进认领池） | 指派的成员 id |
  | dependencies | array | 否 | [] | 必须先完成的任务 id 列表 |

- **输出**：`{"ok": true, "taskId": "t<n>", "teamName"}`（`teamhub.mjs:264`）。
- **语义**：任务 id 自增生成 `'t' + nextTask`；任务记录 `{id, title, description, assignee|null, dependencies, status: 'pending', output: null, createdAt}`；`nextTask` 递增（`teamhub.mjs:244-262`）。
- **边界与失败**：
  - 无团队 → `ok: false`（`teamhub.mjs:243`）。
  - assignee 非成员 → `{"ok": false, "error": "assignee \"...\" is not a team member"}`（`teamhub.mjs:247`）。
  - 依赖任务不存在于本团队 → `{"ok": false, "error": "dependency \"...\" is not a task of this team"}`（`teamhub.mjs:250`）。依赖只校验存在，不校验是否已完成（完成性在 claim 时校验）。
- **关联**：`team_claim_task`、`team_update_task`、`team_status`；技能 `agent-teamwork`。

### team_claim_task

- **所属插件**：teamhub
- **一句话用途**：为成员认领任务（所有依赖须已完成）；队长可代任何成员认领，成员只能认领给自己。

- **工具提示词（模型可见的 description，原文）**：
  > 为成员认领一个待处理任务（或取消认领退回待处理）。所有依赖必须已完成。队长可为任何人认领；成员只能为自己或未指派任务认领。完整工作流见 agent-teamwork 技能。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | taskId | string | 是 | — | 任务 id，如 "t1" |
  | memberId | string | 否 | 调用者 | 认领者；省略表示调用者（队长或成员） |

- **输出**：`{"ok": true, "taskId", "claimedBy": "<成员 id>", "teamName"}`（`teamhub.mjs:309`）。
- **语义**：
  - 调用方身份解析：本人在 `team` 表有记录（key=自己）→ 队长；否则遍历所有团队查自己是否成员 → 成员；两者都不是 → 失败（`teamhub.mjs:285-293`）。
  - claimant = 显式 memberId 或调用者；队长认领时 claimant 必须是成员；成员认领时 claimant 必须是自己（`teamhub.mjs:297-301`）。
  - 依赖校验：每个依赖任务必须存在且 `status === 'completed'`（`teamhub.mjs:302-305`）。
  - 认领即写 `task.status = 'claimed'`、`task.assignee = claimant`（`teamhub.mjs:306-307`）。
- **边界与失败**：
  - 非队长非成员 → `ok: false`；任务不存在、无 claimant、claimant 非法、依赖未完成均报 `ok: false`（`teamhub.mjs:293-304`）。
  - **不校验任务当前状态**：任意状态（含 completed/failed）的任务都可被 claim 覆盖为 `claimed`（已对代码确认：claim 路径只校验依赖与 claimant 身份，不看当前 status，`teamhub.mjs:484-498`）。
  - 「取消认领退回 pending」由 `team_update_task` 的 `claimed → pending` 实现，本工具不含该逻辑。
- **关联**：`team_update_task`、`team_create_task`；技能 `agent-teamwork`。

### team_update_task

- **所属插件**：teamhub
- **一句话用途**：推进任务状态（六状态机）并可选记录输出；成员更新自己的任务，队长可更新任何任务。

- **工具提示词（模型可见的 description，原文）**：
  > 推进任务状态（claimed → in_progress → completed | failed | cancelled）并可选记录其输出。成员更新自己的任务；队长可更新任何任务。完整工作流见 agent-teamwork 技能。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | taskId | string | 是 | — | 任务 id，如 "t1" |
  | status | string | 是 | — | 新状态：claimed / in_progress / completed / failed / cancelled |
  | output | string | 否 | 不更新 | 结果文本（交付物或摘要） |

- **输出**：`{"ok": true, "taskId", "status", "teamName"}`（`teamhub.mjs:349`）。
- **语义**：
  - status 必须属于 `TASK_STATUSES`（`teamhub.mjs:325`）。
  - 身份解析同 claim（队长 = key 命中，否则查成员身份，`teamhub.mjs:332-340`）。
  - 权限：`me !== captain && task.assignee !== me` → 拒绝（`teamhub.mjs:343`）。
  - 按 `TASK_TRANSITIONS` 校验流转，非法流转报错并在 error 中列出允许的目标（`teamhub.mjs:344-345`）。
  - `output` 只在非空字符串时覆盖写入（空串不更新，`teamhub.mjs:347`）。
  - 流转到 `completed` 时会唤醒所有在 `team_wait` 里等该任务的成员（`wakeWaiters`，`teamhub.mjs:539`）。
- **边界与失败**：非法 status、不在任何团队、任务不存在、非 assignee/队长、非法流转各报 `ok: false`（含允许列表）；completed/failed/cancelled 为终态、任何流转都拒绝。
- **关联**：`team_claim_task`、`team_status`；技能 `agent-teamwork`。

### team_wait

- **所属插件**：teamhub
- **一句话用途**：暂停当前回合，挂起等待另一名队员的消息或某个任务的完成（任一满足即唤醒）；用它替代轮询 `team_status`。

- **工具提示词（模型可见的 description，原文）**：
  > 暂停当前回合，等待另一名队员的消息或某个任务的完成（两者都给时任一满足即唤醒）。等待期间回合挂起、不消耗额外步骤：目标发来消息、目标任务 completed、或队长发来任何消息都会立即唤醒你继续。超时（默认 600 秒，上限 3600 秒）后返回 timeout，模型可再次调用继续等。队长随时可发消息拆掉等待，因此不会死锁。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | memberId | string | 否 | — | 要等待的成员 id；省略则等待任意消息（与 taskId 至少给一个） |
  | taskId | string | 否 | — | 要等待的任务 id（如 "t2"）；该任务 completed 时唤醒 |
  | timeoutSeconds | number | 否 | 600（上限 3600） | 最长等待秒数；非法/非正数回落默认，超过 3600 截断 |

- **输出**：
  - 消息唤醒：`{"ok": true, "wokenBy": "message", "from": "<发送方会话 id>"}`
  - 任务完成：`{"ok": true, "wokenBy": "task-completed", "taskId"}`（等待开始前就已完成则附 `note: "the task was already completed before the wait started"`）
  - 超时：`{"ok": true, "wokenBy": "timeout", "afterSeconds": <秒>}`
  - 中止：`{"ok": false, "error": "wait aborted (turn cancelled)"}`（回合取消）；`{"ok": false, "error": "wait aborted (member session disposed)"}`（等待期间本方会话被 dispose）
- **语义**：
  - 调用方注册进进程内 `waiters` 挂起表；`team_send_message`（在线与排队两条路径都触发）唤醒目标是本会话的等待者，`team_update_task` 流转到 `completed` 唤醒等该 taskId 的等待者，`agent/disposed` 中止本方所有等待（`teamhub.mjs:49-60, 544-589, 647/658, 539, 732-736`）。
  - `memberId` 过 `cleanId` 校验且必须是本团队成员；`taskId` 必须是本团队任务。
  - 依赖 `timer` 服务：缺失时直接报错 `{"ok": false, "error": "timer service unavailable; waiting is disabled — poll team_status instead"}`。
- **边界与失败**：
  - `memberId` 与 `taskId` 都为空 → `{"ok": false, "error": "memberId or taskId is required"}`；不在任何团队、成员/任务不存在于本团队各报 `ok: false`。
  - 挂起的是**当前回合**：超时返回后模型可再次调用继续等；队长发消息总能拆掉等待，不会死锁。
- **关联**：`team_send_message`（唤醒源）、`team_update_task`（completed 唤醒源）、`team_status`（轮询替代方案）；技能 `agent-teamwork`。

### team_send_message

- **所属插件**：teamhub
- **一句话用途**：给队长或另一成员发消息；在线立即投递并唤醒，离线持久排队到下次会话启动；发送方永远是调用会话（不可伪造）。

- **工具提示词（模型可见的 description，原文）**：
  > 给队长或另一成员发消息。在线接收方立即在收件箱收到并醒来；否则消息持久排队，在该会话下次启动时送达。发送方永远是调用会话（不可伪造）。何时该沟通见 agent-teamwork 技能。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | to | string | 是 | — | 接收方：成员 id 或 "captain" |
  | text | string | 是 | — | 消息正文，禁止空串 |

- **输出**：`{"ok": true, "delivered": "live"|"queued", "to", "messageId"}`（`teamhub.mjs:409/419`）。
- **语义**：
  - 消息包裹 `[team message from <发送方会话 id>]` … `[team message end]`，正文尾部旧标记（`[/team message]`、`[team message end]`）先剥除（`teamhub.mjs:395-397`）。
  - 目标解析：队长发成员按 `members[].id` 找 `sessionId`；成员发 `"captain"` 定位队长；成员间互发需在同一团队（`teamhub.mjs:369-393`）。
  - 目标在线（内存注册表）→ `running` 走 `steer` 否则 `followup`，抛错静默降级排队（`teamhub.mjs:404-411`）；否则写 `mail` 表排队，目标下次 `agent/session-start` 时投递、成功即删（`teamhub.mjs:412-419, 491-516`）。
  - **与 session_send 不同：没有 `wake` 参数**。
- **边界与失败**：
  - 队长给 "captain" 发 → `{"ok": false, "error": "you are the captain; address members by id"}`（`teamhub.mjs:372`）。
  - 成员按队长会话 id 发 → `{"ok": false, "error": "members address the captain as \"captain\""}`（`teamhub.mjs:386`）。
  - 接收方不在团队 → `{"ok": false, "error": "recipient \"...\" is not part of your team"}`（`teamhub.mjs:394`）。
  - 在线投递失败降级排队同样存在重复投递风险（同 session_send，待审校确认）。
- **关联**：`team_status`（收件箱查看）、`session_send`（同构机制）；技能 `agent-teamwork`。

### team_status

- **所属插件**：teamhub
- **一句话用途**：团队全貌——成员及在线状态、带依赖与输出的任务板、排在本会话收件箱里的消息；轮询它以收集成员输出。

- **工具提示词（模型可见的 description，原文）**：
  > 团队全貌：成员及其在线状态、带依赖和输出的任务板、以及排在你收件箱里的消息。轮询它以收集成员输出并决定下一步。完整工作流见 agent-teamwork 技能。
- **参数**：无。
- **输出**：
  - 不在任何团队：`{"ok": true, "inTeam": false, "note": "you are not part of any team; use team_create to lead one"}`（`teamhub.mjs:443`）
  - 在团队：`{"ok": true, "inTeam": true, "teamId", "name", "captain", "youAreCaptain", "members": [{"id", "sessionId", "role", "status"}], "tasks": [...], "inbox": [...]}`（`teamhub.mjs:455-465`）
- **语义**：
  - 成员 `status` 取自内存注册表，不在线为 `"offline"`（`teamhub.mjs:444-447`）。
  - `inbox` 是 `mail` 表中 `to === 本会话` 的记录，**只读展示、不消费**（`teamhub.mjs:448-454`）——与 mailbox_check 的消费语义不同。
  - `tasks` 直接吐整个任务数组（含 assignee/dependencies/status/output）。
- **边界与失败**：不在团队时 `ok: true` + `inTeam: false`（不视为失败）；邮箱打不开时整体报错。
- **关联**：`team_send_message`、`team_update_task`、`team_claim_task`；技能 `agent-teamwork`。

### team_delete

- **所属插件**：teamhub
- **一句话用途**：结束团队——尽力打断在线成员，随后归档团队记录（任务、依赖图、成员列表保留供回顾）。

- **工具提示词（模型可见的 description，原文）**：
  > 结束团队：尽力打断在线成员，然后归档团队记录（任务、依赖图和成员列表保留供回顾）。完整工作流见 agent-teamwork 技能。
- **参数**：无。
- **输出**：`{"ok": true, "archived": "<teamId>", "name", "note": "team archived; members stopped where possible"}`（`teamhub.mjs:488`）。
- **语义**：
  - 逐成员 `subagents.interrupt(member.sessionId, {kind: 'ancestor', agent})`，best-effort（`teamhub.mjs:480-484`）。
  - 团队记录写入 `archive` 表（附 `archivedAt`），随后删除 `team` 表条目（`teamhub.mjs:485-487`）。
- **边界与失败**：
  - 该队长无团队 → `{"ok": false, "error": "no team found for this captain"}`（`teamhub.mjs:479`）。
  - 只打断当前回合，成员可续会话本身仍在（用户仍可在 GUI 打开）；不清理 `mail` 表中遗留的排队消息——成员会话若再启动仍可能收到（待审校确认）。
- **关联**：`team_create`；技能 `agent-teamwork`。

---

## modsub（子代理派发）

**插件级说明**：`spawn_model_subagent` 的实现。默认**全继承父代理**（provider/model/effort/预设/沙箱），保证计费与能力面不悄悄变化；显式参数只覆盖对应维度。提权审批、显式 effort 校验与子代理侧 mode/effort/sandbox 注入全部来自共享库 `lib/subagent-policy.mjs`。

### spawn_model_subagent

- **所属插件**：modsub
- **一句话用途**：派发一个可续子代理会话，继承本会话组合（相同工具、相同工作区），默认继承父级路由/强度/模式；提权先审批。

- **工具提示词（模型可见的 description，原文）**：
  > 派发一个可续子代理会话，继承本会话的组合（相同工具、相同工作区），且默认继承父级的 `provider`/`model`/`reasoningEffort`/`mode`（agent preset），因此计费不会悄悄改变。显式传入其中任意一项只覆盖该维度：单独显式传 `model` 时仍保留父级 provider。提权——同系列内更高模型档位、跨系列换模型，或插件行能力面不是父级子集的目标模式——会请求用户审批，未获允许则取消；同档或更低档、能力相同或更少则直接执行，无需询问。可用 provider/model 组合见 `model_list`。返回的 childId 就是子会话 id：用户可在 GUI 中打开它并向它发截图/文本，子会话会把最终答案回报给本会话。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | prompt | string | 是 | — | 子代理的完整任务（它看不到本对话的任何内容） |
  | label | string | 否 | `"<model> 子代理"` | 子会话显示标签（`modsub.mjs:101`） |
  | provider | string | 否 | 继承父级 provider | 显式供应商路由（推荐省略以保持计费路由） |
  | model | string | 否 | 继承父级 live 路由模型 | 显式模型 id |
  | reasoningEffort | string | 否 | 继承父级当前强度 | 显式思考强度（供应商专属 id） |
  | mode | string | 否 | 继承父级组合 | 显式 agent preset id |
  | sandbox | string | 否 | 继承部署默认 | 显式沙箱模式（"read-only" \| "workspace-write" \| "danger-full-access"）；比父级更宽的写权限会请求审批 |

- **输出**：`{"ok": true, "childId", "messageId", "route": {"provider", "model", "reasoningEffort"|null}, "mode"?, "sandbox"?, "approvedEscalations"?: [...], "note": "the child session inherits this session composition (same tools, same workspace); send it follow-up input by opening its session in the GUI"}`（`modsub.mjs:141-150`）。`childId` 即子会话 id。
- **语义**：
  - **继承规则**（`modsub.mjs:67-82`）：父模型取 `policy.liveRoute(agent)` 的 model（无则取父 header config），子模型 = 显式 ?? 父模型；**provider 只有显式传入才会换**（单独显式传 model 保留父 provider——计费安全）；effort = 显式 ?? 父 header 的 `reasoningEffort`（spawn 时快照，作用于子代理每一回合）；父沙箱取 `sandboxPolicy.overrideOf(session)`，缺省回退部署默认。
  - **effort 校验（fail-loud）**：显式 `reasoningEffort` 在审批前先过共享库 `validateEffort`——目标路由未声明该值直接报错返回（`modsub.mjs:84-87`），不再让子代理静默无输出。
  - **审批四条件（共享库）**：同系列内更高档位、跨系列换模型、目标 preset 插件行能力面不是父级子集、sandbox 写权限比父级更宽（含未知 sandbox 值）。`escalations = collectModelEscalations(parentModel, childModel) + collectPresetEscalations(...) + collectSandboxEscalations(...)`；任一命中 → `approval.request({toolName: 'spawn_model_subagent', reason: 'subagent escalation: ...'})`，结果必须为 `allowed-once`，否则 `{"ok": false, "cancelled": true, "reason": "the user did not allow this subagent escalation (…); nothing was spawned", "escalations"}`（`modsub.mjs:89-108`）。
  - `subagents.startContinuable({provider: 'spawn', label, request: {prompt, parent: agent, agentOptions?}})` 派发；显式 provider/model 才进 `agentOptions`（`modsub.mjs:124-139`）。
  - `policy.prepare({parentId, mode?, effort?, sandbox?})`：spawn **之前**预登记（`startContinuable` 同步分发 `agent/created`，之后登记永远太迟），spawn 失败用 `staged.cancel()` 撤回；mode 在子代理首次 pre-step **之前**重组合（`presets.recompose`），effort 在子代理**每个** `agent/request` 上钉住，sandbox 以 `sandbox/mode` 事件在首步前落日志（`subagent-policy.mjs:226-262, 314-333`）。
- **边界与失败**：
  - 不在会话内 → `ok: false`（`modsub.mjs:61`）；`prompt` 为空 → `ok: false`（`modsub.mjs:63`）。
  - 显式 `reasoningEffort` 不被目标路由声明 → `{"ok": false, "error": "unsupported reasoningEffort \"...\" for <provider>/<model>; supported: ..."}`（共享库 `validateEffort`，`subagent-policy.mjs:150-164`；枚举不可得时放行，由宿主在请求时校验）。
  - 需审批但无审批服务 → `{"ok": false, "error": "this spawn escalates (…; …) but no approval service is mounted to confirm it"}`（`modsub.mjs:96-98`）。
  - 能力面解析失败 → 保守审批（共享库）；模型未知系列（无法归类）同样按「系列变更」保守处理（`subagent-policy.mjs:117-119`）。
  - 仅换 provider 不触发审批；显式 model 等于父模型不触发审批（`subagent-policy.mjs:108`）。
- **关联**：`model_list`（选 provider/model）；`modelroute.mjs`（子代理路由的隐式钳制与 plan 计费重写，`model_route_status` 可查）；`team_add_member`（同策略）；subflt 动态插件（子代理 report/settle 通道：报告在父忙时走 steer、同轮结算去重）；共享库 `lib/subagent-policy.mjs`。

---

## injector（运行时插件注入）

**插件级说明**：在官方 bundle/repository 安装路径之外提供运行时插件管理层——把本地插件包 symlink 进 profile 的 hoisted `node_modules` 再 `loader.create`，不改 patch/package.json/bundles（`injector.mjs:6-12`）。注册表 `DSH_HOME/injector/registry.json`（`{version: 1, plugins: [{name, dir}]}`），所有读改写串行化 + 临时文件 rename 原子落盘（`injector.mjs:167-179`）。**重启自恢复**：监听首个 `agent/session-start`，对注册表里不在线的插件逐个重新 `inject` 并打印结果日志（`injector.mjs:317-343`）。安全细节：包名必须符合 npm 风格正则且不能逃逸 node_modules（`assertSafeName`/`nodeModulesTarget`，`injector.mjs:50-68`）；卸载只删 injector 自己的 symlink、绝不 `rm -rf` 真实依赖（`removeLinkOnly`，`injector.mjs:131-141`）。另注册 Web 路由 `GET/HEAD /dsh-forge/plugin-descriptions` 供插件管理器面板取各插件自描述（`injector.mjs:100-129`）。**主会话守卫（安全评审 t7-H1）**：`dev_inject_plugin` / `dev_uninject_plugin` / `dev_reload_package` 三个管理工具仅主会话可用——按会话头 origin/parentSession 判定，子代理调用一律拒绝（`injector.mjs:152-160`）；只读工具（dev_injected_list / dev_plugin_status）不受限。

### dev_inject_plugin

- **所属插件**：injector
- **一句话用途**：把本地插件包运行时注入到正在运行的 web profile（无需重启，不改 patch/打包产物），Host 工具与客户端 UI 都生效。

- **工具提示词（模型可见的 description，原文）**：
  > 把本地插件包运行时注入到正在运行的 web profile（无需重启，不改 patch/打包产物）。`dir` 必须包含一个带 `name` 和 `dsh`/bundle 声明的 package.json；Host 工具和客户端 UI 都会生效。仅主会话可用（子代理拒绝）。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | dir | string | 是 | — | 插件包目录路径（描述要求绝对路径；代码未强制校验绝对性，见边界） |

- **输出**：`{"ok": true, "name", "id", "dir"}`（`injector.mjs:216`；`name` 为 package.json 的包名，`id` 为 `slug(name)`，`dir` 为解析后的绝对路径）。
- **语义**：
  - 读 `dir/package.json` 的 `name`（缺失即失败），校验安全包名（`readPackageName`，`injector.mjs:181-187`）。
  - 目标 symlink 已存在时只删**符号链接**（非 symlink 拒绝删除），再 `symlink(resolve(dir), target)`（`linkPackage`，`injector.mjs:189-196`；Windows 用 junction）。
  - `loader.create({id: slug(name), name, config: {}})` 加载并构建 fiber；失败则回滚 symlink 并抛错（`injector.mjs:202-210`）。
  - 成功后在注册表去重追加 `{name, dir}` 并原子落盘（`injector.mjs:211-215`）。
- **边界与失败**：
  - 非主会话（子代理）调用 → `{"ok": false, "error": "restricted to the main session (subagents cannot manage plugin injection)"}`（`injector.mjs:282`）。
  - 空 dir → `{"ok": false, "error": "dir is required"}`（`injector.mjs:269`）。
  - 目录无 package.json / 无 name、非法包名（含 `..` 逃逸）→ `ok: false` + 对应错误。
  - loader.create 失败 → symlink 已回滚，返回 `ok: false`。
  - 注入包需自带 `@deepseek-ai/*` 依赖链接与完整 JSON Schema 参数（见插件头部注释，`injector.mjs:21-29`）。
- **关联**：`dev_uninject_plugin`、`dev_injected_list`、`dev_plugin_status`；与 plins 市场共用同一注册表文件。

### dev_uninject_plugin

- **所属插件**：injector
- **一句话用途**：取消注入一个运行时注入的插件包：fiber 释放、symlink 移除、注册表条目删除，无需重启。

- **工具提示词（模型可见的 description，原文）**：
  > 取消注入一个运行时注入的插件包：fiber 被释放、符号链接移除、注册表条目删除。无需重启。仅主会话可用（子代理拒绝）。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | name | string | 是 | — | 插件包名**或其子串**（先在注册表按精确匹配，再按子串匹配） |

- **输出**：`{"ok": <bool>, "name": "<实际包名>", "problems"?: ["loader: ...", "unlink: ..."]}`（`injector.mjs:237`）。`ok: false` 仅在出现 problems 时。
- **语义**：
  - 精确匹配失败再子串匹配（`injector.mjs:281-282`）。
  - `loader.remove(id)` 释放 fiber；条目已不存在（如恢复尚未执行）视为幂等成功（吞掉 `cannot resolve entry`，`injector.mjs:225-228`）。
  - 删 symlink（仅符号链接）、注册表过滤删除（`injector.mjs:229-236`）。
- **边界与失败**：
  - 非主会话（子代理）调用 → `{"ok": false, "error": "restricted to the main session (subagents cannot manage plugin injection)"}`（`injector.mjs:292`）。
  - 空 name → `ok: false`；注册表无匹配 → `{"ok": false, "error": "no injected plugin matches \"...\""}`（`injector.mjs:283`）。
  - loader.remove 或 unlink 失败不中断流程，收集进 `problems` 并返回 `ok: false`。
- **关联**：`dev_inject_plugin`、`dev_plugin_status`。

### dev_injected_list

- **所属插件**：injector
- **一句话用途**：列出每个运行时注入的插件包（名称 + 源目录）。

- **工具提示词（模型可见的 description，原文）**：
  > 列出每个运行时注入的插件包（名称 + 源目录）。
- **参数**：无。
- **输出**：`{"ok": true, "count": <数量>, "plugins": [{"name", "dir"}]}`（`injector.mjs:292`）。
- **语义**：直接吐注册表快照（读前等注册表加载完成）。
- **边界与失败**：注册表文件缺失时视为首次运行，返回空列表不报错（`injector.mjs:158-159`）。
- **关联**：`dev_plugin_status`、`dev_inject_plugin`。

### dev_reload_package

- **所属插件**：injector
- **一句话用途**：重建一个注入的插件条目（释放 fiber + 重新导入）。

- **工具提示词（模型可见的 description，原文）**：
  > 重建一个注入的插件条目（释放 fiber + 重新导入）。注意：Node ESM 模块缓存尚未清除，因此编辑过的文件内容可能要到加载器清掉缓存后才生效。仅主会话可用（子代理拒绝）。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | name | string | 是 | — | 插件包名 |

- **输出**：`{"ok": true, "name", "note": "re-created the entry; ESM module cache is NOT cleared yet"}`（`injector.mjs:244`）。
- **语义**：`loader.remove(id)` 后立即 `loader.create({id, name, config: {}})`（`injector.mjs:240-244`）。
- **边界与失败**：
  - 非主会话（子代理）调用 → `{"ok": false, "error": "restricted to the main session (subagents cannot manage plugin injection)"}`（`injector.mjs:315`）。
  - 空 name → `ok: false`。
  - **不校验 name 是否在注册表**；条目不存在时 `loader.remove` 会抛错（与 uninject 不同，这里没有吞 `cannot resolve entry`）→ `ok: false`（待审校确认是否有意）。
  - Node ESM 模块缓存未清除：编辑过的文件内容可能要等加载器清缓存后才生效（note 原文）。
- **关联**：`dev_inject_plugin`、`dev_uninject_plugin`。

### dev_plugin_status

- **所属插件**：injector
- **一句话用途**：显示注入器注册表以及每个在线 loader 条目（id + 名称 + 禁用状态）。

- **工具提示词（模型可见的 description，原文）**：
  > 显示注入器注册表以及每个在线 loader 条目（id + 名称 + 禁用状态）。
- **参数**：无。
- **输出**：`{"ok": true, "injected": [{"name", "dir"}], "loaderEntries": [{"id", "name"|undefined, "disabled": bool}]}`（`injector.mjs:314`）。
- **语义**：`loader.entries()` 全量枚举（不仅注入插件），`name` 取 `entry.options?.name`、`disabled` 取 `entry.disabled === true`。
- **边界与失败**：无显式失败路径（注册表读失败按空处理）。
- **关联**：`dev_injected_list`、`dev_inject_plugin`；重启自恢复（`agent/session-start` 监听，`injector.mjs:317-343`）。

---

## modelroute（子代理模型路由策略）

**插件级说明**：解决两件事——(1) **子代理静默升级**：官方子代理创建选项继承父的创建配置，但 dsh-host-apiproxy 的按代理模型选择会把新子代理重写到全局默认模型，父的 live 路由从不被咨询；本插件在每个代理的 `agent/request` 上装最外层（prepend）监听：`origin === 'subagent'` 的子代理，**显式**指定的 provider/model 原样尊重（更高或跨厂商是用户的选择），**隐式继承**才回落到父的 live 路由（绝不升级）；(2) **plan 计费重写**：设置 `config.plan` 后，非子代理请求的 provider 按模型系列重写到 plan 网关路由（`modelroute.mjs:7-25, 84-137, 150-173`）。系列分类可配置扩展（`series = {...DEFAULT_SERIES, ...config.series}`，`modelroute.mjs:44`），匹配不到任何系列的模型 id 为 `unknown`，策略绝不换模型（`modelroute.mjs:23-24`）。

### model_taxonomy

- **所属插件**：modelroute
- **一句话用途**：显示模型系列分类（系列、档位关键词）并可对一个模型 id 归类。

- **工具提示词（模型可见的 description，原文）**：
  > 显示模型系列分类（系列、档位关键词）并对一个模型 id 归类。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | model | string | 否 | 不归类 | 要归入系列与档位的模型 id |

- **输出**：`{"ok": true, "plan": <字符串|null>, "planProvider": {...}, "series": [{"series": "deepseek", "tiers": ["flash","lite","pro","max"]}, ...], "classify"?: {"model", "series"|null, "tier"}}`（`modelroute.mjs:202-213`）。`tier` 是档位在 tiers 数组中的下标：系列命中但档位关键词未命中时为 `-1`；系列未命中时 `tier` 为 `null`。
- **语义**：
  - 内置系列表（`modelroute.mjs:26-31`）：deepseek `/^deepseek/i`、claude `/^(claude|anthropic)/i`、chatgpt `/^(gpt|chatgpt|o1|o3|openai)/i`、qwen `/^qwen/i`，各自带档位数组；可被 `config.series` 扩展/覆盖。
  - 正则匹配前剥掉有状态的 `g/y` 标志防止 lastIndex 污染（`modelroute.mjs:50-57`）；非正则 match 走大小写不敏感子串。
  - 输出同时暴露 plan 与 planProvider 配置（便于调试计费重写）。
- **边界与失败**：无失败路径；未匹配系列返回 `series: null`（classify 内）。
- **关联**：`model_route_status`、`spawn_model_subagent`（提权档位判断在共享库用同表，见共享库「taxonomy 同步」注）。

### model_route_status

- **所属插件**：modelroute
- **一句话用途**：显示当前代理路由；对子代理，显示它被钳制到的父级在线路由。

- **工具提示词（模型可见的 description，原文）**：
  > 显示当前代理路由；对子代理，显示它被钳制到的父级在线路由。
- **参数**：无。
- **输出**：`{"ok": true, "id": "<本代理 id>", "origin": "subagent"|"top-level"|..., "route": {"provider", "model"}, "parentRoute"?: {...}, "clampedToParent"?: true}`（`modelroute.mjs:225-231`）。父代理在线（`agents.get(parentId)` 命中）时才附 `parentRoute` 与 `clampedToParent: true`。
- **语义**：
  - `liveRoute(agent)`：优先取 `requestHeader().config` 的 provider/model，否则取创建选项（`modelroute.mjs:77-82`）。
  - 实际钳制发生在 `resolveSubagentRoute`（`modelroute.mjs:84-137`）：子代理**隐式**继承时 model/provider 回落父 live 路由（绝不升级）；显式 model/provider 与父创建选项不同则**原样尊重**；显式 model 而 provider 未显式时 provider 保留模型选择层已解析的结果；provider 未显式且配了 plan 时仍按系列重写 provider；子代理未显式注入 effort 时继承父当前 reasoningEffort（`modelroute.mjs:127-136`）。
  - 非子代理请求走 `applyPlanRoute`（plan 配置存在且系列命中时改 provider，`modelroute.mjs:139-148`）。
  - 本工具展示的是**结果视图**：`route` 为当前代理解析后的路由，`origin` 来自会话头（缺失为 `top-level`）。
- **边界与失败**：无 `exec.agent` → `{"ok": false, "error": "no agent context"}`（`modelroute.mjs:220`）；父代理不在线时只返回本代理路由（无 clampedToParent 标记）。
- **关联**：`model_taxonomy`；`spawn_model_subagent`（route 字段）；`team_add_member`（成员同受钳制）；共享库 `lib/subagent-policy.mjs` 的 liveRoute 与其同构（`subagent-policy.mjs:196-203`）。

---

## sklui（skill 管理器面板宿主半部 · auto-plugins 动态插件）

**插件级说明**：`auto-plugins.json` 中 `idPrefix: "sklui"` 的动态插件宿主半部。它**自己不持有状态**：只读工具（skill_list / skill_show）直连 `skills` 服务；管理工具（skill_add / disable / enable / remove）全部转发给宿主插件 skillmanager.mjs 提供的 `skillRegistry` 服务（单一 Map + 单一持久 store `DSH_HOME/skillmanager/registry.json`；服务面为 `state/add/disable/enable/remove/setInject`，面板切换 alwaysInject 的 RPC `skillui/setInject` 走 `setInject`，skillmanager.mjs:338-366），工具与设置页 UI 共用一份注册表（hostCode L9-12, 74-102）。若 `skills` 服务缺失则只读工具不注册；若 `skillRegistry` 缺失则管理工具不注册。**主会话守卫（安全评审 t7-H2）**：四个管理工具仅主会话可用（hostCode 的 `isMainSession` 按会话头 origin/parentSession 判定），只读工具不受限。以下「管理工具的输出/失败」来自 skillregistry 的实现（skillmanager.mjs，文中注 `<skillmanager.mjs:N>`）。

### skill_list

- **所属插件**：sklui（auto-plugins 动态插件）
- **一句话用途**：列出调用方代理可见的技能（名称、provider、模型/用户可调用性、描述）。

- **工具提示词（模型可见的 description，原文）**：
  > 列出调用方代理可见的技能（名称、provider、模型/用户可调用性、描述）。
- **参数**：无。
- **输出**：`{"ok": true, "count", "skills": [{"name", "provider", "model": <bool>, "user": <bool>, "description"}]}`（hostCode L48-58）。`model`/`user` 即 `invocation.modelInvocable / userInvocable`。
- **语义**：`skills.list({scope: exec.agent, cwd: <会话 cwd>, signal: exec.signal})`（hostCode L46-47），把可见技能展平为五字段。
- **边界与失败**：任一技能的 `invocation` 字段缺失会触发异常 → 整体 `ok: false`（代码直接读 `s.invocation.modelInvocable`，hostCode L54-55，待审校确认）。
- **关联**：`skill_show`、`skill_add`；宿主插件 skillmanager.mjs；`skill` 工具（dsh-tool-skill，注入目录与调用）。

### skill_show

- **所属插件**：sklui（auto-plugins 动态插件）
- **一句话用途**：显示一个技能的完整 Markdown 正文。

- **工具提示词（模型可见的 description，原文）**：
  > 显示一个技能的完整 Markdown 正文。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | name | string | 是 | — | 确切技能名 |

- **输出**：`{"ok": true, "name", "provider", "content"}`（hostCode L70）。
- **语义**：名字先过正则 `/^[a-z0-9]+(-[a-z0-9]+)*$/`；`skills.get(name, {scope, cwd, signal})` 找不到返回 undefined。
- **边界与失败**：非法名字 → `{"ok": false, "error": "invalid skill name \"...\""}`（hostCode L66）；未知技能 → `{"ok": false, "error": "unknown skill \"...\""}`（hostCode L69）。
- **关联**：`skill_list`。

### skill_add

- **所属插件**：sklui（auto-plugins 动态插件）
- **一句话用途**：添加一个持久运行时技能（host/全局层），重启后仍保留。

- **工具提示词（模型可见的 description，原文）**：
  > 添加一个持久的运行时技能（host/全局层）。重启后仍保留。仅主会话可用（子代理拒绝）。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | name | string | 是 | — | `/^[a-z0-9]+(-[a-z0-9]+)*$/`（isSkillName 校验） |
  | description | string | 是 | — | 一行路由描述 |
  | content | string | 是 | — | Markdown 指令正文 |
  | whenToUse | string | 否 | 无 | 何时使用该技能的指引 |
  | modelInvocable | boolean | 否 | true | 允许模型经 skill 工具加载 |
  | userInvocable | boolean | 否 | true | 允许用户 `/name` 手势注入 |
  | alwaysInject | boolean | 否 | false | true = 完整内容常驻注入系统提示词（非渐进披露） |

- **输出**：`{"ok": true, "name", "alwaysInject", "note": "registered at the host (global) layer"}`（skillmanager.mjs:280）。
- **语义**：
  - 转发 `registry.add(args)`（hostCode L86）。skillmanager 侧：`skills.register` 运行时注册 + 持久 store 追加 + `persist()` 原子落盘（skillmanager.mjs:245-281）。
  - `alwaysInject: true` 时额外注册系统提示词 section（名 `forge-always-skill:<name>`、order 90、带 `<!-- forge-always-skill:<name> -->` 标记，供 router-standard 预设首轮抑制），失败仅记日志不影响添加（skillmanager.mjs:218-225, 266-268）。
- **边界与失败**（均来自 skillmanager.mjs 的 addSkill）：
  - 非主会话（子代理）调用 → `{"ok": false, "error": "restricted to the main session (subagents cannot manage skills)"}`（sklui hostCode 的 isMainSession 守卫）。
  - 非法名字 → `{"ok": false, "error": "invalid skill name \"...\""}`（skillmanager.mjs:247）。
  - **已被 skillmanager 托管** → `{"ok": false, "error": "skill \"...\" is already managed by skillmanager"}`（skillmanager.mjs:248）。
  - description 或 content 为空 → `{"ok": false, "error": "description and content are required"}`（skillmanager.mjs:251）。
- **关联**：`skill_disable` / `skill_enable` / `skill_remove`；skillmanager.mjs（重启自恢复注册，skillmanager.mjs:365-380）。

### skill_disable

- **所属插件**：sklui（auto-plugins 动态插件）
- **一句话用途**：禁用本管理器添加的一个技能（释放注册；可恢复）。

- **工具提示词（模型可见的 description，原文）**：
  > 禁用本管理器添加的一个技能（释放；可用 skill_enable 恢复）。仅主会话可用（子代理拒绝）。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | name | string | 是 | — | 确切技能名 |

- **输出**：`{"ok": true, "name", "enabled": false}`（skillmanager.mjs:297）。
- **语义**：转发 `registry.disable`（hostCode L91）。skillmanager 侧：释放 skills 注册（dispose）、摘除 always-inject section、store 里 `enabled: false` 并持久化（skillmanager.mjs:283-298）。
- **边界与失败**：非主会话（子代理）调用 → `{"ok": false, "error": "restricted to the main session (subagents cannot manage skills)"}`；**非 skillmanager 托管的技能（preset/插件提供的）** → `{"ok": false, "error": "skill \"...\" is not managed by skillmanager"}`（skillmanager.mjs:285）——即「只读可见、不可增删启停」。
- **关联**：`skill_enable`、`skill_remove`。

### skill_enable

- **所属插件**：sklui（auto-plugins 动态插件）
- **一句话用途**：重新启用本管理器先前禁用的技能。

- **工具提示词（模型可见的 description，原文）**：
  > 重新启用本管理器先前禁用的技能。仅主会话可用（子代理拒绝）。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | name | string | 是 | — | 确切技能名 |

- **输出**：`{"ok": true, "name", "enabled": true}`（skillmanager.mjs:316）。
- **语义**：转发 `registry.enable`（hostCode L96）。skillmanager 侧：重新 `skills.register`（保留原注册描述），`alwaysInject` 且 section 缺失时重建，store 置 `enabled: true` 并持久化（skillmanager.mjs:300-317）。
- **边界与失败**：非主会话（子代理）调用 → `{"ok": false, "error": "restricted to the main session (subagents cannot manage skills)"}`；非托管技能 → `{"ok": false, "error": "skill \"...\" is not managed by skillmanager"}`（skillmanager.mjs:302）。
- **关联**：`skill_disable`。

### skill_remove

- **所属插件**：sklui（auto-plugins 动态插件）
- **一句话用途**：永久移除本管理器添加的一个技能（释放 + 从存储删除）。

- **工具提示词（模型可见的 description，原文）**：
  > 永久移除本管理器添加的一个技能（释放 + 从存储中删除）。仅主会话可用（子代理拒绝）。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | name | string | 是 | — | 确切技能名 |

- **输出**：`{"ok": true, "name", "removed": true}`（skillmanager.mjs:332）。
- **语义**：转发 `registry.remove`（hostCode L101）。skillmanager 侧：释放注册与 always-inject section、从 owned Map 与 store 中删除、持久化（skillmanager.mjs:319-333）。
- **边界与失败**：非主会话（子代理）调用 → `{"ok": false, "error": "restricted to the main session (subagents cannot manage skills)"}`；非托管技能 → `{"ok": false, "error": "skill \"...\" is not managed by skillmanager"}`（skillmanager.mjs:321）。
- **关联**：`skill_add`、`skill_disable`。

---

## plins（插件市场宿主半部 · auto-plugins 动态插件）

**插件级说明**：`auto-plugins.json` 中 `idPrefix: "plins"` 的动态插件宿主半部，本职是社区插件市场（browse / install / uninstall，经 `harness.handle` 暴露 `plinst/*` RPC，非模型工具）。与本文档相关的是它顺带注册的一个**模型工具** `dev_stop_dyn_plugin`。该工具仅在 `dynamicCordisRunner` 服务存在时注册（hostCode L221-222）；若服务缺失，工具根本不存在（调用方会收到"无此工具"）。

### dev_stop_dyn_plugin

- **所属插件**：plins（auto-plugins 动态插件）
- **一句话用途**：按 pluginId 前缀应急停止一个运行中的动态插件，同时停掉其 Host 与 Client 两半；用于动态插件客户端把 UI 搞崩时的救援。

- **工具提示词（模型可见的 description，原文）**：
  > Emergency stop for a running dynamic plugin by pluginId prefix (e.g. "sklui"). Stops its Host and Client halves. Use when a dynamic plugin client crashes the UI.
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | prefix | string | 是 | — | pluginId 前缀，如 "sklui"；须匹配 `/^[a-z0-9]{3,12}$/` |

- **输出**：`{"ok": true, "stopped": "<完整 pluginId>", "agentId": "<owner agent id>", "detail"?: {...}}`（hostCode L243）。
- **语义**：
  - `runner.inventory()` 取动态插件清单，找第一条 `pluginId` 以 prefix 开头的记录（hostCode L235-237）。
  - 用 `row.agentId` 在内存代理注册表找 owner：**owner 不在线则失败**（hostCode L239-241）。
  - `runner.stopFromPanel(agent, row.pluginId)` 执行停止，返回对象（若有）附到 `detail`（hostCode L242-243）。
- **边界与失败**：
  - prefix 非法 → `{"ok": false, "error": "invalid prefix"}`（hostCode L234）。
  - 无匹配插件 → `{"ok": false, "error": "no plugin with prefix \"...\""}`（hostCode L238）。
  - **owner 不在线** → `{"ok": false, "error": "owner agent \"...\" is not live; cannot stop \"...\" from here"}`（hostCode L241）。
- **关联**：dynboot（动态插件宿主，`dynamicCordisRunner`）；`auto-plugins.json` 本身；与 injector 的注入插件体系无关（只停动态插件）。

---

## sfind（session_find 会话查找 · auto-plugins 动态插件）

**插件级说明**：`auto-plugins.json` 中 `idPrefix: "sfind"` 的动态插件宿主半部，注册单一工具 `session_find`。标题经 shell 服务读投影缓存、live 状态来自内存会话注册表。

### session_find

- **所属插件**：sfind（auto-plugins 动态插件）
- **一句话用途**：按关键字（会话 id 或标题子串）快速查会话，返回带在线状态的紧凑匹配列表；优先于 `session_list` 以省上下文。

- **工具提示词（模型可见的 description，原文）**：
  > 按关键字（会话 id 或标题子串）查找会话，返回带在线状态的紧凑匹配列表。知道标题或 id 片段时优先用它而不是 `session_list`，以节省上下文；只有需要完整名册时才用 `session_list`。完整工作流见 `cross-session-mailbox` 技能。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | query | string | 是 | — | 与会话 id 和标题做不区分大小写匹配的关键字 |
  | limit | number | 否 | 20（上限 50） | 最大结果数 |

- **输出**：`{"ok": true, "query": "<原始 query>", "count", "sessions": [{"sessionId", "title"|null, "live": bool}]}`（hostCode L72）。
- **语义**：
  - **标题来自投影缓存**：shell 跑一段 node 内联脚本读 `~/.dsh/storages/session_projcache.json` 的 `tables.sessions[*].rows.title.val`（hostCode L48-53，超时 8s）。
  - **live 状态来自内存注册表**：`sessions.get(id) !== undefined`（hostCode L58）。
  - 匹配：id 或标题转小写后 `includes(query)`，命中即入结果，到 cap 即停（hostCode L55-61）。
  - **兜底**：结果不足 cap 时，把「在线但无缓存标题」的会话以 `title: null, live: true` 补进结果（hostCode L62-71）。
- **边界与失败**：
  - query 为空 → `{"ok": false, "error": "query is required"}`（hostCode L45）。
  - 缓存读失败只损失标题来源、不报错；**离线且无缓存标题的会话不会出现在结果里**（只有缓存标题集 + 在线兜底，待审校确认是否有意）。
- **关联**：`session_list`（被替代方）、`session_read` / `session_send`（取 id）；技能 `cross-session-mailbox`。

---

## archive（项目档案，#67 新增）

**插件级说明**：项目档案 v0：证据句柄与精确读取——薄封装上游 `sessionQuery` 服务，**只读、不建索引**（`archive.mjs:1`）。依赖注入 `['sessionQuery', 'tools']`（`archive.mjs:13`）；四个工具均经本插件 `registerTool` 包装注册（`archive.mjs:18-33`），`execute` 抛出的异常统一转为 `{"ok": false, "error": "<message>"}`。事件坐标 `<sessionId>:<seq>` 是项目档案的证据句柄（质粒/缺口报告的 evidence 字段引用这个稳定坐标，见 plasmid 一节），`archive_read_event` 是其权威读取端。各工具对 `sessionId` 做独立必填校验（空串 → `ok: false`）。

### archive_read_event

- **所属插件**：archive
- **一句话用途**：按 sessionId + seq 精确读取一个会话事件及其上下文窗口——项目档案的证据句柄，质粒/缺口报告的 evidence 字段引用这个稳定坐标；事件内容完整返回、不截断。

- **工具提示词（模型可见的 description，原文）**：
  > 按 sessionId + seq 精确读取一个会话事件及其上下文窗口。这是项目档案的证据句柄：质粒/缺口报告的 evidence 字段引用这个稳定坐标。事件内容完整返回，不截断。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | sessionId | string | 是 | — | 会话 id。 |
  | seq | number | 是 | — | 事件 seq（会话内单调递增）。 |
  | before | number | 否 | 0 | 向前包含的上下文事件数。 |
  | after | number | 否 | 0 | 向后包含的上下文事件数。 |

- **输出**：`{"ok": true, "session": <会话信息>, "target": <目标事件>, "events": [...], "startSeq": <窗口起始 seq>, "endSeq": <窗口结束 seq>}`（`archive.mjs:52`）。
- **语义**：
  - `sessionId` 空串直接失败；`seq` 必须是**非负安全整数**（`archive.mjs:47-48`）。
  - `before` / `after` 非安全整数或负数时回落 0（`archive.mjs:49-50`）。
  - 调 `sessionQuery.readEvent({sessionId, seq, before, after})`，把返回窗口展开为六个字段（`archive.mjs:51-52`）。
- **边界与失败**：
  - `{"ok": false, "error": "sessionId is required"}`（`archive.mjs:47`）。
  - `{"ok": false, "error": "seq must be a non-negative safe integer"}`（`archive.mjs:48`）。
  - 其余异常由 `registerTool` 包装为 `{"ok": false, "error": "<message>"}`（`archive.mjs:28`）。
- **关联**：`archive_filter_events`（找坐标）、`archive_list_events`；plasmid 的 `plasmid_submit` / `gap_report`（evidence 句柄的权威读取端）。

### archive_list_events

- **所属插件**：archive
- **一句话用途**：列一个会话的事件索引（seq/type/time/surface），快速扫一眼该会话发生过什么，再决定用 `archive_read_event` 精读哪几个。

- **工具提示词（模型可见的 description，原文）**：
  > 列一个会话的事件索引（seq/type/time/surface），用于快速扫一眼该会话发生过什么，再决定用 archive_read_event 精读哪几个事件。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | sessionId | string | 是 | — | 会话 id。 |
  | limit | number | 否 | 100（上限 500） | 最多返回事件数。 |

- **输出**：`{"ok": true, "count": <全部记录数>, "events": [...最后 limit 条]}`（`archive.mjs:67`）。注意 `count` 是截断**前**的记录总数，`events` 是截断后的。
- **语义**：
  - `sessionQuery.listEvents(sessionId)` 取全量记录（`archive.mjs:65`）。
  - cap：`limit` 为安全正整数时 `min(limit, 500)`，否则默认 100；返回 `records.slice(-cap)`（最后 cap 条，`archive.mjs:66`）。
- **边界与失败**：`sessionId` 空 → `{"ok": false, "error": "sessionId is required"}`；其余异常统一包装 `ok: false`。
- **关联**：`archive_read_event`（精读）、`archive_filter_events`（带过滤的精读入口）。

### archive_filter_events

- **所属插件**：archive
- **一句话用途**：在一个会话内按事件类型 / 关键字过滤事件，返回带语义文本的匹配文档；关键字是字面量匹配（不区分大小写、忽略多余空白）。找 evidence 坐标的推荐入口。

- **工具提示词（模型可见的 description，原文）**：
  > 在一个会话内按事件类型 / 关键字过滤事件，返回带语义文本的匹配文档。关键字是字面量匹配：不区分大小写、忽略多余空白。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | sessionId | string | 是 | — | 会话 id。 |
  | types | array | 否 | 无 | 事件类型白名单，如 `["tool/call","tool/result"]`。 |
  | text | string | 否 | 无 | 语义文本关键字。 |
  | limit | number | 否 | 50（上限 500） | 最多返回条数。 |

- **输出**：`{"ok": true, "count": <匹配总数>, "events": [...最后 limit 条]}`（`archive.mjs:87`）。
- **语义**：
  - `types` 为非空数组时推入 `{kind: 'type', values: <字符串化>}` 过滤条件；`text` 非空（trim 后）时推入 `{kind: 'text', text}`（`archive.mjs:82-84`）；两者都缺则不过滤。
  - 调 `sessionQuery.filterEvents(sessionId, filters)`（`archive.mjs:85`）。
  - cap：`limit` 安全正整数时 `min(limit, 500)`，否则默认 50；`docs.slice(-cap)`（`archive.mjs:86-87`）。
- **边界与失败**：`sessionId` 空 → `ok: false`；其余异常统一包装。
- **关联**：`archive_read_event`（精读坐标）；`plasmid_submit` / `gap_report`（描述明确指引「用 archive_filter_events 找到相关事件后抄它的 sessionId 和 seq」）。

### archive_trace

- **所属插件**：archive
- **一句话用途**：追踪一个会话的祖先链与后代树（谁派生了它、它派生了谁），回答「谁和谁合作过」。

- **工具提示词（模型可见的 description，原文）**：
  > 追踪一个会话的祖先链与后代树（谁派生了它、它派生了谁），回答「谁和谁合作过」。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | sessionId | string | 是 | — | 会话 id。 |

- **输出**：`{"ok": true, "target": <目标会话>, "ancestors": [...], "descendants": [...], "complete": true|false}`；`complete: false` 时额外附 `unresolvedParentId`（祖先链断裂处无法解析的父 id）——字段由代码条件展开决定（`archive.mjs:100`）。
- **语义**：调 `sessionQuery.traceSession(sessionId)`，返回 `{target, ancestors, descendants, complete}`，`complete === false` 时追加 `unresolvedParentId`（`archive.mjs:99-100`）。
- **边界与失败**：`sessionId` 空 → `ok: false`；其余异常统一包装。
- **关联**：`archive_read_event`、`archive_list_events`。

---

## verify（言行一致检查器，#68 新增）

**插件级说明**：言行一致检查器 v0：`verify_claim` 显式验货工具（git commit / 文件存在 / 文本条目），证据原文可复核。**不写任何东西，只读**（`verify.mjs:1, 120`）。纯验证逻辑 `runVerification({type, target, path, cwd})` 单独导出（`verify.mjs:30-86`），可被探针/其他模型直接复用。路径安全：所有路径先过 `assertInside(cwd, target)`——解析后必须落在基准目录内，否则抛 `path escapes the working directory: <target>`（`verify.mjs:18-27`）。cwd 缺省取调用会话 header 的 cwd（`callerCwd`，`verify.mjs:110-117`）。**注意输出形态**：`verify_claim` 直接返回 `runVerification` 的对象，**没有统一的 `{"ok": true}` 外壳**——成功形态含 `ok: true, verified: true, evidence`，失败形态含 `ok: false, verified: false` 与 `error` / `note`（见条目输出）。

### verify_claim

- **所属插件**：verify
- **一句话用途**：言行一致检查器：显式验货——验证声称的 git 提交 / 文件 / 文本条目真实存在，返回 evidence（原始证据文本）供独立复核；只读、不写任何东西。

- **工具提示词（模型可见的 description，原文）**：
  > 言行一致检查器：显式验货。当汇报声称"已提交 <sha>"、"已修复 <文件>"、"已登记 <条目>"时，模型主动调用本工具验证声称的对象是否真实存在。返回 evidence（原始证据文本）供其他模型独立复核，不是黑箱 true/false。不写任何东西，只读。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | type | string | 是 | — | 验证类型：git-commit=校验 git 提交 sha 存在；file=校验文件存在；text-in-file=校验文件里含指定条目（如 'U-A1'）。 |
  | target | string | 是 | — | 声称的对象：git-commit 时是完整提交 sha；file 时是相对路径；text-in-file 时是想命中的关键字/ID。 |
  | path | string | 否 | 无 | 仅 text-in-file 必填：要 grep 的绝对路径或相对路径。 |
  | cwd | string | 否 | 当前会话的工作目录 | 可选：验证基准目录（git 仓库根 / 相对路径基准）。 |

- **输出**（`runVerification` 的返回值原样，`verify.mjs:145-146`）：
  - git-commit 成功：`{"ok": true, "verified": true, "type": "git-commit", "target", "cwd", "evidence": "<%h %s / %an <%ae> / %ad>"}`
  - file 成功：`{"ok": true, "verified": true, "type": "file", "target", "cwd", "evidence": "path=<绝对路径>\nsize=<字节>\nmtime=<ISO>\ntype=file|directory"}`
  - text-in-file 成功：`{"ok": true, "verified": true, "type": "text-in-file", "target", "path": <解析后绝对路径>, "hitCount", "evidence": "<最多 10 行命中，每行 `行号: 行内容前 160 字符`>"}`
- **语义**（`runVerification`，`verify.mjs:30-86`）：
  - **git-commit**：sha 必须匹配 `/^[0-9a-fA-F]{7,40}$/`；`git -C <cwd> cat-file -t <sha>`（timeout 15s）确认对象类型为 `commit`；再 `git show -s --format=%h %s%n%an <%ae> %ad` 取证据原文（`verify.mjs:31-40`）。
  - **file**：`assertInside(cwd, target)` 后 `stat`，evidence 含绝对路径 / size / mtime(ISO) / 类型（`verify.mjs:49-56`）。
  - **text-in-file**：`assertInside(cwd, path)` 后读 utf8，逐行 `includes(target)` 收集命中（`verify.mjs:65-76`）；`hitCount` 为总命中数，evidence 只带前 10 行。
  - cwd 解析：显式 `args.cwd` 优先，否则取调用会话 header 的 cwd，都拿不到 → `{"ok": false, "error": "cannot resolve working directory (no exec cwd and no cwd argument)"}`（`verify.mjs:143-144`）。
- **边界与失败**：
  - sha 格式不合法 → `{"ok": false, "verified": false, "error": "not a plausible commit sha: <sha>"}`（`verify.mjs:33`）。
  - git 对象存在但不是 commit → `{"ok": false, "verified": false, "note": "git object exists but is not a commit: <type>"}`（`verify.mjs:36`）。
  - git 失败（退出码 128，如 sha 不存在）→ `{"ok": false, "verified": false, "type": "git-commit", "target", "cwd", "evidence": <错误原文前 3 行>}`——原始证据进 `evidence`、不给 `error` 字段（`verify.mjs:41-44`）。
  - 文件不存在：file / text-in-file 均 `{"ok": false, "verified": false, "note": "ENOENT: file does not exist"}`（`verify.mjs:58-60, 78-80`）。
  - text-in-file 缺 path → `{"ok": false, "error": "path is required for text-in-file"}`（`verify.mjs:66`）；无命中 → `{"ok": false, "verified": false, "note": "no line contains the target"}`（`verify.mjs:75`）。
  - 未知 type → `{"ok": false, "error": "unknown type: <type>"}`（`verify.mjs:85`）。
  - 路径逃逸 cwd → 抛 `path escapes the working directory: <target>`，由包装转 `ok: false`（`verify.mjs:24`）；git 非 128 / stat 非 ENOENT 等其他异常同样上抛包装。
- **关联**：`git-commit-style` / `file-edit-protocol` 技能（验证声称的提交/文件/条目）；可配合 archive 系列核对档案坐标。

---

## plasmid（最薄质粒，#69 新增）

**插件级说明**：最薄质粒 v0（dsh-forge.md §5）：自荐制经验单元。`plasmid_submit / plasmid_search / plasmid_get / plasmid_report` + 四道闸（格式/证据/密钥/查重）+ fitness 记录；`gap_report`（缺口报告，**#70 新增**）与质粒共用管道/证据闸/查重/注册表（`plasmid.mjs:1, 235`）。注册表 = `DSH_HOME/plasmids/registry.json`（缺省 `~/.dsh/plasmids/registry.json`，`defaultRegistryPath`，`plasmid.mjs:26-28`），JSON 文件原子写（tmp + rename，`plasmid.mjs:40-45`）；质粒 P-xxx 与缺口 G-xxx 各自独立计数（`plasmid.mjs:48-59`）。**删除键只在人手里，工具只能新增/更新**（`plasmid.mjs:8, 411`）。机器**四道闸全自动**：格式 → 证据 → 密钥 → 查重（`plasmid.mjs:5, 98-165`）；证据闸挂档案（`sessionQuery.readEvent` 解析 `<sessionId>:<seq>` 句柄，引不出来直接拒，`plasmid.mjs:150-165`）；密钥闸只报命中模式名、不回显疑似密钥（`plasmid.mjs:132-148`）。fitness 近期滑动窗口（最近 20 条）算成功率：跌破 0.3 自动降级 `status='idea'`（有争议标注）、回升自动恢复 `active`（`plasmid.mjs:348-373`）。另注册只读面板数据面 `GET/HEAD /dsh-forge/plasmids`（`?id=` 单条 / `?q=` 搜索 / 缺省全量摘要，`plasmid.mjs:492-527`），非模型工具。**注意与通用约定的差异**：`plasmid_submit` / `gap_report` 的接受/拒绝形态是 `{"accepted": true|false, "gate": ...}`（无 `ok` 字段），`plasmid_search` 直接返回 `{count, total, results}`（无 ok 外壳）；只有 `plasmid_get` / `plasmid_report` 用 `ok` 字段，见各条目「边界与失败」。

### plasmid_submit

- **所属插件**：plasmid
- **一句话用途**：自荐制质粒提交：学到教训的当下自己提交一条修复质粒（WHEN/WORKED/FAILED/WHY + evidence 句柄）；机器四道闸全自动，只可新增/更新、不可删除。

- **工具提示词（模型可见的 description，原文）**：
  > 质粒提交（自荐制，dsh-forge §5）。学到教训的当下自己提交一条修复质粒：WHEN 触发条件 / WORKED 怎么做成了（几次）/ FAILED 怎么做败了（几次）/ WHY 为什么 + evidence 证据句柄列表。机器四道闸全自动：格式→证据→密钥→查重。evidence 必须引用档案里真实存在的事件坐标 <sessionId>:<seq>（用 archive_filter_events 找到相关事件后抄它的 sessionId 和 seq）；引不出来直接拒。写的是陈述句不是命令句。删除键只在人手里，本工具只能新增/更新。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | type | string | 是 | — | 质粒类型。v0 只做修复质粒，固定 "fix"。 |
  | when | string | 是 | — | WHEN：什么时候遇到的（触发条件）。 |
  | worked | string | 是 | — | WORKED：怎么做成了，几次。 |
  | failed | string | 是 | — | FAILED：怎么做败了，几次（负向知识最值钱，如实写）。 |
  | why | string | 是 | — | WHY：为什么（机制/条件/范围）。 |
  | evidence | array | 是 | — | 证据句柄列表（1..8），形如 `"<sessionId>:<seq>"`，必须能从档案解析出真实事件。 |
  | confidence | string | 否 | medium | 枚举 `high` \| `medium` \| `low`。 |
  | scope | string | 否 | project | 作用域说明（<=200 字）。 |
  | updateOf | string | 否 | 无 | 可选：要更新的既有质粒 id（如 "P-002"）。给定时不跑查重闸，给该条出新版本。 |

- **输出**（`submitPlasmid` 返回值，无 `ok` 外壳，`plasmid.mjs:232`）：
  - 接受：`{"accepted": true, "id": "P-xxx", "status": "active", "version": <n>, "updated": true|false}`
  - 拒绝：`{"accepted": false, "gate": "format"|"evidence"|"secret"|"dedup", "error": "<原因>"}`；dedup 额外附 `existingId` / `similarity` / `existingWhen` / `suggestion`
- **语义**（`submitPlasmid`，`plasmid.mjs:169-233`）：
  - **格式闸**（`gateFormat`，`plasmid.mjs:111-130`）：type 必须为 `"fix"`；when/worked/failed/why 必填且 ≤4000 字符；evidence 必须 1..8 个合法 `<sessionId>:<seq>` 句柄（`parseEvidenceHandle` 在**最后一个冒号**处切分、sessionId 不含空格，`plasmid.mjs:100-109`）；confidence 非法值直接拒；scope >200 拒。
  - **证据闸**（`gateEvidence`，`plasmid.mjs:150-165`）：逐个句柄经 `sessionQuery.readEvent` 解析，坐标处无事件或读取失败 → 拒（错误里列出每个句柄原因，并指引「请用 archive_filter_events / archive_read_event 找到真实坐标再提交」）。
  - **密钥闸**（`gateSecrets`，`plasmid.mjs:132-148, 179`）：扫描 when/worked/failed/why/scope 拼接文本是否含高信号密钥模式（private-key / `sk-` 前缀 / AWS AKIA / GitHub token / GitHub PAT / Slack token / 凭证赋值），命中只报模式名（`命中「<模式名>」`）、不回显疑似密钥。
  - **查重闸**（`plasmid.mjs:185-201`）：非 updateOf 时与库内每条修复质粒算文本相似度（`similarity` 为 token 集 Jaccard 变体），最高 ≥0.4 → 拒，suggestion 指引用 updateOf 出更新或写明差异重试。
  - 四闸全过 → 写注册表（`plasmid.mjs:203-230`）：updateOf 存在 → 合并旧条目出新版本（version+1、evidence 替换、updatedAt 刷新）；否则新条目 `P-<n>`（`nextId` 自增）、`status: 'active'`、fitness 初始 `{worked: 0, failed: 0, seen: 0, recent: [], score: 0.5}`。source 取调用会话 id，取不到为 `'unknown'`。
- **边界与失败**：四道闸拒绝均为 `{"accepted": false, "gate": <闸名>, ...}`（**不是** `ok: false`）；其余异常由包装转 `ok: false`。
- **关联**：`archive_filter_events` / `archive_read_event`（找 evidence 坐标）、`plasmid_search`（拉取制检索）、`plasmid_get`（取全文）、`plasmid_report`（用后反馈）。

### plasmid_search

- **所属插件**：plasmid
- **一句话用途**：拉取制检索（§5.5/5.6）：遇到情况先查摘要和适用度，想要全文再用 plasmid_get 拉；默认按相关度+适用度排序。

- **工具提示词（模型可见的 description，原文）**：
  > 质粒/缺口检索（拉取制，dsh-forge §5.5/5.6）。遇到情况先查摘要和适用度，想要全文再用 plasmid_get 拉。返回排序后的摘要（id/状态/when 或 what/worked/fitness/outlet），默认按相关度+适用度。系统不主动推送内容。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | query | string | 否 | 无 | 关键字（空格分词，全部命中才算高相关）。 |
  | type | string | 否 | 全查 | 类型过滤：fix（修复质粒）\| gap（缺口报告）。 |
  | scope | string | 否 | 全查 | 作用域过滤（如 "project"）。 |
  | status | string | 否 | 全查 | 状态过滤：active/idea（质粒）、open/adopted/rejected（缺口）。 |
  | limit | integer | 否 | 20（上限 100） | 最多返回条数。 |

- **输出**：`{"count": <命中数>, "total": <过滤后总数>, "results": [<摘要>...]}`（**无 `ok` 外壳**，`searchPlasmids`，`plasmid.mjs:339`）。摘要 = `summarize`（`plasmid.mjs:85-96`）：`id / type / status / confidence / scope / version / when(140 截断) / worked(140 截断) / evidenceCount / fitness{score, seen, worked, failed} / createdAt / updatedAt / source`；gap 条目附加 `outlet`；有打分时附加 `relevance`。
- **语义**：
  - 过滤：type/scope/status 非空即精确匹配（`plasmid.mjs:317-322`）。
  - **打分**（`plasmid.mjs:323-332`）：query 空 → relevance 0；否则 `ratio = 命中词数 / 词数`，`sub = blob 含完整 query 子串 ? 1 : 0`，`relevance = round(0.7*ratio + 0.3*sub, 2)`；分词走 `tokensOf`（汉字逐字、其余按字母数字下划线）。
  - 排序：relevance 降序 → fitness.score 降序 → id 升序（`plasmid.mjs:333-336`）。
  - cap：`limit` 安全正整数时 `min(limit, 100)`，否则 20。
  - **副作用**：命中结果的条目 `fitness.seen + 1` 并落盘（"看过"计数，`plasmid.mjs:441-451`）。
- **边界与失败**：无显式失败路径（注册表缺失按空库返回）；异常统一包装。
- **关联**：`plasmid_get`（全文）、`plasmid_submit`。

### plasmid_get

- **所属插件**：plasmid
- **一句话用途**：按 id 拉取一条质粒的完整文本（WHEN/WORKED/FAILED/WHY + 机读字段 + evidence 坐标 + fitness）。

- **工具提示词（模型可见的 description，原文）**：
  > 按 id 拉取一条质粒的完整文本（WHEN/WORKED/FAILED/WHY + 机读字段 + evidence 坐标 + fitness）。plasmid_search 只给摘要，需要全文时用这个。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | id | string | 是 | — | 质粒 id，如 "P-002"。 |

- **输出**：`{"ok": true, "entry": <完整条目>}`（`getPlasmid`，`plasmid.mjs:342-346`）；不存在 → `{"ok": false, "error": "没有质粒 <id>"}`。
- **语义**：注册表全量线性查找 id（`plasmid.mjs:343`）。
- **边界与失败**：id 不存在 → `{"ok": false, "error": "没有质粒 <id>"}`（`plasmid.mjs:344`）。
- **关联**：`plasmid_search`、`plasmid_submit`。

### plasmid_report

- **所属插件**：plasmid
- **一句话用途**：质粒使用反馈（fitness）：用后回报 worked/failed，fitness 近期滑动窗口算成功率，跌破 0.3 自动降级 `'idea'`（回升自动恢复 active）。

- **工具提示词（模型可见的 description，原文）**：
  > 质粒使用反馈（fitness）。用了一条质粒后回报它这次管不管用：worked=这条经验对得上、乱帮了忙，failed=这次误导了我。fitness 用近期滑动窗口算成功率，跌破 0.3 自动降级为 "idea"（仍有争议标注）。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | id | string | 是 | — | 质粒 id。 |
  | outcome | string | 是 | — | 枚举 `worked` \| `failed`：worked=帮上忙；failed=误导。 |
  | note | string | 否 | 无 | 可选：一句话记下具体怎样（<=500 字，超出截断）。 |

- **输出**：`{"ok": true, "id", "outcome", "score": <成功率 0-1>, "recentWindow": <窗口条数>, "status": "active"|"idea"}`（`reportPlasmid`，`plasmid.mjs:372`）；不存在 → `{"ok": false, "error": "没有质粒 <id>"}`。
- **语义**（`reportPlasmid`，`plasmid.mjs:348-373`）：
  - 反馈记录进 `fitness.recent`，窗口 = 最近 20 条（`recent.slice(-20)`）；`score = worked + failed === 0 ? 0.5 : round(worked / (worked + failed), 2)`。
  - **降级/恢复**：`score < 0.3` → `status = 'idea'`；原为 idea 且 `score >= 0.3` → 恢复 `'active'`；其余保持（`plasmid.mjs:360`）。
  - note 经 `first(note, 500)` 截断（只记录，不影响 score）；fitness 累计 worked/failed、seen 不变；写回注册表并原子落盘。
- **边界与失败**：id 不存在 → `ok: false`；其余异常包装。
- **关联**：`plasmid_search` / `plasmid_get`（用前查看）、`plasmid_submit`。

### gap_report（#70 新增）

- **所属插件**：plasmid
- **一句话用途**：缺口报告（§5.12）：干活时"这里少了个东西"当场记下来进待办；共用质粒的证据闸/密钥闸/查重/注册表，只进待办、不改变行为；删除/改状态只在人手里。

- **工具提示词（模型可见的 description，原文）**：
  > 缺口报告（§5.12）：干活时"这里少了个东西"当场记下来进待办。与质粒共用证据闸/密钥闸/查重/注册表，只进人待办、不改变行为。出口分流三选一：缺工具→先查插件市场雷达（采用优先），查无此物才进开发 backlog；流程可以更好→转方法质粒候选，走自荐制的闸；协作怎么配合更合适→不进 backlog，直接喂评分系统和能力卡。evidence 必须引用档案里真实存在的事件坐标 <sessionId>:<seq>。删除/改状态只在人手里（本工具只能新增）。
- **参数**：

  | 参数名 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | what | string | 是 | — | 缺的是什么（一句话）。 |
  | why | string | 是 | — | 为什么缺 / 缺了之后卡在哪。 |
  | impact | string | 否 | 无 | 可选：影响面（谁/什么活被拖住）。 |
  | outlet | string | 否 | backlog | 出口：backlog（开发待办，默认）\| plasmid-candidate（转方法质粒候选）\| scoring（喂评分系统）。 |
  | evidence | array | 是 | — | 证据句柄列表（1..8），形如 `"<sessionId>:<seq>"`。 |
  | confidence | string | 否 | medium | 枚举 `high` \| `medium` \| `low`。 |
  | scope | string | 否 | project | 作用域说明（<=200 字）。 |

- **输出**（`submitGap` 返回值，**无 `ok` 外壳**，`plasmid.mjs:308`）：
  - 接受：`{"accepted": true, "id": "G-xxx", "type": "gap", "outlet": "backlog"|"plasmid-candidate"|"scoring", "status": "open"}`
  - 拒绝：`{"accepted": false, "gate": "format"|"evidence"|"secret"|"dedup", "error": ...}`；dedup 额外附 `existingId` / `similarity` / `existingWhat` / `suggestion`
- **语义**（`submitGap`，`plasmid.mjs:263-309`）：
  - **格式闸**（`gateFormatGap`，`plasmid.mjs:240-261`）：what/why 必填且 ≤4000 字符；impact ≤2000；evidence 1..8 个合法句柄；outlet ∈ backlog | plasmid-candidate | scoring；confidence ∈ high/medium/low；scope ≤200。
  - **证据闸** / **密钥闸**与质粒**共用**（`gateEvidence` / `gateSecrets`，密钥闸扫描 what/why/impact/scope 拼接文本）。
  - **查重闸只对 gap 类**：blob = what + why + impact，与库内每条 gap 算相似度，最高 ≥0.5 → 拒，suggestion 指引「有进展需人工更新原条状态；不同缺口写明差异再重试」（`plasmid.mjs:276-291`）。
  - 接受 → 新条目 `G-<n>`（`nextId(reg.entries, 'G-001')`，与 P-xxx 独立计数）、`status: 'open'`、outlet 缺省 `'backlog'`、fitness 初始（`plasmid.mjs:293-306`）。
  - **只能新增，没有更新路径**：删除/改状态只在人手里。
- **边界与失败**：每道闸拒绝为 `{"accepted": false, "gate": <闸名>, ...}`；异常统一包装 `ok: false`。
- **关联**：`plasmid_submit`（共用管道）；`archive_filter_events` / `archive_read_event`（取坐标）；outlet 分流后进开发待办 / 方法候选 / 评分系统。

---

## 共享库：lib/subagent-policy.mjs（提权审批与子代理注入核心）

**用途**：一处实现供所有委托面（`spawn_model_subagent`、`switch_mode`、`team_add_member`）共用：preset 能力面比对、模型系列/档位分类、提权清单收集（模型 / 能力面 / sandbox）、显式 effort 校验、子代理侧 mode/effort/sandbox 注入。**没有硬编码的权限阶梯**——能力面就是 preset 组合的插件行集合（`subagent-policy.mjs:3-11`）。

### 能力面判定：rowNamesOf

- 用 js-yaml 解析 composition 文本，`DEFAULT_SCHEMA` 扩展官方 `!!js` 标签类型：`!!js <表达式>` 被接受但**不求值**，表达式作为文本保留（只需要行名，`subagent-policy.mjs:13-19`）。
- 递归收集所有 `name` 字段：数组逐项展开；`group: true` 的节点（cordis:group）只递归展开其 `config` 数组、自身不产生名字；普通对象收集自己的 `name` 并递归所有值；最后 Set 去重（`subagent-policy.mjs:26-45`）。
- 解析失败返回 `null`——调用方把它当作**能力面未知**处理。

### 提权四条件

1. **模型档位升级**（`collectModelEscalations`，`subagent-policy.mjs:107-121`）：父、子模型同系列且子档位下标更高 → `model tier upgrade`。系列表（`subagent-policy.mjs:73-78`，与 modelroute 内置表一致）：deepseek `[flash, lite, pro, max]`、claude `[haiku, sonnet, opus]`、chatgpt `[mini, lite, pro, max]`、qwen `[flash, lite, plus, max]`；档位按 id 里关键词子串匹配，未命中档位返回 `-1`。
2. **跨系列换模型**：两模型系列不同（含一方无法归类为 null）→ `model series change`（不同厂商家族，计费语义未知）——未知系列也按提权处理（保守）。
3. **能力面超集**（`collectPresetEscalations`，`subagent-policy.mjs:55-70`）：读两个 preset 文本 → 行名集合求差（`addedRows`），目标行名不是当前子集即提权。任一 preset 读不到/解析失败 → 返回「preset capability face unknown (a composition could not be parsed); treated as an upgrade」——**解析失败 → 保守审批**。
   - 空集或「目标行 ⊆ 当前行」→ 不审批；parentPreset/targetPreset/presets 任一缺失或两者相同 → 不审批。
4. **sandbox 拓宽**（`collectSandboxEscalations`，`subagent-policy.mjs:134-144`）：档位枚举 `SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access']`；显式子 sandbox 档位高于父级有效模式（`sandboxPolicy.overrideOf(session)`，缺省回退部署默认）→ `sandbox upgrade: <父> -> <子>`。**未知 sandbox 值同样进审批**（'unknown sandbox mode "…"; supported: …'）；子未显式指定则不触发。

### 显式 effort 校验：validateEffort

- `validateEffort(llm, provider, model, effort)`（`subagent-policy.mjs:150-164`）：经 `llm.resolveModelInfo` 取目标路由声明的 effort 枚举，显式值不在枚举内直接 fail-loud——`unsupported reasoningEffort "…" for <provider>/<model>; supported: …`；枚举不可得（llm 服务缺失 / 路由未声明 / 查询异常）则放行并注明由宿主在请求时校验。spawn 与 team_add_member 均在收集提权**之前**调用——非法 effort 不再表现为子代理静默无输出。

### 子代理侧 mode / effort / sandbox 注入：installChildPolicy

- **时序契约**：`startContinuable` 在 resolve 前**同步**分发 `agent/created`，spawn 之后再登记永远太迟——调用方必须在 spawn **之前**调 `prepare({parentId, mode?, effort?, sandbox?})` 预登记；条目按父会话 id 进 FIFO 队列（`stagedByParent`），`agent/created` 时消费一个槽位；spawn 失败用返回句柄的 `staged.cancel()` 撤回（`subagent-policy.mjs:226-245, 314-333`）。`register(childId, {mode?, effort?})` 保留为兼容入口：子代理已在线则直接装钩子，否则按会话 id 落待注入表（`subagent-policy.mjs:335-344`）。
- `agent/created` 时（`subagent-policy.mjs:226-299`）：
  - **mode**：一次性 `agent/pre-step` 前置监听，在子代理**首次提示词组装之前**执行 `presets.recompose(agent.ctx, modeId)`，并 best-effort 追加 `agent-preset/selected` 事件；recompose 失败只记日志、流程照常继续。
  - **effort**：`agent/request` 前置监听，把解析结果里的 `reasoningEffort` 在**每个**请求上钉为指定值（已相等则不动；注入异常时返回原解析结果）。
  - **sandbox**：显式沙箱在首步前向会话日志追加 `sandbox/mode` 事件，使子代理每次受限调用都折叠进所请求的模式（`subagent-policy.mjs:258-262`）。
  - **日志纠偏**：未显式指定 mode 的子代理冷启动恢复时，在首个 pre-step 内读持久日志里最近一次 `agent-preset/selected`，与当前组合不一致则 recompose 回**日志记录的模式**——修复离线期间延迟切换（或既有 switch_mode 记录）被父组合静默还原的问题（`subagent-policy.mjs:271-298`）。
- `agent/disposed` 时清理两类监听器（`subagent-policy.mjs:301-312`）。
- `liveRoute(parent)`（`subagent-policy.mjs:345-352`）：取父 `requestHeader().config` 的 `{provider, model, reasoningEffort}`，否则取父创建选项——是 `spawn_model_subagent` / `team_add_member` 判定「父当前路由」的依据。

### 与 modelroute 的 taxonomy 关系（待审校确认）

- 本库系列表固定为 `DEFAULT_SERIES`（注释声明「kept in sync with modelroute.mjs」，`subagent-policy.mjs:72`）；modelroute 的系列表可被 `config.series` 扩展/覆盖（`modelroute.mjs:44`）。若 modelroute 侧配置了扩展系列，**审批档位判断与计费重写可能使用不同的系列表**，分叉行为待审校确认。

---

## 附录 A：auto-plugins 动态插件宿主半部的工具注册形态

- `hostCode` 是返回 `{ apply(ctx) { ... } }` 的代码字符串，由 dynboot 恢复运行。
- 工具注册用 `harness.defineTool({name, description, parameters, output, execute})` + `harness.registerTool(ctx, tool)`（`sklui` hostCode L19-39、`sfind` hostCode L31-79、`plins` hostCode L223-250）；output 统一 `{schema: {type: 'string'}, render: 文本块}`，与 composition 插件同构。
- `harness.handle('<prefix>/<name>', fn)` 暴露客户端面板 RPC（如 `skillui/*`、`plinst/*`），不属于模型工具面。
- 动态插件代码改动的生效边界：改 `auto-plugins.json` 后旧实例仍在内存运行，须 `dev_stop_dyn_plugin <prefix>` 停旧实例，重启后用新代码重新 define。

## 附录 B：关键数据文件与持久层位置

| 位置 | 用途 | 相关插件/工具 |
| --- | --- | --- |
| `~/.dsh/storages/session_projcache.json` | 会话标题投影缓存 | mailbridge（session_list / session_send 的 fromName）、sfind（session_find） |
| `~/.dsh/sessions/<workspace>/<id>/` | 会话目录（存在性校验用） | mailbridge（session_list / session_send） |
| kv 单元 `agent_mailbox`（表 `msg`） | 跨会话离线消息队列 | mailbridge（session_send 排队 / mailbox_check / session-start 投递） |
| kv 单元 `agent_teams`（表 `team` / `archive` / `mail`） | 团队、归档、成员消息队列 | teamhub 全部工具 |
| `~/.dsh/injector/registry.json` | 注入插件注册表（重启自恢复） | injector 全部工具；plins 市场安装 |
| `~/.dsh/skillmanager/registry.json` | 持久技能存储 | sklui 管理工具（经 skillmanager.mjs） |
| `~/.dsh/auto-plugins.json` | 动态插件清单（hostCode/clientCode） | sklui / plins / sfind / dynboot |

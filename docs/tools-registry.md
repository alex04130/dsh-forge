# 工具索引（机器生成，勿手改）

> 生成器：`~/.dsh/scripts/gen-tools-registry.mjs`（单一事实源=代码内 registerTool 调用；改工具改代码，索引重新生成即可）
> 生成时间：2026-08-27 02:19 ｜ 总数：49 ｜ 静态 37 + 动态 12

## 其他（12）

| 工具 | 插件 | 形态 | 描述（首句） |
|---|---|---|---|
| `dev_stop_dyn_plugin` | capmgr 三合一能力管理 v2（ | 动态 | Emergency stop for a running dynamic plugin by pluginId pref |
| `git_diff` | gitdock v8 完整版（宿主+ | 动态 | Show the git diff of the session workspace: unstaged changes |
| `git_log` | gitdock v8 完整版（宿主+ | 动态 | Show the recent git commit history of the session workspace, |
| `git_show` | gitdock v8 完整版（宿主+ | 动态 | Show one git commit in detail: full message, file stat, and  |
| `git_status` | gitdock v8 完整版（宿主+ | 动态 | Show the git working tree status of the session workspace (p |
| `session_find` | session_find 会话查找工 | 动态 | 按关键字（会话 id 或标题子串）查找会话，返回带在线状态的紧凑匹配列表 |
| `skill_add` | capmgr 三合一能力管理 v2（ | 动态 | 添加一个持久的运行时技能（host/全局层） |
| `skill_disable` | capmgr 三合一能力管理 v2（ | 动态 | 禁用本管理器添加的一个技能（释放 |
| `skill_enable` | capmgr 三合一能力管理 v2（ | 动态 | 重新启用本管理器先前禁用的技能 |
| `skill_list` | capmgr 三合一能力管理 v2（ | 动态 | 列出调用方代理可见的技能（名称、provider、模型/用户可调用性、描述） |
| `skill_remove` | capmgr 三合一能力管理 v2（ | 动态 | 永久移除本管理器添加的一个技能（释放 + 从存储中删除） |
| `skill_show` | capmgr 三合一能力管理 v2（ | 动态 | 显示一个技能的完整 Markdown 正文 |

## 协作域（18）

| 工具 | 插件 | 形态 | 描述（首句） |
|---|---|---|---|
| `mailbox_check` | mailbridge | 静态 | 检查并消费排给本会话的跨会话消息（本会话不在线期间发来的消息） |
| `session_archive` | mailbridge | 静态 | 归档本主会话下辖的子会话（含子子会话 |
| `session_export` | mailbridge | 静态 | 把会话（默认=调用方自己）递归导出为明文：连同其下辖全部子会话（含子子会话）的消息一并导出——子代理的对话也重要 |
| `session_list` | mailbridge | 静态 | 列出本 DSH 进程中的会话（在线与已持久化），含 id、标题、在线状态、工作区、主从关系与归档状态 |
| `session_list_archived` | mailbridge | 静态 | 列出本主会话下辖的已归档子会话（含子子会话 |
| `session_read` | mailbridge | 静态 | 读取另一会话的近期消息日志（仅精确读取）：用户、助手和工具消息及其文本，按时间从旧到新 |
| `session_send` | mailbridge | 静态 | 向本 DSH 进程中的另一会话发送消息 |
| `session_unarchive` | mailbridge | 静态 | 捞出（取消归档）本主会话下辖的已归档子会话（含子子会话 |
| `team_add_member` | teamhub | 静态 | 添加团队成员：派发一个带指定角色和任务提示词的可续子代理会话（成员继承本会话的组合，包括团队工具） |
| `team_add_members` | teamhub | 静态 | 批量添加团队成员：一次传入多个成员数组（每项含 memberId/role/prompt 及可选的 provider/m |
| `team_claim_task` | teamhub | 静态 | 为成员认领一个待处理任务（或取消认领退回待处理） |
| `team_create` | teamhub | 静态 | 创建一个以你（调用会话）为队长的代理团队 |
| `team_create_task` | teamhub | 静态 | 把团队工作拆成一个任务 |
| `team_delete` | teamhub | 静态 | 结束团队：尽力打断在线成员，然后归档团队记录（任务、依赖图和成员列表保留供回顾） |
| `team_send_message` | teamhub | 静态 | 给队长或另一成员发消息 |
| `team_status` | teamhub | 静态 | 团队全貌：成员及其在线状态、带依赖和输出的任务板、以及排在你收件箱里的消息 |
| `team_update_task` | teamhub | 静态 | 推进任务状态（claimed → in_progress → completed | failed | cancelle |
| `team_wait` | teamhub | 静态 | 暂停当前回合，等待另一名队员的消息或某个任务的完成（两者都给时任一满足即唤醒） |

## 知识域（10）

| 工具 | 插件 | 形态 | 描述（首句） |
|---|---|---|---|
| `archive_filter_events` | archive | 静态 | 在一个会话内按事件类型 / 关键字过滤事件，返回带语义文本的匹配文档 |
| `archive_list_events` | archive | 静态 | 列一个会话的事件索引（seq/type/time/surface），用于快速扫一眼该会话发生过什么，再决定用 archi |
| `archive_read_event` | archive | 静态 | 按 sessionId + seq 精确读取一个会话事件及其上下文窗口 |
| `archive_trace` | archive | 静态 | 追踪一个会话的祖先链与后代树（谁派生了它、它派生了谁），回答「谁和谁合作过」 |
| `gap_report` | plasmid | 静态 | 缺口报告（§5 |
| `plasmid_get` | plasmid | 静态 | 按 id 拉取一条质粒的完整文本（WHEN/WORKED/FAILED/WHY + 机读字段 + evidence 坐标 |
| `plasmid_report` | plasmid | 静态 | 质粒使用反馈（fitness） |
| `plasmid_search` | plasmid | 静态 | 质粒/缺口检索（拉取制，dsh-forge §5 |
| `plasmid_submit` | plasmid | 静态 | 质粒提交（自荐制，dsh-forge §5） |
| `verify_claim` | verify | 静态 | 言行一致检查器：显式验货 |

## 路由域（4）

| 工具 | 插件 | 形态 | 描述（首句） |
|---|---|---|---|
| `model_call` | llmrouter | 静态 | 以一次性、纯文本补全的方式调用另一供应商（或同一供应商）的模型，并把它的完整回复作为本次工具调用的结果返回 |
| `model_list` | llmrouter | 静态 | 列出本 DSH 进程中注册的每条 LLM 供应商路由及其提供的模型，外加一个反向索引（byModel：每个模型 id 由 |
| `model_route_status` | modelroute | 静态 | 显示当前代理路由 |
| `model_taxonomy` | modelroute | 静态 | 显示模型系列分类（系列、档位关键词）并对一个模型 id 归类 |

## 运行时域（5）

| 工具 | 插件 | 形态 | 描述（首句） |
|---|---|---|---|
| `dev_inject_plugin` | injector | 静态 | 把本地插件包运行时注入到正在运行的 web profile（无需重启，不改 patch/打包产物） |
| `dev_injected_list` | injector | 静态 | 列出每个运行时注入的插件包（名称 + 源目录） |
| `dev_plugin_status` | injector | 静态 | 显示注入器注册表以及每个在线 loader 条目（id + 名称 + 禁用状态） |
| `dev_reload_package` | injector | 静态 | 重建一个注入的插件条目（释放 fiber + 重新导入） |
| `dev_uninject_plugin` | injector | 静态 | 取消注入一个运行时注入的插件包：fiber 被释放、符号链接移除、注册表条目删除 |


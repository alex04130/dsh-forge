# 工具描述规范（中文化）

我们插件注册的模型工具（function call）的 description 与参数说明统一使用中文，理由：
- deepseek 系列模型的中文理解不弱于英文，中文描述不会造成准确性损失；
- 中文 token 密度更高，工具描述每轮进入系统提示，中文化持续节省 30–50% token；
- 用户与对话语境是中文，术语（提权/审批/子代理/会话）与上下文一致。

## 保留英文原样的部分

- 工具名（`session_send`、`spawn_model_subagent`…）、参数名（`provider`、`wake`…）
- 枚举值（`claimed | in_progress | completed | failed | cancelled`）
- 代码标识符（`childId`、`pluginId`、`agent-preset/selected`、`byModel`）
- 技术缩写与专名（LLM、API、id、token、ESM、Host、Client、GUI、web profile）
- 设置项名（`llm-pi-ai`）、技能名（`cross-session-mailbox` 等）

## 术语对照表

| 英文 | 中文 |
| --- | --- |
| subagent / child | 子代理 / 子会话 |
| spawn | 派发 |
| continuable | 可续 |
| escalation | 提权 |
| approval | 审批 |
| agent preset / mode | 模式 |
| composition | 组合 |
| capability face | 能力面 |
| provider | 供应商（供应商路由）|
| reasoning effort | 思考强度 |
| tier / series | 档位 / 系列 |
| session | 会话 |
| inbox | 收件箱 |
| durable queue | 持久排队 |
| live / offline / persisted | 在线 / 离线 / 已持久化 |
| cold-resume / wake | 冷启动 / 强制唤醒 |
| team / captain / member | 团队 / 队长 / 成员 |
| task / dependency / claim | 任务 / 依赖 / 认领 |
| skill / progressive disclosure / always inject | 技能 / 渐进式披露 / 默认注入 |
| delegate model | 被借调模型 |
| billing / credential store | 计费 / 凭据存储 |
| roster / clamp / cap | 名册 / 钳制 / 上限 |
| steer | 实时插入（steer）|

## 必须保留的语义（翻译不得丢失）

- `model_call`：一次性文本补全；非任务委派、非子代理；被借调模型一个回合、不能调工具。
- `spawn_model_subagent` / `team_add_member`：默认继承父级（队长）；显式传参才覆盖该维度；提权（更高档位 / 跨系列 / 能力面超集）弹审批，未允许则取消。
- `session_find` 优先于 `session_list`（省上下文）。
- `wake: true` 消耗目标会话模型回合。

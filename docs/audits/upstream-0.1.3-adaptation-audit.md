# 上游 0.1.2-rc.1 / 0.1.3-alpha.1 适配审计（逐行判定 + upgrade-skill 试用）

> 2026-09-05，审计会话 b967da6b（Qwen 3.8 flash）。受 grok `session-85a6c062` 调度（用户明示：升级评估给审计做）。**判断权在人**；本文给拍板依据。
> 配套：grok 初稿 `docs/upstream-0.1.3-impact.md`（已按本审计修订：modsub 提权链保留、节奏改并行、静态活行实数 20）。
> 纪律声明：本审计只读（tmp clone 试 skill、grep 本机插件源码），未改任何被审代码/组合。

## 0. 版本事实（2026-09-05 实测）

| 项 | 值 | 依据 |
|---|---|---|
| 本机 npm dist-tag | `latest`/`next` = `0.1.2-rc.1`，`alpha` = `0.1.2-alpha.5` | `npm view @deepseek-ai/dsh dist-tags` 实测 |
| 本机安装版 | `0.1.2-alpha.3` | `/usr/lib/node_modules/@deepseek-ai/dsh/package.json` |
| 0.1.3-alpha.1 | 09-04 GitHub release，**未进本机 npm tag**；含已知性能回退（历史 session 加载变慢，官方声明下版修） | [release dsh-v0.1.3-alpha.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.1) |
| rc.1 本质 | alpha.5 + 2 commits（纯版本 bump，零源码差异）——**插件面 = alpha.5** | skill 卡 `v0.1.2-rc.1.md` 真机核对 |

## 1. upgrade-skill 试用结论（oh-my-dsh，非官方）

**是什么**：58 张版本升级卡（0.1.0-rc.8 → 0.1.2-rc.1）+ 12 条通用对策 + 9 个 skill + 3 个可执行脚本（[repo](https://github.com/oh-my-dsh/dsh-plugin-upgrade-skill)）。官方 rc.1 release notes 引用了它，并声明非官方。

**实跑了什么**（Mode A 只读，tmp clone，未装进任何会话/registry）：
- `plan-migration.mjs --from dsh-v0.1.2-alpha.3 --to dsh-v0.1.2-rc.1` 对 `dynplugins/`（31 文件）与 `profiles/web/`（76 文件）各跑一遍；走廊解析 alpha.3→alpha.4→alpha.5→rc.1 正确。
- 动态侧命中卡：**A4-01**（report 工具包删除，send_message 替代）、**A4-03**（Session.events 移除 → seq/eventAt/snapshotEvents）、**A4-04**（SessionSeq/LogOffset 强类型）、A4-05/A4-06（行为默认：ptc workflow、base web_fetch）。
- **A5-03（信息性，对我们最要紧）**：0.1.1-rc.2 / 0.1.2-alpha.3 的 home 升到 alpha.4 可能**拒启或丢会话标题**，alpha.5 起才读全三代 session_projcache —— 我们是 alpha.3 home，**升级不得停在 alpha.4**，直接落 rc.1（或 0.1.3）。

**评价**：
- 卡质量高：每张带源码坐标、迁移配方、验证步骤、真机记录；rc.1 卡自证"零插件面变更"。
- 两个边界必须知道：①卡是 **curated 非完整 diff**，A4-03 的 ledger 打的是 `Session.events` 直读，而我们动态插件走的是 `sessionPersistence.inspect()` 的 events 投影 + append——**命中面不同，不能盲套**，需人工判读（本审计 §2 逐条做了）；②**0.1.2→0.1.3 走廊无卡**（社区标注"等社区认领"），0.1.3 迁移只能按 release notes + 源码 diff 走，skill 只剩方法论（双 cohort 探针、ghost-host-check、分层验证）可复用。
- 采用建议：①`host-plane-probes.md` 的 `!!js` 双 cohort 探针三式（resolve 子路径 / 预设文件判据 / 包目录判据）直接用于临时 profile 并行验证；②A5-03 提醒进升级流程；③rc.1 临时 profile 起来后可跑 `ghost-host-check.mjs` 防旧进程幽灵；④**不装进任何会话**（本轮 tmp clone 只读即"试用"，如需常驻由人拍）。

## 2. 动态插件 12 条逐行判定（auto-plugins.json 实读）

判定依据：源码 grep（行号实指）+ planner 命中卡 + 用户已拍决策。**rc.1 判** = 0.1.2-rc.1 临时 profile 上；**0.1.3 判** = 0.1.3-alpha.1。

| id | 现状 | rc.1 | 0.1.3 | 依据 |
|---|---|---|---|---|
| gitdk | disabled | 不动 | 退役候选 | 已关；纯文件行 |
| modpk | on | 回归探针 | **要改** | `modpk.host.js:21,34-40,68-69`：`sessionPersistence.inspect` → `inspection.events` 遍历 + append `agent-preset/selected`；SessionHandle/format v2 下 inspect/append 契约变 |
| modlpk | disabled | 不动 | **退役候选** | 已关；官方 A1-11 子代理选型 + A1-09 设置页登录落地后无存在必要；升档只删不改 |
| imgsub | disabled | 不动 | **可退役** | 官方原生发图（rc.1 notes 多项图片改进）已替代；随升级连 `imgsubbridge` 静态行一起删 |
| sfind | on | 不动 | **要改** | `sfind.host.js:3,5`：薄委托 `sessionmgmt`（P-005 撞名守卫已加）；sessionmgmt 形状随 SessionHandle 变则跟改 |
| subflt | on | **先探针** | **可退役候选** | `subflt.host.js:14-15,42,47` 包装 `subagents.reportFrom`；rc.1 探针 P1：reportFrom 是否仍在 + 官方 steer 是否覆盖其去重面。**先对照再关（用户拍板）** |
| stfx | disabled | 不动 | 退役候选 | 已并 fshell |
| steer | on | **对照探针** | **要改（可能退役）** | `steer.host.js:2` host 直发 agent.steer + client 拦 Ctrl+Enter；rc.1 send_message 双向后与官方面重叠，探针 P5 定去留 |
| forge | on | 回归探针 | **要改** | `forge-ui.host.js:54-136` sessionmgmt RPC 全部 typeof 防御（风格好）；0.1.3 session 锁卡 sesmgr/capmgr 双进程探测 |
| purity | on | 不动（现进程） | **要改** | `purity.host.js:45` inject agents+agentPresets；A 层 recompose 撞 `agentLoop.create()` 异步 + session 锁 |
| featui | disabled | 不动 | 不动 | 设置页已另走（console/官方 settings） |
| trout | disabled | 不动 | 不动 | C-1 已走真包 `dsh-tool-router` |

附：**inbx-22** 是本会话动态闸门件，不作常驻，升档前停。**dynrestore**（`@local/dsh-dynrestore` 静态行）：0.1.3 **要改**（client 重挂 + 锁）。

## 3. 静态活行 20 条逐行判定（profiles/web/cordis.patch.yml 实读）

初稿写"约 15 活件"，实数 **20**（17 本地 mjs + dynrestore + authorization + mcp-github）。

| 行 | 判定 | 依据 |
|---|---|---|
| featsw.r9 | 不动 | 文件面开关 + registerTool；A4-06 web_fetch 默认开属政策复查项（探针 P7） |
| console.r13 | rc.1 不动 / 0.1.3 **要改** | 3082 独立 HTTP 面；0.1.3 接 sessionmgmt（T13 靠后） |
| mailbridge.r4 | rc.1 回归 / 0.1.3 **要改** | resume/inspect/events 面；0.1.3 换 SessionHandle；live 投递对账官方 steer（探针 P8） |
| llmrouter | 不动 | 模型委派，无版本敏感面 |
| modeswitch | rc.1 不动 / 0.1.3 **要改** | preset 事件 + session 锁 |
| teamhub.r1 | rc.1 回归 / 0.1.3 **要改** | kv/agent_teams 仍旧；send_message 双向后消息投递面回归（P6）；并入闸在新 profile 之后（用户拍） |
| modsub.r1 | **保留并适配（用户拍）** | 官方 A1-11 只放开授权范围内选模型/调用方指定；`collectModel/Preset/SandboxEscalations` + approval 是**能力面提权**（升档/跨系列/sandbox 加宽），官方无等价物。探针 P2 对交叠面 |
| injector | 不动 | 热载注册表；0.1.3 起来后探针 |
| skillmanager.r1 | 不动 | 技能存储，文件面 |
| modelroute | **小改候选** | 官方模型探测增强（rc.1 notes）+ A1-11 选型参数；能力页受益；提权链不动 |
| dynboot | rc.1 不动 / 0.1.3 **要改** | define 快照 + runHostHalf；0.1.3 撞 session 锁与生命周期 |
| forgeboot2.r2 | 小改候选 | 清单缺失补 define；仍靠 inventory |
| hotmgr.r2 | 不动 | 热载看门狗（planner #1 命中即 monkey-patch 式重载，现状工作正常）；0.1.3 探针 |
| imgsub-bridge | **可退役** | 与 imgsub 同命运，随升级删行 |
| dynrestore（@local） | 0.1.3 **要改** | 见 §2 附注 |
| authorization（官方包） | 不动 / 删行候选 | rc.1 A1-09 官方设置页登录：若 base bundle 已原生注册 AuthorizationService，本行冗余（探针 P4）；T6 能力页登录对照官方 |
| plasmid | 不动 | 文件面 |
| web-search-kimi | 不动 / 小改候选 | 0.1.3 出站请求跟 `HTTP(S)_PROXY`，受益不改也行 |
| web-search-select | 不动 | provider 选择持久化 |
| mcp-github（LOCAL-ONLY） | 不动 | 不改 patch |

未挂行（`*.rN.mjs` 历史副本 / `.pre73-0825/` / toolrouter.r1 静态版）：非活件，planner 命中多为历史副本噪音，不计入判定。

## 4. 临时 profile 探针清单（rc.1，现在就能做）

| # | 探针 | 决定什么 |
|---|---|---|
| P1 | `subagents.reportFrom` 服务在 rc.1 是否存在/行为 | subflt 立即失效 or 正常；对照官方 send_message steer 覆盖面后定 subflt 退役 |
| P2 | 官方子代理选型（A1-11）参数名/授权边界（skill 卡明确：**勿按 release notes 臆造形状，查目标 tag 类型定义**） | modsub 提权链与官方选型的交叠与分工 |
| P3 | `sessionmgmt.list/inspect` 契约回归 | sfind / forge-ui / mailbridge 三消费方 |
| P4 | base bundle 是否已原生注册 AuthorizationService | authorization 行删留 + T6 登录走官方 or 自建 |
| P5 | 官方 client 是否已支持子代理插话/排队 | steer 插件去留 |
| P6 | teamhub kv 面 + send_message 双向投递 | teamhub 回归结论 |
| P7 | base bundle `web_fetch: true` 默认 | featsw 闸门是否需显式关（政策项） |
| P8 | mailbridge live 投递 vs 官方 steer 是否重复 | mailbridge 0.1.3 改造范围 |

探针方法论直接用 skill 的 `!!js` 双 cohort 三式 + `ghost-host-check.mjs`（防旧进程幽灵）。

## 5. 0.1.3-alpha.1 专项适配面（单独立项，按 release notes + 源码 diff，无社区卡）

1. **SessionHandle + create() 异步 + session 锁**：mailbridge（resume）、purity（recompose）、dynboot/dynrestore（define+runHostHalf 生命周期）、forge（sesmgr/capmgr 探测）、modeswitch。
2. **format v2（不可变 generation 迁移 + settlement 聚合）**：凡假设 jsonl 行形状的——蒸馏脚本（zstd 行扫描）、archive 类扫描、modpk/modlpk 的 append+inspect、sesmgr 归档真值（**meta.json 是否保留需探针，不臆断**）。已知性能回退，等下一版再评估。
3. **send_message 统一 steer**：subflt/steer 去留终判；teamhub 消息面。
4. **PTC 默认不暴露 workflow**：forge-team/forge-team-creative 本就不挂 workflow，方向一致，无动作。
5. **Web 通用文件上传 / proxy env / read_image 工具卡渲染**：受益项，默认不动。

## 6. 推荐拍板（待人判）

- **A**：现进程 T8b 闸门继续，不重启主进程——与升级**并行**（用户已拍节奏）。
- **B**：临时 profile **现在**升 `0.1.2-rc.1`（落地即 rc.1，**不停 alpha.4**——A5-03 拒启/丢标题坑），跑 P1-P8 探针；「要改」清单适配代码在临时 profile 写验。
- **C**：0.1.3-alpha.1 单独立项，按 §5 适配面做；验收成功才重启主进程（闸门次序不变）。
- **D**：退役动作（subflt / steer / modlpk / imgsub+imgsubbridge / authorization 行）**全部等 P1-P8 结论后由人逐项拍**，不预删。
- **E**：T9 MCP env 掩码随 T9，不塞进本轮。
- **F**（可选）：0.1.3 无社区卡——我们实测踩坑可回填 oh-my-dsh（走 upstream discussion 流程，由人/交接决定是否投）。

---

## 7. 实测结果（2026-09-05 01:05-02:30，headless CDP 无争用环境）

### 7.1 结论先行

**0.1.3-alpha.1 无法加载我们的任何历史会话——v0→v1 迁移器硬拒绝，问题等级从"性能回退"升级为"兼容性阻断"。** C 拍板（等官方修复后再立项）被实测强烈支持。

### 7.2 证据链（全部本机实测）

1. **环境**：0.1.3-alpha.1 源码树全量构建成功（tarball→git init→pnpm build，CLI `apps/cli/lib/bin.js --version`=0.1.3-alpha.1）；tmp-013-home :3091；同批 6 大会话拷贝（copyA=013/v2 迁移对象，copyB=tmp-alpha3-home :3092 对照，byte-identical，125MB）。
2. **对照**：alpha.3 同批同流程 headless 加载 row0（session-d3404dc5，15.7MB/146k events）**3.0 秒完成**，内容正常渲染。
3. **0.1.3**：同一会话 40-200s 后报错——
   ```
   Failed to load history: failed to observe session "session-d3404dc5-…":
   @deepseek-ai/dsh-session-format-v0-to-v1 refuses this format v0 Session:
   assistant/chunk 95 chunk replayState has unexpected member "kind";
   source v0 artifact remains unchanged
   ```
   session-5019fb00（19MB）同样拒绝（chunk 94）。其余 4 会话在长等待下预期同样拒绝（同一 writer 代）。
4. **根因样本**（d3404dc5 chunk seq=95）：`chunk.replayState = {kind:"pi-ai", version:1, api:"openai-completions", provider:"cerebras", model:"deepseek-v4-pro-eco", …}` —— 0.1.2-alpha.x 的 pi-ai writer 在 replayState 里写 `kind` 家族判别字段；0.1.3 的 v0→v1 迁移器 schema 不容该成员 → 拒收且**源日志保持不变**（安全但阻断）。
5. **次生现象**：拒绝前迁移扫描极慢（chunk 94 要 40s+，而裸解压全文件只要 0.25s）——用户亲测的"加载极慢"即此扫描过程。
6. **中途排除项**：曾疑似 mux WS 挂死→实为源码构建不完整（build:lib:host+client+web 三面不足）；跑通官方全量 `pnpm run build` 后 mux 正常。构建插曲不计入上游结论。

### 7.3 对拍板的影响

- **C（0.1.3 立项时点）**：实测支持"等官方修复"。修复前 0.1.3 对我们的历史数据不可用。
- **F（回填 oh-my-dsh）**：+1 张硬卡素材——"0.1.3 v0→v1 迁移拒绝 pi-ai replayState.kind（0.1.2-alpha.x writer 产物）"，附完整错误串与样本行。
- **升级流程**：rc.1 → 0.1.3 的闸门必须加"历史会话抽测"（P9：任选 2 个大会话在 0.1.3 打开，报错即停）。

### 7.4 rc.1 侧（未竟项）

rc.1（0.1.2-rc.1，3090）UI 可用但 headless 会话加载验证未完成（workspace 选择器交互差异）；rc.1 无 v2 迁移面（原生读 v0/v1），风险面本就小于 0.1.3，不阻塞结论。


### 7.5 插件归因排除（三腿证明，2026-09-05 应拍补做）

用户点破要害（上次教训：曾误把插件 bug 当 dsh bug）。本节把"0.1.3 拒收不是插件所为"做实：

| 腿 | 证据 | 结论 |
|---|---|---|
| L1 负向排除 | `grep replayState / assistant-chunk 写入` 于 dynplugins/ + profiles/web/plugins/ + community-plugins/ 全部插件源码：**零命中** | 插件不写该字段 |
| L2 官方构造点 | `@deepseek-ai/dsh-llm-pi-ai/lib/index.js:62` `toPiReplayState()`（官方包）构造 replay envelope：`response.kind:"pi-ai", version:2` | 该字段是官方 writer 所写 |
| L2b 代际定性 | 被拒样本是**顶层** `kind:"pi-ai", version:1` = pre-alpha.4 更老 writer 代；append-only 日志跨版本层积保留 | 0.1.3 迁移器单代 schema 拒官方自己相邻版本的产物 |

**定性升级**：不是"0.1.2 写的字段 0.1.3 不认"这么简单——是**官方 writer 跨版本格式层积 vs 官方迁移器单代 schema** 的结构性矛盾。素材稿 `docs/upstream/013-replaystate-kind-refusal-draft.md` 已按三腿证明重写 root cause。P-011（证据分级纪律）记 worked。

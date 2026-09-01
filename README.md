# dsh-forge · DSH 锻造台

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

> DeepSeek Harness 的运行时扩展套件：像 Minecraft 的 Forge 一样，为 DSH 锻造、安装、路由、编排插件。
> A runtime extension suite for DeepSeek Harness — forge, install, route and orchestrate plugins the Forge way.

Topics: `dsh-plugin` `deepseek-harness` `dsh` `cordis` · 更多社区插件见 https://github.com/topics/dsh-plugin

## 这是什么

dsh-forge 是运行在 `~/.dsh` 用户层的一整套 DSH 扩展，不 monkey-patch 任何 npm 包。当前规模：host 插件 15 个 / 动态插件 12 条 / 模型工具 49 个 / npm latest `@dsh-forge/bundle` **0.2.0**。

核心能力：

| 组件 | 能力 |
|---|---|
| **插件市场 + 安装器** | 浏览 GitHub `dsh-plugin` topic 社区插件，一键安装（npm 包 / 动态清单 / preset / bundle 四种形态自动识别），注入器热加载 + 持久注册表 |
| **任务感知思维模式路由**（router-standard preset） | 首条消息分类 spec（先计划）/ react（直接干）/ weak（模型自路由），首轮极简锚定 + 首个 tool/call 后放全量工具；锚定仅对 deepseek 系列生效 |
| **Skill 管理器** | 统一管理全部技能：持久化增删启停、内容预览、内置 runtime 技能（跨会话邮箱 / 模型委派 / agent 团队）收敛为一处管理，设置页面板 + 模型工具双通道 |
| **插件管理面板** | 实时发现宿主/注入/官方三类 loader 条目 + 动态插件运行/停止/删除，搜索 + 分区导航 |
| **会话管理** | mailbridge：列表 / 查找 / 归档 / 捞回 / 导出（含子树、工作区过滤）；sesmgr 侧栏「已归档」面板（v8，SVG 徽章 + 窄轨 wide 契约） |
| **档案 · 质粒 · 验货** | archive 证据句柄（`sessionId:seq`）；plasmid 自荐 / 检索 / fitness + `gap_report`；`verify_claim` 对 git-commit / file / text-in-file 显式验货 |

协作与编排层（15 个 host 插件）。`bundle/cordis.patch.yml` 与 npm 0.2.0 的 `cordis.npm.yml` **insert 15 行**；`archive` / `verify` / `plasmid` 自 0.2.0 写入 insert（#71 拍板；plsm 不进 insert，随动态清单走）。

- `mailbridge` — 跨会话邮箱 + 会话管理：session_list / session_find（sfind 委托）/ session_list_archived / session_archive / session_unarchive / session_export / session_read / session_send / mailbox_check
- `skillmanager` — 持久技能注册表（增删启停、默认注入）；模型工具与设置页 UI 由动态插件 sklui 挂在同一服务上
- `teamhub` — Claude-Code 风格 agent 团队：captain + 成员子代理 + 依赖排序任务板 + 成员间直连消息
- `llmrouter` — 多厂商模型委派：model_list / model_call，一次任务丢给任意 provider/model
- `modelroute` — 子代理模型继承策略（永不静默升级到更贵 tier）+ 模型系列 taxonomy + plan 计费路由
- `modeswitch` / `modsub` — 会话中途切 preset；指定模型 spawn 子代理
- `injector` — BepInEx 式运行时注入：symlink + loader.create + 持久注册表，重启自动恢复
- `dynboot` / `dynrestore` — auto-plugins.json 动态插件重启恢复 + 页面刷新重挂客户端
- `imgsub-bridge` — 子代理图片消息转附件引用
- `plugmgr` — 插件管理面板（@local/dsh-plugmgr 双面包）
- `archive` — 项目档案 v0：只读封装上游 sessionQuery，四工具证据句柄
- `verify` — 言行一致检查器 v0：verify_claim 显式验货，只读
- `plasmid` — 最薄质粒 v0：submit/search/get/report + gap_report，四道闸 + fitness

动态插件（`dynamic/auto-plugins.json`，12 条，`gitdk` 禁用）：模式下拉框（modpk）、模型+等级选择器（modlpk）、子代理图片补丁（imgsub）、技能管理面板（sklui）、插件市场面板（plins）、会话查找（sfind）、sesmgr（子会话归档/删除 UI，v8）、plsm（质粒面板 v0.1.1，只读；数据面走包私有 RPC，client 禁 fetch）。补丁型：subflt（子代理 report/结算通道 steer 化 + 同轮去重）、stfx（侧栏 Settings 行对齐）、steer（子代理会话 Ctrl+Enter 插话）。多面板 clientCode 中英双语（`locale.active` + 缺席回退英文）。

## 为什么叫 forge

DSH 的插件生态和 Minecraft 的 mod 生态很像：一个稳定的宿主（Harness），海量第三方扩展（插件），以及把这一切管理起来的装载层。Forge 就是那层：注入（装载）、路由（兼容）、市场（分发）、锻造（创作）。

## 安装

**推荐：npm 包（官方插件机制，含全部 host 插件）**

```sh
dsh plugin --profile web add @dsh-forge/bundle
```

`@dsh-forge/bundle` 声明官方 `dsh.bundle.patch` manifest，`dsh plugin add` 会自动把它注册进 profile 的 patch 层；装完重启 DSH（`dsh web`）即可。需要 **0.1.4+**（0.1.3 及更早版本在 npm 路径下 boot 失败，为已知历史 bug）。npm 0.2.0 的 insert 已含 archive / verify / plasmid：`dsh plugin add` 后随重启自动挂上。

**可选组件：任务感知路由 preset（手动复制）**

```sh
cp -r presets/router-standard $DSH_HOME/.agent-presets/
# 新建会话选择「路由标准（实验性）」preset
```

npm bundle 不含 preset 与动态面板，需要时从源码仓库复制。

**从源码安装（完整套件：host 插件 + 动态面板 + preset）**

```sh
git clone https://github.com/alex04130/dsh-forge.git
cd dsh-forge
node scripts/install.mjs     # 复制到 $DSH_HOME，自动备份、幂等
# 重启 DSH（dsh web），新建会话选择「路由标准（实验性）」preset
```

或手动对照 `bundle/`、`dynamic/`、`presets/` 目录复制；本地路径形态：`dsh plugin --profile web add <path>/bundle`。

### 可选：GitHub MCP 工具（mcp__github__*，默认不集成）

默认不集成（`bundle/cordis.patch.yml` 已不含 mcp-github 条目）。以下为手动可选配置，
需自备 token：

1. 本地安装 MCP server（依赖运行时目录 `~/.dsh/mcp/github-server/`，不进仓库；本机 npm
   全局/缓存目录可能只读，故指定 `--cache /tmp/npm-cache`）：

```sh
npm install --prefix ~/.dsh/mcp/github-server --cache /tmp/npm-cache \
  --no-bin-links --no-package-lock @modelcontextprotocol/server-github
```

2. 在 profile 的 `cordis.patch.yml` 里手工追加 mcp-github 条目（stdio 走
   `node ~/.dsh/mcp/github-server/node_modules/@modelcontextprotocol/server-github/dist/index.js`，
   serverName=github，工具名 `mcp__github__*`）。

token 由 DSH 进程环境变量 `GITHUB_PERSONAL_ACCESS_TOKEN` / `GITHUB_TOKEN` 提供，配置文件不落密钥。

## 验证

`npm run check`（全部 host/client 代码语法自检）。运行时验证：`dev_plugin_status`（注入器）、`skill_list`（技能）、`model_taxonomy`（路由）、`dev_router_status`（思维模式路由）。plsm 面板探针：`node scripts/verify-plsm.cjs`（维护者本机，依赖本机 chromium 缓存）。

## 平台支持

Windows / macOS / Linux 全平台可用：

- **路径运行时派生**：host 静态插件用 `process.env.DSH_HOME || join(os.homedir(), '.dsh')` 解析 DSH 家目录。**已拍板例外**：动态 host 半部无 `process` 全局，`plsm.host.js` 使用部署常量 `/home/alex/.dsh/plasmids/registry.json`（#71；`sandboxPolicy.workspaceRoot` 是部署 home 而非会话工作区，不能拿来拼 `~/.dsh`）。
- **注入与安装**：`scripts/install.mjs` 与注入器均带 win32 junction 回退（无符号链接权限时自动降级）。
- **动态插件 shell 操作**（插件市场 / session_find 等）全部改写为 `node -e` 跨平台实现（bash 与 pwsh 双壳安全引用），不依赖 POSIX 命令。
- 发布脚本 `scripts/publish-client-packages.sh` 为维护者本机专用（POSIX），不影响使用端。

## 已知限制

- **teamhub**：队长代认领的任务，成员本人无法 update（assignee 记录 memberId、鉴权用 sessionId）；`team_create` / `team_add_member` 的审批等待会串行阻塞其他 `team_*` 调用（P1 顺延项）。
- **市场安装的插件以宿主进程权限执行**（与 `dsh plugin add` 同样无沙箱隔离）：只安装审查过来源的仓库；面板内已有警示横幅。
- **动态 client 半部禁 fetch**：面板数据面必须走 `host.call` / `harness.handle` 包私有 RPC（UI-LESSONS #16）；fs 的「不存在」是 `FS_NOT_FOUND`，不是 Node `ENOENT`。

## 对插件开发者的告诫

- **禁止经常变化的整体注入**：不要做"每次变更都整体注入"的设计：注入内容随会话累积只增不减，context 单调膨胀，token 成本与噪声持续上升。只注入增量或一次性快照。
- **避免中途 surface replace**：运行中途整体替换 surface（界面/渲染层）会让此前构建的前缀缓存全部失效，性能断崖。需更换表面时尽早替换，或做增量补丁。

（完整版与协作约定见 [CONTRIBUTING.md](CONTRIBUTING.md#对插件开发者的告诫上游审计教训)。）

## 故障排查

- **装完没生效**：host 插件、preset、动态清单的改动都要重启 DSH（`dsh web`）才生效；npm 包装完同样需重启。
- **npm 包装完没有路由 preset 与动态面板**：`@dsh-forge/bundle` 只含 host 插件与客户端包；preset 与动态面板需从源码仓库复制（见上文「可选组件」与「从源码安装」）。
- **首轮锚定/工具收窄没发生**：锚定仅对 deepseek 系列模型生效（`anchorApplies`，默认 `/^deepseek/i`）；其他系列模型全程拿完整提示词与全量工具，属预期行为。
- **npm 路径 boot 失败**：确认装的是 `@dsh-forge/bundle` 0.1.4+；0.1.3 及更早版本在 npm 路径下 boot 失败（已知历史 bug）。
- **卸载**：`dsh plugin --profile web remove @dsh-forge/bundle` 后重启；源码安装的参照 `scripts/install.mjs` 的落点反向删除（插件、preset、`# dsh-suite:start/end` 标记块）。

## 工具定义

本套件注册的全部模型工具，按插件分组（49 个；gitdk 四工具已禁用，不计）：

| 插件 | 工具与用途 |
|---|---|
| **mailbridge**（跨会话消息桥 + 会话管理） | `session_list`（列出会话，工作区/归档过滤）、`session_list_archived`、`session_archive`、`session_unarchive`、`session_export`、`session_read`、`session_send`、`mailbox_check` |
| **llmrouter**（模型委派） | `model_list`（provider/model 目录 + byModel 反向索引）、`model_call`（一次性文本补全，非子代理） |
| **modeswitch** | `switch_mode`（当前会话中途切换 agent preset，提权需确认）、`session_mode`（查询任意会话当前生效的模式） |
| **teamhub**（代理团队） | `team_create` / `team_add_member` / `team_add_members` / `team_create_task` / `team_claim_task` / `team_update_task` / `team_wait` / `team_send_message` / `team_status` / `team_delete` |
| **modsub**（子代理派发） | `spawn_model_subagent`（可指定 provider/model/reasoningEffort/mode/sandbox，默认全继承父，提权自动审批） |
| **injector**（运行时注入） | `dev_inject_plugin` / `dev_uninject_plugin` / `dev_injected_list` / `dev_reload_package` / `dev_plugin_status` |
| **modelroute**（路由策略） | `model_taxonomy`（模型系列与档位）、`model_route_status`（当前路由与父路由钳制） |
| **skillmanager + sklui**（技能管理） | `skill_list` / `skill_show` / `skill_add` / `skill_disable` / `skill_enable` / `skill_remove`（持久技能，支持默认注入 / 渐进式披露） |
| **plins**（插件市场） | `dev_stop_dyn_plugin`（按前缀紧急停动态插件）；另有市场面板 RPC（browse / installed / install / uninstall） |
| **sfind** | `session_find`（按 id/标题关键字查会话，省上下文） |
| **archive**（项目档案 v0） | `archive_read_event`（证据句柄 sessionId:seq 精确读取 + 上下文窗口）、`archive_list_events`（事件索引）、`archive_filter_events`（类型/关键字过滤）、`archive_trace`（会话血缘追踪） |
| **verify**（言行一致检查器 v0） | `verify_claim`（git-commit / file / text-in-file 三类型显式验货，evidence 带原文供独立复核） |
| **plasmid**（最薄质粒 v0） | `plasmid_submit`（四道闸自荐）、`plasmid_search`（拉取制+适应度）、`plasmid_get`（全文）、`plasmid_report`（fitness 反馈）、`gap_report`（缺口报告，outlet 三选一） |

## 截图

| 技能管理面板（两层视图） | 插件市场 | 侧栏（竖排） |
| :---: | :---: | :---: |
| ![skill-ui](docs/screenshots/skill-ui.png) | ![plugin-market](docs/screenshots/plugin-market.png) | ![sidebar](docs/screenshots/sidebar.png) |

## 目录

```
bundle/     host 插件（cordis.patch.yml + plugins/*.mjs + @local 客户端包，可发布 dsh bundle；含 archive/verify/plasmid 与 plsm.{host,client}.js）
dynamic/    动态插件清单（auto-plugins.json，12 条）
presets/    router-standard agent 预设
scripts/    install.mjs / check.mjs / verify-plsm.cjs（plsm 面板 playwright 探针，维护者本机）
docs/       roadmap.md（总体规划/路线图）+ 架构文档（注入方式对比、分层规则、锚定规则、cache 规则、npm 升级风险、自研 subagent provider 设计）；工具详细定义含 archive / verify / plasmid
```

## 架构文档

`docs/ARCHITECTURE.md` 记录全部设计决策：八种注入方式对比、host/preset/dynamic 分层规则、首轮锚定规则、prompt cache 规则、npm 升级风险清单、已知坑（勿在 React 插槽搬 DOM 等）。经验体系（档案 / 质粒 / 缺口 / 验货）的工具级定义见 [工具详细定义参考](docs/tools-reference.zh.md)。另见 [总体规划 / 路线图](docs/roadmap.md)、[工具描述规范（中文化）](docs/tool-descriptions.zh.md)、[验收测试方法论](docs/VERIFICATION.md)、[跨平台验证指南](docs/PLATFORM-VERIFY.md)、[多代理协作涌现档案](docs/EMERGENCE.md)、[自研 subagent provider 设计（提案）](docs/SUBAGENT-PROVIDER.md)、[协作约定](CONTRIBUTING.md)。运行时协作方法论与排班在 `~/.dsh/COLLAB-METHOD.md`、`~/.dsh/ROSTER.md`、`~/.dsh/UI-LESSONS.md`（不进本仓库）。

## 友情链接

- [Deepseek-Harness-EAC](https://github.com/zouyuxuan122/Deepseek-Harness-EAC) — DeepSeek Harness 的 Windows 桌面客户端：内置 Node.js + dsh CLI、一键启动、10 套内置皮肤（EAC：Embracing All Creation 揽尽万象）。

## 借鉴与致谢

只列实际参考过的项目。代码移植细节见 [NOTICE](NOTICE)。日后参考他人项目在本表加一行。idea 借鉴不写入 NOTICE，避免看起来像复制了代码。

| 项目 | 关系 |
|---|---|
| [dsh-router-standard](https://github.com/yjh051108/dsh-router-standard) | 代码移植（MIT）：路由核 |
| [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) | 代码移植（MIT）：首轮锚定 |
| [dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite) | 代码移植（MIT）：injector 思路 |
| [V1ki/dsh-plugin-subscriptions](https://github.com/V1ki/dsh-plugin-subscriptions) | **idea 借鉴，未抄代码**：订阅当 LLM provider；自写走 pi-ai 路由 + OAuth token |
| cn-humanizer（0xtresser） | 计划采用（纯 SKILL.md） |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | 宿主 |

## 许可与归因

MIT。代码改编来源见上表与 NOTICE。

> 历史：本项目原名 **dsh-suite**，2026-08 更名为 **dsh-forge**；`scripts/install.mjs` 的 cordis 合并标记仍保留旧拼写（`# dsh-suite:start/end`）以保证对已安装 profile 的幂等合并。

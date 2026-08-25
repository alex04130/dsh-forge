# 协作约定（Contributing）

本仓库与 `~/.dsh` 运行时目录由多个会话并行维护，动手前请遵守以下规则。

## 文件操作：先读后写

- 修改任何现有文件前，**必须先用 read 工具读当前内容**（含行号），确认最新状态；禁止凭记忆或旧上下文直接覆盖。
- edit 用精确锚点（old_string 逐字匹配）；批量替换脚本必须带断言（如 `assert old in code`），失败立即停止。
- 改后立即自检：`npm run check`（host/client 代码语法）、`node --check scripts/*.mjs`、JSON 文件 parse 校验。
- 改坏了从 git 历史恢复：`git show HEAD:<path>`，不要手搓重写。
- 完整协议见持久技能 `file-edit-protocol`（本机 skillmanager 注册，模型 catalog 可见）。

## 并行分工

- **仓库侧**（本仓库：同步、commit、push、README、改名、GitHub 元信息）与 **运行时侧**（`~/.dsh`：代码、验证、截图、UI 迭代）并行开工，不串行等待。
- 文件同步用**同步清单编号**（#N），每条列清楚：源路径 → 仓库路径 + 变更摘要。仓库侧按 idPrefix / 文件比对合并（逐字节 diff 确认未改动的条目不动）。
- 动态插件运行态在 `~/.dsh/auto-plugins.json`，仓库只放清单；`bundle/plugins/`、`presets/`、`docs/` 以运行时侧文件为同步源。

## 提交规范

- Conventional Commits 中文消息：`类型(范围): 摘要` + 分条正文（逐文件/逐特性列出），类型如 `feat` / `fix` / `docs` / `chore` / `sync`。
- 推送前确认工作区状态，push 用 ed25519 key（`GIT_SSH_COMMAND='ssh -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes'`）。

## 文档同步（每次落地必带）

- **代码进仓库，文档必须同 commit**（或同清单内显式标注 docs 影响与排期）。这是硬纪律：新插件/新工具/服务变更/配置形态变化，落地时同步核对以下三处：
  1. `README.md` 工具定义表（按插件分组列工具）
  2. `docs/tools-reference.zh.md`（逐工具详细定义；头部"权威源"清单同步加文件）
  3. `docs/ARCHITECTURE.md`（§5.1 上游缺口与兼容面、§6 已实现清单的插件数量与列表）
- docs-only 改动（如修订说明）无需动代码，但与代码行为相关的文档变化不允许滞后一个 commit。
- 落地前自查：`grep` 新工具名是否已在上述文档出现；缺失则本次 commit 一并补上（commit message 标注 `docs:` 段）。

## 分支工作流（版本管理）

- `master` 为稳定发布分支；`dev` 为功能验证分支。
- 新功能/大改先合入 `dev`，在 dev 上完成运行时验证（重启、截图、回归），稳定后再合并回 `master` 并发布。
- 日常小修（同步清单驱动的微改）可直推 `master`，但涉及新特性或行为变更的一律走 dev。
- 合并流程：`git checkout master && git merge dev`（或 GitHub PR dev→master）；发布时在 master 上打 tag（如 `v0.1.0`）。
- **发布清单（npm）**：① 在 master 上 bump `bundle/package.json` 的 `version`，并核对 `cordis.npm.yml` 引用与 `files` 白名单；② 发布客户端包：`scripts/publish-client-packages.sh <版本>`（默认 0.1.1；POSIX、维护者本机专用——脚本复制到临时目录改写 name/version、去掉 private、重写 client.js 里的 `@local/*` 注册 id）；③ 发布 bundle 本体（`bundle/` 下 `npm publish --access public`）；④ 打 tag（如 `v0.1.4`）并 push；⑤ 发布后回归：`npm run check` + 按 `docs/PLATFORM-VERIFY.md` 清单做运行时验收。
- 分支保护规则需在 GitHub 网页侧设置（Settings → Branches → Branch protection rules：master 与 dev 均建议开启「require pull request」由仓库侧/运行时侧互相 review）；本机无 gh CLI，暂以本约定为准。

## 重启边界

- cordis.patch.yml 插件、preset .mjs、auto-plugins.json 的改动需重启 DSH 生效；动态插件热更新需 `dev_stop_dyn_plugin <prefix>` 停旧实例（dynboot define 是一次性快照）。
- 侧栏 UI：禁止在 React 插槽里搬 DOM（insertBefore 会拖垮 sidebar slot）；用纯 CSS `[class$="_footerActions"] { flex-direction: column }`。

## 对插件开发者的告诫（上游审计教训）

插件设计中避免以下两种反模式（源自 harness 上游反馈审计，详见 `docs/` 与上游讨论素材）：

- **禁止经常变化的整体注入**：不要做"每次变更都整体注入"的设计——注入内容随会话累积只增不减，context 单调膨胀，token 成本与噪声持续上升。只注入增量或一次性快照。
- **避免中途 surface replace**：运行中途整体替换 surface（界面/渲染层）会让此前构建的前缀缓存全部失效，性能断崖。需更换表面时尽早替换，或做增量补丁。

## 运行时与仓库的有意差异（LOCAL-ONLY 块）

- `profiles/web/cordis.patch.yml`（运行时）与 `bundle/cordis.patch.yml`（仓库）存在一条**有意为之**的差异：运行时文件末尾有 `LOCAL-ONLY personal integration` 注释块（mcp-github 行），是维护者本机的私人集成——**永远不要镜像进仓库**，也不要写进 bundle/cordis.npm.yml。
- 同步该文件一律 diff 审查 + 排除 LOCAL-ONLY 块，禁止整文件 cp 覆盖。
- 同理：injector registry（~/.dsh/injector/registry.json）与市场安装的个人插件（如 kimi webbridge）属本机个人状态，仓库必须保持零引用。

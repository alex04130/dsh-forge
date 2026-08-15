# DSH Extension Suite（DSH 扩展套件）

在 DeepSeek Harness（DSH）用户层构建的一整套扩展：运行时注入器、任务感知思维模式路由、跨会话邮箱、Agent 团队、模型委派、Skill 管理器与插件管理 UI。**全部落在 `~/.dsh` 用户层，不 monkey-patch 任何 npm 包。**

## 组件

| 组件 | 位置 | 说明 |
|---|---|---|
| Host 插件（12 个） | `bundle/plugins/*.mjs` + `bundle/cordis.patch.yml` | 跨会话邮箱 / 模型委派 / 切模式 / 团队 / 指定模型子代理 / 运行时注入器 / skill 管理 / 模型路由策略 / 动态插件恢复 / 图片桥接 + 2 个 `@local` 客户端包 |
| 动态插件（5 个） | `dynamic/auto-plugins.json` | 内联 host+client 代码：gitdock（默认禁用）、模式下拉框、模型选择器、子代理图片补丁、skill 管理器面板 |
| Agent 预设 | `presets/router-standard/` | 任务感知思维模式路由：spec / react / weak 分类 + 首轮极简锚定（仅 deepseek 系列）+ 首个 tool/call 后放全量工具 |
| 架构文档 | `docs/ARCHITECTURE.md` | 注入方式对比、分层规则、首轮锚定规则、cache 规则、npm 升级风险清单、验证记录 |

## 安装

> 目标环境：`$DSH_HOME`（默认 `~/.dsh`），profile 名 `web`。

### 方式 A：一键复制（推荐）

```sh
git clone https://github.com/<you>/dsh-suite.git
cd dsh-suite
node scripts/install.mjs          # 复制到 $DSH_HOME，自动备份，幂等
# 重启 DSH（dsh web）后生效
```

install.mjs 会：

1. 把 `bundle/plugins/*.mjs` 复制到 `$DSH_HOME/profiles/web/plugins/`；
2. 把 `bundle/packages/{dsh-plugmgr,dsh-dynrestore}` 复制到 `$DSH_HOME/profiles/web/packages/` 并写入 `pnpm-workspace.yaml` 所需的 `@local/*` symlink；
3. 把 `bundle/cordis.patch.yml` 合并进 `$DSH_HOME/profiles/web/cordis.patch.yml`（只插一次，用 `# dsh-suite:start/end` 标记包裹）；
4. 把 `dynamic/auto-plugins.json` 的条目合并进 `$DSH_HOME/auto-plugins.json`（按 `idPrefix` 去重）；
5. 把 `presets/router-standard/` 复制到 `$DSH_HOME/.agent-presets/router-standard/`。

### 方式 B：手动

对照上面的目录结构手动复制；`bundle/cordis.patch.yml` 与 `dynamic/auto-plugins.json` 需自行合并。

### 方式 C：npm 包形态（bundle）

`bundle/` 目录是一个可发布的 dsh bundle 包：

```sh
dsh plugin --profile web add <path-to-dsh-suite>/bundle
```

bundle 的 `dsh.bundle.patch` 指向其 `cordis.patch.yml`。插件行的 `./plugins/*.mjs` 相对路径在 profile 层解析；若以 npm 包安装，请把 `name` 改为包内子路径（如 `@dsh-suite/host/plugins/mailbridge.mjs`，需在 package.json `exports` 声明 `./plugins/*`）。

## 关键配置

- `router-standard` 的锚定适用模型：`presets/router-standard/agent.cordis.yml` 里 `router-bootstrap` 的 `config.anchorModels`（正则或模型 id 数组，默认 `/^deepseek/i`）。**首轮锚定只应对 deepseek 系列生效**——它是 v4 过拟合/RL 对齐问题的缓解方案；其他模型系列直接获得完整工具面（详见 `docs/ARCHITECTURE.md` §3.3）。
- 持久数据：skill 注册表 `$DSH_HOME/skillmanager/registry.json`；注入器注册表 `$DSH_HOME/injector/registry.json`；团队/邮箱在 `$DSH_HOME/storages/`。
- 动态插件禁用：`dynamic/auto-plugins.json` 条目加 `"disabled": true`（`dynboot.mjs` 会跳过）。

## 验证

```sh
npm run check          # 全部 host/client 代码语法自检（vm Script wrapper）
```

运行时验证手段（模型工具）：`dev_plugin_status` / `dev_injected_list`（注入器）、`skill_list` / `skill_add`（技能）、`model_taxonomy` / `model_route_status`（路由）、`dev_router_status`（思维模式路由，非锚定模型显示 `router BYPASSED`）。

## 归因与许可

MIT。本仓库包含/改编自以下 MIT 项目的代码与思路，详见 `NOTICE`：

- [dsh-router-standard](https://github.com/yjh051108/dsh-router-standard)（yjh051108，MIT）
- [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)（xiaobright，MIT）
- [dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite)（yjh051108，MIT）

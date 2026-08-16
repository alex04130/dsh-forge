# @dsh-forge/bundle

> DeepSeek Harness 扩展套件 host bundle：跨会话邮箱、agent 团队、子代理派发与模型路由策略、运行时注入器、技能管理器、动态插件启动，以及插件/技能管理面板客户端包。

GitHub: [alex04130/dsh-forge](https://github.com/alex04130/dsh-forge) · License: MIT

## 安装

```sh
# 推荐：通过 DSH 的 plugin 命令安装 bundle
dsh plugin --profile web add @dsh-forge/bundle

# 或直接 npm 安装后手动对照复制
npm install @dsh-forge/bundle
```

peer 依赖：`@deepseek-ai/dsh-skill` 与 `@deepseek-ai/dsh-tools`（均为 `>=0.1.0-rc.6 <0.2.0`）。

## 使用

1. 安装后**重启 DSH**（`dsh web`）。
2. （可选）新建会话选择 **router-standard** preset（任务感知思维模式路由）——npm 包**不含** preset 与动态面板，需从[源码仓库](https://github.com/alex04130/dsh-forge) `presets/` 复制到 `$DSH_HOME/.agent-presets/`。
3. 运行时验证：`dev_plugin_status`（注入器）、`skill_list`（技能）、`model_taxonomy`（路由）、`dev_router_status`（思维模式路由）。

## 包含内容

- `cordis.patch.yml` — host 插件装配清单（默认**不含** GitHub MCP 条目；手动可选配置见[主 README](https://github.com/alex04130/dsh-forge#readme)）。
- `plugins/` — 10 个 host 插件：
  - `mailbridge` 跨会话邮箱（session_list / session_read / session_send / mailbox_check，离线持久排队 + wake 冷启动）
  - `teamhub` agent 团队（captain + 成员子代理 + 依赖任务板 + 成员间消息）
  - `modsub` 子代理派发（spawn_model_subagent：provider/model/effort/mode/sandbox 可选，默认全继承父级，提权审批）
  - `modelroute` 子代理模型继承策略 + 模型系列 taxonomy + plan 计费路由
  - `modeswitch` 会话中途切换 agent preset（switch_mode / session_mode）
  - `llmrouter` 多厂商模型委派（model_list / model_call）
  - `injector` BepInEx 式运行时注入（symlink + 持久注册表，重启自动恢复）
  - `skillmanager` 技能统一管理（持久化增删启停 + 默认注入模式）
  - `dynboot` / `imgsub-bridge` 动态插件启动 / 子代理图片附件桥
- `plugins/lib/subagent-policy.mjs` — 共享子代理策略库（能力面判定、模型档位/系列升级、sandbox 提权、mode/effort 注入）。
- `packages/dsh-plugmgr`、`packages/dsh-dynrestore` — 插件管理面板与动态插件客户端恢复包。

## 文档

- [README](https://github.com/alex04130/dsh-forge#readme)（含「工具定义」清单）
- [ARCHITECTURE](https://github.com/alex04130/dsh-forge/blob/master/docs/ARCHITECTURE.md)
- [工具详细定义参考](https://github.com/alex04130/dsh-forge/blob/master/docs/tools-reference.zh.md)
- [工具描述规范（中文化）](https://github.com/alex04130/dsh-forge/blob/master/docs/tool-descriptions.zh.md)

## 许可与归因

MIT。改编自 [dsh-router-standard](https://github.com/yjh051108/dsh-router-standard)、[dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)、[dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite)（均 MIT）。

# Alpha 迁移评估（0.1.2-alpha.1 → alpha.3，基线迁移预评估）

> 2026-09-01 · 自编辑会话（用户拍板"开发基线迁 alpha"后备评估 → 结论在此）
> 范围：dsh 主包 0.1.1-rc.2（当前）→ 0.1.2-alpha.3（dist-tag: alpha）
> 四项目标：QVD/#250 修复、核心 API 漂移、子代理模型选择 vs modsub/modelroute 冲突、升级路径

## 结论速览

| 项 | 结论 | 性质 |
|---|---|---|
| QVD-2026-57410 / #250 修复 | **alpha.1-.3 均未修复** | 预判保留 |
| 核心 API 漂移 | **两处硬变更**：APIProxy 移除（@Remote 网关统一）＋ SQLite Session 后端移除 | 需查本地依赖 |
| 子代理模型选择 | **alpha.1 官方原生上线**（spawn 指定 provider/model/effort/maxtokens）＝ 与 modsub/modlpk/modelroute **功能重叠** | 冲突待裁 |
| 升级路径 | npm 升级 + 前置/后置验证（沿用 0.1.1-rc.2 预案） | 可执行 |

---

## 一、QVD-2026-57410 / #250 审批回环

- **alpha.1 / .2 / .3 release notes 全部未提及**这两个洞；`SAFETY.zh.md` 在 alpha.1 只是"更新安全说明"（声明未审计），无修复。
- 与本机关系：**127.0.0.1:3080 纯回环，QVD 不适用**；#250 需本地加固（apiproxy 审计日志两行 patch）。
- **结论**：迁 alpha 安全面与 rc.2 持平，不是迁移的收益项，也不是阻断项。

## 二、核心 API 漂移（硬变更，逐条对照本地依赖）

### 2.1 APIProxy 移除 → @Remote 网关（alpha.1 "其他变更"）
- alpha.1：*"旧版调用接口 APIProxy 已迁移并移除，请统一使用 @Remote 网关"*。
- 本地检查：`profiles/web/plugins/*.mjs` / `dynplugins/*.js` 逐文件 grep `apiproxy|APIProxy` —— **零命中**（唯一相关是 mailbridge.mjs:80 注释提及 workspaceRegistry 别名，非 APIProxy 调用）。
- **结论：本地插件不依赖 APIProxy，移除无影响。**（风险低，但升级后需跑一次跨会话消息 + 会话列表冒烟，确认 mailbridge/sessionQuery 走新网关正常。）

### 2.2 SQLite Session 持久化后端移除（alpha.3 "其他变更"）
- alpha.3：*"移除可选的 SQLite Session 持久化后端；已有内容不会删除，请使用旧版本导出"*。
- 本地用 `session-persistence-jsonl`（jsonl 后端），**不受影响**。
- **但归档数据**：`~/.dsh/storages/` 或历史会话若有 sqlite 文件，需**先导出再升级**（alpha.3 后不可读）。核对当前持久化后端。

### 2.3 其他注意项（不一定是漂移，升级后需核）
- `SessionEvent.ignorable` alpha.1 移除 → **alpha.2 恢复**（我们若引用该字段，alpha.2 起安全；alpha.1 单独用有风险——直接迁 alpha.3 无此问题）。
- 会话视图工程拆分（"面向诉求分层导入"，纯前端模块化，我们 client 插件不受影响，但**页面刷新后 client 插件若用了被拆模块要回归**——dynboot 4a 外置 + forge-shell 需在 alpha.3 下复验）。
- 网关 WebSocket 心跳/RemoteError 统一封装：mailbridge / teamhub / modsub 的 host.call + client 侧通信是否兼容新 RemoteError 包装（**逐插件冒烟**）。

## 三、子代理模型选择冲突（本项是迁移的真正决策点）

### 3.1 alpha.1 官方原生能力
- *"开启子代理模型选择后，Agent 可在授权范围内选择提供方、模型和推理力度"*（@Dudu-0223）。
- *"启动子代理时可指定提供方、模型、推理力度和最大输出长度"*（@pku-xht）。
- *"Claude Code、Codex 子代理支持配置模型"*。
- 即：**官方 spawn 已原生支持 provider/model/effort/maxtokens**——正是我们 modsub（spawn_model_subagent 显式覆盖）+ modlpk（模型+等级选择器持久化回退）+ modelroute（子代理模型路由策略）三件套做的事。

### 3.2 本地现状
- **modsub**：`spawn_model_subagent` v2（provider/model/effort/mode，默认继承父；提权自动问用户）——与官方功能**高度重叠**。
- **modlpk**：模型+等级选择器（持久化回退，live 会话直接 append）。
- **modelroute**：子代理模型路由策略（与 dsh-host-apiproxy 的 model-selection rewrite 是协作关系，注释自证：*"parent's CREATION options, but dsh-host-apiproxy's per-agent model-selection"*——我们**挂在官方代理的 rewrite 链上**，不是绕过）。
- 模型管理 UI（capm 模型 tab）读的是官方 `llm.listProviders/listModels/resolveModelInfo`——**API 面兼容**。

### 3.3 冲突判定
- **modsub**：与官方 spawn 模型选择**重复**。官方上线后，我们的 spawn_model_subagent 要么退役（用官方 spawn_subagent），要么保留为"带提权审批语义"的补充（官方 spawn 的授权范围是否含我们的提权链未证）。
- **modlpk**：官方设置页已有"模型选择"（模型设置页添加 provide 登录配置 + 模型选择器）。modlpk 的"持久化回退"语义若官方覆盖则退役；不覆盖则保留。
- **modelroute**：**不冲突**（与官方 rewrite 链协作），迁移候选保留。
- **capm 模型 tab**：读官方 API 面，兼容，可保留（提供订阅登录 + 默认模型 + provider 目录 UI）。

### 3.4 建议（呈用户拍板）
1. **迁 alpha.3 后测官方子代理模型选择**：spawn_subagent 在授权范围内选 provider/model 是否覆盖我们使用场景（开/关能力、默认继承、提权审批）。
2. 若全覆盖 → **modsub/modlpk 退役**（动态插件 12→10→进一步减，呼应"动态插件尽量减"）；modelroute 保留；spawn_model_subagent 从工具面移除（或保留薄兼容层）。
3. 若不覆盖（如提权审批语义缺失）→ 保留 modsub 薄改（只留提权部分），移除重复的模型/effort 参数。

## 四、升级路径（沿用 0.1.1-rc.2 预案 + alpha 增量）

### 4.1 前置
1. `sudo npm install -g @deepseek-ai/dsh@0.1.2-alpha.3`（全局目录属主 nobody 需 sudo，用户执行/确认）。
2. **备份** `/usr/lib/node_modules/@deepseek-ai/dsh` → `~/.dsh/.backups/dsh-0.1.1-rc.2-alpha3-pre/`（tar）。
3. **归档数据先行导出**：核对是否有 sqlite 会话后端数据，有则先导出（alpha.3 移除 SQLite 后端）。
4. 保存当前 auto-plugins.json / cordis.patch.yml / settings.yaml 快照（已有备份习惯）。

### 4.2 后置验证（升级后，k3/自编辑协作）
- [ ] tmp 隔离实例：archive / verify / plasmid 探针全绿（同 rc.2 预案）。
- [ ] 12 动态插件 + 注入器（kimi-webbridge）dynboot 恢复。
- [ ] capm 模型页（llm.listProviders/listModels 在新版本别名是否变——**核 resolveModelInfo 签名**）。
- [ ] mailbridge / teamhub / modsub 跨会话通信冒烟（RemoteError 包装兼容）。
- [ ] forge-shell + plsm + capm 四 tab 渲染（client 模块拆分回归）。
- [ ] 官方子代理模型选择实测（开/关/指定 provider/提权审批）。
- [ ] web 搜索 provider（deepseek-official+kimi-coding 并存 + selector set）。
- [ ] 结论回 relay 记档（同步号）。

### 4.3 回滚
- 还原 `~/.dsh/.backups/` 备份 + npm install 回 0.1.1-rc.2；auto-plugins/patch/settings 快照还原（升级前后零迁移成本，C4 原则）。

---

## 五、附带收益（alpha 相比 rc.2 值得迁的点）

- 长会话右导航分页轮次预览/跳转（改善我们 30+ 轮的会话体验）。
- 会话流 token 用量精确展示（配合成本月报，数据更细）。
- 子代理模型选择官方原生（若我们采纳 = 消掉 modsub/modlpk 两插件，动态插件进一步减）。
- 权限标签多语言（UI 中文化加分）。
- `read_image` 无扩展名路径识别（我们视觉资产常见）。

## 六、风险登记

| 风险 | 等级 | 缓解 |
|---|---|---|
| APIProxy 移除后 mailbridge/sessionQuery 走新网关行为变化 | 低 | 升级后冒烟 |
| SQLite 会话数据不可读 | 低 | 升级前导出核对 |
| 子代理模型选择与我们 modsub 重复（动态插件冗余） | 中 | 测官方能力后拍板退役 |
| client 模块拆分破坏 forge-shell/plsm 客户端 | 中 | k3 复验四 tab |
| alpha 为 prerelease，上游可能继续 break | 中 | 只迁 dev 基线（本机），npm 发布仍走 stable；alpha 稳定后回迁补丁 |

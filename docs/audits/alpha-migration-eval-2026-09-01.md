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
- **⚠️ 修正（grok 复核）**：**host.call ≠ APIProxy**。harness.handle / host.call 是动态插件**包私有 RPC**，不走 @Remote 网关——mailbridge/teamhub/modsub 的 host.call **不受** RemoteError 包装影响，**不该列进 RemoteError 冒烟**。
- **真可能碰到 RemoteError 包装的**：client 走 `session.api.*` / `ctx.remote` 的（modlpk 的 selectModel、若有官方 RPC 的 sesmgr）——**冒烟这些**，不要冒烟 host.call。
- **结论**：本地静态行不依赖旧类名；冒烟范围修正确认。

### 2.2 SQLite Session 持久化后端移除（alpha.3 "其他变更"）
- alpha.3：*"移除可选的 SQLite Session 持久化后端；已有内容不会删除，请使用旧版本导出"*。
- 本地用 `session-persistence-jsonl`（jsonl 后端），**不受影响**。
- **但归档数据**：`~/.dsh/storages/` 或历史会话若有 sqlite 文件，需**先导出再升级**（alpha.3 后不可读）。核对当前持久化后端。

### 2.3 其他注意项（不一定是漂移，升级后需核）
- `SessionEvent.ignorable` alpha.1 移除 → **alpha.2 恢复**（我们若引用该字段，alpha.2 起安全；alpha.1 单独用有风险——直接迁 alpha.3 无此问题）。
- 会话视图工程拆分（"面向诉求分层导入"，纯前端模块化，我们 client 插件不受影响，但**页面刷新后 client 插件若用了被拆模块要回归**——dynboot 4a 外置 + forge-shell 需在 alpha.3 下复验）。
- 网关 WebSocket 心跳/RemoteError 统一封装：**client 走 session.api.*/ctx.remote 的**（modlpk selectModel、sesmgr 官方 RPC）冒烟新 RemoteError 包装；**host.call 是包私有 RPC 不走 @Remote 网关，不冒烟**（grok 复核修正）。

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

### 3.3 冲突判定（修正版，grok 复核 2026-09-01）
- **结论：三件套全部保留，不预判退役。**
- **modsub**：per-call 选参部分与官方重叠，但**提权链/mode/sandbox 官方没有**——官方"授权范围选择"是**预授权允许名单**（`modelSelectionSettings`，顶层 Session 采样 Host 偏好，精确 provider/model 名单），**不是**"比父 live 升档弹审批"；modsub 精华=默认继承父（账单不静默变）+ collectModelEscalations（同系列升档/跨系列）+ preset 能力面 + sandbox 加宽 → approval allowed-once。**至多**升完后若官方 schema 已有 per-call 三字段，考虑薄化为"官方 spawn + 我们只留审批/mode/sandbox"——那是拍板项，不是现在的结论。
- **modlpk**：官方几乎不覆盖——官方 ModelSelect 仍拒绝 addressed-subagent（rc.2 README 原文）；alpha 的选参是 **subagent 工具 schema**，不是子会话 composer。与 spawn 选参**不是同一层**，保留。
- **modelroute**：保留（与官方是协作/补洞）。create 时 live 继承可能被官方部分吃掉（官方隐式子取"父 latest logged request，否则父创建 options"——create 时可盖戳，针对 Problem 1 一半），但 request 时钳制（空白子第一请求是否仍回全局默认未证）+ plan 计费重写（官方无）仍是我们的。**未核之前不标"覆盖"**。
- **⚠️ 修正**：原文"全覆盖则 modsub/modlpk 退役（动态插件 10→8）"**作废**——grok 明确"禁止全覆盖→退役预判"。

### 3.4 建议（修正版）
1. 迁 alpha.3 后**实测官方子代理模型选择**，写成三条**可证伪**（不是"开/关/指定 provider"糊成一项）：
   - ① 隐式 spawn（不传 model）：子第一轮是父 **live** 还是**全局默认**？（空白子 selectionFor 是否仍回全局默认）
   - ② 显式升档：是否**只靠允许名单**、有无审批弹窗？（官方允许名单 vs 我们的 allowed-once 审批）
   - ③ 父 spawn 后切模型：隐式子下一轮**跟不跟**父 live？（官方盖戳 vs modelroute 每轮跟父）
2. 三条测完**再拍板**是否薄化 modsub；**默认假设三件都留**。
3. modsub 薄化属于**拍板项**，不是迁移评估能预定的结论。

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
- [ ] 官方子代理模型选择实测（grok 修正：写成三条**可证伪**，不糊成"开/关/指定 provider"）：
  - [ ] ① 隐式 spawn（不传 model）：子第一轮是父 **live** 还是**全局默认**？（空白子 selectionFor 是否仍回全局默认）
  - [ ] ② 显式升档：是否**只靠允许名单**、有无审批弹窗？（官方 allowed list vs 我们 allowed-once）
  - [ ] ③ 父 spawn 后切模型：隐式子下一轮**跟不跟**父 live？（官方盖戳 vs modelroute 每轮跟父）
- [ ] web 搜索 provider（deepseek-official+kimi-coding 并存 + selector set）。
- [ ] 结论回 relay 记档（同步号）。

### 4.3 回滚
- 还原 `~/.dsh/.backups/` 备份 + npm install 回 0.1.1-rc.2；auto-plugins/patch/settings 快照还原（升级前后零迁移成本，C4 原则）。

---

## 五、附带收益（alpha 相比 rc.2 值得迁的点）

- 长会话右导航分页轮次预览/跳转（改善我们 30+ 轮的会话体验）。
- 会话流 token 用量精确展示（配合成本月报，数据更细）。
- 子代理模型选择官方原生（迁移后实测三问，见 §3.4；**是否薄化 modsub 是拍板项，不预判**）。
- 权限标签多语言（UI 中文化加分）。
- `read_image` 无扩展名路径识别（我们视觉资产常见）。

## 六、风险登记

| 风险 | 等级 | 缓解 |
|---|---|---|
| APIProxy 移除后 mailbridge/sessionQuery 走新网关行为变化 | 低 | 升级后冒烟 |
| SQLite 会话数据不可读 | 低 | 升级前导出核对 |
| 子代理模型选择与我们 modsub 重叠（功能冗余度待测） | 中 | 迁移后按 §3.4 可证伪三问实测；**默认三件都留**，是否薄化另行拍板 |
| client 模块拆分破坏 forge-shell/plsm 客户端 | 中 | k3 复验四 tab |
| alpha 为 prerelease，上游可能继续 break | 中 | 只迁 dev 基线（本机），npm 发布仍走 stable；alpha 稳定后回迁补丁 |

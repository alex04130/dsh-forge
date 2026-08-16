# 验收测试方法论（VERIFICATION）

> 这套流程不是预先设计的测试框架，而是 dsh-forge 开发过程中「自动涌现」的验收手段——每一步都是被真实 bug 逼出来的。记录在此，供其他 DSH 插件作者参考。
>
> 核心信条：**dump-config 不等于能 boot；服务器绿不等于页面绿；发布后才发现不如发布前烧掉。**

## 一、三个教训（流程的由来）

1. **dump-config 骗过我们**（相对路径 bug）：早期验收只跑 `dsh --profile X --dump-config` 看 patch 行在不在，就宣布「安装链 OK」。真 boot 才发现 npm 安装路径下 `./plugins/*.mjs` 相对行从 profile 根解析、全部模块找不到——0.1.0~0.1.2 三个版本都有这病。→ 验收必须包含**真实 boot**。
2. **服务器绿 ≠ 页面绿**（客户端注册 id bug）：服务器 boot 零错误、HTTP 200，浏览器打开却是 "Failed to load plugins"——client.js 自注册 id 与包名不一致，只有浏览器能看见。→ **双验收 = 服务器 boot + 真实页面**。
3. **发布前预验收**：与其发布等用户撞坑，不如在发布前把「发布脚本要做的改写」先在本地已装副本上模拟一遍、页面跑绿，再正式发布。→ publish-time transform 必须**可预演**。

## 二、验收链（每步都是真实命令）

### 1. 改动自检（改完立即跑）
- .mjs：`node --check <file>`
- auto-plugins.json 内嵌 hostCode/clientCode：JSON.parse + 每段 `new vm.Script('function __check(){' + code + '}')`
- YAML（含 !!js 的 patch）：用真实 boot 验证（本地 js-yaml 不认识 !!js，别用它做终判）
- 残留：`grep -rn "/home/alex" <targets>` 零命中（硬编码路径）

### 2. 全新 profile 安装链
```sh
rm -rf ~/.dsh/profiles/tmp-verify-XX
dsh plugin --profile tmp-verify-XX add @you/pkg
```
- 官方 CLI 转发 pnpm，需 pnpm 在 PATH；受限环境把 `XDG_DATA_HOME` 或 `store-dir` 指进可写区
- 检查 profile package.json 的 `dsh.profile.bundles` 自动注册
- 检查 node_modules 布局；注意 pnpm minimumReleaseAge 会把新发版本延迟解出（显式 `@版本` 钉版）

### 3. 真实 boot（模拟 web profile）
```sh
# 官方 web-app 不走 registry（其 npm 依赖图是断的），把包名直接写进 bundles 列表：
# ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@you/pkg']
timeout 300 dsh --profile tmp-verify-XX --port 0   # 日志找 "dsh web: http://127.0.0.1:<port>"
```
- `grep -niE "error|fail|cannot|did not activate|waiting for|aggregate"` 零命中
- `curl -sf http://127.0.0.1:<port>/` → HTTP 200

### 4. 浏览器验收
- 等 `window.__DSH_BOOT__ !== undefined`
- 断言：无 "Failed to load plugins"、侧栏/面板入口渲染、本次改动的 UI 元素可见
- 无视觉能力的模型：用 DOM 断言（innerText 关键词）或把截图交给带视觉的子代理

### 5. 发布前预验收（有 publish-time transform 时必做）
发布脚本的改写（sed/name 重写等）先在已安装副本上手动执行 → 重跑 3+4 → 全绿再发布

### 6. 发布后终验
- registry 复查：version endpoint（权威）与 packument（会滞后数分钟，404 是 CDN 传播不是失败）
- 全新 profile 装 latest → 3+4 再来一遍

## 三、环境陷阱清单（全部真实踩过）
1. 官方 CLI 不自带 pnpm；store 目录权限（EROFS）→ XDG_DATA_HOME/store-dir 重定向
2. packument CDN 滞后：刚发布的包 packument 404 数分钟，version endpoint 立即 200
3. minimumReleaseAge：pnpm 供给链策略延迟新版本解出
4. /tmp 隔离：后台 job 与前台 shell 的 /tmp 可能不同命名空间，日志写工作区
5. `dsh web` 是 web profile 专用别名；boot 其他 profile 用 `dsh --profile <name>`，app 参数直接跟在后面（`--profile X web` 与 `web --profile X` 都会被拒）

## 四、验收清单模板（复制即用）
- [ ] node --check / vm.Script / 零残留 grep
- [ ] 全新 profile 安装 + bundles 自动注册
- [ ] 真实 boot：dsh web URL + 零错误 + HTTP 200
- [ ] 页面：__DSH_BOOT__ + 无 Failed to load plugins + UI 断言
- [ ] 发布前预演（有 transform 时）
- [ ] registry 复查 + 发布后终验
- [ ] 验收结论随同步清单回传（verify-first：有结论才进 dev/master）

## 五、协作流程（verify-first）
运行时先改 → 自检 → 临时 profile 双验收 → 同步清单（带验收结论）→ 仓库侧合并；npm 发布后跑终验。没有验收结论的改动不进仓库。

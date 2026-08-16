# 跨平台验证指南（PLATFORM-VERIFY）

> 状态说明：**Linux/WSL 路径已实测通过**；**Windows 与 macOS 尚未在实机上验证**——代码层已按平台差异处理（DSH_HOME 运行时派生、pwsh 安全引用、win32 junction 回退、curl.exe 分支），但以下清单需在对应实机/CI 上跑通后方可宣称全平台可用。

## 0. 前置（三平台通用）
- Node ≥ 22、git、pnpm（npm 路径用；Windows 用原生 pnpm，勿用 WSL shim）
- 路径派生探针：
  node -e "console.log(process.env.DSH_HOME || require('path').join(require('os').homedir(), '.dsh'))"
  Windows 应输出 C:\Users\<你>\.dsh；macOS /Users/<你>/.dsh；Linux /home/<你>/.dsh

## 1. 两条安装路径
- 路径 A 源码安装：git clone https://github.com/alex04130/dsh-forge.git && cd dsh-forge && node scripts/install.mjs（纯本地拷贝，零网络）
- 路径 B npm 安装：dsh plugin --profile web add @dsh-forge/bundle（0.1.4+ 起可用；0.1.3 及更早版本在 npm 路径下 boot 失败，为已知历史 bug）
装完 dsh web 重启，对照功能矩阵。

## 2. 平台专属检查点
- Windows：junction 回退（Get-Item ~/.dsh/profiles/node_modules/<包> 的 LinkType 应为 Junction，无需管理员）；pwsh 下市场面板搜索正常（node -e + curl.exe 链路）；curl.exe 存在（Win10 1803+ 自带）；源码安装无相对路径 .dsh 泄漏（C-1 修复点）
- macOS/Linux：boot 日志零错误、工具齐全（无平台差异代码，主要回归）

## 3. 运行时功能矩阵
| 操作 | 验证点 |
|---|---|
| 市场面板打开→搜索 | 只读 curl + node -e 目录列举 |
| 市场装小仓库→卸载 | git clone + symlink/junction + 注册表读写 + 卸载清理 |
| session_find 工具 | node -e projcache 解析 |
| skill_add/skill_list | skillmanager 注册表 + 重启持久 |
| dev_inject_plugin → 重启 | 注入 + 重启自动恢复（Windows 验 junction） |
| 动态清单型仓库安装 → 重启 | auto-plugins.json 合并 + dynboot 恢复 |

## 4. 每平台验收清单
- [ ] DSH_HOME 探针输出本平台正确路径
- [ ] 安装落点正确（无相对路径 .dsh 泄漏）
- [ ] grep -rn "/home/alex" ~/.dsh/profiles/web/ 零命中
- [ ] dsh web boot 日志零 error
- [ ] 工具目录齐全（skill_list/session_find/team_*/spawn_model_subagent/dev_plugin_status）
- [ ] 浏览器侧栏「插件/市场/技能/设置」全渲染
- [ ] 市场面板警示横幅可见 + 搜索正常
- [ ] Windows：LinkType=Junction
- [ ] 重启后注入/技能/动态插件恢复正确

## 5. CI 冒烟（无实机时的最小矩阵）
GitHub Actions：ubuntu-latest + macos-latest + windows-latest 三 runner，各跑：install.mjs → grep 硬编码零命中 → (0.1.4+) dsh plugin add @dsh-forge/bundle → boot --port 0 → HTTP 200。workflow 文件可由维护者按需补（本指南先落文档）。

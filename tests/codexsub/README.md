# codexsub 自检 harness

用**假 Codex app-server** 验证 `bundle/plugins/codexsub.mjs` 的协议行为，
**不需要装 codex、不需要登录、不联网**。

```powershell
cd tests\codexsub
node driver.mjs        # [selftest] 全部通过 = 通过
```

## 为什么需要它

本机（以及任何没装 Codex 的机器）跑不了真 app-server，于是「provider 到底发没发对方法、
字段对不对、线程续没续上」全都没法验。这个 harness 把 Codex 那一侧换成脚本，
让被测文件跑真管道（真 `spawn`、真 JSON-RPC line transport），从而把协议行为钉住。

这也是**重写 provider 时的安全网** —— 换实现先过它。

## 覆盖的场景

| 场景 | 断言 |
|---|---|
| A 首次派发 | argv 形状、调用序列、`thread/start` **不带 `ephemeral`**、`turn/start` 参数、结果、线程表落盘 |
| B 同父会话再派发 | 走 `thread/resume` 且参数正确 |
| C 续接失败（`-32602`） | 回退 `thread/start` 并覆盖线程表，结果仍为 completed |
| D turn 中途进程猝死 | 不 reject，扁平化成官方格式的诊断 |
| E 线程表损坏 | 当空表处理，重建且保留旧键 |
| F dispose 后 | 线程记录仍在（dispose 不删续接信息） |

## 文件

- `driver.mjs` —— 驱动与断言
- `fake-app-server.mjs` —— 假 app-server（响应 `initialize` / `thread/start` /
  `thread/resume` / `turn/start` / `turn/interrupt`，并推 `item/completed` + `turn/completed`）
- `node_modules/` —— 三个 stub：`@deepseek-ai/dsh-sdk-protocol`（真 `JsonRpcLineTransport`）、
  `@deepseek-ai/dsh-subagent`（`settleRunResult` / `subprocessRunHandle` 等）、
  `@openai/codex`（只提供 wrapper 路径，从不真执行）

## 被测文件怎么来的

`driver.mjs` **运行时从 `bundle/plugins/codexsub.mjs` 生成一份临时副本**
（把 `./lib/` 重指到真品旁边那份，再追加两行导出以暴露内部函数），
所以仓库里**不保留插桩分叉** —— 不会出现副本与真品各自漂移。

生成物（`codexsub-testable.generated.mjs`）与运行痕迹（`dsh-home/`、`methods.log`）
已在 `.gitignore` 里排除。

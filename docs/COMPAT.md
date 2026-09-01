# COMPAT（兼容性断言，P2-1 底座）

> 机器可查的 API 面断言：升级 DSH 后跑 `node scripts/check.mjs --compat`，
> 断言我们插件依赖的上游 API 面是否仍存在/签名未变。
> 数据驱动：docs/compat-manifest.json（断言清单，机器生成/维护）。
> 2026-09-01 起草（自编辑，P2-1），待 relay 落地 + 审计复核。

## 用途

升级路径（如 rc.2 → alpha.3）前/后，一键验证：
- 我们依赖的 Cordis 服务（sessionPersistence/agents/sessions/…) 是否在
- 关键方法签名是否还在（inspect/list/get/deleteSessions…）
- 触发失败能定位"哪个插件依赖被上游改没"

## 断言分层

| 层 | 断言 | 检查方式 |
|---|---|---|
| L1 服务在册 | 我们 inject 的服务（sessionPersistence/agents/llm/sessionmgmt…) 存在 | dump-config 或运行时 get |
| L2 方法签名 | 关键方法（inspect/list/deleteSessions/masterIdFromSessionId/searchEvents…）是 function | 运行时 typeof |
| L3 行为语义 | 边界行为（离线 masterId 判定/配额/default fallback） | 探针（tmp profile 或单测） |

## 清单（初始，随插件变动维护）

见 docs/compat-manifest.json（生成器 gen-compat-manifest.mjs 从插件 inject 面 + svc 调用提取）。

## 冒烟清单（升级后人工核）

1. sessionPersistence.inspect（离线会话读 meta/events）
2. sessionmgmt.deleteSessions（删除守卫 masterIdFromSessionId）
3. llm.listProviders/listModels（模型目录）
4. agents.get（在线会话归属）
5. tools 服务 entries（工具表）
6. 12 动态插件 dynboot 恢复

## 引入方式

- check.mjs 加 `--compat`：读 compat-manifest.json → 断言 L1/L2（运行时服务探测）
- L3 走探针（tmp-verify 系列，临时 profile 验证，不污染生产）
- 升级批：`node scripts/check.mjs --compat` + 冒烟清单

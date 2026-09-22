# Codex Local Router — E2E 验收规范与执行计划

## 概要

为本项目建立一套收敛的端到端验收体系：**6 条用例 + 10 条横向判据 + 9 条不可突破架构规约 + patch loop 契约**；落地规范文档与薄 runner；按序执行并以可追溯证据判定；不达标进入受规约约束的 patch loop。同时回滚上一轮越界的 `NO_PROXY` 例外。

设计意图：用例只负责制造真实流量，判据负责判定健康——避免"用例外形枚举功能"。

## 目标 / 非目标

**目标**
- 落地 `docs/e2e/goal-spec.md`（本 Plan 的导出）、`docs/e2e/acceptance.md`（验收记录）、`docs/e2e/thresholds.json`（异常绊线单一来源）
- 落地薄 runner 与判据评估器，统一输出 `artifacts/e2e/<runId>/`
- 按序执行 G0 → E2E-1/2/3/5 → E2E-6 →（发布前）E2E-4
- FAIL/ANOMALY 进入 patch loop，直到全部达标或触发停止条件

**非目标**
- 不发布新 Release、不改产品语义、不做性能调优
- 不驱动真实 App UI、不强退 App、不中断活动轮次
- 不修改历史数据结构、不删除恢复副本

## 行为与接口变更

| 变更 | 内容 |
|---|---|
| 新增 npm scripts | `e2e`（全跑）、`e2e:l0`（门禁）、`e2e:l1`（协议级）、`e2e:l2`（App 后端级）、`e2e:live`（E2E-6 线上）、`e2e:report`（汇总渲染） |
| 新增证据契约 | `artifacts/e2e/<runId>/summary.json` + `<case>.json` + `raw/`；`summary.json` 固定含：runId、时间、harness 种类/路径/版本/二进制 sha256、gateway url/instance/version、每用例 verdict 与 H 判据结果、证据路径、耗时、模型调用数、人工签核段、阈值文件哈希 |
| 新增绊线契约 | `docs/e2e/thresholds.json` 为唯一来源；判据代码只读该文件，不内嵌数字 |
| 新增单测 | `test/e2e-criteria.test.mjs`：H 判据求值、三分判定、绊线加载、ANOMALY 归因必填校验 |
| 运维行为变更 | 回滚 LaunchAgent 的 `NO_PROXY/no_proxy` 例外（删除 `opencode.ai,.opencode.ai`）；先备份 plist，在无活动轮次窗口幂等重渲染并重启服务，随后校验 plist 中不含该例外 |
| 不变更 | 无公开 API、协议、类型变更；Gateway 对外行为不变 |

新增文件集中在 `scripts/e2e/`（harness 驱动、判据评估、6 个用例、run 入口）与 `docs/e2e/`；不重写既有 `scripts/accept-*.mjs`（保留为历史证据），新套件自包含。

## 执行方式（固定）

| 代号 | 载体 | 覆盖 | 不做什么 |
|---|---|---|---|
| **A** | `/Applications/ChatGPT.app/Contents/Resources/codex exec`（缺失时回退 PATH `codex`） | HTTP 入口、订阅与 API 双入口、协议适配 | — |
| **B** | 同一二进制的 `app-server --stdio` | **App 真实客户端协议**：WS、prewarm、逐 frame turn、Responses Lite、客户端重试语义 | 不启动 App UI |
| **D** | 人工 UI 签核（由用户执行并署名） | 渲染、菜单、文件选择器 | 后端通过不得替代 |

隔离规则：独立 `CODEX_HOME`（临时目录）、`auth.json` 只做 symlink、独立 Gateway + 随机端口、独立历史命名空间（可关闭持久化）。启动时记录 harness 版本与二进制 sha256；**版本或哈希变化即强制重跑 E2E-1/2/3 + D**。

## E2E 用例（6 条）

| ID | 证明什么 | 入口 | 被测对象 | 核心断言（H 之外） |
|---|---|---|---|---|
| **E2E-1** | 官方订阅透传基线 | A / B | 隔离 Gateway | GPT 完成；官方路径逐字节透传、phase 不改写；无第三方头 |
| **E2E-2** | 第三方 Responses 路径 | B | 隔离 Gateway | DeepSeek 完成；phase 与 `output_item.done` 一致；渠道会话头仅 adapter 发送；图片两分支（多模态原图 / 文本目标有损说明） |
| **E2E-3** | 跨模型切换 + 历史与工具 | B | 隔离 Gateway | 双向成功；工具只执行一次；口令跨切换可复述；摘要调用数 = 0；顺序 `reasoning → 全部 call → 全部 output`；prewarm 零上游；Lite 前缀不入历史 |
| **E2E-4** | 容量边界 | A（HTTP） | 隔离 Gateway | ≥360K 成功且未发生有损压缩；明确超限仅 1 次摘要 + 1 次重试；原文不被覆盖 |
| **E2E-5** | 第二入口与非 Responses 协议 | A（HTTP） | 隔离 Gateway | 本地令牌校验生效；Chat 目标工具正常；搜索回退 continuation 顺序正确；内部工具对客户端不可见 |
| **E2E-6** | 并发稳定性 | B | **线上 8788** | 4 会话全部完成、无串话；H1–H10 全过；健康检查可用；结束后无残留 |

E2E-6 约束（已批准）：仅在你非使用时段运行；启动前检查 `activeTurns == 0`；4 会话 × 短轮；全程可中止；不重启、不改配置、不跑大上下文；发现活动轮次立即让路。
E2E-4 节奏：只在发布前运行，不进日常。

## 横向验收标准 H1–H10

每条用例自动套用；硬性契约违反即 FAIL。

| # | 判据 | 机检方式 | 绊线 |
|---|---|---|---|
| H1 | 完成性：终态唯一且为 `completed`，无 `error`/`failed`，无异常断流 | 终态事件计数 | 硬性 |
| H2 | 前进性：首实质事件 ≤30s（大请求 90s）；首文本 ≤45s（大请求 90s）；相邻事件间隔 ≤60s | 客户端事件时间戳 | 异常绊线（**不判总时长**） |
| H3 | 重连：同 turn 在 Gateway 侧被重复请求的次数 | 日志中同 `turn` 哈希的分组计数 | 0 正常；1 记录；**≥2 异常** |
| H4 | 工具完整性：每个 call 有 result，无 error 状态，`call_id` 唯一且不重复执行 | provider 事件流 | 硬性 |
| H5 | 协议契约：`sequence_number` 严格连续；phase 与 done 一致；事件类型在已知集合内 | 流内校验 | 硬性 |
| H6 | 隔离隐私：第三方出站不含订阅凭证/账号头；日志与 artifact 无正文、无 token、无跨会话串内容 | 出站抓头 + 扫描 | 硬性 |
| H7 | 幂等副作用：同 turn 重试不新增历史版本、不产生重复上游副作用 | 版本号 + 调用数 | 硬性 |
| H8 | 资源可用：健康检查 p95 ≤1000ms；event-loop p99 ≤200ms；结束后 `activeTurns` 归零 ≤30s | 运行期采样 | 异常绊线（CPU 不单独判） |
| H9 | 可归因：任何非成功路径必须落到具体错误分类，禁止 `other`/未知 | 错误字段断言 | 硬性 |
| H10 | 证据完整：artifact 含 case/run/时间/模型/provider/入口/请求字节/阶段耗时/结论 | schema 校验 | 硬性 |

判定三分：`PASS`（硬性契约通过 + 绊线未越界 + 事件持续前进）/ `ANOMALY`（硬性通过但绊线越界，必须归因到 H9 分类）/ `FAIL`（硬性违反、ANOMALY 无法归因、或同一异常连续两次）。

纪律：只跑一次偶发通过不算 PASS；不稳定项记 `FLAKY` 并保留证据，不得记为 PASS，不得靠重试凑通过。

用例自身标准（准入）：走真实入口、证明单测证明不了的事、单一可判定结论、输入与断言确定（波动只进 H 阈值）、隔离且可重复、成本明示、人工缺口显式、失败可定位、可回归。

## 架构规约（patch loop 不可突破）

1. 凭证与身份不跨边界（订阅凭证只发官方后端；渠道头不互串；`/v1` 令牌与订阅租户校验）
2. 用户资产与环境零改写（不改 rollout、不强退 App、不中断活动轮次、不改写网络策略）
3. 写入事务性与唯一副本保护（原子写 + 备份 + 可回滚；失败不覆盖唯一副本）
4. 原文不可覆盖、版本不可变（original/view 分离；提交先于对外发布完成）
5. 有输出即禁止回退/重试/重放（含已执行本地工具副作用）
6. 压缩决策权归 Codex（无固定阈值、无递归摘要；仅明确超限一次摘要 + 一次重试）
7. turn 内路由冻结 + 能力显式声明 + 无隐式执行路径（无动态插件、无旁路进程）
8. 协议保真与客户端可见契约（官方透传；序号连续、终态唯一、事件不丢）
9. 观测隐私与非阻塞（只记结构化元数据；诊断不得成为主线程阻塞）

**B 类停止条件**（必须报告，不得自行处理）：放宽或修改阈值/断言/已冻结证据；新增 provider/协议/依赖；改动网络策略（含 NO_PROXY/TLS/代理）；修改历史数据结构或删除恢复副本；需要强退 App 或中断活动轮次；需要超出本次授权的线上服务范围；同一用例连续 2 轮 patch 仍失败。

**阈值改动属于 B 类**，且必须附证据说明原阈值为误报。

## Patch loop 契约

冻结证据（只读）→ 归因到层（API/Normalizer/Router/Planner/Adapter/Relay/Archive/Service/Env）→ 影响面（全部 caller + 触及的规约编号）→ A/B 判定（B 即停并报告）→ 最小修复 + 1 个可运行检查 → 验证（该用例 + G0 全量 + 触及的规约检查）→ 更新 artifact + 写 patch 记录 → 未过回到归因（限 2 轮）。

Patch 记录字段：`patch / case / layer / rootCause / invariants / files / test / before / after / reruns`。

禁止：改断言、跳过用例、改证据、把 L2/L3 降级为 CLI、以放宽阈值使其通过、静默重试直到偶然通过。

## 执行顺序

1. **P-000 回滚 `NO_PROXY` 例外**（备份 plist → 无活动轮次窗口重渲染 → 校验 plist 无该例外 → 记录）
2. **落地规范与 runner**（`docs/e2e/*`、`scripts/e2e/*`、`test/e2e-criteria.test.mjs`、npm scripts）
3. **G0 门禁**：`npm test`（含新增用例）+ `audit:package` + 源码扫描（无固定阈值压缩常量、无动态插件加载、无新增出网地址）
4. **E2E-1 → E2E-2 → E2E-3 → E2E-5**（隔离 Gateway，真实渠道）
5. **E2E-6**（线上 8788，按上述约束；需你确认时段）
6. **E2E-4**（发布前）
7. **D 人工 UI 签核**（你执行，写入 `manual` 段）
8. 任何 FAIL/ANOMALY 进入 patch loop，修复后重跑该用例 + G0

## 验证与完成证据

- `artifacts/e2e/<runId>/summary.json`：6 条用例 verdict + H1–H10 逐条结果 + 证据路径 + harness 版本与 sha256
- `docs/e2e/acceptance.md`：结论表、ANOMALY 归因、patch 记录、人工签核项、已知边界
- G0 全绿
- 未达标项必须显式列为本轮未完成，禁止记为通过
- 每个交付步骤一个提交；提交只含本任务相关文件

## 假设与默认值

- harness 二进制用 App 包内 core（与 App 同版本），缺失时回退 PATH `codex`；二选一在 preflight 记录
- 隔离 Gateway 使用 `config/e2e.local.json`（从生产配置派生、独立历史库、随机端口），不入 git、不含明文凭证
- E2E-6 在线上服务上通过 B harness 驱动，判据依赖时间窗切片 + 同 `turn` 哈希分组
- E2E-4 仅发布前运行
- 人工签核由用户署名 `attested-by-user`，我不代替
- 既有 `docs/acceptance.md` 为历史记录，新记录写 `docs/e2e/acceptance.md` 并由旧文件链入

## Goal 交接

导出路径（Plan 批准后执行）：

```
/plan export /Users/liangruihe/Workspace/project/side-project/llm-auto-gateway-productize/docs/e2e/goal-spec.md
```

导出并退出 Plan mode 后，先 `/goal status`（无未完成 Goal 则新建），再执行：

```
/goal 目标：按 /Users/liangruihe/Workspace/project/side-project/llm-auto-gateway-productize/docs/e2e/goal-spec.md 执行 Codex Local Router 的 E2E 验收。该导出 Plan 是唯一执行规范，本 Objective 只重申与它一致的约束与完成证据。

范围
- 落地 docs/e2e/{acceptance.md, thresholds.json} 与 scripts/e2e/ runner（npm run e2e:l0|l1|l2|live）
- 先执行 P-000：回滚 LaunchAgent 的 NO_PROXY 例外（已批准），备份 plist、无活动轮次窗口重渲染、校验不含该例外
- 按序运行 G0 与 E2E-1 → E2E-2 → E2E-3 → E2E-5 → E2E-6 →（发布前）E2E-4，以及 D 人工签核
- 任一 FAIL/ANOMALY 进入 patch loop

执行方式（固定，不可替换）
- A：App 包内 core 的 exec（缺失时回退 PATH codex）
- B：同一二进制 app-server --stdio（App 真实客户端协议：WS / prewarm / 逐 frame turn / Lite / 客户端重试语义）
- D：人工 UI 签核，由用户署名 attested-by-user；后端通过不得替代 UI 通过
- 禁止驱动真实 App UI；禁止强退 App 或中断活动轮次
- 隔离：独立 CODEX_HOME、auth.json 只 symlink、独立 Gateway 随机端口、独立历史命名空间
- E2E-6 指向线上 8788：仅用户非使用时段，启动前 activeTurns 必须为 0，4 会话 × 短轮，可随时中止，不重启不改配置

判据
- 硬性契约（违反即 FAIL）：H1 完成性、H4 工具完整性、H5 协议契约、H6 隔离隐私、H7 幂等副作用、H9 可归因、H10 证据完整
- 异常绊线（宽松，非性能目标）：H2 首输出 30/45/90s、静默 60s；H3 重连 1 记录 / ≥2 异常；H8 健康 p95 ≤1000ms、event-loop p99 ≤200ms、activeTurns 归零 ≤30s
- 判定三分：PASS / ANOMALY（必须归因）/ FAIL
- 阈值改动属于 B 类，必须停下报告并取得批准

架构规约（patch loop 不可突破）
1 凭证与身份不跨边界　2 用户资产与环境零改写　3 写入事务性与唯一副本保护
4 原文不可覆盖、版本不可变　5 有输出即禁止回退/重试/重放　6 压缩决策权归 Codex
7 turn 内路由冻结 + 能力显式声明 + 无隐式执行路径　8 协议保真与客户端可见契约　9 观测隐私与非阻塞

停止条件（必须报告，不得自行处理）
- 需要放宽或修改阈值、断言、已冻结证据
- 需要新增 provider / 协议 / 依赖
- 需要改动网络策略（含 NO_PROXY / TLS / 代理）
- 需要修改历史数据结构、删除恢复副本
- 需要强退 App 或中断活动轮次
- 需要超出本次授权的线上服务范围
- 同一用例连续 2 轮 patch 仍失败

完成证据
- artifacts/e2e/<runId>/summary.json：每用例结论 + 各 H 判据结果 + 证据路径 + harness 种类/版本/二进制 sha256
- docs/e2e/acceptance.md：结论表、ANOMALY 归因、patch 记录、人工签核项、已知边界
- G0 全绿：npm test（含 test/e2e-criteria.test.mjs）、audit:package、源码扫描
- 未达标项必须显式列为本轮未完成，禁止记为通过
```

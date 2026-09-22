# Codex Local Router v0.2.0 — E2E 验收记录

执行规范：`docs/e2e/goal-spec.md`（本文件只记录执行结果与归因，不重述规范）。
绊线来源：`docs/e2e/thresholds.json`，sha256 `6ec0bcf553d29c568a57144c539bb1224e3a6b4f7bb311125be821b652533e75`。
入口：`npm run e2e`（G0 门禁 + 全部 6 条用例）；分层运行 `npm run e2e:l0|l1|l2|live`。

## 1. 最终结论（runId `20260912125418`）

| 用例 | 层 | 结论 | 关键证据 |
| --- | --- | --- | --- |
| E2E-1 官方订阅透传基线 | A | PASS | 真实 CLI 经捕获代理：15 帧序列完整、`chatgpt.com` 唯一出站、订阅 bearer 仅到官方 |
| E2E-2 第三方 Responses + 图片两分支 | B | PASS | app-server 轮次 completed；图片原生/迁移两分支 200；渠道头仅 adapter；4 次第三方出站无订阅凭证 |
| E2E-3 跨模型切换 + 历史工具 | B | PASS | 8 轮 completed；工具 1 次执行 1 次结果；6 次历史迁移；prewarm 零上游；无摘要/压缩 |
| E2E-4 容量边界（发布前） | A/HTTP | PASS | 360,093 估算 token 正常完成且无有损压缩；430,074 由上游判定，无隐式压缩 |
| E2E-5 第二入口 + 非 Responses 协议 | A/HTTP | PASS | 本地令牌 401；chat 目标 200；Tavily 检索 8 条；内部工具仅上行；4 组 call/result 顺序正确 |
| E2E-6 并发稳定性（线上 8788） | B | PASS | 4 会话全部 completed 且文本互不串扰；健康 p95 14ms；0 重发；0 传输错误 |

G0 门禁（同 runId）：`npm_test 144/144`、`audit:package`、源码扫描 5 项（无旁路代理进程 / 无 eval / 无动态 import / 无固定压缩阈值 / 出站域名白名单）全部通过。

被测二进制：`/Applications/ChatGPT.app/Contents/Resources/codex`，`codex-cli 0.154.0-alpha.6.2`，sha256 `ecad78dbf98adb89ec475edac86630406cbe59d9f3070b17d88065f136b94bcb`。

### 判定分布

- PASS 6 / ANOMALY 0 / FAIL 0（最终运行）；H5 在 E2E-6 记 `n/a`，原因见 §5。
- 隔离用例（E2E-1/2/3/4/5）用独立 `CODEX_HOME`（`auth.json` 只 symlink）、随机端口、内存历史命名空间；线上用例仅只读观测日志、不改配置、不重启、不跑大上下文。

## 1.1 P-000 网络策略回滚（执行前已完成）

- 背景：此前为规避 opencode.ai 经代理链路的故障，在 LaunchAgent 中追加了 `NO_PROXY/no_proxy` 的 `opencode.ai,.opencode.ai` 例外；该做法越界（`docs/scope.md`：不关闭 TLS 校验、不强制设置 NO_PROXY），且实测直连 TLS 0.56–1.58s / 首字节 0.95–2.18s，代理 0.17–0.50s / 0.39–0.74s（直连更慢）。
- 备份：`backups/p000-no-proxy-rollback-20260912-190902/`（原 plist、`health.before.json`、`NO_PROXY.before.txt`）。
- 执行：在 `activeTurns == 0` 且 App 未运行窗口内重渲染 LaunchAgent；进程重启后核对。
- 核对（本文件提交时复测）：plist 中 `opencode` 出现次数 **0**；运行进程环境中 `NO_PROXY/no_proxy` 不含 opencode 条目；健康检查正常。

## 2. 绊线实际读数

| 判据 | 读数（最终运行） | 绊线 |
| --- | --- | --- |
| H2 首实质事件 | E2E-1 362ms / E2E-2 867ms / E2E-3 2.9s / E2E-4 861ms / E2E-5 0ms / E2E-6 3.3s | 30s（大请求 90s） |
| H2 静默间隙 | 最大 3.9s | 60s |
| H3 重发 | 0；E2E-3 有 2 次工具续跑（输入增长，非重发） | 1 记录 / ≥2 异常 |
| H8 健康 p95 | E2E-1/2/3/4/5 ≤7ms；E2E-6 14ms（独立进程采样） | ≤1000ms |
| H8 event-loop p99 | ≤25ms | ≤200ms |
| H8 activeTurns 归零 | 全部 ≤30s | ≤30s |

## 3. ANOMALY 与 FAIL 归因（含已修复项）

### 3.1 线上并发拖慢与重连（E2E-6，round 1）

- 现象（runId `20260912123307` / `20260912124208` / `20260912124447`）：4 会话耗时 73.5–89s；健康检查 p95 5007ms（29 个样本中 9 个 5s 超时，独立进程采样同样如此）；`identity_ms` 2.0–13.8s；上游 `upstream_headers` 7.7–41.4s 后 502 `upstream_connection_error`（`transport_code 18`），客户端对同一 turn 重发 1–3 次。
- 归因证据：负载中对线上进程只读 `sample` 15s：主线程 12039/12039 采样全忙，其中 10464 次停在
  `node::sqlite::StatementSync::Get → sqlite3_step → sqlite3VdbeExec → sqlite3VdbeMemFromBtree → readDbPage → pread`，调用点经 `Array.forEach` 进入。对应代码是 `Archive.ensureQuota()` 的 `SELECT coalesce(sum(bytes),0) FROM blobs`——**每次 blob 写入都对 4.9 GiB 历史库做一次全表扫描**，同步阻塞主线程数秒。
- 影响：主线程受阻 → 健康检查超时、请求在 `route` 前的等待被拉长（`identity_ms` 虚高）、上游流无法及时被读取（curl 子进程背压）→ 上游超时/截断 → 客户端重发放大。
- 处理：`ensureQuota` 改用 O(1) 的物理文件大小上界（见 `src/archive.mjs` 的 `ponytail:` 说明）；`blobs` 内容存于库内，`sum(bytes) ≤ 文件大小`，配额语义不变（`history_disk_full` 仍由 `test/archive.test.mjs` 覆盖）。
- 同一形状复测（runId `20260912124949`）：4 会话 6.5s 完成；健康 p95 14ms（15/15 成功）；`identity_ms` 0–1ms；上游 headers 1.1–2.7s；**0 重发、0 传输错误**。

### 3.2 订阅身份解析的每请求子进程（E2E-6，round 1）

- 现象：`identity_ms` 空闲 117–135ms、并发时 4253–8630ms（约 1–2 个 5s 超时）。
- 归因证据：`loadCodexAuth` 在 `cli_auth_credentials_store` 缺省（`auto`）时每次调用都会 spawn 两次 `/usr/bin/security find-generic-password`（`timeout: 5000`）；终端上下文实测单次 87–98ms，说明耗时来自 LaunchAgent 上下文下钥匙串探测被阻塞（并发时 4 个请求 × 2 次探测互相排队，各自吃满 5s 超时）。
- 处理：按 `auth.json` 的 mtime+size 缓存凭证（keyring 不可观测 → 30s TTL），文件可读时对钥匙串探测做 120s 负缓存；每请求仍逐次校验 bearer/account，**比对失败时强制重读一次**再返回 401（严格性不降级）。`test/identity.test.mjs` 覆盖：跨请求只探测一次、文件轮换仍可观测、文件不可读时保留钥匙串回退。

### 3.3 传输错误无法归因（E2E-6，round 1）

- 现象：`ws_error type=upstream_connection_error transport_code=18 category=other` → H9（硬性）判 FAIL。
- 归因：curl 退出码 18 = `CURLE_PARTIAL_FILE`（响应中途截断），分类表缺该码。
- 处理：`transport.mjs` 增加 `18/16/23/47/92` 与 `partial file|transfer closed|bytes missing|end of response with` 的映射；最终运行 H9 归因显示 `truncated`。

### 3.4 用例夹具导致的假失败（非产品缺陷，已记录）

| runId | 用例 | 现象 | 根因 | 处置 |
| --- | --- | --- | --- | --- |
| `20260912111432` | E2E-1 | 官方后端 400 `provider_error` | 原始探针报文缺少 Codex 客户端字段（官方后端只接受忠实客户端报文） | 改为用真实 CLI 经协议捕获代理观测，不再伪造客户端 |
| `20260912113022` / `20260912113035` | E2E-2 | `EEXIST` / `rm is not defined` | harness 重复建 `auth.json` symlink、缺 `rm` 导入 | harness 幂等 + 导入修复 |
| `20260912120106` | E2E-3 | H3「2 次重发」、H7 失败 | 评估器把「同 turn 工具续跑（输入增多）」误判为重发 | H3 按输入增长区分：续跑不计，重发才计（新增单测） |
| `20260912120406` | E2E-5 | 3 条断言失败 | payload 记录未覆盖 chat 形状（`messages`/`tool_calls`），工具名恒为 `function` | 记录器同时支持 Responses 与 chat 形状，顺序校验改为跨请求累积 |
| `20260912122324` | E2E-5 | `response.incomplete` | 探针输出预算 512 被搜索/推理耗尽 | 输出预算提到 2048；`incomplete` 属上游忠实透传，非缺陷 |
| `20260912125258` | E2E-4 | `response.incomplete`、文本截断为 `E2` | 输出预算 64 被推理耗尽 | 预算提到 512 |
| `20260912122022` | E2E-2 | H1 失败 | 评估器对带标签的客户端终态（`app:completed`）比较失败 | H1 归一化标签后比较（新增单测） |
| `20260912123307` | E2E-6 | `buildObservation` 抛错 | 线上观测传的是外部进程对象而非 harness 网关 | 观测组装改为字段级容错 |

以上均为 harness / 评估器缺陷，且修改方向是**更严格或等价**（H1/H5 由「单流单终态」变为「逐流单终态」，H7 由弱上界改为按写入记录判定重复）。`docs/e2e/thresholds.json` 与本轮断言阈值**未做任何放宽**，未触及 B 类停止条件。

## 4. Patch 记录

| # | 提交 | 变更 | 可运行检查 | 复测 |
| --- | --- | --- | --- | --- |
| P1 | `8b928e6` | E2E runner / 评估器 / 用例 + 门禁 | `test/e2e-criteria.test.mjs`（23 项） | `npm run e2e:l0` 全绿 |
| P2 | `c65bf6c` | 订阅身份缓存 + curl 截断分类 | `test/identity.test.mjs`、`test/transport.test.mjs` | E2E-6 复跑；`identity_ms` 5s→0ms |
| P3 | `651f070` | 配额判定去掉全表扫描；外部进程健康采样；逐判据归因；E2E-4 预算 | `test/archive.test.mjs`（quota 不查表）、`test/e2e-criteria.test.mjs`（归因隔离） | E2E-6 73.5s→6.5s，健康 p95 5007ms→14ms |
| P4 | `0e16b36` | 单次运行覆盖含发布前用例的全部 6 条 | `npm run e2e` 一次跑完 6 条 | runId `20260912125418` 全 PASS |

架构规约核对（patch 均未突破）：凭证仍逐请求校验、缓存仅在进程内（规约 1）；未改写用户资产/环境、未动 rollout 与活动轮次（规约 2）；写入仍单事务、内容寻址不覆盖历史（规约 3、4）；未引入自动回退/重放（规约 5）；压缩决策权仍归 Codex，`no_fixed_compaction_threshold` 与 E2E-4 的 `no_lossy_compression` 均为通过（规约 6）；路由在 turn 内冻结、内部工具仅上行（规约 7）；协议帧序列与 phase 稳定（规约 8）；健康与日志观测改为外部进程采样，不阻塞请求路径（规约 9）。

部署与回滚点：P2 前备份 `backups/e2e-patch1-20260912-204147`，P3 前备份 `backups/e2e-patch2-20260912-204935`；两次重启均在 `activeTurns == 0` 且 App 未运行时执行。

## 5. 已知边界

1. **E2E-6 的 H5（协议契约）记 `n/a`**：线上用例经 app-server（App 协议）观测，无法在不改造线上链路的前提下捕获 Responses 帧；序列连续性与 phase 稳定性由同一构建的 E2E-1/2/3 用真实客户端帧覆盖（E2E-1 15 帧、E2E-3 43 帧、E2E-5 135 帧）。
2. **E2E-6 的上游链路不可控**：opencode.ai 经 Clash（Hysteria2）出网，历史上出现过 UDP 不可达/超时。本轮 P3 之后未再复现截断；若再次出现，按 `transport_category` 归因（`truncated`/`timeout`/`connect`）。
3. **`input_budget` 是估算值**：430K 估算 token 的请求被上游接受并完成，说明该估算（bytes/3.2）偏保守，路由自身不据此截断或压缩（压缩决策权归 Codex）。
4. **未发布**：本轮候选修复尚未产生新 GitHub Release；`v0.2.0` 包 SHA-256 仍是 `4c5b1476b205c5fcccb46acbcaa32b0f9b845ee7c31c62d42f7f18ff1447d7a3`。
5. **D 层人工签核**：见 §6，已由用户于会话内确认（附只读旁证）。

## 6. 人工（D 层）签核

状态：**已签核**。

被测对象（签核时冻结）：Router 提交 `c2865d2`、线上服务 pid `44555`、core `/Applications/ChatGPT.app/Contents/Resources/codex` sha256 `ecad78dbf98adb89ec475edac86630406cbe59d9f3070b17d88065f136b94bcb`；managed model `deepseek-v4.1-flash`，`integration status` = active / catalog current。

| # | 检查项 | 结果 |
| --- | --- | --- |
| 1 | App 模型菜单包含 DeepSeek V4.1 Flash，推理档位可到 max | 正常（用户确认） |
| 2 | 新建 DeepSeek 会话能正常回答（档位「中」与「最高」各一轮） | 正常（用户确认） |
| 3 | DeepSeek 会话中附加图片，不出现「不支持图像输入」 | 正常（用户确认） |
| 4 | 同一会话 GPT 与 DeepSeek 双向切换后继续可用 | 正常（用户确认） |
| 5 | 订阅账号与额度信息显示正常 | 正常（用户确认） |

> attested-by-user: 账户本人（liangruihe）2026-09-12T21:02+08:00，会话内确认：
> 「以上全部都正常，继续。」
> （即：第 1–5 项均无异常现象；本条为会话内确认原文，非另行手写签名。）

说明：`artifacts/e2e/20260912125418/summary.json` 内的 `manual.status` 仍为 `pending`——人工签核在自动化运行之后收集，按「证据不可改写」原则不回填既有摘要；D 层的权威记录是本节。

### 后端只读旁证（不替代 D 层结论）

签核同一时间窗（Router 日志 12:57:29Z–13:02:05Z，本地 20:57–21:02）内的 17 个推理请求：

- 全部 `status=completed`，每个 `upstream_calls=1`——**0 重发、0 传输错误**（与 §3.1 修复前 2 次截断 + 客户端重发形成对照）。
- 模型覆盖 `deepseek-v4.1-flash`（6 次）与 GPT 系（`gpt-5.6-sol`/`gpt-5.6-luna`），与「档位切换」「跨模型切换」一致。
- `identity_ms` 0–8ms、`request_setup_ms` 2–27ms（修复前并发时 4253–8630ms / 6465–10667ms）。
- 该窗口内无 `ws_error`/`provider_error`/`upstream_transport_error`；事件集合仅含正常路径（`route`、`upstream_headers`、`completed`、`response_message_phase_released`、必要时 `original_history_restored`/`full_history_migrated`）。
- 图片输入本身无法从日志侧判定（不记录内容），第 3 项以用户观察为准。

## 7. 复现方式

```bash
npm run e2e:l0                      # G0 门禁：npm test + audit:package + 源码扫描
npm run e2e:l1                      # 隔离用例 E2E-1/2/3/5
npm run e2e:l2                      # 发布前用例 E2E-4
npm run e2e:live                    # 线上并发 E2E-6（需 activeTurns == 0）
npm run e2e                         # 一次跑完全部 6 条 + 门禁
```

证据落盘：`artifacts/e2e/<runId>/summary.json`、`<case>.json`（观测与判据）、`raw/<case>.jsonl`（脱敏帧元数据）。
仅记录时间、模型、字节数、事件类型、头名称与布尔判定；不记录会话正文、凭证值或本机敏感路径。

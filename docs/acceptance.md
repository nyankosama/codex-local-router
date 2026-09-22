# 验收记录

## Gateway Core 质量准出计划（待执行）

下一轮用于 Goal 驱动的 revision 2 准出规范已建立在
[docs/e2e/quality-gate/goal_spec.md](./e2e/quality-gate/goal_spec.md)，上一轮冻结记录及下一轮追加位置在
[docs/e2e/quality-gate/acceptance.md](./e2e/quality-gate/acceptance.md)。

这不是新的通过结论。新契约把 `Gateway Core`、官方订阅、逐渠道健康、真实 App 灰度、Local Use Ready 和 Release Ready 分开判定：第三方渠道自身超时、配额或拒绝可以在证据充分时记为 `EXTERNAL_DEGRADED`，不再冒充 Gateway 缺陷；渠道仍不能因此记为可用。`models_cache.json` 的 App 自刷新按隔离条件记录为环境观测，不再要求必须定位写入 PID。性能只验证正常健康与可归因性，不做性能优化型硬门槛。

## E2E 验收（2026-09-12，最新）

执行规范 `docs/e2e/goal-spec.md`，绊线唯一来源 `docs/e2e/thresholds.json`，工具链 `scripts/e2e/`（`npm run e2e:l0|l1|l2|live`，或 `npm run e2e` 一次跑完全部用例）。完整结论、归因、patch 记录与人工签核见 [docs/e2e/acceptance.md](./e2e/acceptance.md)。

- 结果：单次运行 `runId 20260912125418`，E2E-1/2/3/4/5/6 全部 PASS，E2E-4（发布前容量边界）最后执行，G0 门禁全绿（`npm test` 144/144、`audit:package`、源码扫描 5 项）。
- 分层：A = App 包内 core 的 `exec`；B = 同一二进制 `app-server --stdio`（覆盖 WS、prewarm、逐 frame turn、Lite 与客户端重试语义）；D = 人工 UI 签核（用户确认 5 项正常，附同时段日志只读旁证）。CLI/doctor 结论不替代 A/B/D。
- 本轮两条真因（均由线上并发用例暴露并用只读 `sample` 归因）：
  1. `Archive.ensureQuota()` 每次写 blob 都对数 GB 历史库执行 `SUM(bytes)` 全表扫描，同步阻塞主线程 → 健康检查超时、请求准备时间虚高、上游读取背压导致截断与客户端重发。改为 O(1) 物理文件大小后，同一并发形状 73.5s → 6.5s、健康 p95 5007ms → 14ms、重发 2 → 0。
  2. 订阅身份解析在 `cli_auth_credentials_store` 缺省时每请求 spawn 两次 `/usr/bin/security`（5s 超时）→ `identity_ms` 4.3–8.6s。改为 `auth.json` mtime+size 缓存、Keychain 30s TTL 与 120s 负缓存，仍逐请求校验、失配强制重读一次。
- 网络策略：P-000 已回滚此前追加的 `NO_PROXY` opencode 例外（备份 `backups/p000-no-proxy-rollback-20260912-190902`），复核 plist 与进程环境均不含该例外。

## 本次结论（2026-09-12）

多模型配置、Codex 主导压缩、单次超限兜底和加密持久历史已经接入生产执行层。真实 GPT 与 DeepSeek 双向切换、工具历史恢复、DeepSeek 360K 输入、图片输入和 `max` 推理强度均已通过隔离生产 Gateway 验收。本次新增 OpenCode Go Responses 消息阶段稳定化：真实上游的 message 从 `final_answer` 变为 `commentary` 时，Gateway 等待该 message 自身完成后以稳定阶段释放，随后立即传递工具调用。

搜索 continuation 补充修复已在隔离 worktree 完成。Gateway 现在持久保存内部搜索和外部工具的原始模型输出顺序，旧版本历史也会恢复为“全部调用在前、全部结果在后”；OpenCode Go `max` thinking 不再因搜索结果插到外部调用之前而返回 `reasoning_text` 错误。搜索回退同时增加 Tavily Extract 与 Exa Contents 正文提取，默认最多返回 20000 字符。

本次阶段修复已通过隔离 Gateway 真实验收。在线 `127.0.0.1:8788` 仍运行上一版本；检查时存在当前任务及其他任务的活动推理，未强制重启。实际 App 折叠闪动复验需等待在线 Gateway 安全切换后完成。（后续状态：该在线 Gateway 已于 2026-09-12 在 `activeTurns == 0` 窗口完成升级与切换，见上节 E2E 记录。）

正在运行的 Codex App 尚未重载本次 `max` 推理档位目录。磁盘上的活动目录已有 DeepSeek `400000`、图片能力且无 `comp_hash`，但推理档位仍只到 `xhigh`，升级工具因此报告 `current=false`。按实施约束，本次没有强制退出正在工作的 App；实际 App `max` 菜单验收需在任务结束、完整退出 App 并升级目录后执行。（后续状态：目录已升级，`integration status` 为 applied / catalog current，App 内 `max` 档位与图片输入已由用户于 2026-09-12 人工复验通过。）

### 已实现

- 沿用 `providers`、`targets` 和路由规则，能力按模型和渠道配置。使用既有协议和适配器的新模型只需增加配置。
- 自定义目标显式选择 `native`、`summary` 或 `unsupported` 压缩模式；默认不宣称原生兼容。
- Codex 负责触发压缩。Gateway 不再使用固定 `64 KiB` 阈值，也不执行分块递归摘要或多轮修订。
- 跨模型先恢复原文；估算只用于观测。仅在目标返回明确上下文超限、尚未输出且未使用过迁移摘要时，调用源模型生成一次摘要并重试一次。
- 同模型继续沿用当前视图；切换到其他模型时评估恢复原文。原文与实际视图分开持久保存。
- DeepSeek 目标为 `400000` 窗口、`summary` 模式、文本与图片输入且无 `comp_hash`。官方 GPT 模型目录保持原有窗口、协议和兼容标识。
- `x-opencode-session` 只由 OpenCode Go 适配器发送；订阅认证不会转发给自定义渠道。
- SQLite 历史启用 WAL、事务和 AES-256-GCM。密钥保存在 macOS Keychain；默认配额 10 GiB，达到上限停止新增且不自动清理。
- 历史按受信本地订阅账号、线程、分支和版本隔离；分叉绑定父分支精确版本。
- 增加 `models check`、`history inspect/import/export/prune` 和 `integration upgrade/status/restore`。
- 保留此前 HTTP `identity`、`zstd`、`gzip`、`deflate` 解压和错误分类修复，压缩请求不会再以 `invalid_json` 掩盖。
- provider 可配置 `responsesMessagePhasePolicy`。OpenCode Go 默认逐 message 等待 `output_item.done` 并稳定 phase；通用兼容渠道默认透传，官方 GPT 固定透传。
- App 推理档位由 target 的 `app.reasoningLevels` 显式配置；DeepSeek V4.1 Flash 的 OpenCode Go target 已启用至 `max`，其他自定义模型不自动继承。
- 缓存粒度是单个 message item。多段过程说明和工具调用仍逐段推进；按精确分类约定，OpenCode Go 的最终回答也在自身完成后整段出现。
- 上游实质输出与客户端可见输出分别跟踪；缓存期间断流、取消或超限不会触发 fallback、摘要重试或工具重放。

### 自动化验证

最终结果为 **95/95 通过**（仓库根目录执行 `npm test`）。覆盖范围包括：

- Responses 与 Chat Completions，流式与非流式请求。
- 原生压缩、摘要适配、不支持压缩；Codex 切换准备、手动压缩和上下文超限。
- 容量估算不触发摘要；明确超限最多一次摘要和一次重试；认证、额度、网络、输出后失败不触发。
- 原文和视图分离、重复消息、工具顺序和调用 ID、摘要复用、重启恢复和分叉引用。
- 加密 SQLite、配额、稳定订阅身份、渠道专用头和第三方认证隔离。
- 旧配置升级、目录生成、DeepSeek 400K/无 `comp_hash`、官方 GPT 目录逐项不变。
- 自定义模型推理档位配置、`max` 目录生成，以及非法、重复和默认值越界校验。
- schema v2 要求每个模型和渠道 target 显式声明窗口；旧配置缺失值迁移为原系统的保守 131072，仍需渠道验收。
- 精确 rollout 导入，压缩前原文与压缩后活动视图并存；无 `call_id` 的 App 输出不误判为缺口。
- App 目录升级允许 Codex 新增 `service_tier` 和其他无关配置；重复升级保留并校验首次目录备份，同时校验 Gateway 的模型、地址及当前目录未被修改。
- Responses 阶段兼容覆盖单段和多段 message、过程说明与工具顺序、最终回答边界、官方 GPT 透传、HTTP/WS 连续序号、取消、断流和缓存超限。
- 搜索与正文提取工具保持内部不可见；混合搜索和多个外部工具在 HTTP/WS 中均保持 provider 顺序。
- 新旧两种 continuation 都保留 `reasoning_text → 全部调用 → 全部结果`；thinking 历史错误使用脱敏分类。

### 真实渠道验证

真实验收使用本项目生产 Gateway 和 Codex App 自带 app-server，运行在隔离端口与隔离 `CODEX_HOME`。认证只链接本机已有 `auth.json`，没有复制或输出凭证。

| 场景 | 结果 | 证据 |
|---|---|---|
| GPT/DeepSeek 双向切换 | 2 个线程、每个 4 turn、共 8/8 completed；连续 6 次跨模型迁移 | `artifacts/production/model-switch-configured-multimodel.json` |
| 容量足够时迁移 | 6 次迁移全部使用完整原历史，摘要调用为 0 | 同上及 Gateway 阶段日志 |
| 工具与历史 | 初始 turn 真实读取随机文件，文件删除后后续各轮仍准确恢复对话口令和工具结果；工具没有重复执行 | 同上 `turns[].tools`、`turns[].checks` |
| 模型目录 | GPT-5.6 Sol 为原目录 `272000`/`comp_hash=3000`；DeepSeek 为 `400000` 且无 `comp_hash` | 同上 `models` |
| DeepSeek 长上下文 | 实际输入 `360060` token、输出 `172` token、状态 completed，标记内容验证通过 | `artifacts/production/long-context-400k.json` |
| DeepSeek 图片输入 | 用户截图 `615963` bytes 经 Responses `input_image` 原样送达 OpenCode Go；一次调用 completed，识别出图片及“不支持图像输入”通知；输入 `1015`、输出 `184` token | `artifacts/production/image-deepseek.json` |
| DeepSeek `max` 推理 | 隔离 Gateway 将 `reasoning.effort=max` 原样转发；OpenCode Go 单次调用 completed，返回 `80` reasoning tokens | `artifacts/production/reasoning-max-deepseek.json` |
| DeepSeek Responses 阶段 | 真实上游起始 `final_answer`、结束 `commentary`；Gateway 缓存该单段 17 个事件、3276 bytes、93 ms，客户端两端均为 `commentary`，随后一次工具调用正常到达 | `artifacts/production/response-phase-deepseek.json` |
| 搜索正文与混合工具 continuation | Tavily Extract 返回 2315 字符；新 continuation 在 `max` 下被 OpenCode Go 接受，旧历史修复后也被接受；调用与结果顺序逐项一致 | `artifacts/production/search-continuation.json` |
| 路由与认证 | GPT 走官方订阅，DeepSeek 走 OpenCode Go；渠道路由与会话头符合配置 | 模型切换证据及隔离 Gateway 日志 |

首次真实切换验收发现官方后端生成的私有加密 reasoning 没有公开摘要，跨渠道无法转发。当前实现保留加密原项于本地原文，同时在可迁移视图中加入明确的协议损失标记，再迁移可见消息和工具结果。修复后完整流程通过；这一步不调用摘要模型。

长上下文结果证明当前 OpenCode Go 路径至少接受 360060 输入 token。它没有覆盖精确边界至 400000，也不等于所有未来渠道自动获得相同能力。

### 持久恢复验证

- 在线 Gateway 实例 ID 已更新为新实现，`/healthz` 与服务状态正常；本次图片能力配置通过 SIGHUP 原子重载，没有中断现有长连接和活动轮次。
- Keychain 中已建立历史加密密钥，数据库位于 `~/.llm-auto-gateway/state/history.sqlite`，数据库、WAL 和 SHM 权限为 `0600`。
- 本次故障线程 `01a090da-2873-7fa2-bb64-7cd7edde7dbb` 已按精确 rollout 重新导入。状态为 `complete_original`，共 17 个版本；最新版本包含 140 个原始事件和 14 个活动视图事件。
- 导入不修改 Codex rollout 文件；内容按版本保存，压缩视图不会覆盖原历史。

## 复现

```bash
npm test
node scripts/gateway-admin.mjs models check \
  --config config/gateway.subscription.local.json
node scripts/gateway-admin.mjs history inspect \
  --config config/gateway.subscription.local.json \
  --thread 01a090da-2873-7fa2-bb64-7cd7edde7dbb
node scripts/accept-model-switch.mjs
node scripts/accept-long-context.mjs
ACCEPT_IMAGE_PATH=/absolute/path/image.png node scripts/accept-image.mjs
node scripts/accept-response-phase.mjs
node scripts/accept-reasoning-max.mjs
node scripts/accept-search-continuation.mjs
```

这些真实验收命令会调用真实订阅或第三方渠道，消耗相应额度。日常回归不需要重复运行真实长上下文、图片和推理档位验收。

历史清理默认只做 dry-run；实际清理必须指定范围并传入 `--apply`。历史导出必须指定输出路径。

## App 目录升级与实际 UI 验收

当前状态可用以下命令查看：

```bash
node scripts/gateway-admin.mjs integration status \
  --config config/gateway.subscription.local.json
```

等待本任务结束并完整退出 Codex App 后执行：

```bash
node scripts/gateway-admin.mjs integration upgrade \
  --config config/gateway.subscription.local.json
```

升级会校验当前目录哈希、保留首次备份并原子写入由 `targets` 生成的新目录。重新打开 App 后验证：

1. 订阅账号及额度信息仍可读取。
2. 官方 GPT 条目保持不变，DeepSeek 显示为 400K 配置且无兼容标识复制。
3. 新建 GPT 和 DeepSeek 对话均可回答。
4. 在 DeepSeek 对话中附加一张图片，确认 App 不再显示“不支持图像输入”，并能根据图片内容回答。
5. DeepSeek 推理强度菜单包含 `max` 对应档位，选择后能正常回答。
6. 同一对话双向切换并继续工具流程，短历史不产生迁移摘要。
7. 查看 Gateway 阶段日志，确认真实目标、迁移模式、摘要调用次数和工具执行次数。

如需恢复，完整退出 App 后执行：

```bash
node scripts/gateway-admin.mjs integration restore \
  --config config/gateway.subscription.local.json
```

## 尚未完成和边界

- 实际 App 菜单重载及 UI 冒烟尚未执行；当前运行中的 App 没有被强制退出。
- 本次 Responses 阶段修复尚未加载到在线 8788 Gateway，实际 App 折叠闪动复验尚未执行；隔离真实 Gateway 验收已经通过。
- 搜索 continuation 修复位于隔离分支，尚未加载到在线 8788 Gateway；上线前需要在无活动推理窗口合并并重启服务。
- 真实测试覆盖了 DeepSeek 约 360K 输入，没有压到精确 400K 边界；400K 是当前保守配置上限。
- DeepSeek 已通过真实图片渠道验收；App 目录重载后的图片 UI 冒烟仍待执行。切换到纯文本目标时仍使用有损图片说明流程。
- 当前只注册已有 Responses、Chat Completions、官方订阅、OpenCode Go 和通用 OpenAI 兼容适配器；未知协议和供应商特性仍需新增代码及真实验收。
- Node.js 当前将内置 SQLite 标记为实验性 API；数据库格式和本项目迁移由 Gateway 自己管理。
- 包含 Gateway 虚拟检查点的会话在脱离 Gateway 前应先导出可迁移历史。回滚保留数据库、Keychain 密钥和目录备份。

## 历史基线

此前的 CLI、App 后端、Chat Completions、搜索、fallback、HTTP 解压和 WebSocket 验收证据仍保存在 `artifacts/production/`。它们用于证明旧能力没有被删除，不替代本次多模型、持久历史和 400K 长上下文验收。

# 三类渠道切换与压缩 E2E 准出

Status: Accepted（`c6a5896` Release 门禁 PASS）

Revision: 4（2026-09-25）

## 目标与交付终点

让本机 Codex CLI/App 在同一逻辑会话中于官方 GPT（O）、第三方 GPT（G，FEEI Sol/Astra）、第三方其他 Responses 模型（R，GLM Flash/DeepSeek/GLM Main）之间任意切换，并在原生压缩、Gateway summary、不支持压缩三种情形下保持历史、工具结果和凭证边界正确。

本次完成到：同一精确 commit、同一 Codex core 上默认 Release 门禁 `PASS`；发现的 Gateway 缺陷已按架构原则修复；候选快进合并到本地 `master`；交付经过守卫验证的手动生效脚本。服务切换与 App UI 签核由用户执行，单独报告。

## 背景与依据

- 当前基线：分支 `codex/e2e-cross-channel-compaction`（`6f557cf`，基于 `master/2053fd4`）。已在 `alpha.16.3` 上取得非 FEEI 范围 O/R 四格 PASS；FEEI 因 HTTP 429 未测，默认 Release 门禁未通过。证据：`~/.codex/acceptance/e2e-cross-channel-compaction-6f557cf/`。
- 原计划：会话 `01a0c6a4`（2026-09-23 “三类渠道压缩切换 E2E 补齐与上线计划”），用户已批准。
- 已证事实（2026-09-24）：App 内置 core 现为 `codex-cli 0.155.0-alpha.16.4`（SHA-256 `93169e74…189a5`），旧收据不能复用；FEEI 新密钥 `/v1/models` 200，`gpt-5.6-sol` 最小生成 200。
- 用户决定：FEEI 更换密钥；围绕既定 E2E 范围完成验收、修复问题并交付；此前要求“给切换脚本，不要自动切换”；FEEI 用 Codex CLI 身份测试，不用非 Codex 客户端（2026-09-25）。
- 已证事实（2026-09-25）：FEEI 中转对非官方 Codex 客户端的请求会在部分上游账号上返回 403 `This account only allows Codex official clients`。App-server 把 `clientInfo.name` 作为 `originator` 和 User-Agent，Gateway 按设计原样转发。直连 FEEI 对照：`clientInfo=codex_local_router_native_diag` 8/10 为 403；`codex_cli_rs` 10/10 完成；`codex exec`（`codex_exec`）20/20 完成。真实 App（`Codex Desktop`）9/22–9/23 经 Gateway 的 FEEI 请求 7120 次 200、0 次 403。
- 约束：`docs/architecture-principles.md`；项目记忆中的 patch loop 规约（不跨 provider 串凭证、事务式可恢复、路由与适配分层、单一终态、原始历史与模型视图分离、日志不泄露正文或凭证）。

## 范围与要求

- 包含：R-01～R-13。
- 排除：npm registry 发布、修改 `codex/release-v0.5.22`、自动关闭或重开 Codex App、真实 App UI 签核（用户执行）、图像回答稳定性的统计准出（见决策）。

### R-01 FEEI 凭证轮换

新密钥只存于 Keychain（`codex-local-router-provider` / `feei`），不出现在配置、命令参数、收据或日志中；旧密钥保存在同 service 的 `feei.previous-20260924` 以便回滚。

### R-02 确定性门禁

干净工作树的精确 commit 上：`npm test` 全通过、`git diff --check`、`npm run audit:package`、`node scripts/audit-public.mjs`、生产依赖高危漏洞为 0。

### R-03 压缩能力探测

DeepSeek、GLM Main 各经一次标准 `/responses/compact` 探测，结果冻结为 `supported` / `provider-unsupported` 之一，并在隔离 Gateway 中通过续接、重启和凭证检查；`inconclusive` 不算通过。

### R-04 FEEI 原生压缩

FEEI Sol、Astra 在强制 Standard 与源配置 Lite 下共四个用例：两次手动原生压缩、一次阈值自动压缩、一次只读工具闭环、续接、Gateway/App-server 重启和同一 checkpoint 复用；`summary_started` 为 0，不回退 Gateway summary。

### R-05 3×3 切换矩阵

三条链 `O→G→O`、`O→R→O`（含图片与自动 summary）、`Sol→Astra→GLM Flash→DeepSeek→Sol` 覆盖九个来源/目标单元；包含旧版 metadata-only checkpoint 恢复。每条链事实与已完成工具结果保留、工具只执行一次、摘要复用、重启可续、不支持时本地明确拒绝、无跨 target opaque 状态、Gateway 虚拟 checkpoint 不发 OpenAI、凭证隔离。

### R-06 独立 App-server 冒烟

全新 Home 与归档运行 `GLM Flash 自动 summary → 官方 GPT → 官方原生压缩`，无 `provider_error`、无隐藏重试。

### R-07 搜索与协议画像

六个画像用例通过；搜索桥接三个用例（GLM Flash App 订阅桥、FEEI Sol CLI 订阅桥、FEEI Sol App Tavily MCP）与官方搜索两个用例通过。

### R-08 Release 汇总

`npm run e2e:release -- --run` 的 `summary.json` 为 `PASS`：所有阶段绑定同一 commit 与同一 core，预算内，`implicitRetries=0`，且收据无密钥和绝对私有路径泄露。

### R-09 缺陷修复纪律

真实 E2E 失败先冻结证据并归类为 Gateway 缺陷、外部渠道问题或未归因。只修 Gateway 缺陷，修复落在共享边界并附一条能稳定复现的确定性测试；不按模型写特例、不放宽断言、不加回退或重试。修复后在新 commit 上重跑受影响阶段，最终以 R-08 全量收据为准。

### R-12 E2E 客户端身份与真实客户端一致

真实渠道 E2E 驱动的 Codex core 必须以 Codex CLI 自身身份（app-server 为 `codex_cli_rs`，`codex exec` 为 `codex_exec`）发出请求。用例标签和调用方 Agent 的宿主环境（`TERM_PROGRAM`、`PI_*`、`CODEX_INTERNAL_ORIGINATOR_OVERRIDE` 等）不得进入 `originator` 或 User-Agent。Gateway 继续只转发客户端真实身份，不改写、不伪造。

### R-13 GitHub Release

R-10 之后，按既有发布流程（`origin/main` 上用 master 树生成 release 提交 → PR → tag → GitHub Release，附 `npm pack` 包与 SHA-256）发布 `v0.5.23`。确定性门禁在 release 提交上重跑；live 门禁以 R-08 在 `c6a5896` 上的收据为准，release 提交相对它只改版本号、CHANGELOG 和文档。

### R-10 合并到本地 master

R-08 通过后，将候选快进合并到本地 `master`（不 rebase、不改远端），合并后 `npm test` 仍全通过。

### R-11 手动生效脚本

交付 `manual-activate-cross-channel-compaction.sh`（`set -euo pipefail`、`printf`、非保留变量名，不安装 coordinator，不排队自动切换）。前置守卫：App 已退出、`activeTurns=0`、无 pending transaction、无配置漂移、`master` HEAD 等于准出 commit；任一不满足则不写任何状态并退出。通过后执行 `gateway upgrade --server <master worktree>/src/server.mjs --wait-seconds 300`，再验证 PID 更新、`accepting=true`、源码路径、配置与 catalog current、活动空间不变。能力探测均为 `provider-unsupported` 时不创建新配置空间，保持 `glm-validation@15`。

## 验收

| 要求 | 验证方式与目标环境/材料 | 预期证据与通过条件 |
| --- | --- | --- |
| R-01 | Keychain 读回长度/尾号；对证据目录和仓库做密钥扫描 | 新条目可用、备份存在；扫描零命中 |
| R-02 | `release-qualification` 的 deterministic 阶段加 public/npm audit 日志 | `deterministic.json` PASS，审计日志通过 |
| R-03 | `compressionCapability.json` | 两个目标均有确定结论，零隐式重试 |
| R-04 | `nativeCompaction.json` | 四用例 `passed=true` |
| R-05 | `historyMigration.json` | 三用例通过，九格 `equivalenceCoverage` 全为 true，legacy 恢复通过 |
| R-06 | `appSmoke.json` | PASS |
| R-07 | `profiles.json`、`universalSearch.json`、`officialSearch.json` | 全部 PASS |
| R-08 | `summary.json` 与 `SHA256SUMS` | `verdict=PASS`，commit/core 一致 |
| R-09 | 每个修复的 patch 记录、确定性测试与重跑收据 | 首次失败收据保留；修复后受影响阶段 PASS |
| R-12 | 本地抓包对照 app-server 发出的 `originator`；Release 收据中无 FEEI 403 | `originator` 为 `codex_cli_rs`/`codex_exec`，User-Agent 不含宿主 Agent 标识；FEEI 阶段无 `official clients` 403 |
| R-10 | `git merge --ff-only` 与合并后 `npm test` | master HEAD 等于准出 commit，测试全通过 |
| R-11 | App 运行时执行脚本验证守卫拒绝；静态检查 `bash -n` | 守卫拒绝且未写状态；实际切换由用户执行后回读核对 |
| R-13 | release 提交上的 `npm test`、审计；Release 资产 SHA-256 校验并从包安装 | Release 可见，资产校验通过，安装后 CLI 版本为 0.5.23 |

证据目录：`~/.codex/acceptance/e2e-cross-channel-compaction-<commit>/`，独占创建，不覆盖旧证据。

## 关键决策与待确认项

- 已定：沿用既定范围与预算（Release 总预算 115 turns / 165 generations / 9 searches），不扩范围。
- 已定：真实失败不自动补跑；有新的具体假设时最多一次人工重跑，首次失败收据保留。
- 已定：图像回答格式按单次运行断言准出；若失败，先归因（模型输出波动还是 Gateway 丢失图片），模型波动不以放宽断言规避，记录后按上一条重跑。稳定性统计准出不在本次范围。
- 已定：服务切换与 App UI 签核由用户执行，Agent 交付脚本并在其后回读验证。

## 执行交接与变更

- 计划与依赖：以原计划（会话 `01a0c6a4`）为执行顺序；FEEI 依赖新密钥额度。
- 修订：Revision 1 相对原计划的变化——core 升至 `alpha.16.4`，所有收据须在其上重新取得；FEEI 更换密钥；新增 R-01。
- 修订：Revision 2——`ab7af66` 的 Release 门禁在 FEEI 种子轮因 403 失败，归因为 E2E harness 以用例标签作为客户端身份（测试保真度缺陷，非 Gateway 缺陷，也非 FEEI 随机故障）。新增 R-12，harness 统一使用 `codex_cli_rs`；R-04、R-05、R-07、R-08 须在修复后的 commit 上重新取证。同一 commit 上非 FEEI 阶段（O/R 四格矩阵、GLM 搜索桥、官方搜索）已在 `alpha.16.4` 上 PASS，仅作参考，最终以新 commit 的完整收据为准。另记观察：403 后 app-server 重发了一次同指纹请求，被 harness 预算守卫拦截。
- 修订：Revision 3——`23d8ddc` 的 Release 门禁在独立 App-server 冒烟失败：四个回答都没复述工具结果。当时该用例的工具结果是一条很长的临时目录绝对路径（早期 `pwd` 方案的遗留，现在的工具调用和结果对已改为从 fixture 注入），失败收据没有载荷级证据，无法归因（UNVERIFIED），不视为 Gateway 缺陷。处理：工具结果改为合成标记 `<NAME>_TOOL_RESULT`，仍要求逐字复述，不放宽断言；并在收据中新增各请求载荷的标记命中。修复前的诊断重跑已 PASS，四个回答均含工具结果。R-05、R-06、R-08 须在新 commit 上重新取证。
- 修订：Revision 4——用户确认准出结果，要求沉淀用例并发布 GitHub Release；新增 R-13，发布从排除项移入范围（npm registry 仍排除）。

## 准出收据

准出 commit `c6a589682333fa91409eb3b3ec0d8789ec1cfbd6`（tree `bb8dbf28`），Codex core `codex-cli 0.155.0-alpha.16.4`（SHA-256 `93169e74…189a5`）。`summary.json` `verdict=PASS`，SHA-256 `3b47adb5eff5a623687e7663ff316e28c8806da8ec04250a8eef39940f0853d2`。用量 91 回合 / 112 次生成 / 5 次搜索（上限 115 / 165 / 9），隐式重试 0、被拦截发送 0。

| 阶段 | 要求 | 结果 |
| --- | --- | --- |
| deterministic | R-02 | PASS：489/489 测试、包审计；另附公开树审计、生产依赖 0 漏洞 |
| profiles | R-07 | PASS：六个画像与协议用例 |
| compressionCapability | R-03 | PASS：DeepSeek、GLM Main 均为 `provider-unsupported`，本地拒绝后续接与重启通过 |
| nativeCompaction | R-04 | PASS：FEEI Sol/Astra × Standard/源 Lite 四用例，`summary_started=0` |
| universalSearch | R-07 | PASS：GLM Flash App 订阅桥、FEEI Sol CLI 订阅桥、FEEI Sol App Tavily MCP |
| officialSearch | R-07 | PASS：缓存默认搜索、显式实时搜索 |
| historyMigration | R-05 | PASS：三条链，九格 `equivalenceCoverage` 全为 true，legacy checkpoint 恢复通过 |
| appSmoke | R-06 | PASS：独立 Home，GLM Flash 自动 summary → 官方 → 官方原生压缩 |

R-01、R-12：收据与仓库扫描无 FEEI 密钥、无 `official clients` 403、无用户主目录绝对路径。R-10：本地 `master` 快进到 `c6a5896`。R-11：脚本守卫与 dry run 通过，服务切换与 App UI 签核待用户执行。

失败收据（均保留，按 R-09 归因）：

| commit | 失败点 | 归因 | 处理 |
| --- | --- | --- | --- |
| `73bd261` | deterministic：Spec 行尾空格使 `git show --check` 失败 | 文档格式 | `ab7af66` 修正 |
| `ab7af66` | FEEI 种子轮 403 | harness 以用例标签作客户端身份（测试保真度缺陷） | `23d8ddc`：统一 `codex_cli_rs`，剥离宿主环境；新增确定性测试 |
| `23d8ddc` | appSmoke：四个回答都未复述工具结果（临时目录长路径） | UNVERIFIED（无载荷级证据） | `e30ddfb` 加载荷标记诊断，诊断重跑 PASS；`c6a5896` 改合成标记，仍逐字断言 |

证据在本机 `~/.codex/acceptance/e2e-cross-channel-compaction-<commit>/`，含 `SHA256SUMS`，不进仓库。复现（需订阅登录、Keychain 中的 Provider 凭证与 `TAVILY_API_KEY`，Codex core 变化后须重新取证）：

```bash
ACCEPTANCE_COMMIT=$(git rev-parse HEAD) npm run e2e:release -- --run --out <新的空目录>/release
```

单独复跑矩阵或冒烟：`npm run e2e:history-migration -- --run`、`npm run e2e:native-compaction -- --run`、`npm run e2e:compression-capability -- --run`。

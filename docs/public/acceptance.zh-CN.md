# 发布准出契约

本文定义长期稳定的公开准出规则。特定版本的客户端、模型矩阵、预算、哈希和结果应放在 GitHub Release Notes 或[冻结证据](evidence/README.zh-CN.md)中。

## 证据分层

| 层级 | 适用范围 | 证明内容 |
|---|---|---|
| 确定性门禁 | 每个 PR 和 Release | 在不调用外部模型的前提下通过测试、审计、导出、打包和干净安装 |
| 真实协议验收 | 运行时有变化的 Release | 在声明预算内验证选定真实渠道的路由、工具、搜索、续接和生命周期 |
| 本机环境验收 | 需要本机生效的 Release | 精确安装包和配置能够无漂移启用，凭证不串线 |
| App UI 签核 | 用户单独确认 | 模型可见且真实 App 操作正常；app-server 证据不能替代 UI |

只有发布分类器证明完整差异不含运行时、依赖、协议、配置或 Harness 变化时，文档型 Release 才能跳过真实协议验收。确定性门禁仍必须执行，Release Notes 必须披露跳过原因，并注明最近具备 live 证据的运行时版本。

## 确定性门禁

默认门禁必须：

- 在隔离的临时 Home 和随机端口中运行完整测试；
- 审计生产依赖和安装包清单；
- 导出干净公开树，并逐文件扫描导出内容和安装包；
- 在公开树中重新完成安装、测试、审计、打包和两个 CLI 别名验证；
- 不调用真实模型，不读取用户 Keychain、Codex 历史、配置或运行中服务。

标准命令：

```bash
npm test
npm audit --omit=dev --registry=https://registry.npmjs.org
npm run audit:package
node scripts/audit-public.mjs
git diff --check
```

## 运行时变更准出

真实验收使用当前支持的 Codex 客户端和有界、预先声明的矩阵，只覆盖本次变化和发布关键边界，不做所有模型与选项的全排列。通过证据必须证明：

- 模型请求只到目标 Provider；
- 订阅凭证与 Provider 凭证不串线；
- 工具或搜索成功完成，结果进入后续生成；
- 涉及的流式、取消、错误、重试、历史、fork 和压缩行为符合契约；
- 不靠隐藏重试、回退或额外网络请求凑通过；
- 失败能区分 Gateway 缺陷、外部渠道问题和责任未明。

缺少执行证据不能记为通过；能力声明、配置中的压缩模式和 catalog 可见性都不能证明真实支持。`npm run e2e:compression-capability -- --run` 会先对 DeepSeek 和 GLM Main 的 Provider 标准 `/responses/compact` 端点各做一次探测，再通过隔离 Gateway 验证结果。端点成功时必须返回 compaction item，随后临时把 target 设为 `native`，并通过 Provider 可见的 trigger、续接、Gateway 重启恢复和凭证隔离，才能记为 `supported`。Provider 明确返回 400、404、405、422 或 501 时记为 `provider-unsupported`；此时保持 target 原配置，要求 Gateway 本地拒绝压缩、不请求 Provider，并且普通续聊和重启恢复成功。任何 502、超时、重试、鉴权失败、成功但缺少 compaction item 的响应或无法归因的 Provider 错误一律记为 inconclusive。探测不会修改活动配置。

默认运行时 Release 门禁先冻结这份能力收据，再执行一条有界的纯 HTTP 官方压缩观测并验证 checkpoint 已落盘。当前 Codex 通过隔离自定义 Provider 的 `supports_websockets = false` 选择该传输，不依赖已移除的旧 feature flag。随后三条 WebSocket 生命周期链覆盖 `官方 → 第三方 GPT → 官方`、`官方 → GLM Flash → 官方` 和 `FEEI Sol → FEEI Astra → GLM Flash → DeepSeek → FEEI Sol`。每个具备能力的 target 都必须在离开前真实压缩；GLM 使用 Gateway-owned summary，第一条 GLM 链还要让本地图片穿过自动 summary 和重启；DeepSeek 严格使用冻结探测结果。第三方 GPT 官方往返链仍从合成旧版 metadata-only checkpoint 重启。通过要求九个来源／目标等价单元全部有路径，事实和已完成工具结果均保留，每条链工具只执行一次，摘要可复用，重启后可继续，不支持时明确本地拒绝，无隐藏重试、凭证串线、跨 target opaque 状态泄漏或 Gateway 虚拟 checkpoint 回传 OpenAI。

独立 App-server 冒烟会在新的 Home 和归档中单独重跑 `GLM Flash 自动 summary → 官方 GPT → 官方原生压缩`，生成单独收据；不得出现 `provider_error` 或隐藏重试。真实 App UI 签核仍单独进行。

涉及渠道自有压缩的变更还需运行 `npm run e2e:native-compaction -- --run`。隔离门禁分别在强制 Standard 和源配置当前 Lite profile 下验证 FEEI Sol 与 Astra：两次手动原生压缩、一次由 Codex 阈值触发的自动原生压缩、一次只读工具闭环、继续生成、Gateway/app-server 重启和同一 checkpoint 复用。Harness 统计每次出站生成，允许显式设置任意正整数上限，不再保留旧的 24 次 harness 硬上限。通过要求每个 target 都没有 `summary_started`、预期压缩均到达 Provider、自动压缩后事实仍可使用、重启前后 opaque checkpoint 指纹稳定、凭证隔离、上游终态完整且 Gateway 无错误。渠道不支持或源配置缺少 Lite profile 时按能力验收失败报告，门禁不会开启 Gateway 摘要回退。这四个用例的收据已纳入默认 Release 准出，且必须与其他阶段绑定同一 commit 和同一 Codex core。

原生压缩失败或能力尚未验证时，禁止回退到 Gateway summary、其他模型或其他渠道。所有门禁都不允许隐式重试、递归摘要或自动修改配置。

针对已报障历史的修复候选，还可使用 `npm run e2e:native-continuation-faults -- --run` 并显式指定线程与 rollout 路径。门禁会把 rollout 复制到隔离 Codex Home，先在空归档上复现缺少可信 checkpoint，再应用显式 rollout 恢复；对已有迁移视图的续接，则在一次一致性只读事务中仅复制指定线程 scope 到新的加密 SQLite 归档。可选的 `--thread-first-migration` 与 `--source-first-migration` 会增加首次迁移用例：先证明目标迁移尚不存在，再于目标预算检查前规范化渠道私有 reasoning，随后只生成一次已授权的来源摘要、持久化该迁移并仅调用目标一次。验收只发送只读、禁用工具的提示，仅保存哈希、数量和终态元数据；源 rollout、归档、App 配置和运行服务都不会被写入。

## 安全与证据处理

真实验收使用隔离 Home、状态、凭证、端口以及合成或公开内容。公开证据可以保留版本、哈希、数量、耗时、脱敏目的地和结果分类，但不得包含凭证、私聊正文、原始历史数据库、本地配置、请求或响应正文、搜索词或结果、runner 主机配置和回滚包。

App UI、本机生效、合并、发布和 npm 发布是彼此独立的决策，必须分别报告。

[English](acceptance.md)

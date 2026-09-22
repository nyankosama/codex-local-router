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

缺少执行证据不能记为通过；能力声明和 catalog 可见性也不能证明真实支持。

默认运行时 Release 门禁先执行一条有界的纯 HTTP 官方压缩观测，并验证 checkpoint 已落盘。当前 Codex 通过隔离自定义 Provider 的 `supports_websockets = false` 选择该传输，不再依赖已移除的旧 feature flag。随后两条 WebSocket 历史生命周期链覆盖：官方模型 → 两次原生压缩 → fork → GLM Flash 或第三方 GPT → 一次只读工具调用／结果／续接 → 同 Provider 摘要复用 → Gateway 与 app-server 重启 → 回切官方续接；其中第三方 GPT 链在首次跨 Provider 请求前从合成的旧版 metadata-only checkpoint 重启。这样既真实验证 HTTP 观测，也不会假定自定义 Provider 会携带内置 OpenAI Provider 才有的动态 thread/fork 元数据。Harness 统计每次出站生成，允许显式设置任意正整数上限，不再保留旧的 18 次 harness 硬上限；失败样本不补跑。通过必须证明 HTTP 官方压缩观测完成且 checkpoint 已落盘、路由前恢复成功，合成事实、最新要求和工具结果仍可使用，工具只执行一次，每次迁移准备恰好生成一次原模型摘要且复用时不再生成，Gateway 与重连无错误，凭证不串线，官方 opaque 状态不发第三方，Gateway 虚拟 checkpoint 不发回 OpenAI。

涉及渠道自有压缩的变更还需运行 `npm run e2e:native-compaction -- --run`。隔离门禁分别在强制 Standard 和源配置当前 Lite profile 下验证 FEEI Sol 与 Astra：两次手动原生压缩、一次由 Codex 阈值触发的自动原生压缩、一次只读工具闭环、继续生成、Gateway/app-server 重启和同一 checkpoint 复用。Harness 统计每次出站生成，允许显式设置任意正整数上限，不再保留旧的 24 次 harness 硬上限。通过要求每个 target 都没有 `summary_started`、预期压缩均到达 Provider、自动压缩后事实仍可使用、重启前后 opaque checkpoint 指纹稳定、凭证隔离、上游终态完整且 Gateway 无错误。渠道不支持或源配置缺少 Lite profile 时按能力验收失败报告，门禁不会开启 Gateway 摘要回退。

针对已报障历史的修复候选，还可使用 `npm run e2e:native-continuation-faults -- --run` 并显式指定线程与 rollout 路径。门禁会把 rollout 复制到隔离 Codex Home，先在空归档上复现缺少可信 checkpoint，再应用显式 rollout 恢复；对已有迁移视图的续接，则在一次一致性只读事务中仅复制指定线程 scope 到新的加密 SQLite 归档。可选的 `--thread-first-migration` 与 `--source-first-migration` 会增加首次迁移用例：先证明目标迁移尚不存在，再于目标预算检查前规范化渠道私有 reasoning，随后只生成一次已授权的来源摘要、持久化该迁移并仅调用目标一次。验收只发送只读、禁用工具的提示，仅保存哈希、数量和终态元数据；源 rollout、归档、App 配置和运行服务都不会被写入。

## 安全与证据处理

真实验收使用隔离 Home、状态、凭证、端口以及合成或公开内容。公开证据可以保留版本、哈希、数量、耗时、脱敏目的地和结果分类，但不得包含凭证、私聊正文、原始历史数据库、本地配置、请求或响应正文、搜索词或结果、runner 主机配置和回滚包。

App UI、本机生效、合并、发布和 npm 发布是彼此独立的决策，必须分别报告。

[English](acceptance.md)

# 验收说明

本次配置空间候选记录见[配置空间候选验收报告](configuration-spaces-acceptance.zh-CN.md)。

PR 门禁使用 A1-A10 十组等价类：策略解析、来源/名单、工具载体、调用闭环、HTTP 透明性、WS 生命周期、身份边界、历史兼容、产品/隔离、证据/预算。它们由纯函数和本地模拟上游完成，不调用真实模型。

配置空间补充 fresh/legacy/applied/disabled/pending/歧义迁移、不可变 revision、official 自动追加、克隆/diff/默认模型/drift capture、official↔Router/Router↔Router/历史版本/rollback、一次性协调器、活跃轮次、凭证/候选/服务/哈希失败与分阶段恢复，以及非受管 Codex 数据保留。测试统一使用临时 Codex/Router Home、配置/状态/LaunchAgent、随机端口、模拟 launchctl 和本地上游。

本轮配置空间候选明确不运行 `e2e:focused -- --run`，真实模型调用为零。门禁前后需确认本机 Router/切换器未加载、8788 未监听、integration 为 disabled、真实 Codex 仍是内置 `openai`。App-server 不能替代后续 UI 签核。

```bash
npm test
npm run audit:package
npm run e2e:l0
```

官方搜索另有一个窄范围真实 canary：

```bash
npm run e2e:official-search -- --run
```

它先通过 Router 的生产级官方 WebSocket 客户端执行一次零生成握手探针并要求 HTTP 101，然后只运行两个隔离的官方订阅短 turn：第一轮不设置 `web_search`、不要求用户增加参数，验证 Codex 正常的 cached 默认模式；第二轮使用单次 `--search` 覆盖，验证 live 模式。两轮都必须看到当前 Codex 版本所选择的官方 Responses 传输成功、固定 OpenAI 目的地的 `/alpha/search` 成功、客户端 `web_search` 完成事件、回答中的来源 hostname，以及不存在第三方出站。预算固定为两个 turn、最多六次生成（一次搜索 turn 可能包含多次模型与工具续接），不保存提示或回答正文。

最终候选另有显式真实验收：

```bash
FEEI_API_KEY=... npm run e2e:focused -- --run
```

它只允许五个短 turn、最多十次可观测模型生成，不做自动重试：官方 CLI 回答与独立搜索；ai.feei Sol/Astra CLI 回答与合成图片；两款模型各一个 App 协议 turn，覆盖允许 Plugin、用户测试 MCP 和独立搜索。超过预算或搜索去向不是 OpenAI 会立即失败。

每个 App 用例必须同时看到：裁剪前存在禁止 Plugin、裁剪后消失；GitHub 与用户 MCP 定义仍在；用户 MCP 返回的随机合成 marker 出现在最终回答；至少两个工具调用完成；独立搜索成功且只到 OpenAI。缺少证据就是 FAIL。

所有过程使用隔离的 `CODEX_HOME`、Router 状态、实例、临时工作区、随机端口和临时加密历史。证据只保存模型/工具类型、来源标识、哈希、状态、数量、字节和耗时，不保存提示、回答、工具 schema、凭证、图片或本地绝对路径。

自动 app-server 验收不能替代 UI。最终报告必须把“实现完成”“自动验收通过”“本机已生效”“App UI 已确认”分开列出。

英文完整说明见 [acceptance.md](acceptance.md)。

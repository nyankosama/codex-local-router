# 兼容性

| 组件 | 当前状态 |
|---|---|
| macOS / Node.js 22 | 支持；Node 仍把内置 SQLite 标记为 experimental |
| Codex CLI 0.154.0-alpha.6.2 | 本次候选驱动基线，验收记录二进制 SHA-256 |
| Codex App | app-server 协议可自动验收，真实 UI 必须单独确认 |
| 官方订阅 HTTP/WS/辅助接口 | 固定目的地透明 Relay |
| ai.feei Sol / Astra Responses | 有内置预设；是否通过真实渠道以当次候选报告为准 |
| Linux / Windows | v0.4.0 不声明支持 |
| 运行时配置 Schema 3 | 保持兼容，活动 Router 空间物化为原格式 |
| 配置空间 Schema 1 | 本机不可变 revision 与单一切换事务 |
| 集成状态 Schema 4 | 关联受保护 official 与当前物化 Router revision |

第三方 Responses 无法假设官方服务端工具缓存，因此 Codex 可能携带完整工具面。第三方 GPT 默认策略只裁剪已确认且不在白名单的 Plugin。允许 Plugin、核心工具和用户 MCP 仍会占用上下文；不承诺固定 token 降幅。

Responses Lite 不是筛选开关，但当前 Codex 的独立搜索依赖 `input[].additional_tools` 中的 `web.run` 载体；Lite 与非 Lite 工具载体仍由同一 Plugin 策略覆盖。Chat Completions 不能表达 namespace，仍会在策略之后省略该类工具并记录诊断。

独立搜索要求 Codex 运行时、模型 catalog 与用户设置同时允许。启用独立来源的 App target 默认使用 Responses Lite；对未声明原生 hosted search 的 target，如果仍出现顶层 hosted-search 载体则明确失败，避免搜索在错误渠道执行。ai.feei 预设通过 `openai-gpt` 默认策略使用订阅搜索，不声明 Provider 内嵌 hosted search。官方模型强制使用订阅；第三方 GPT 可逐 target 显式改为 Provider 或禁用；非 GPT/旧 target 保持旧行为。Provider endpoint 不根据模型名或 `/models` 推断，选定来源失败也不会切换到其他来源。

每个模型 turn 会冻结一份按 turn/thread/session/account 关联的搜索路由。`/subscription/v1/alpha/search` 先验证订阅身份，再选择固定 OpenAI 后端，或剥离订阅身份并换成目标 Provider Key。关联缺失或冲突会明确失败。第一版即使选择 Provider 搜索也仍要求有效 Codex 登录；本地 `/v1/alpha/search` 始终不开放。

官方 HTTP 和 WSS Relay 使用同一机器代理边界：优先识别 `WS_PROXY` / `WSS_PROXY`，兼容回退到 `HTTP_PROXY` / `HTTPS_PROXY`，再使用通用 `ALL_PROXY`，并始终遵守 `NO_PROXY`。代理凭证由代理 agent 处理，不进入官方端到端 Header 或 Router 日志。

英文完整矩阵见 [compatibility.md](compatibility.md)。

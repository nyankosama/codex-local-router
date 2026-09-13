# 兼容性

| 组件 | 当前状态 |
|---|---|
| macOS / Node.js 22 | 支持；Node 仍把内置 SQLite 标记为 experimental |
| Codex CLI 0.154.0-alpha.6.2 | 本次候选驱动基线，验收记录二进制 SHA-256 |
| Codex App | app-server 协议可自动验收，真实 UI 必须单独确认 |
| 官方订阅 HTTP/WS/辅助接口 | 固定目的地透明 Relay |
| ai.feei Sol / Astra Responses | 有内置预设；是否通过真实渠道以当次候选报告为准 |
| Linux / Windows | v0.3.0 不声明支持 |
| 运行时配置 Schema 3 | 保持兼容，活动 Router 空间物化为原格式 |
| 配置空间 Schema 1 | 本机不可变 revision 与单一切换事务 |
| 集成状态 Schema 4 | 关联受保护 official 与当前物化 Router revision |

第三方 Responses 无法假设官方服务端工具缓存，因此 Codex 可能携带完整工具面。第三方 GPT 默认策略只裁剪已确认且不在白名单的 Plugin。允许 Plugin、核心工具和用户 MCP 仍会占用上下文；不承诺固定 token 降幅。

`useResponsesLite` 不是筛选开关：工具定义可能出现在顶层，也可能进入 `input[].additional_tools.tools`，Router 同时覆盖两种载体。Chat Completions 不能表达 namespace，仍会在策略之后省略该类工具并记录诊断。

独立搜索要求 Codex 运行时、模型 catalog 与用户设置同时允许。ai.feei 预设仅声明独立搜索，不声明 Provider 内嵌 hosted search。订阅命名空间中的搜索请求只转发 OpenAI；本地 `/v1` 不获得该能力。

英文完整矩阵见 [compatibility.md](compatibility.md)。

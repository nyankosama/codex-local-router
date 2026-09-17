# 兼容性

| 组件 | 当前状态 |
|---|---|
| macOS / Node.js 22 | 支持；Node 仍把内置 SQLite 标记为 experimental |
| Codex CLI 0.154.0-alpha.6.2 | 本次候选驱动基线，验收记录二进制 SHA-256 |
| Codex App | app-server 协议可自动验收，真实 UI 必须单独确认 |
| 官方订阅 HTTP/WS/辅助接口 | 固定目的地透明 Relay |
| OpenCode Go DeepSeek | 既有 legacy 接入保留；通用模板、Code mode 与多代理 v2 尚未准出 |
| ai.feei Sol / Astra Responses | 有内置预设；是否通过真实渠道以当次候选报告为准 |
| Linux / Windows | v0.5.2 不声明支持 |
| 运行时配置 Schema 3 | 保持兼容，活动 Router 空间物化为原格式 |
| 配置空间 Schema 1 | 本机不可变 revision 与单一切换事务 |
| 集成状态 Schema 4 | 关联受保护 official 与当前物化 Router revision |

Gateway 能力与真实渠道健康度分别准出。本地确定性夹具可以验证路由、身份、协议、生命周期、工具、历史和性能不变量，即使某个真实 Provider 当时不可用；真实渠道则单独记录为 `HEALTHY`、`EXTERNAL_DEGRADED`、`GATEWAY_DEFECT` 或 `UNVERIFIED`。只有 `HEALTHY` 会进入 ready set，而可归因于 Gateway 的缺陷仍然阻断 Core。

第三方 Responses 无法假设官方服务端工具缓存，因此 Codex 可能携带完整工具面。通用模板的标准策略只裁剪已确认且不在白名单的结构化 Plugin；允许 Plugin、核心工具、用户 MCP 及嵌入 `exec` 的不透明定义仍会占用上下文，不承诺固定 token 降幅。

新建且能力满足、preset 已通过 Provider 准出的第三方 App target 默认使用通用模板；`lite-search`、官方 GPT 指令快照和缓存亲和均需显式选择。Chat Completions 或缺少 freeform 工具能力的 target 必须使用 `legacy`。OpenCode Go DeepSeek preset 会为自身选择 `legacy`，并拒绝直接开启尚未准出的 Code mode 或多代理 v2。

已有任务从其他 Provider 切到 `lite-search` 时，Router 会删除历史 Lite 声明，只恢复当前请求携带的 `additional_tools`。因此核心工具和通过既有 Plugin 策略的客户端工具在切换后仍可调用；这不会把缩减的 Lite 画像升级为完整 `standard-tools` 工具面。

独立搜索要求 Codex 运行时、模型 catalog 与用户设置同时允许。`standard-tools` 不广告独立搜索；显式 `lite-search` 使用 Responses Lite 和选定来源。对未声明原生 hosted search 的 target，如果仍出现顶层 hosted-search 载体则明确失败，避免搜索在错误渠道执行。CLI 新建 ai.feei target 默认 `standard-tools`，需要时可显式选择订阅或 Provider 搜索；官方模型始终强制使用订阅。没有 `app` 声明的旧 GPT target 保持既有默认；显式 App-disabled GPT target 不继承空间默认或旧 native-search 广告，但显式 target 策略与旧 App 搜索别名仍按更高优先级解析，Provider 搜索依然要求 App-enabled Responses target。非 GPT 与其他旧 target 保持旧行为。Provider endpoint 不根据模型名或 `/models` 推断，选定来源失败也不会切换到其他来源。

每个模型 turn 会冻结一份按 turn/thread/session/account 关联的搜索路由。`/subscription/v1/alpha/search` 先验证订阅身份，再选择固定 OpenAI 后端，或剥离订阅身份并换成目标 Provider Key。关联缺失或冲突会明确失败。第一版即使选择 Provider 搜索也仍要求有效 Codex 登录；本地 `/v1/alpha/search` 始终不开放。

官方 HTTP 和 WSS Relay 使用同一机器代理边界：优先识别 `WS_PROXY` / `WSS_PROXY`，兼容回退到 `HTTP_PROXY` / `HTTPS_PROXY`，再使用通用 `ALL_PROXY`，并始终遵守 `NO_PROXY`。如果安装进程显式使用 `NODE_EXTRA_CA_CERTS`，受管服务和一次性切换器会把该 CA 文件路径与代理变量一起保留；Provider 凭证变量和任意 `NODE_OPTIONS` 不会被复制。运行时支持时，官方 WSS 会合并 Node 默认与系统 CA，同时保持证书和主机名校验，只记录白名单内的 TLS 错误码。代理凭证由代理 agent 处理，不进入官方端到端 Header 或 Router 日志。

官方 HTTP/WS 续接会区分 response 来源。透明官方 Relay 观察到的 response 可以继续原生、保持字节透明；Engine 或本地协议步骤生成的 response 则从加密历史回放，不会把本地 ID 作为上游 `previous_response_id` 发送。缺少来源标记的旧记录也选择安全回放。这样，工具结果续接不会因为前一条 response 实际由 Gateway 生成而被新的官方透明连接拒绝。

完整的动态工具搜索历史可以在官方与第三方 Responses 之间迁移，也可通过固定、无 schema 的历史标记进入 Chat Completions。目标渠道不会收到原搜索参数、Provider 执行元数据、item ID、工具名、描述或 schema；普通函数/custom-tool 调用和结果继续保留。pair 缺失或歧义时返回 `tool_search_history_incomplete`，不回退、不重试。该能力不能恢复 Router 从未观察到完整原文的旧官方 opaque compaction；这类会话仍需要既有可移植 checkpoint。

英文完整矩阵见 [compatibility.md](compatibility.md)。

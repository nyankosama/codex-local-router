# 架构说明

```text
不可变空间 revision
  -> 校验凭证与随机端口候选
  -> 哈希绑定 pending 事务
  -> App 正常退出 + Gateway 活跃轮次归零
  -> 原子物化 Router/Codex/服务
  -> 验证后最后提交 active/previous 指针
```

配置空间是下面请求数据面的控制面。并发文件修改会失败关闭；回滚仅在文件仍匹配本事务写入哈希时执行。切换不强退、不重开 App，机器级访问、历史、监听与资源限制不随空间交换。

```text
Codex HTTP / WebSocket
  -> 本地认证或订阅身份校验
  -> /subscription/v1 分类
       |-- 显式自定义模型、虚拟历史恢复 -> Engine
       `-- 其他请求 -------------------> 官方 Relay
  -> Engine：target 策略、协议适配、统一事件、加密历史
  -> Relay：固定官方目的地、实体/消息透明传输、旁路历史观察
```

自定义模型映射优先。其余订阅模型交给官方判断，Router 不再维护完整官方模型名单。除必要的 Engine 请求外，`/subscription/v1/**` 固定转发到 `https://chatgpt.com/backend-api/codex/`，配置和请求不能覆盖目的地。

Relay 保留 query、HTTP 方法、响应状态、实体字节、压缩、错误正文，以及 WebSocket 消息的载荷、类型和顺序；移除逐跳 Header、动态 `Connection` 项和代理凭证；拒绝绝对 URL、路径穿越、`CONNECT` 与 `TRACE`；不跟随重定向、不自动重试。HTTP 分帧、WS 掩码和握手属于逐跳行为，不承诺网络帧逐字节一致。

`access_programs` 等官方请求字段在此路径保持字节透明。若当前登录组织没有对应能力，Router 原样转发官方错误，不删除字段，也不以其他能力重试。

官方 Responses 通过有界旁路观察写入既有加密历史。观察失败不影响普通官方响应；后续跨 Provider 需要该历史却无法确认完整时，明确返回 `history_observation_incomplete`。每条保留的 response 还记录内部续接来源：只有成功旁路观察到的官方透明 Relay response，后续官方请求才继续携带原生 `previous_response_id`；Engine 生成、本地预热、虚拟压缩及没有来源标记的旧记录都会重新进入 Engine，展开加密历史并在唯一一次上游发送前移除本地 response ID，后续 response 继续留在同一回放链。完全未知的官方 ID 在没有跨 Provider 历史要求时仍保持既有透明行为。Router 虚拟 response ID/checkpoint 因此不会发给官方。

动态工具发现属于 Provider 控制历史，不是可直接跨渠道重放的工具结果。跨 Provider 或协议前，每个 `tool_search_call` 必须在后面存在唯一、同 `call_id` 的 `tool_search_output`。合法 pair 会转换成一条固定 assistant 标记；查询参数、执行状态、Provider item ID 和返回的工具 schema 全部省略，后续函数/custom-tool 调用与结果保持原顺序。缺失、重复、反序或畸形 pair 会在发送上游前返回 `tool_search_history_incomplete`。不可变原始流保留精确 pair，目标视图只保存标记，因此反复切换不会改写归档或叠加标记。

工具策略在 target 确定后、每次上游发送前运行。回退时从未裁剪副本重新生成目标视图，同一 turn 使用固定配置/来源快照。来源识别只读取受信内置映射、已启用 Plugin manifest 与 Codex MCP 配置，不启动 Plugin，也不依据通用 `mcp__*` 前缀猜测。

官方订阅不裁剪。第三方 GPT 默认只保留标准 Plugin 白名单，同时保留核心和用户 MCP。未知/冲突来源放行。筛选覆盖普通函数、namespace 和 `input[].additional_tools.tools`；被禁止的显式 `tool_choice` 返回 `tool_policy_conflict`，禁止的直接调用在交给客户端前返回 `disallowed_plugin_tool_call`。

显式 `subscriptionSearch.delivery: "standard-tool"` 使用独立的标准 Responses 路径。只有当前客户端请求启用搜索时，Engine 才注入一个内部函数；模型调用后，Gateway 使用本轮已认证的订阅身份访问固定 `/alpha/search`，把有界结果作为不可信工具数据送回既有循环，并对客户端隐藏内部调用。用户 MCP 仍由客户端负责；当前 Codex 可能通过 `tool_search` 延迟提供 schema，Router 只保留这一链路，不读取或启动用户 MCP。

第三方 `openai-gpt` Responses target 会为 Codex 感知型中转保留不含身份的客户端协商 Header（`User-Agent`、`originator`、beta feature 和 Responses-Lite 声明）；订阅 Authorization、账号、Cookie、request/session/thread/turn/window/install 标识、turn metadata 及正文 client metadata 仍全部剥离。新建 App target 默认 `standard-tools`，使用标准 Responses、保留策略允许的工具面且不广告独立搜索；显式 `lite-search` 使用 Responses Lite 和选定来源，并披露缩减后的工具面。模型 target 确定后，Engine 会按账号哈希及 turn、thread、session 关联冻结独立搜索租约。官方模型强制选择订阅搜索。对未声明原生 hosted search 的 Lite target，若收到顶层 hosted-search 载体则返回 `standalone_search_protocol_mismatch`，不会静默交给模型 Provider 执行。`/subscription/v1/alpha/search` 先验证订阅身份，再解析租约：订阅走固定官方 Relay；Provider 模式剥离全部 ChatGPT/Codex 身份 Header，只注入对应 Provider Key，并保留方法、query、实体字节、状态、压缩、SSE 与错误正文。来源不自动重试或切换；关联不唯一返回 `standalone_search_route_unresolved`，禁用返回 `standalone_search_disabled`。其他订阅路径继续透明转发，`/v1/alpha/search` 不开放。

官方空间仅保存四个 Router 受管 Codex 字段及本地 catalog 的哈希快照。离开官方前比较当前受管投影，有变化就追加 official revision，永不替换 `official@1`。Router revision 保存归一化策略与凭证引用，不包含 Codex 账号或扩展数据。

官方原生压缩触发项和 opaque 压缩项继续透明转发，不因出现压缩历史就进入 Engine。压缩响应会替换活动上下文窗口，而不是追加到压缩前历史；归档分别保存不可变原始记录、有效替换窗口和面向目标的可迁移视图。Gateway 自有检查点、Engine 留存的 response ID 和跨 Provider 迁移仍必须恢复历史。观察提交按分支串行；即使客户端未携带 `previous_response_id`，后续跨渠道切换也会有界等待所依赖的压缩提交。缺失或冲突谱系不阻断普通官方续聊，但不能授权跨 Provider 回放。参见 [OpenAI 压缩契约](https://developers.openai.com/api/docs/guides/compaction)。

Router 继续按 target 声明执行 `native`、`summary` 或 `unsupported`。同账户、同 target 的 `native` 压缩由渠道负责：Router 原样转发 Codex 压缩请求及后续 opaque checkpoint，不选择摘要窗口，也不因 token 估算阻断。`summary` 是用户显式选择的、有损的 Gateway 压缩模式，原生压缩失败或尚未验证时不会自动回退到它。跨 target 迁移独立受 `nativeMigrationSummary` 授权：只有目标无法使用精确可迁移历史时，才允许原模型生成一次关闭工具的迁移摘要并保存来源窗口哈希。它不会修补谱系缺口、吞掉必要尾部、递归摘要、自动重试、换模型或换渠道。fork 恢复沿已验证的 `history_base` 边界、在有限深度内展开；未知工具执行结果保留为明确历史不确定性；多个 checkpoint 共享事件前缀，不重复复制完整历史。HTTP Relay 与 Engine 的 SSE 共用[无数据超时](configuration.zh-CN.md#请求超时)，不再用总生成时长截断持续传输。

英文完整架构见 [architecture.md](architecture.md)。

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

官方 Responses 通过有界旁路观察写入既有加密历史。观察失败不影响普通官方响应；后续跨 Provider 需要该历史却无法确认完整时，明确返回 `history_observation_incomplete`。每条保留的 response 还记录内部续接来源：只有成功旁路观察到的官方透明 Relay response，后续官方请求才继续携带原生 `previous_response_id`；Engine 生成、本地预热、虚拟压缩及没有来源标记的旧记录都会重新进入 Engine，展开加密历史并在唯一一次上游发送前移除本地 response ID，后续 response 继续留在同一回放链。完全未知的官方 ID 在没有跨 Provider 历史要求时仍保持既有透明行为。Router 虚拟 response ID/checkpoint 因此不会发给官方。

工具策略在 target 确定后、每次上游发送前运行。回退时从未裁剪副本重新生成目标视图，同一 turn 使用固定配置/来源快照。来源识别只读取受信内置映射、已启用 Plugin manifest 与 Codex MCP 配置，不启动 Plugin，也不依据通用 `mcp__*` 前缀猜测。

官方订阅不裁剪。第三方 GPT 默认只保留标准 Plugin 白名单，同时保留核心和用户 MCP。未知/冲突来源放行。筛选覆盖普通函数、namespace 和 `input[].additional_tools.tools`；被禁止的显式 `tool_choice` 返回 `tool_policy_conflict`，禁止的直接调用在交给客户端前返回 `disallowed_plugin_tool_call`。

第三方 `openai-gpt` Responses target 会为 Codex 感知型中转保留不含身份的客户端协商 Header（`User-Agent`、`originator`、beta feature 和 Responses-Lite 声明）；订阅 Authorization、账号、Cookie、request/session/thread/turn/window/install 标识、turn metadata 及正文 client metadata 仍全部剥离。新建 App target 默认 `standard-tools`，使用标准 Responses、保留策略允许的工具面且不广告独立搜索；显式 `lite-search` 使用 Responses Lite 和选定来源，并披露缩减后的工具面。模型 target 确定后，Engine 会按账号哈希及 turn、thread、session 关联冻结独立搜索租约。官方模型强制选择订阅搜索。对未声明原生 hosted search 的 Lite target，若收到顶层 hosted-search 载体则返回 `standalone_search_protocol_mismatch`，不会静默交给模型 Provider 执行。`/subscription/v1/alpha/search` 先验证订阅身份，再解析租约：订阅走固定官方 Relay；Provider 模式剥离全部 ChatGPT/Codex 身份 Header，只注入对应 Provider Key，并保留方法、query、实体字节、状态、压缩、SSE 与错误正文。来源不自动重试或切换；关联不唯一返回 `standalone_search_route_unresolved`，禁用返回 `standalone_search_disabled`。其他订阅路径继续透明转发，`/v1/alpha/search` 不开放。

官方空间仅保存四个 Router 受管 Codex 字段及本地 catalog 的哈希快照。离开官方前比较当前受管投影，有变化就追加 official revision，永不替换 `official@1`。Router revision 保存归一化策略与凭证引用，不包含 Codex 账号或扩展数据。

英文完整架构见 [architecture.md](architecture.md)。

# 数据流与隐私

| 数据 | 目的地 | 本地持久化 |
|---|---|---|
| 官方订阅请求 | 固定 ChatGPT Codex 后端 | 成功 Responses 可旁路写入加密历史 |
| 第三方模型生成 | target 配置的 Provider | 加密历史 |
| `lite-search` 第三方 GPT 的独立搜索 | 选定的 ChatGPT Codex 后端或显式 Provider endpoint；`standard-tools` 不广告该能力 | 搜索结果可进入后续模型上下文 |
| 订阅凭证 | 仅官方 Relay/adapter | 由 Codex 管理 |
| Provider 凭证 | 仅对应 Provider | Keychain 或环境变量 |
| 第三方 GPT 缓存亲和 | 仅向对应 Provider 发送匿名 `clr-pc-v1-*` 键 | 专用 Keychain secret 与有界、仅派生 ID 的加密谱系状态 |
| 工具定义 | 按最终 target 策略发送 | 不单独存档 schema |
| 运行日志 | 用户级日志目录 | 只含类型、数量、字节、耗时等元数据 |
| 配置空间 revision | 仅本机 Router 数据目录 | 不可变 Router 策略或官方受管投影，使用 SHA-256 寻址 |
| 切换事务 | 仅本机 Router 数据目录 | 来源/目标引用和哈希、阶段、脱敏错误及 Router 恢复配置；不含 Codex auth、用户 MCP/提示/历史正文 |

标准策略只删除已确认来源且不在有效名单中的结构化 Plugin 定义，不改写提示、Skills、Hooks 或历史正文。核心、用户 MCP、未知、来源冲突以及嵌入 Code mode 说明的定义保留。日志不记录 schema。

启用 `gateway-opaque` 后，原始客户端 cache key 与 Codex 账号/thread/turn/session/install metadata 都留在本机。Router 不扫描或哈希 Prompt，只按 Provider、模型和谱系派生 HMAC 键并在 turn 内冻结，只发送匿名键。日志只含谱系来源枚举和 token 数量/比例，不含键与正文。账号池中转站可以用匿名键稳定选择上游账号或 Cache Shard，详见[Provider 协议](provider-cache-affinity.zh-CN.md)。

每个模型 turn 会按 turn、thread、session、account 的顺序冻结搜索路由租约。订阅 bearer 和账号 Header 只存在于固定官方链路；Provider 搜索会先剥离订阅身份，再只注入对应 Provider Key。租约仅保存来源、target、endpoint/凭证引用名称、配置摘要、关联标识和 TTL，不保存查询、结果或凭证。`/v1/alpha/search` 不开放，也不会把本地 API Key 升级为订阅身份。

订阅、Provider、Tavily、Exa 之间没有自动回退：选中的来源必须成功，否则返回明确类型错误。验收 Harness 的搜索观察也只持久化响应/URL 哈希、字节、目的地和布尔判据。

确定性的 L0-L2 与能力画像门禁不经过上述生产数据流：Codex 使用临时合成身份，子进程中的环境代理和凭证变量会被剥离，官方、Provider 与搜索传输都由本地夹具注入。显式 live canary 是独立的限额操作，只把必要 auth 复制到临时 0600 文件，并仅持久化元数据证据。

Router 是路由边界，不是匿名层。第三方 Provider 会收到完成该次生成所需的会话、允许工具定义及搜索结果，用户仍需判断数据是否适合发送。

切换只修改 Router 管理的 Codex 键和 Router 空间字段；用户 MCP、Skills、Hooks、提示、历史和认证文件保持原位。App 打开时，pending 事务在 App 正常退出并成功提交前不会影响数据面。

显式 rollout 恢复只会流式读取用户选定的本地 Codex JSONL，将通过完整性校验的可移植 checkpoint 写入同一加密归档。它不调用模型、不访问网络、不改 Codex rollout；预览和诊断只包含线程引用、哈希、数量、状态和错误类型，消息、工具、compaction 与凭证内容始终留在本地加密边界内。

英文完整说明见 [data-flow.md](data-flow.md)。

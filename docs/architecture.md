# 架构与实现

## 执行层

```text
HTTP / WebSocket
  -> 解压、大小限制、JSON 解析、受信账号识别
  -> 会话/turn 配置租约、历史版本恢复
  -> Router + 模型/渠道能力
  -> Responses 或 Chat Completions 协议适配
  -> Provider Adapter
  -> SSE / Chat 事件归一化、渠道级 message phase 稳定化
  -> 历史事务提交
  -> Codex
```

server 管理双入口、连接、背压、取消和 WebSocket 队列；Engine 管理路由、历史视图、压缩适配、图片说明、搜索循环及有限 fallback；Provider Adapter 管理认证、端点和渠道专用会话头；transport 管理 curl HTTP/1.1 生命周期；StateStore 是可重建的 128 MiB/30 分钟内存层，Archive 是 SQLite 持久层。

HTTP 请求按 `Content-Encoding` 支持 identity、zstd、gzip 和 deflate，压缩前后分别执行 20 MiB 限制。非法 JSON、损坏压缩流、不支持编码和真实上游容量错误使用不同错误类型。HTTP/SSE 和 WebSocket 共用 Engine 错误边界。

## 路由与能力

`providers` 管理渠道地址、适配器和认证引用；`targets` 管理唯一接入 ID、上游模型、协议、窗口、输出预留、输入能力、工具能力、压缩模式及 App 展示。能力按 target 声明，不根据模型品牌推断。

订阅入口先匹配由 targets 生成的自定义模型映射，其余模型必须存在于官方 GPT 目录。官方 GPT 固定发往 ChatGPT Codex Responses 后端；自定义模型只能使用声明的 provider。OpenCode Go 的 session 头只由 `opencode-go` adapter 发送，订阅 bearer 及账号元数据不会发给第三方。

provider 的 `responsesMessagePhasePolicy` 控制 Responses 消息阶段兼容。OpenCode Go 默认 `defer_until_done`：每个 message item 缓存到自身 `output_item.done`，用结束事件的 phase 修正起始事件后立即释放，因此后续工具调用不会等待整轮完成；真正最终回答也在自己的 done 边界整段释放。通用 OpenAI 兼容 provider 默认 `passthrough`，官方订阅固定透传。上游实质输出与客户端可见输出分别记录，缓存期间断流、取消或超限不能触发 fallback 或重放。

App 目录从官方缓存和 target 配置生成。官方条目逐项原样保留；自定义条目使用明确字段，不复制官方 `comp_hash`。新增模型若复用 Responses/Chat 和现有渠道，只需配置 target。新协议、特殊认证或特殊会话行为才需要代码适配器。本项目不加载动态脚本或插件。

自定义模型的 Codex 推理档位由 target 的 `app.reasoningLevels` 配置，目录生成时转换为 `supported_reasoning_levels`。档位是模型与渠道组合的已验收能力；DeepSeek V4.1 Flash 的 OpenCode Go target 声明到 `max`，未知 target 默认仍只声明到 `xhigh`。

每个 turn 冻结配置版本，压缩准备与正式回答分别租约。正式回答和工具循环锁定同一 target。API fallback 仍限定在同一 provider、尚未输出且错误可恢复的首次调用；订阅入口不跨渠道 fallback。

## 压缩与切换

```text
Codex 发起压缩
  native      -> 已验证后端原生压缩
  summary     -> 当前模型单次摘要，tools=[]
  unsupported -> 明确错误

A -> B
  原文请求成功                 -> 保存 B 的完整视图
  明确上下文超限且尚未输出       -> A 单次摘要 -> B 重试一次
  摘要后仍超限/其他错误/已输出    -> 明确失败
```

Gateway 不再使用 64 KiB 阈值、分块摘要、递归归并或多次自动修订。估算 token 只用于日志。`model_downshift` 压缩请求先建立包含完整原文的虚拟检查点，等目标请求到达后再决定；通常先发送原文。DeepSeek 同模型达到 Codex 的 400K 容量条件时走一次摘要，GPT 同模型继续走官方原生压缩。自定义模型再次压缩时处理当前有效视图，最新用户消息及其后的事件保持原文，归档原文不会被覆盖。

同一账号、分支、原历史和目标的摘要使用稳定键持久复用。并发请求等待同一进程内正在执行的摘要。调用中断且结果未知时标为 uncertain，后续不自动重试。工具调用及结果作为完整单元保留，未闭合工具调用拒绝压缩。

官方加密状态只交给官方后端验证。自定义 native 状态必须符合 target 声明的同账号兼容 target 集合。其他跨范围切换从本地归档展开原文；Gateway 虚拟检查点永远不会发给上游。

## 历史与身份

SQLite 默认位于 `~/.llm-auto-gateway/state/history.sqlite`，启用 WAL、FULL 同步和事务。每个成功响应先以一个事务提交响应记录和不可变历史版本，再向客户端发布完成结果。版本保存：

- 受信账号命名空间、thread、branch 和父分支版本。
- target 的模型与渠道身份、原始响应关联和渠道 session。
- 完整原历史与当前模型实际上下文视图。
- 原图、工具轨迹、虚拟/原生检查点、摘要与图片说明状态。

正文和派生内容使用 AES-256-GCM；密钥只存 macOS Keychain。索引身份以 HMAC 保存。订阅 bearer 必须等于本机 Codex 当前 access token，可选账号头也必须匹配；持久归属使用 account ID，因此同账号刷新 token 后继续访问同一历史。API 与订阅、不同账号、thread 及 branch 相互隔离。

默认磁盘配额 10 GiB，80% 记录提示，满额时事务回滚并返回明确错误。内存淘汰不影响持久记录。显式 prune 会检查后续版本和分叉引用；不自动删除原文。

## 图片、工具与搜索

目标支持图片时保留原图。文本目标会调用历史中具备视觉能力的源 target，为每个图片哈希生成一次文字说明，说明中标记有损转换，原图继续加密保存。缺少原图或视觉源 target 时失败。

跨渠道保留工具 `call_id`、名称、参数和结果，移除 provider 专用 item ID。缺少公开摘要的加密 reasoning 会转换为明确的私有状态缺失标记；未知 provider item 仍明确失败。Responses Lite 的工具声明由 Codex 重建，不作为历史迁移。

原生搜索取决于 target 能力；其他目标可使用 Gateway 搜索工具循环。Gateway 向这类目标提供内部 `gateway_web_search` 和 `gateway_web_fetch`：前者返回候选链接及摘要，后者通过已配置的 Tavily Extract 或 Exa Contents 提取单页正文。正文默认最多返回 20000 字符，可在 1000–100000 内配置；日志只记录结果数量、返回字符数和是否截断。

内部搜索与 Codex 外部工具同时出现时，Gateway 保存完整 provider continuation，同时只向 Codex 暴露外部工具。恢复顺序保持为 `reasoning/message → 全部 function_call → 全部 function_call_output`，因此 OpenCode Go 的 thinking 模式能够取得原始 `reasoning_text` 和完整调用组。旧版本保存的 `[搜索调用, 搜索结果, 外部调用]` 会在外部结果返回时一次性修正，并同步修复持久原文视图。工具执行后的输出失败不自动重放。

上游明确报告 thinking 模式缺少回传 `reasoning_text` 时，Gateway 返回脱敏的 `thinking_history_incompatible`，并将日志分类为 `thinking_history`；不记录上游正文或请求内容。

## 管理与上线

`gateway-admin.mjs` 提供配置升级、models check/catalog、history inspect/import/export/prune 和 integration upgrade/status/restore。配置升级先 dry-run，应用时保留原始备份；目录升级检查现有状态和哈希。App 正在运行时接入脚本拒绝修改，Gateway 代码升级需要在无活动推理窗口重启。

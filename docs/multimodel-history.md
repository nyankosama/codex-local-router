# 多模型、压缩与历史恢复

## 职责

```text
Codex 判断是否压缩、选择压缩前模型、安装结果
  -> Gateway 归档原文并按目标 compression.mode 执行请求
     -> native: 交给已验证兼容的后端
     -> summary: 当前/源模型单次摘要，工具关闭
     -> unsupported: 明确失败
```

Gateway 不按字节数主动压缩，也不进行分块、递归归并或自动多轮修订。请求大小估算只写入观测日志。目标计数不确定时先发送原文；只有上游在 400/413/422 中明确返回上下文长度错误，且尚未产生输出，跨模型请求才允许一次源模型摘要和一次目标重试。摘要后的请求仍超限时返回 `context_after_summary_exceeded`。

摘要只处理最新用户消息之前的当前有效视图；最新用户消息及其后的事件保持原文。摘要输出上限同时受 16384、源模型输出能力和目标预算剩余量约束。同一模型已经使用 Gateway 摘要后再次压缩时，继续摘要当前视图，不从归档自动展开全部原文；完整原文仍独立保留，供切换到其他模型时重新评估。

渠道私有的加密 reasoning 不能跨兼容范围原样转发。没有公开 reasoning 摘要时，迁移视图会加入明确的私有状态缺失标记；可见消息、工具参数和工具结果仍逐项保留，完整原始 item 继续留在加密归档中。

`tool_search_call` / `tool_search_output` 是动态加载工具定义的 Provider 控制历史。跨 Provider 或切到 Chat Completions 前，Gateway 按 `call_id` 线性校验完整 pair，并将每对转换为固定的脱敏 assistant 标记；查询、执行元数据、Provider item ID 与工具 schema 均不进入目标视图。后续真实函数/custom-tool 调用和结果保持顺序，原始 pair 继续只存在于不可变加密原历史中。缺失、重复、反序或畸形 pair 返回 `tool_search_history_incomplete`，且不会请求目标 Provider。

模型降档时，Codex 的压缩请求不含目标预算。Gateway 根据 `compaction.reason=model_downshift` 创建无损本地检查点，不调用摘要模型；目标请求到达后先尝试完整原文。手动压缩、同模型容量压缩及其他压缩原因按当前目标的压缩模式执行。

## 配置

`providers` 管理地址、认证引用、渠道适配器和 Responses 消息阶段策略；`targets` 管理唯一接入 ID、上游模型 ID、协议、窗口、输入能力、工具能力和压缩模式。能力属于模型与渠道的组合。同一上游模型可以在不同渠道建立多个 target。OpenCode Go 默认逐个等待 message item 的结束事件以稳定 phase；其他兼容渠道默认透传。

OpenCode Go 使用 `adapter: opencode-go`，只有该适配器发送 `x-opencode-session`。其他 OpenAI 兼容渠道使用 `adapter: openai-compatible`。订阅 bearer 和账号头不会转发给自定义渠道。凭证只通过环境变量或 Keychain 引用。

DeepSeek V4.1 Flash 的默认及最大窗口均为 400000，输入类型为文本和图片，压缩模式为 `summary`。图片经 Responses `input_image` 原样发送到 OpenCode Go；只有切换到明确的纯文本目标时才生成有损图片说明。其他自定义模型必须声明自己的窗口及能力；schema v1 旧配置升级时，缺少窗口的非 DeepSeek 目标会显式落为旧系统的保守值 131072，并保持 `unsupported`，这个迁移值不代表渠道能力已经验收。自定义 App 模型不声明 `comp_hash`。自定义 `native` 模式还必须声明同账号兼容 target 集合。

输入预算按以下公式记录：

```text
min(contextWindow * effectivePercent, contextWindow - outputReserve) - 2048
```

请求的 `max_output_tokens` 优先于目标默认输出预留。当前实现没有跨供应商可信 tokenizer，因此估算不会直接触发摘要。

## 持久历史

默认数据库是 `~/.llm-auto-gateway/state/history.sqlite`，使用 WAL、同步事务和不可变版本。正文、附件、响应及派生摘要使用 AES-256-GCM；加密密钥只存 macOS Keychain。账号、线程及分支索引使用带密钥 HMAC，订阅历史以本机 `auth.json` 中已验证的 account ID 为归属，token 刷新不改变归属。

每个版本分别保存完整原历史和模型实际使用的上下文视图。压缩结果、图片说明、响应关联及 OpenCode session 可在进程重启和内存缓存过期后恢复。内容哈希只用于加密内容共享，消息合并按顺序和响应关系完成，不按文本去重。

图片切到文本目标时，Gateway 从归档原图调用会话中已验证具备视觉能力的源模型一次，缓存图片哈希对应的说明，并在输入中标记 `Lossy image description`。没有原图或视觉源模型时返回 `image_migration_unavailable`。

磁盘配额默认 10 GiB，80% 记录提醒，到达配额返回 `history_disk_full`。清理仅由显式命令触发；仍被后续版本或分叉引用的历史不能删除。

## 错误边界

认证、额度、网络、格式和输出后的失败不会触发摘要或重放。摘要或图片说明中断且结果未知时记为 `uncertain`，后续不会自动重复调用。上游已经完成的响应在相同账号、线程和分支中可恢复；工具调用和结果保留原 `call_id`，Gateway 不重新执行工具副作用。

旧 rollout 导入要求精确 thread ID。分叉可同时提供 `--parent-source`，父 rollout 会先导入并绑定父版本。恢复状态区分 `complete_original`、`summary_only` 和 `gap_present`。

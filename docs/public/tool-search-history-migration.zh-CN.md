# 工具搜索历史迁移

模型动态发现工具定义后，Codex 历史中可能保留 `tool_search_call` 和 `tool_search_output`。这些 item 包含 Provider 控制状态和工具 schema，因此 Router 不会把它们原样重放到另一个 Provider 或协议。

跨 target 迁移时，Router 对完整序列做一次线性校验。每个 call 必须有唯一、位于其后且使用同一非空 `call_id` 的 output；缺失、重复、反序或畸形 pair 会在任何目标请求发出前返回 HTTP 409 `tool_search_history_incomplete`。合法 pair 转换为固定 assistant 历史标记：

```text
[Dynamic tool discovery occurred on the previous provider. Provider-specific discovery metadata and tool schemas were omitted during migration; subsequent tool calls and results remain in history.]
```

标记不包含搜索参数、工具名、描述、schema、执行元数据或 Provider ID。动态发现后已经完成的函数与 custom-tool 调用/结果保持原顺序并继续迁移。历史恢复提示使用相同表示，Responses 与 Chat Completions target 均可接收。

加密原历史永不改写。每个目标只保存独立的可移植视图，后续切换重新从原历史构建，不会叠加标记。日志只记录 pair 数量、既有相关性哈希和源/目标 Provider 身份。

本功能不恢复 Router 从未完整观察到的旧官方 opaque compaction，也不会为畸形历史调用摘要模型、自动重试或切换到其他 Provider。

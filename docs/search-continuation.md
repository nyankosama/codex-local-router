# 搜索与外部工具 continuation

自定义模型没有原生 Web Search 时，Gateway 把 Codex 的 `web_search` 声明转换为两个内部函数：

```text
gateway_web_search -> 标题、URL、摘要
gateway_web_fetch  -> 指定 URL 的定长可读正文
```

Tavily 使用 Search 与 Extract 接口，Exa 使用 Search 与 Contents 接口。认证只从配置指定的环境变量读取；返回给模型的正文默认限制为 20000 字符，配置项为 `webSearch.maxExtractCharacters`。内部调用和正文不会作为工具事件交给 Codex 执行。

## 混合工具顺序

同一模型输出可能同时包含 Gateway 内部搜索和 Codex 外部工具。provider continuation 必须保留两个阶段：

```text
reasoning / commentary
内部搜索调用 A、B
外部工具调用 C、D
内部搜索结果 A、B
外部工具结果 C、D
```

Gateway 在向 Codex 返回首段响应时隐藏内部调用，但在 `previous_response_id` 对应的本地记录中保存完整模型输出和内部结果。Codex 返回外部结果后直接追加到该记录，不再根据单个外部调用临时拼接整段搜索历史。

旧版本会把内部调用和结果绑定到外部 `call_id`。恢复时 Gateway 按共享内部调用集合分组，移除已经存在的旧顺序，再将内部调用放到最早的关联外部调用之前，将内部结果放到最早的关联外部结果之前。该过程可重复执行，不会重复添加调用或结果。

OpenCode Go thinking 模式要求工具 continuation 带回相应的 `reasoning_text`。如果上游仍明确拒绝这段历史，Gateway 返回 `thinking_history_incompatible`，日志只记录 `thinking_history` 分类。

## 验证

```bash
npm test
GATEWAY_CONFIG=/absolute/path/gateway.subscription.local.json \
  node scripts/accept-search-continuation.mjs
```

真实验收会调用 Tavily Extract 一次，并向 OpenCode Go 发送一次修正后的 `max` thinking continuation。证据只保存调用顺序、返回长度、状态和次数，不保存搜索正文、模型回答或凭证。

# 架构规约

## 分层

```text
Responses API
      ↓
Request Normalizer
      ↓
Rule Router
      ↓
Capability Planner
      ↓
Provider Adapter
      ↓
SSE / Response Relay
```

- **API 层**：接收 Codex 请求，处理认证、request ID、超时和取消。
- **Normalizer**：提取可稳定读取的请求字段，不做语义理解。
- **Router**：只决定 Provider、模型和匹配规则，不处理上游协议细节。
- **Capability Planner**：决定原生能力透传、工具回退或明确失败。
- **Provider Adapter**：封装 base URL、认证、模型映射、协议差异和错误转换。
- **Relay**：把内部事件转换回 Codex 可消费的 Responses SSE。

## 路由原则

- 全局模式先确定：透传、固定或规则。
- 规则按配置顺序匹配，第一条命中。
- 单条规则内所有条件必须满足。
- 未命中使用默认目标。
- 一次请求的路由决定在执行期间保持不变。
- 规则必须可读、可测试、可解释，并记录命中结果。

## 能力原则

模型选择与模型能力独立。至少区分 `responses`、`streaming`、`toolCalling`、`nativeWebSearch` 和 `reasoning`。

```text
原生 web search → 透传
无原生搜索但支持工具调用 → Gateway 工具回退
两者都不支持 → 明确错误
```

新增自适应路由时，应实现新的 Router 或 Policy 层，不把学习逻辑塞入规则匹配器。

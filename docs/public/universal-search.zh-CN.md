# 第三方模型通用搜索

Codex Local Router 提供两条相互独立的搜索路径，不会在失败时暗中互相回退。

| 路径 | 执行者 | Gateway 职责 |
|---|---|---|
| Tavily 等用户 MCP | Codex 客户端 | 保留发现过程、调用 ID 和结果；不复制 MCP 配置或凭证 |
| OpenAI 订阅桥接 | Gateway | 暴露一个标准函数，调用固定 OpenAI `/alpha/search`，把有界、不可信的结果交回既有工具循环 |

订阅桥接按 target 显式开启：

```json
{
  "targets": {
    "example": {
      "subscriptionSearch": { "delivery": "standard-tool" }
    }
  }
}
```

```bash
codex-local-router model edit --id example \
  --subscription-search standard-tool --yes
```

它只处理已认证的 `/subscription/v1/responses`，并要求当前 Codex 搜索模式可观察。用户关闭搜索时不注入工具；`cached`、`indexed`、`live` 和域名限制保持不变，无法识别的请求形态明确失败。搜索请求只携带 ChatGPT 订阅身份并发往固定 OpenAI 目的地；模型生成只携带对应 Provider 凭证。`/v1` 不借用订阅身份。

桥接与 Responses Lite、`nativeWebSearch`、模型家族和 Provider 原生搜索相互独立。它要求标准 Responses 函数调用和结果续接能力。结果受条数、字节、超时和单轮次数限制，并始终作为不可信工具数据返回；不会切换搜索源、模型或凭证。

模型可以在同一 turn 多次调用桥接。`webSearch.maxRounds` 限制成功的内部搜索轮数（默认 3，合法范围 1-10）；再发起搜索会返回 `tool_loop_limit`，不会重试或回退。内部搜索调用和结果会刻意从客户端对话中隐藏，所以 Codex App 通常只显示最终回答及来源。客户端可见文本与普通工具仍在到达时立即转发，只有私有搜索生命周期由 Gateway 内部消费。

当前 Codex 可能先向模型提供标准 `tool_search`，待模型选择后再加载用户 MCP，而不是首轮发送全部 MCP schema。这能控制初始上下文。Gateway 会保留 `tool_search`、动态调用及结果，但不会读取或启动用户 MCP。若模型不能可靠调用 `tool_search`，Gateway 不能在不接管用户 MCP 权限的前提下替它完成该步骤；本项目明确不越过这条边界。

GLM 5.3 Flash 的目标配置是：标准 Responses、`shell_command`、标准工具、取消强制 Code mode、多代理使用 `client-default`、不声明 freeform 工具，思考档位为 `low`、`high`、`max` 且默认 `max`，订阅搜索使用 `standard-tool`。Provider／模型 ID、压缩和客户端交付的通用指令保持不变。上下文窗口仍是 target 本地配置值，catalog 声明不等于容量已被验证。

v0.5.4 live 候选已经用三轮、七次生成、三次搜索且零重试，证明 GLM 与 ai.feei 订阅桥接以及 ai.feei 客户端 Tavily 路径。GLM 桥接用例产生 38 个客户端可见文本 delta；后续长回答约 13 秒内产生 523 个 delta。这是协议和下游发送证据，不保证 App 绘制时序。再叠加官方 cached/live 回归，发布矩阵覆盖五个有界等价类，不做模型与协议全排列。

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

桥接支持多次搜索：同一次 Provider 响应可以请求多个搜索，模型读取结果后也可以继续发起下一轮搜索。`webSearch.maxRounds` 限制“模型／搜索续接轮次”，而不是单次响应中的查询数量；默认 `3`，允许 `1` 到 `10`。超过上限返回 `tool_loop_limit`，Gateway 不会自动重试、切换搜索源或回退模型。

订阅搜索的调用和结果是 Engine 内部事件，因此 Codex App 不会为这条路径显示搜索工具卡片。客户端可见文本和普通客户端工具仍会在收到时立即流式发送，包括声明了搜索但实际未搜索的轮次。Gateway 不伪造进度，也不把 reasoning 转成 commentary；如果模型只发工具调用而没有过程文字，界面仍可能一直安静到最终回答开始。

当前 Codex 可能先向模型提供标准 `tool_search`，待模型选择后再加载用户 MCP，而不是首轮发送全部 MCP schema。这能控制初始上下文。Gateway 会保留 `tool_search`、动态调用及结果，但不会读取或启动用户 MCP。若模型不能可靠调用 `tool_search`，Gateway 不能在不接管用户 MCP 权限的前提下替它完成该步骤；本项目明确不越过这条边界。

GLM 5.3 Flash 的目标配置是：标准 Responses、`shell_command`、标准工具、取消强制 Code mode、多代理使用 `client-default`、不声明 freeform 工具，思考档位为 `low`、`high`、`max` 且默认 `max`，订阅搜索使用 `standard-tool`。Provider／模型 ID、压缩、指令与上下文窗口声明仍是 target 本地配置；开启桥接不会迁移这些值，也不能证明模型容量。

v0.5.4 候选已通过五项有界 live 矩阵：五个 turn、十三次模型生成、七次搜索、零重试。矩阵证明了 GLM 与 ai.feei 订阅桥接、一个客户端拥有的 Tavily MCP 路径、结果续接、凭证隔离，以及官方 cached／live 搜索未回归。GLM App 协议用例在完成前交付了 38 个客户端文本 delta；不实际搜索的长回答 canary 在约 13 秒内交付 523 个 delta。这些是传输／协议证据，不是延迟目标，也不代表所有模型都会输出中间过程说明。

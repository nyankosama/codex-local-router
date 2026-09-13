# 配置说明

默认配置位于 `~/Library/Application Support/Codex Local Router/config.json`，也可用 `CODEX_LOCAL_ROUTER_CONFIG` 或 `--config` 指定。运行时 Schema 保持 3；空间存储为 Schema 1，集成状态升为 Schema 4。

字段所有权分为两层：`listen`、`access`、`history`、请求/连接/超时限制和官方 catalog 源路径属于机器全局；路由模式与 target 选择、`providers`、`targets`、`rules`、`pluginTools`、`webSearch`、`standaloneSearch`、订阅接入、可用模型及默认 Codex 模型属于配置空间。`config.json` 是全局字段权威加活动 Router 空间物化结果；手工改动空间字段会形成 drift，切换不会静默覆盖。

初始化、克隆、切换、回滚、drift、pending 事务和救援流程见[配置空间指南](configuration-spaces.zh-CN.md)。

```text
spaces/index.json                 当前、上一次成功激活、各空间最新 revision
spaces/<name>/<revision>.json     带 SHA-256 的不可变版本
transactions/space-switch.json    唯一待完成或待恢复事务
```

空间名匹配 `[a-z0-9][a-z0-9._-]{0,63}`。revision 只保存环境变量名或 Keychain service/account，不保存明文 Provider 凭证、ChatGPT Token、`auth.json`、用户 MCP、Skills、Hooks、提示和会话历史。`official@1` 永久保留。

## ai.feei

内置两个预设：

| preset | App 模型 ID | 上游模型 | 配置窗口 |
|---|---|---|---|
| `feei/gpt-5.6-sol` | `feei-gpt-5.6-sol` | `gpt-5.6-sol` | 272,000 |
| `feei/gpt-6-astra` | `feei-gpt-6-astra` | `gpt-6-astra` | 272,000 |

两者使用 Responses Lite 工具传输、文本/图片输入、freeform 工具、`summary` 压缩、`modelFamily: "openai-gpt"` 和 `useResponsesLite: true`。272,000 是保守配置，不代表已验证更大的容量。

```bash
printf '%s' "$FEEI_API_KEY" | codex-local-router provider add \
  --id feei --base-url https://ai.feei.cn/v1 \
  --adapter openai-compatible --credential-stdin --yes
codex-local-router model add --id feei-sol --provider feei \
  --preset feei/gpt-5.6-sol --yes
codex-local-router model add --id feei-astra --provider feei \
  --preset feei/gpt-6-astra --yes
```

API Key 保存在独立 Keychain 项或由 `FEEI_API_KEY` 提供，不得写入配置。App 模型 ID 带 `feei-` 前缀，不冒用官方模型 ID。

两款预设通过 `modelFamily: "openai-gpt"` 继承第三方 GPT 的搜索默认策略，不再维护 ai.feei 专属布尔值。Responses Lite 让 Codex 以 `input[].additional_tools` 中的 `web.run` 暴露独立搜索；`capabilities.nativeWebSearch: false` 表示不宣称 ai.feei 支持嵌入模型请求的 hosted search。搜索是否发生仍由 Codex 运行时、catalog 和用户搜索设置共同决定。为兼容 Codex 感知型中转，第三方 GPT Responses 请求只保留不含身份的客户端协商 Header；订阅凭证及账号/session/request/install 关联均留在本机。OpenAI 文档同样要求自定义 Provider、模型和运行时共同支持独立搜索：[Web search](https://learn.chatgpt.com/docs/web-search)。

## 独立搜索路由

独立搜索与 `capabilities.nativeWebSearch` 分离。当前 Codex 通过 Responses Lite 的 `web.run` namespace 提供独立搜索，因此 App-enabled target 启用独立来源时会默认使用 Responses Lite；显式配置 `useResponsesLite: false` 会校验失败。官方模型固定使用官方订阅搜索；第三方 `modelFamily: "openai-gpt"` 默认使用用户自己的 Codex 订阅搜索。第一版因此仍要求有效的 Codex 官方登录。非 GPT 和旧 target 不会被自动切换到新策略。

优先级为：官方模型、target 显式策略、旧 `app.supportsSearchTool` 显式值、第三方 GPT 空间默认、旧行为。可选来源只有 `subscription`、`provider`、`disabled`：

```json
{
  "standaloneSearch": {
    "thirdPartyGpt": { "defaultSource": "subscription" }
  },
  "providers": {
    "my-provider": {
      "baseUrl": "https://api.example.com/v1",
      "standaloneSearch": { "endpoint": "alpha/search" }
    }
  },
  "targets": {
    "my-gpt": {
      "modelFamily": "openai-gpt",
      "standaloneSearch": { "source": "provider" }
    }
  }
}
```

Provider 模式只接受显式声明：target 必须是 App-enabled Responses，Provider 必须有相对搜索 endpoint。绝对 URL、query、fragment、路径穿越、编码穿越和跨 origin 会被拒绝。选定来源不可用时不会在订阅、Provider、Tavily 或 Exa 之间自动回退；禁用时返回 `standalone_search_disabled`，无法唯一关联当前模型轮次时返回 `standalone_search_route_unresolved`。

旧字段和 `--supports-search-tool` / `--no-supports-search-tool` 继续作为兼容输入：分别映射为 `subscription` / `disabled`。新 CLI 写入会移除旧字段，新旧声明冲突则校验失败。catalog 的 `supports_search_tool` 由最终策略派生。

## Plugin 策略

最终 target 决定策略，优先级固定为：官方订阅透明转发；target 显式策略；第三方 `openai-gpt` 默认白名单；其他及旧 target 原样转发。

`pluginToolPolicy` 支持：

- `passthrough`
- `third-party-gpt-default`
- `{ "mode": "allowlist", "allowedPlugins": [...] }`

标准名单只有 `github`、`figma`、`sites`、`connected_documents`。`spreadsheets` 与 `codex_document_control` 会归一到 `connected_documents`。全局扩展如下：

```json
{
  "pluginTools": {
    "thirdPartyGpt": {
      "additionalAllowedPlugins": [],
      "excludedDefaultPlugins": []
    }
  }
}
```

别名归一化后，同一项不能同时增加和排除。Codex 核心工具、`codex_app`、`cua_repl`、Router 搜索工具、用户自行配置的 MCP、Skills、Hooks 与提示正文不受裁剪。来源未知或冲突时放行并记录结构化诊断。

`history.observationWaitMs` 可设置紧接着跨 Provider 切换时等待官方历史旁路提交的上限，默认 2,000 ms。普通官方响应不会等待观察解析或写盘完成才结束。

`model list --json` 和非 live 的 `model probe --json` 会显示最终 Plugin/搜索策略、选择原因、是否向 App 广告、Provider endpoint 和凭证就绪状态。CLI 相关参数包括 `--model-family`、`--plugin-policy`、`--allowed-plugins`、`--search-source` 和兼容的 `--supports-search-tool`。只有搜索来源为 `disabled` 或不使用独立搜索时才能显式选择 `--no-responses-lite`。

英文完整配置参考见 [configuration.md](configuration.md)。

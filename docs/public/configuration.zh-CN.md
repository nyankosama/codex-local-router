# 配置说明

默认配置位于 `~/Library/Application Support/Codex Local Router/config.json`，也可用 `CODEX_LOCAL_ROUTER_CONFIG` 或 `--config` 指定。运行时 Schema 保持 3；空间存储为 Schema 1，集成状态升为 Schema 4。

字段所有权分为两层：`listen`、`access`、`history`、请求/连接/超时限制和官方 catalog 源路径属于机器全局；路由模式与 target 选择、`providers`、`targets`、`rules`、`pluginTools`、`webSearch`、`standaloneSearch`、订阅接入、可用模型及默认 Codex 模型属于配置空间。`config.json` 是全局字段权威加活动 Router 空间物化结果；手工改动空间字段会形成 drift，切换不会静默覆盖。

初始化、克隆、切换、回滚、drift、pending 事务和救援流程见[配置空间指南](configuration-spaces.zh-CN.md)。

## 第三方默认模板

新建 App-enabled 第三方模型在声明 Responses、工具调用和 freeform 工具能力且其 preset 已通过 Provider 准出时，默认使用 `codex-general-v1`，物化通用指令、标准 Responses、Code mode、多代理 v2、关闭的独立搜索和标准 Plugin 策略。`thirdPartyDefaults.template` 只允许 `codex-general-v1` 或 `legacy`，且只影响后续创建；已有 target 仅通过 `model apply-template` 改变。当前 OpenCode Go DeepSeek preset 虽有静态能力声明，仍只允许 `legacy`。详见[第三方模型模板](third-party-templates.zh-CN.md)。

```text
spaces/index.json                 当前、上一次成功激活、各空间最新 revision
spaces/<name>/<revision>.json     带 SHA-256 的不可变版本
transactions/space-switch.json    唯一待完成或待恢复事务
```

空间名匹配 `[a-z0-9][a-z0-9._-]{0,63}`。revision 只保存环境变量名或 Keychain service/account，不保存明文 Provider 凭证、ChatGPT Token、`auth.json`、用户 MCP、Skills、Hooks、提示和会话历史。`official@1` 永久保留。

## ai.feei

### 显式启用 code mode

`targets.<id>.app.toolMode: "code_mode_only"` 只投影为 catalog 的 `tool_mode`，让兼容客户端使用 `exec`/`wait`。要求第三方、App-enabled、Responses 协议且声明 `toolCalling` 和 `freeformTools`；如果 preset 收窄了 Provider 准出范围，还必须通过对应准出。不再以 GPT 家族为准入条件。旧安装不自动迁移。诊断同时显示 `structured-only; embedded-exec-opaque` 边界。

Plugin 白名单继续裁剪结构化工具定义，但不解析或改写 `exec.description` 内嵌的 schema，不分析 JavaScript，也不阻断间接调用。这里的目标是控制上下文体积，不是建立安全沙箱；不能因为有 `exec` 包装就认定上下文变小。

启用前，固定客户端二进制、模型、Prompt、指令、传输方式及实际工具集合，对照开关前后 Provider 出站的 `{instructions, tools, input}` 序列化 UTF-8 字节与工具定义哈希。这是 Wire 体积代理指标，不是实测 token。建议准出线：首请求增量不超过 `max(8 KiB, 原上下文载荷的 10%)`，工具续接和下一 turn 的工具哈希稳定；超线或缺少 call/result 证据不启用。客户端或工具集合显著变化后重新预检。这是上线前门禁，不是运行时自动限额或自动降级。

批量预览（仅在预检通过、App 已退出的上线窗口增加 `--yes`）：

```bash
codex-local-router model set-tool-mode --ids feei-sol,feei-astra \
  --tool-mode code_mode_only --space default --json
```

两个 target 一次提交为同一个不可变空间版本，分别保留空间默认模型和 Codex 当前选模。`--tool-mode default` 清除覆盖；切回精确历史空间引用可恢复旧设置。安全激活并重开后使用新任务验收。App-server 协议通过不能替代 App UI 签核，批量调用也不保证每次任务都减少轮次。

内置两个预设：

| preset | App 模型 ID | 上游模型 | 配置窗口 |
|---|---|---|---|
| `feei/gpt-5.6-sol` | `feei-gpt-5.6-sol` | `gpt-5.6-sol` | 272,000 |
| `feei/gpt-6-astra` | `feei-gpt-6-astra` | `gpt-6-astra` | 272,000 |

两者声明文本/图片输入、freeform 工具、`summary` 压缩、`modelFamily: "openai-gpt"` 和 272,000 的保守窗口。CLI 新建 target 时会叠加 `standard-tools`；旧的纯 preset 或显式 Lite 配置保留原传输，只有搜索生效时才按 `lite-search` 解析，避免静默迁移或能力夸大。272,000 不代表已验证更大容量。

```bash
printf '%s' "$FEEI_API_KEY" | codex-local-router provider add \
  --id feei --base-url https://ai.feei.cn/v1 \
  --adapter openai-compatible --credential-stdin --yes
codex-local-router model add --id feei-sol --provider feei \
  --preset feei/gpt-5.6-sol --yes
codex-local-router model add --id feei-astra --provider feei \
  --preset feei/gpt-6-astra --yes
```

以上命令创建 `standard-tools` target。若要让其中一款显式改用独立订阅搜索：

```bash
codex-local-router model edit --id feei-sol \
  --app-profile lite-search --search-source subscription --yes
```

API Key 保存在独立 Keychain 项或由 `FEEI_API_KEY` 提供，不得写入配置。App 模型 ID 带 `feei-` 前缀，不冒用官方模型 ID。

CLI 新建两款 target 时默认写入 `app.capabilityProfile: "standard-tools"`、`useResponsesLite: false` 与禁用的独立搜索；显式增加 `--app-profile lite-search` 才启用 Responses Lite 和选定的订阅/Provider 搜索。`capabilities.nativeWebSearch: false` 表示不宣称 ai.feei 支持嵌入模型请求的 hosted search。既有显式 Lite 配置不变。搜索是否发生仍由 Codex 运行时、catalog 和用户设置共同决定。为兼容 Codex 感知型中转，第三方 GPT Responses 请求只保留不含身份的客户端协商 Header；订阅凭证及账号/session/request/install 关联均留在本机。OpenAI 文档同样要求自定义 Provider、模型和运行时共同支持独立搜索：[Web search](https://learn.chatgpt.com/docs/web-search)。

## 第三方 App 能力画像

具备能力的第三方 Responses target 可使用同一组画像；旧非 GPT target 只有在显式配置画像或物化通用模板后才进入。基础指令独立版本化，不继承源模型能力画像。标准 Responses 使用客户端交付；符合条件的 Lite target 可显式启用 `gateway-lite`。约束、证据和上线门禁见[指令快照](instruction-snapshots.zh-CN.md)。

| 画像 | 传输与工具面 | 独立搜索 |
|---|---|---|
| `standard-tools` | 标准 Responses；按策略保留核心工具、允许 Plugin 和用户 MCP | 不向 App 广告 |
| `lite-search` | Responses Lite；诊断中明确标为缩减工具面 | 必须启用选定的订阅或 Provider 来源 |

通过 `model add` 新建的 Responses target 会持久化 `standard-tools`，因此诊断原因是 `target-explicit`；没有显式 Lite 兼容信号的新验证 App-enabled GPT Responses target 同样默认使用 `standard-tools`，但原因是 `standard-default`。非 GPT target 仅通过显式画像或通用模板 marker 进入。需要独立搜索时显式使用 `--app-profile lite-search`。既有 Responses target 的 `useResponsesLite: true` 保持传输行为且不自动改写持久化配置：搜索生效时解析为 `lite-search`；若明确禁用搜索，则保持未画像，原因是 `legacy-responses-lite-transport-only`，工具面为 `legacy-responses-lite`。显式选择 `lite-search` 却禁用搜索，或 `standard-tools` 启用搜索，仍会 fail closed。旧的非 Responses 与未配置的非 GPT target 保持原传输行为和未画像状态。`model list`、非 live `model probe`、`status`、`doctor` 的 JSON 与人类可读输出，以及自定义 catalog entry，都会输出最终画像、选择原因和工具面。官方订阅模型不参与这组画像拆分，继续透明转发。

画像不会因上游失败、重试、重连或工具请求而切换。`standard-tools` 与启用的独立搜索、显式 `lite-search` 与禁用搜索或标准传输等冲突组合会直接校验失败。未画像的旧 Lite 纯传输是兼容状态，不是第三种已准出画像。

`--no-app` 会保留 target 的路由能力，但将其显式标为 App-disabled，并清理 target 级画像、Responses Lite 与搜索状态。App-disabled target 不继承空间级 App 搜索默认；同一空间中其他 App-enabled target 继续使用该默认值。

## 第三方 Prompt Cache 亲和

缓存亲和是 Provider 级显式能力，作用于兼容的第三方 Responses target：`openai-gpt`，或已显式物化 `codex-general-v1` 的非 GPT target。旧的非 GPT target 保持不变：

```json
{
  "providers": {
    "example": {
      "adapter": "openai-compatible",
      "baseUrl": "https://provider.example/v1",
      "promptCaching": { "affinity": "gateway-opaque" }
    }
  }
}
```

`affinity` 只接受 `none`、`gateway-opaque`。未配置等价于 `none`；包括 ai.feei 在内的 preset 都不会因升级自动启用。通过配置空间 revision 显式修改：

```bash
codex-local-router provider edit --id example \
  --prompt-cache-affinity gateway-opaque --yes
```

官方订阅请求继续透明保留客户端缓存字段。符合准入且显式启用的第三方 Responses 请求会先删除原始 `prompt_cache_key`、Codex metadata、账号/thread/turn/session/install 标识和 `comparison_response_id`，只向 Provider 发送 `clr-pc-v1-*` HMAC 键。`prompt_cache_options` 仅可保留安全的 `mode`（`implicit`/`explicit`）与 `ttl`（`30m`）。Chat Completions、OpenCode Go 和未启用通用模板的旧非 GPT 配置不会获得 Gateway 亲和键。

第三方 GPT Responses 在 `none` 与 `gateway-opaque` 下都会在一次成功终态后写入一条脱敏 `prompt_cache_usage`；上游未返回 usage 时保持 `null`/未知，不转换成 0，错误和取消不写终态 usage。Responses Lite 按 HTTP 请求或 WebSocket frame 独立协商，只把规范化的 `true` 发给适用 Provider；缺失或 false 的 frame 不继承连接上一轮状态，内部摘要/图片辅助请求继续强制非 Lite。

专用 32-byte secret 只在功能首次实际使用时生成，并写入 macOS Keychain：service 为 `com.nyankosama.codex-local-router.prompt-cache-v1`，account 为 `affinity`。谱系状态只含派生 ID，容量受限、30 分钟过期，并在可用时进入加密状态库。同一 turn 的工具续接冻结第一次策略和键。fork 只有在客户端 cache key 相同，或同账号父线程映射已存在时才继承；无法验证关系时创建独立谱系。

`model list`、非 live `model probe`、`status` 和 `doctor` 会报告最终模式、选择原因、载体、可用谱系来源和重启稳定能力，不输出派生键或客户端标识。端到端效果仍取决于 Provider 行为；[账号池互操作建议](provider-cache-affinity.zh-CN.md)是条件性建议，只配置 Gateway 不能证明任何命中率。

## 独立搜索路由

独立搜索与 `capabilities.nativeWebSearch` 分离。当前 Codex 通过 Responses Lite 的 `web.run` namespace 提供独立搜索；因此新建 `standard-tools` target 不广告搜索，显式 `lite-search` target 才启用选定来源。官方模型固定使用官方订阅搜索；既有 Responses target 的 `useResponsesLite: true` 或显式旧搜索策略推导出的 Lite 组合保持原有订阅搜索行为，没有这些兼容信号的未画像 App-enabled GPT Responses target 使用新的 Standard 默认值。Lite 订阅搜索仍要求有效的 Codex 官方登录；非 Responses、非 GPT 和其他旧 target 保持原行为。

标准 Responses target 还可以用与模型家族无关的订阅桥接，把 OpenAI 订阅搜索暴露成普通函数工具：

```bash
codex-local-router model edit --id example --subscription-search standard-tool --yes
```

它与下方旧版／Lite 独立搜索策略及 Provider 原生 hosted search 相互独立。桥接要求订阅入口已认证、客户端搜索模式可观察，并支持函数调用和结果续接；与 Lite、独立搜索源或原生 hosted search 冲突时配置校验失败。详见[通用搜索](universal-search.zh-CN.md)。

共享配置 `webSearch.maxRounds` 同时限制该桥接的模型／搜索续接循环：默认 `3`，允许 `1` 到 `10`，按轮次而不是同一 Provider 响应里的单个查询计数。因此桥接可以执行多次搜索，但不能无界循环。

优先级为：官方模型、target 显式策略、旧 `app.supportsSearchTool` 显式值、显式 App-disabled 截断、第三方 GPT 空间/缺省值、旧 `nativeWebSearch` 兼容层、其他旧行为。只有前两项 target 声明都不存在时才进入 App-disabled 截断，避免已隐藏 GPT 继承仅供 App 使用的搜索广告。可选来源只有 `subscription`、`provider`、`disabled`：

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

`model list --json` 和非 live 的 `model probe --json` 会显示最终 Plugin/搜索策略、App 能力画像、选择原因、工具面、是否向 App 广告、Provider endpoint 和凭证就绪状态；`status` 与 `doctor` 也输出画像摘要。CLI 相关参数包括 `--model-family`、`--plugin-policy`、`--allowed-plugins`、`--app-profile`、`--search-source` 和兼容旧参数。

Provider 凭证不得依赖受管 LaunchAgent 继承 Shell 环境，应存入 Keychain。服务只保留代理变量及安装进程显式配置的 `NODE_EXTRA_CA_CERTS` 路径；这两者共同构成网络信任边界，不会连带复制 `NODE_OPTIONS` 或 Provider Key。

英文完整配置参考见 [configuration.md](configuration.md)。

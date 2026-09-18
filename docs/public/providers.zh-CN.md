# Provider 接入与准出状态

[English](providers.md)

Provider 配置、确定性协议覆盖、真实 Release 准出和 App UI 确认是四种不同结论：

| 状态 | 含义 |
|---|---|
| Preset available | CLI 内置了对应名称的 preset |
| Configuration supported | 公开 Schema 与 CLI 能表达该 Provider／模型 |
| Deterministic tested | 本地夹具覆盖了声明的协议和 Gateway 行为 |
| Live release-qualified | 指定 Release 的有界真实渠道用例通过 |
| App UI confirmed | 用户另行确认了 App 实际显示与交互 |

真实结论只属于证据中精确命名的 Provider、模型和路径。Provider 健康度可以独立于 Gateway 兼容性变化。

## 通用 OpenAI-compatible Provider

没有适用内置 preset 时，显式创建 Provider 和 target：

```bash
codex-local-router provider add --id my-provider \
  --adapter openai-compatible \
  --base-url https://api.example.com/v1 \
  --credential-prompt --concurrency 4 --yes

codex-local-router model add --id my-model \
  --provider my-provider \
  --upstream-model upstream-model-id \
  --protocol responses \
  --context-window 128000 \
  --input-modalities text \
  --compression unsupported \
  --display-name "My Model" \
  --reasoning-levels low,medium,high \
  --yes
```

只声明 endpoint 确实支持的能力。上下文窗口、图片、工具、原生搜索和压缩模式都是路由契约，不是自动发现结果。依赖新渠道前显式执行 live probe：

```bash
codex-local-router model probe --id my-model --live
```

标准 Responses 是主要接入面。Chat Completions 使用 JSON function tools，不能承载 namespace 或 freeform 工具。

## 内置 preset

当前源码内置：

| Preset | Provider 路径 | 重要边界 |
|---|---|---|
| `opencode-go/deepseek-v4.1-flash` | OpenCode Go Responses | 保留已接受的 legacy 路径；通用模板、直接 Code mode 和直接多代理元数据尚未准出 |
| `feei/gpt-5.6-sol` | ai.feei Responses | 使用独立 App 模型 ID；GPT 策略和可选能力仍需显式配置 |
| `feei/gpt-6-astra` | ai.feei Responses | 使用独立 App 模型 ID；GPT 策略和可选能力仍需显式配置 |

全新 setup 可以显式使用中性本地 ID：

```bash
codex-local-router setup \
  --preset feei/gpt-5.6-sol \
  --provider-id feei \
  --target-id feei-sol \
  --credential-prompt
```

setup 后可在同一个 Provider 中增加第二个 target：

```bash
codex-local-router model add --id feei-astra --provider feei \
  --preset feei/gpt-6-astra --yes
```

项目不包含任何 Provider Key。隐藏输入／stdin 会把凭证保存到 macOS Keychain；环境变量引用适合前台运行，但受管 LaunchAgent 不会继承该变量。

## BigModel Coding Plan 示例

BigModel 是公开自定义 Provider 示例，不是内置 preset。已接受的 GLM 5.3 Flash 路径使用其公开 OpenAI-compatible endpoint、标准 Responses、标准工具、文本输入、客户端默认代理和可选的 `standard-tool` 订阅搜索。

```bash
codex-local-router provider add --id bigmodel \
  --adapter openai-compatible \
  --base-url https://open.bigmodel.cn/api/v1 \
  --credential-prompt --yes

codex-local-router model add --id glm-flash \
  --provider bigmodel \
  --upstream-model glm-5.3-flash \
  --protocol responses \
  --context-window 270000 \
  --input-modalities text \
  --compression summary \
  --template legacy \
  --display-name "GLM 5.3 Flash Coding Plan" \
  --reasoning-levels low,high,max \
  --default-reasoning-level max \
  --shell-type shell_command \
  --no-freeform-tools \
  --multi-agent-version client-default \
  --subscription-search standard-tool \
  --yes
```

270,000 token 是用户配置，不是独立容量证明。GLM 5.3 main 可以接入同一 Provider，但不能继承 Flash 的真实 Release 证据。

## 搜索选择

- 用户 MCP 搜索继续由 Codex 持有并执行；Router 保留调用／结果，但不复制 MCP 配置或凭证。
- `--subscription-search standard-tool` 允许已准出的标准 Responses 模型通过一个有界函数使用已登录 OpenAI 订阅搜索。
- Provider 原生 hosted search 与 Responses Lite 独立搜索是其他能力，不会作为隐藏回退。

为自定义 target 开启搜索前，先阅读[通用搜索](universal-search.zh-CN.md)。

## 准出摘要

当前公开状态统一维护在[兼容性矩阵](compatibility.zh-CN.md)。精确驱动版本、哈希、预算和历史结果只保存在[冻结证据](evidence/README.zh-CN.md)或对应 GitHub Release，不进入长期有效的接入指南。

# Provider setup and qualification

[简体中文](providers.zh-CN.md)

Provider configuration, deterministic protocol coverage, live release qualification, and App UI confirmation are separate claims:

| Status | Meaning |
|---|---|
| Preset available | The CLI ships a named preset |
| Configuration supported | The public schema and CLI can express the Provider/model |
| Deterministic tested | Local fixtures cover the declared protocol and Gateway behavior |
| Live release-qualified | A bounded real-channel case passed for the named release |
| App UI confirmed | A user separately verified the rendered App experience |

Only the exact Provider/model/path named by evidence inherits a live claim. Provider health can change independently of Gateway compatibility.

## Generic OpenAI-compatible Provider

Use an explicit Provider and target when no built-in preset applies:

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

Declare only capabilities the endpoint actually supports. A context window, image modality, tool flag, native search flag, or compression mode is a routing contract—not a discovery result. Run an explicit live probe before relying on a new channel:

```bash
codex-local-router model probe --id my-model --live
```

Standard Responses is the primary integration surface. Chat Completions uses JSON function tools and cannot carry namespace or freeform tools.

## Built-in presets

The source currently includes these presets:

| Preset | Provider path | Important boundary |
|---|---|---|
| `opencode-go/deepseek-v4.1-flash` | OpenCode Go Responses | Accepted legacy path; generic template, direct Code mode, and direct multi-agent metadata are not qualified |
| `feei/gpt-5.6-sol` | ai.feei Responses | Same-target native compaction qualified; cross-target migration and optional GPT features remain explicit |
| `feei/gpt-6-astra` | ai.feei Responses | Same-target native compaction qualified; no implicit compatibility with Sol |

Fresh setup can assign neutral local IDs explicitly:

```bash
codex-local-router setup \
  --preset feei/gpt-5.6-sol \
  --provider-id feei \
  --target-id feei-sol \
  --credential-prompt
```

Add the second target to the same Provider after setup:

```bash
codex-local-router model add --id feei-astra --provider feei \
  --preset feei/gpt-6-astra --yes
```

The project contains no Provider key. Hidden prompt/stdin input stores credentials in macOS Keychain; an environment-variable reference is suitable for foreground use but is not imported into the managed LaunchAgent.

## BigModel Coding Plan example

BigModel is a public custom-Provider example, not a built-in preset. The accepted GLM 5.3 Flash path uses its public OpenAI-compatible endpoint, Standard Responses, standard tools, text input, client-default agents, and optional subscription search delivered as `standard-tool`.

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
  --compression unsupported \
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

The 270,000-token value is a user configuration, not independent capacity proof. GLM 5.3 main can be configured through the same Provider, but it does not inherit Flash's live release evidence.

## Search choices

- User MCP search stays owned and executed by Codex. The Router preserves calls/results but does not copy MCP configuration or credentials.
- `--subscription-search standard-tool` lets a qualified Standard Responses model use the signed-in OpenAI subscription search through one bounded function.
- Provider-native hosted search and Responses Lite standalone search are separate capabilities and are never selected as hidden fallbacks.

See [universal search](universal-search.md) before enabling search on a custom target.

## Qualification summary

The current public status is maintained in the [compatibility matrix](compatibility.md). Exact driver versions, hashes, budgets, and historical results live in [frozen evidence](evidence/README.md) or the corresponding GitHub Release, not in this evergreen setup guide.

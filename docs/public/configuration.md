# Configuration

The default configuration is stored under `~/Library/Application Support/Codex Local Router/config.json`. Override it with `CODEX_LOCAL_ROUTER_CONFIG` or `--config`.

Runtime configuration remains schema 3. Configuration-space storage is schema 1 and integration state is schema 4. Ownership is explicit:

- global machine layer: `listen`, `access`, `history`, `maxBodyBytes`, `maxConnections`, `timeoutMs`, and the official catalog source path;
- versioned space layer: route mode and target choice, `providers`, `targets`, `rules`, `pluginTools`, `webSearch`, subscription routing, available App models, and the default Codex model.

`config.json` is the authority for global fields plus the materialized active Router-space fields. A manual change to the latter is drift and blocks switching until it is captured or reverted.

For initialization, cloning, switching, rollback, drift, pending transactions, and rescue workflows, see the [configuration-space guide](configuration-spaces.md).

Space metadata lives below the Router data directory:

```text
spaces/index.json                  active, previous, latest revisions
spaces/<name>/<revision>.json      immutable content plus SHA-256
transactions/space-switch.json     one pending/recoverable switch
```

Names match `[a-z0-9][a-z0-9._-]{0,63}`. A revision stores credential references only: environment variable names or Keychain service/account pairs. Plaintext Provider credentials, ChatGPT tokens, `auth.json`, user MCP, Skills, Hooks, prompts, and conversation history are excluded. `official@1` is permanently retained.

Within a Router space, schema 3 keeps three model-routing layers:

- `providers`: base URL, adapter, endpoint paths, credential reference, message-phase policy, timeout, and concurrency.
- `targets`: unique target ID, provider, upstream model, protocol, context window, input modalities, tools, reasoning levels, search, compression, and Codex catalog metadata.
- global policy: routing, local access, history, request limits, subscription routing, and search fallback.

A target can name a versioned `preset`. Presets fill missing values; explicit target and provider values win. `opencode-go/deepseek-v4.1-flash` currently declares a 400,000-token configured window, image input, Responses, tools, streaming, summary compression, and reasoning levels through `max`. `feei/gpt-5.6-sol` and `feei/gpt-6-astra` declare standard Responses, text and image input, freeform tools, summary compression, and a conservative 272,000-token configured window. These declarations are specific to each provider-model pair and do not prove a provider's larger capacity.

## Third-party GPT Plugin policy

`modelFamily` is optional and accepts `openai-gpt` or `other`. Leaving it absent preserves the pre-policy behavior: all client tools pass through. The final upstream target, not the request path or a model-name pattern, selects the policy in this order:

1. the official subscription target is always passthrough;
2. an explicit target `pluginToolPolicy` wins;
3. a third-party `modelFamily: "openai-gpt"` uses the standard allowlist;
4. other and legacy third-party targets are passthrough.

`pluginToolPolicy` accepts `"passthrough"`, `"third-party-gpt-default"`, or an explicit allowlist:

```json
{
  "mode": "allowlist",
  "allowedPlugins": ["github", "my_plugin"]
}
```

There is one standard allowlist: `github`, `figma`, `sites`, and `connected_documents`. `spreadsheets`, `connected_documents`, and `codex_document_control` normalize to the same `connected_documents` identity. `safety_settings` is a Plugin, not an App core tool, and is excluded by default. Extend the standard list globally without editing target definitions:

```json
{
  "pluginTools": {
    "thirdPartyGpt": {
      "additionalAllowedPlugins": ["my_plugin"],
      "excludedDefaultPlugins": ["figma"]
    }
  }
}
```

An alias-normalized name cannot be present in both arrays. Codex built-ins, `codex_app`, `cua_repl`, router search tools, and MCP servers configured by the user always pass. Skills, Hooks, and prompt/history text are never rewritten. A confirmed Plugin outside the list is removed; an unknown or colliding source passes with a metadata-only diagnostic.

The filter covers ordinary functions, namespace tools, and `input[].additional_tools.tools`. An explicit `tool_choice` that selects a removed Plugin fails with `tool_policy_conflict`. If an upstream nevertheless emits a confirmed forbidden Plugin call, the router ends the turn with `disallowed_plugin_tool_call` before the call reaches the client; this policy failure never triggers model fallback.

`history.observationWaitMs` optionally sets the bounded wait for an in-flight official-history observation when the very next turn switches providers; the default is 2,000 ms. Ordinary official responses finish without waiting for observation parsing or disk I/O.

Provider endpoint paths are optional:

```json
{
  "baseUrl": "https://provider.example/api/v1",
  "endpoints": {
    "responses": "/v1/responses",
    "chatCompletions": "/v1/chat/completions"
  }
}
```

The joiner avoids a duplicate `/v1`. Vendor context errors can be classified with `contextErrorCodes`; body and attachment error codes belong in `nonContextErrorCodes`. A generic `request_too_large` never triggers lossy compression by itself.

Credentials may use `apiKeyEnv` or a Keychain reference:

```json
{
  "keychain": {
    "service": "codex-local-router-provider",
    "account": "my-provider"
  }
}
```

Inline `apiKey`, `token`, and `authorization` values are rejected.

Codex 0.153.4 only accepts `freeform` as a non-null `apply_patch_tool_type`.
Targets that have verified freeform tool support receive that value. Chat
Completions targets use `null`, so the catalog does not claim a freeform tool
that their JSON function protocol cannot carry. Codex may still attach plugin
namespace definitions to every request; the Chat adapter omits those definitions
with a metadata-only log entry and forwards the ordinary JSON function tools.
An explicit custom/freeform tool remains a capability error.

## Add a provider and a model

Provider and target changes go through the CLI. It prints a diff and asks for confirmation; pass `--yes` for automation. Routing is not a CLI subcommand and is edited in `config.json`.

```bash
# 1. Provider: endpoint, credential reference, concurrency budget.
codex-local-router provider add --id my-provider \
  --adapter openai-compatible \
  --base-url https://api.example.com/v1 \
  --credential-prompt \
  --concurrency 4 --yes

# 2. Target: declare the protocol, window, modalities, and compression mode.
codex-local-router model add --id my-model \
  --provider my-provider \
  --upstream-model the-upstream-model-id \
  --protocol chat_completions \
  --context-window 200000 \
  --input-modalities text \
  --compression unsupported \
  --display-name "My Model" \
  --reasoning-levels low,medium,high,xhigh \
  --yes

# 3. Apply, then refresh what the Codex App sees, then verify end to end.
codex-local-router service restart
codex-local-router integration sync --yes
codex-local-router model probe --id my-model --live
```

A target can name the built-in preset `opencode-go/deepseek-v4.1-flash` with `--preset`. Explicit flags override preset values.

For ai.feei, store the credential independently and create two targets with the built-in presets:

```bash
printf '%s' "$FEEI_API_KEY" | codex-local-router provider add \
  --id feei --base-url https://ai.feei.cn/v1 \
  --adapter openai-compatible --credential-stdin --yes

codex-local-router model add --id feei-sol --provider feei \
  --preset feei/gpt-5.6-sol --yes
codex-local-router model add --id feei-astra --provider feei \
  --preset feei/gpt-6-astra --yes
```

The App-visible IDs intentionally remain `feei-gpt-5.6-sol` and `feei-gpt-6-astra`; they do not impersonate official catalog IDs. The presets set `modelFamily: "openai-gpt"`, `useResponsesLite: false`, and `app.supportsSearchTool: true`. The last field advertises the App's standalone search path. It is independent from `capabilities.nativeWebSearch`, which remains false because the presets do not claim that ai.feei implements an embedded hosted-search tool. Codex still honors the user's runtime search setting; the router does not force search on.

Declarations are validated rather than guessed:

- `--context-window` is required by schema 3. Too small a value causes premature summarization; too large a value defers the failure to the upstream.
- `--compression` states what the channel can do with a full history: `native` (the channel accepts the stored original directly and an explicit same-account compatibility target set is required), `summary` (one source-model summary is allowed after an explicit context-limit rejection), or `unsupported` (never lossy).
- `--input-modalities` must match the channel. `chat_completions` targets cannot accept images. An image sent to a text-only target is described by a configured source model when one exists, otherwise the request is rejected with `image_migration_unavailable`.
- `--no-tools`, `--no-streaming`, `--freeform-tools`, and `--native-search` (Responses only) keep the declared capabilities honest. `--supports-search-tool` controls the separate App standalone-search declaration. A chat_completions target cannot declare `--native-search`.
- `--model-family openai-gpt|other` opts a target into the corresponding default. `--plugin-policy passthrough|third-party-gpt-default|allowlist` selects an explicit policy; `--allowed-plugins` is required with `allowlist`.
- Credentials are never inline. `--credential-prompt` or `--credential-stdin` stores the value in macOS Keychain; `--api-key-env` works for foreground runs, but the managed LaunchAgent does not import your shell environment, so Keychain is the reliable choice for a service.
- A target appears in the Codex App menu only when it is App-enabled; `--no-app` keeps it routable but hidden. `model remove` refuses while a target is selected by `defaultTarget`, `fixedTarget`, or `passthroughTarget`.

Routing stays explicit: `defaultTarget` selects the fallback target for `/v1`, `fixedTarget`/`passthroughTarget` pin an entry point, and `rules` map request models to targets. If these advanced fields are edited in the materialized `config.json`, review the reported drift and run `codex-local-router space capture`; the captured revision then becomes the active authority. A new provider, protocol, or capability declaration is a compatibility boundary: re-run the acceptance harness (`npm run e2e:l1`, see [acceptance harness](acceptance.md)) before depending on it.

# Configuration

The default configuration is stored under `~/Library/Application Support/Codex Local Router/config.json`. Override it with `CODEX_LOCAL_ROUTER_CONFIG` or `--config`.

Configuration schema 3 keeps three layers:

- `providers`: base URL, adapter, endpoint paths, credential reference, message-phase policy, timeout, and concurrency.
- `targets`: unique target ID, provider, upstream model, protocol, context window, input modalities, tools, reasoning levels, search, compression, and Codex catalog metadata.
- global policy: routing, local access, history, request limits, subscription routing, and search fallback.

A target can name a versioned `preset`. Presets fill missing values; explicit target and provider values win. `opencode-go/deepseek-v4.1-flash` currently declares a 400,000-token configured window, image input, Responses, tools, streaming, summary compression, and reasoning levels through `max`. These declarations are specific to that provider-model pair.

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

Declarations are validated rather than guessed:

- `--context-window` is required by schema 3. Too small a value causes premature summarization; too large a value defers the failure to the upstream.
- `--compression` states what the channel can do with a full history: `native` (the channel accepts the stored original directly and an explicit same-account compatibility target set is required), `summary` (one source-model summary is allowed after an explicit context-limit rejection), or `unsupported` (never lossy).
- `--input-modalities` must match the channel. `chat_completions` targets cannot accept images. An image sent to a text-only target is described by a configured source model when one exists, otherwise the request is rejected with `image_migration_unavailable`.
- `--no-tools`, `--no-streaming`, `--freeform-tools`, and `--native-search` (Responses only) keep the declared capabilities honest. A chat_completions target cannot declare `--native-search`.
- Credentials are never inline. `--credential-prompt` or `--credential-stdin` stores the value in macOS Keychain; `--api-key-env` works for foreground runs, but the managed LaunchAgent does not import your shell environment, so Keychain is the reliable choice for a service.
- A target appears in the Codex App menu only when it is App-enabled; `--no-app` keeps it routable but hidden. `model remove` refuses while a target is selected by `defaultTarget`, `fixedTarget`, or `passthroughTarget`.

Routing stays explicit in `config.json`: `defaultTarget` selects the fallback target for `/v1`, `fixedTarget`/`passthroughTarget` pin an entry point, and `rules` map request models to targets. After editing, run `codex-local-router service restart`. A new provider, protocol, or capability declaration is a compatibility boundary: re-run the acceptance harness (`npm run e2e:l1`, see [acceptance harness](acceptance.md)) before depending on it.

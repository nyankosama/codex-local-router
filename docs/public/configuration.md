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

# Compatibility matrix

| Component | v0.4.0 status |
|---|---|
| macOS | Supported |
| Node.js 22 | Supported; Node currently labels built-in SQLite experimental |
| Codex CLI 0.154.0-alpha.6.2 | Current focused-candidate driver; exact binary SHA is recorded by the harness |
| Codex App | App-server integration baseline; UI reload must be verified for each installed build |
| ChatGPT subscription HTTP/WS and auxiliary APIs | Fixed-origin transparent relay; model/search queries and future paths covered locally |
| OpenCode Go Responses | Supported for the accepted DeepSeek target |
| ai.feei GPT 5.6 Sol / GPT 6 Astra Responses | Built-in configuration presets; live result belongs to each candidate report |
| Generic OpenAI-compatible Responses | Configuration support; provider capability requires live probe |
| Generic OpenAI-compatible Chat Completions | Configuration support with JSON function tools |
| Linux / Windows | Not supported in v0.4.0 |
| Runtime configuration schema 3 | Preserved; active Router space materializes into the existing format |
| Configuration-space schema 1 | Local immutable revisions and one switch transaction |
| Integration state schema 4 | Links protected official and materialized Router revisions |

The DeepSeek preset records the accepted provider-model combination. A configured context window or capability does not prove an unrelated provider offers the same behavior.

## Custom providers and the client tool surface

The official ChatGPT backend can provide its own server-side tool surface. A target declared with `wireApi: responses` and `useResponsesLite: false` cannot rely on that, so the Codex client sends the tool definitions needed by the third-party provider.

On an install with Codex Apps connected, that surface is dominated by the app namespaces rather than by the built-in tools. Measured on one such install with a trivial prompt, one request to a custom target carried 21 tool definitions totalling 306 KB, of which about 293 KB was ten `mcp__codex_apps__*` namespaces (figma, github, gmail, alpaca, sites, tavily_ai, plugin_management, codex_document_control, safety_settings, hotline) and roughly 8 KB was built-in tools (`exec_command`, `apply_patch`, `view_image`, and similar). The provider reported 97,610 input tokens for that turn, against 16,197 for the same prompt on an official model.

The third-party GPT default now narrows only confirmed Plugin tools. The standard allowlist is `github`, `figma`, `sites`, and `connected_documents`; the last identity covers `spreadsheets` and `codex_document_control`. Codex built-ins, `codex_app`, `cua_repl`, router search, and user-configured MCP stay available. Unknown or colliding sources are passed and diagnosed rather than guessed. Non-GPT and legacy targets keep the previous full passthrough unless explicitly configured.

Consequences and limits:

- Allowed Plugin schemas and all core/user-MCP schemas still count toward the third-party context. The policy reduces known unnecessary Plugin overhead; it does not promise a fixed token reduction.
- Responses Lite is not the filtering mechanism, but current Codex requires its `input[].additional_tools` / `web.run` carrier for standalone search. Both Lite and non-Lite carriers remain covered by the same Plugin policy.
- A forbidden direct Plugin call is stopped before client execution. Indirect use through shell/code, unrecognized sources, and tool names preserved inside historical prose are outside this guarantee.
- Chat Completions cannot carry namespace tools and continues to omit them with a metadata-only diagnostic after the Plugin policy has run.

## Standalone web search

The effective `standaloneSearch` policy controls whether the generated Codex catalog advertises the client's standalone search capability. It is intentionally separate from `capabilities.nativeWebSearch`, which declares a provider-hosted tool embedded in model generation. Current Codex carries standalone search as Responses Lite `web.run`; active standalone sources therefore require Lite, and a mismatched top-level hosted-search request to a target without declared native hosted search fails instead of executing on an unintended provider. The ai.feei presets inherit the `openai-gpt` default (`subscription`) and leave native hosted search disabled.

Search only works when the Codex runtime, selected catalog model, and user search setting all allow it. The router does not override a user-disabled setting. Official models are forced to subscription search. Third-party GPT models default to subscription search but may explicitly select a compatible Provider endpoint or disable search. Non-GPT/legacy targets keep their old behavior. A Provider endpoint is never inferred from a model name or `/models` response, and a failed source never falls back to another source.

Each model turn freezes a correlation-scoped search route. `/subscription/v1/alpha/search` validates the subscription identity first, then either reaches the fixed OpenAI backend or replaces that identity with the selected Provider key. Ambiguous or missing scoped routes fail explicitly. `/v1/alpha/search` remains unavailable, so a local API key cannot acquire subscription identity. This first version still requires a valid Codex subscription login even when the selected search source is a Provider.

Official HTTP and secure WebSocket relays share the machine's proxy boundary. WebSocket-specific `WS_PROXY` / `WSS_PROXY` take precedence when present; `HTTP_PROXY` / `HTTPS_PROXY` are compatible fallbacks, `ALL_PROXY` remains the generic fallback, and `NO_PROXY` is honored. Proxy credentials are handled by the proxy agent and are never copied into the official end-to-end header set or Router logs.

# Compatibility matrix

| Component | v0.3.0 status |
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
| Linux / Windows | Not supported in v0.3.0 |
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
- Setting `useResponsesLite: true` is not the filtering mechanism. In observed client behavior the definitions may move into `input[].additional_tools.tools`; both carriers are therefore covered by the same policy.
- A forbidden direct Plugin call is stopped before client execution. Indirect use through shell/code, unrecognized sources, and tool names preserved inside historical prose are outside this guarantee.
- Chat Completions cannot carry namespace tools and continues to omit them with a metadata-only diagnostic after the Plugin policy has run.

## Standalone web search

`app.supportsSearchTool` controls whether the generated Codex catalog advertises the client's standalone search capability. It is intentionally separate from `capabilities.nativeWebSearch`, which declares a provider-hosted tool embedded in model generation. The ai.feei presets enable the former and leave the latter disabled.

Search only works when the Codex runtime, selected catalog model, and user search setting all allow it. The router does not override a user-disabled setting. Under `/subscription/v1`, standalone search is relayed to the fixed OpenAI backend and is not subject to the Plugin allowlist. `/v1/alpha/search` remains unavailable, so a local API key cannot acquire subscription identity.

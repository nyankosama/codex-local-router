# Compatibility matrix

| Component | v0.5.3 candidate status |
|---|---|
| macOS | Supported |
| Node.js 22 | Supported; Node currently labels built-in SQLite experimental |
| Codex CLI 0.154.0-alpha.6.2 | Current focused-candidate driver; exact binary SHA is recorded by the harness |
| Codex App | App-server integration baseline; UI reload must be verified for each installed build |
| ChatGPT subscription HTTP/WS and auxiliary APIs | Fixed-origin transparent relay; model/search queries and future paths covered locally |
| BigModel GLM 5.3 Flash | Standard Responses target shape qualified deterministically; subscription bridge passed an isolated live round; client-owned MCP search is not yet live-qualified |
| OpenCode Go DeepSeek | Existing legacy integration supported; generic template, Code mode and multi-agent v2 are not qualified |
| ai.feei GPT 5.6 Sol / GPT 6 Astra Responses | Built-in configuration presets; live result belongs to each candidate report |
| Generic OpenAI-compatible Responses | Configuration support; provider capability requires live probe |
| Generic OpenAI-compatible Chat Completions | Configuration support with JSON function tools |
| Linux / Windows | Not supported in v0.5.3 |
| Runtime configuration schema 3 | Preserved; active Router space materializes into the existing format |
| Configuration-space schema 1 | Local immutable revisions and one switch transaction |
| Integration state schema 4 | Links protected official and materialized Router revisions |

The DeepSeek preset records the accepted provider-model combination and is explicitly legacy-only. A configured Responses/freeform capability is not sufficient to enable generic-template behavior until the real Provider accepts that Codex payload.

New eligible App-enabled third-party models use `codex-general-v1`; protocol capabilities, rather than GPT naming, gate code mode and direct multi-agent v2 metadata. Chat Completions and models without freeform tools require explicit `legacy`. Existing configurations do not migrate. Official snapshots, Lite, standalone search and cache affinity remain opt-in.

Gateway capability and live channel health are qualified independently. Deterministic local fixtures can qualify routing, identity, protocol, lifecycle, tools, history, and performance invariants even when a real Provider is unavailable. A live channel is reported separately as `HEALTHY`, `EXTERNAL_DEGRADED`, `GATEWAY_DEFECT`, or `UNVERIFIED`; only `HEALTHY` belongs in a ready set, while a Gateway-owned defect still fails the Core gate.

## Custom providers and the client tool surface

The official ChatGPT backend can provide its own server-side tool surface. A target declared with `wireApi: responses` and `useResponsesLite: false` cannot rely on that, so the Codex client sends the tool definitions needed by the third-party provider.

On an install with Codex Apps connected, that surface is dominated by the app namespaces rather than by the built-in tools. Measured on one such install with a trivial prompt, one request to a custom target carried 21 tool definitions totalling 306 KB, of which about 293 KB was ten `mcp__codex_apps__*` namespaces (figma, github, gmail, alpaca, sites, tavily_ai, plugin_management, codex_document_control, safety_settings, hotline) and roughly 8 KB was built-in tools (`exec_command`, `apply_patch`, `view_image`, and similar). The provider reported 97,610 input tokens for that turn, against 16,197 for the same prompt on an official model.

The generic third-party template narrows only confirmed structured Plugin tools. The standard allowlist is `github`, `figma`, `sites`, and `connected_documents`; the last identity covers `spreadsheets` and `codex_document_control`. Codex built-ins, `codex_app`, `cua_repl`, router search, and user-configured MCP stay available. Unknown or colliding sources are passed and diagnosed rather than guessed. Existing non-GPT and legacy targets keep their previous behavior until explicitly updated.

Consequences and limits:

- Allowed Plugin schemas and all core/user-MCP schemas still count toward the third-party context. The policy reduces known unnecessary Plugin overhead; it does not promise a fixed token reduction.
- New eligible third-party App targets materialize `standard-tools`, code mode and multi-agent v2; standalone search remains disabled until explicitly selected.
- `lite-search` is an explicit Responses Lite opt-in. Current Codex requires its `input[].additional_tools` / `web.run` carrier for standalone search, but the observed Lite Plugin/MCP surface is reduced and is not claimed as full tool compatibility. Both carriers remain covered by the same Plugin policy where their tools are present.
- When an existing task switches from another Provider to `lite-search`, the router removes historical Lite declarations and restores only the current request's `additional_tools` carrier. Core tools and every client-provided tool that passes the existing Plugin policy therefore remain callable after the switch; this does not upgrade the reduced Lite profile into the full `standard-tools` surface.
- A forbidden direct Plugin call is stopped before client execution. Indirect use through shell/code, unrecognized sources, and tool names preserved inside historical prose are outside this guarantee.
- Chat Completions cannot carry namespace tools and continues to omit them with a metadata-only diagnostic after the Plugin policy has run.

## Standalone web search

An explicit `subscriptionSearch.delivery: "standard-tool"` is the model-family-neutral alternative for third-party Standard Responses targets. It exposes subscription search as one ordinary function only when the current Codex request enables search, executes the call at the fixed OpenAI destination with subscription identity, and returns bounded untrusted results through the existing tool loop. It does not turn on Lite, Provider-native hosted search, or `/v1` subscription access. User MCP search remains client-owned and may be deferred behind the current Codex `tool_search` discovery function. See [universal search](universal-search.md).

The effective `standaloneSearch` policy controls whether the generated Codex catalog advertises the client's standalone search capability. It is intentionally separate from `capabilities.nativeWebSearch`, which declares a provider-hosted tool embedded in model generation. Current Codex carries standalone search as Responses Lite `web.run`; `standard-tools` therefore disables it, while explicit `lite-search` requires an active source. A mismatched top-level hosted-search request to a target without declared native hosted search fails instead of executing on an unintended provider. New ai.feei targets created by the CLI default to `standard-tools`; explicit `lite-search` normally inherits the `openai-gpt` subscription source. Native hosted search remains disabled.

Search only works when the Codex runtime, selected catalog model, and user search setting all allow it. The router does not override a user-disabled setting. Official models are forced to subscription search. A third-party GPT `lite-search` target may use subscription search or explicitly select a compatible Provider endpoint; `standard-tools` does not advertise standalone search. App-absent legacy GPT targets keep their existing default, while explicitly App-disabled GPT targets do not inherit the space default or the legacy native-search advertisement. An explicit target policy or legacy App search alias retains its documented higher precedence, although Provider search still requires an App-enabled Responses target. Non-GPT and other legacy targets keep their old behavior. A Provider endpoint is never inferred from a model name or `/models` response, and a failed source never falls back to another source.

Each model turn freezes a correlation-scoped search route. `/subscription/v1/alpha/search` validates the subscription identity first, then either reaches the fixed OpenAI backend or replaces that identity with the selected Provider key. Ambiguous or missing scoped routes fail explicitly. `/v1/alpha/search` remains unavailable, so a local API key cannot acquire subscription identity. This first version still requires a valid Codex subscription login even when the selected search source is a Provider.

Official HTTP and secure WebSocket relays share the machine's proxy boundary. WebSocket-specific `WS_PROXY` / `WSS_PROXY` take precedence when present; `HTTP_PROXY` / `HTTPS_PROXY` are compatible fallbacks, `ALL_PROXY` remains the generic fallback, and `NO_PROXY` is honored. When the installer process explicitly uses `NODE_EXTRA_CA_CERTS`, the managed service and one-shot switcher preserve that CA file path together with the proxy variables; Provider credential variables and arbitrary `NODE_OPTIONS` are never copied. Official WSS combines Node's default and system CA sets where the runtime supports that API, keeps certificate and hostname verification enabled, and logs only an allowlisted TLS error code. Proxy credentials are handled by the proxy agent and are never copied into the official end-to-end header set or Router logs.

Official continuation is provenance-aware across HTTP and WebSocket. A response observed on the opaque official relay may continue natively and remains byte-transparent. A response created by the Engine or another local protocol operation is replayed from encrypted history instead; its local ID is never forwarded as an upstream `previous_response_id`. Legacy retained records without provenance take the safe replay path. This distinction prevents a tool-result continuation from failing merely because its predecessor was generated by the Gateway rather than by the active opaque relay session.

Completed dynamic tool-search history is portable across official and third-party Responses targets and into Chat Completions through a fixed schema-free marker. The destination does not receive the original search query, provider execution metadata, IDs, tool names, descriptions, or schemas. Ordinary function/custom-tool calls and results remain portable. An incomplete or ambiguous pair fails as `tool_search_history_incomplete` without fallback or retry. This does not make an old opaque official compaction portable when the Router never observed its full source history; that case still requires an existing portable checkpoint.

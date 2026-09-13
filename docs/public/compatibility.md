# Compatibility matrix

| Component | v0.2.1 status |
|---|---|
| macOS | Supported |
| Node.js 22 | Supported; Node currently labels built-in SQLite experimental |
| Codex CLI 0.153.4 | Automated and local integration baseline |
| Codex App | App-server integration baseline; UI reload must be verified for each installed build |
| ChatGPT subscription Responses | Supported |
| OpenCode Go Responses | Supported for the accepted DeepSeek target |
| Generic OpenAI-compatible Responses | Configuration support; provider capability requires live probe |
| Generic OpenAI-compatible Chat Completions | Configuration support with JSON function tools |
| Linux / Windows | Not supported in v0.2.1 |

The DeepSeek preset records the accepted provider-model combination. A configured context window or capability does not prove an unrelated provider offers the same behavior.

## Custom providers carry the client tool surface

The official ChatGPT backend receives Codex requests in Responses Lite mode: the client sends no tool definitions and the backend supplies them. A target declared with `wireApi: responses` and `use_responses_lite: false` cannot rely on that, so the Codex client sends the whole tool surface it knows about to the provider instead.

On an install with Codex Apps connected, that surface is dominated by the app namespaces rather than by the built-in tools. Measured on one such install with a trivial prompt, one request to a custom target carried 21 tool definitions totalling 306 KB, of which about 293 KB was ten `mcp__codex_apps__*` namespaces (figma, github, gmail, alpaca, sites, tavily_ai, plugin_management, codex_document_control, safety_settings, hotline) and roughly 8 KB was built-in tools (`exec_command`, `apply_patch`, `view_image`, and similar). The provider reported 97,610 input tokens for that turn, against 16,197 for the same prompt on an official model.

Consequences:

- The fixed overhead is charged to the custom provider on every request and appears in the App's context meter. It is not a router defect: the router forwards what Codex sends and adds only the internal search and page-fetch functions when a target needs the search fallback.
- Setting `use_responses_lite: true` on a custom target does not remove the overhead. Measured: the `tools` array becomes empty but the same definitions are inlined into the request input, so the payload size and the tokens the third-party model reads stay the same.
- The reduction that works is user-side: disconnect the Codex Apps (or plugins and skills) that a session does not need. Dropping the ten namespaces above removes about 293 KB, roughly 80,000 tokens, from every request to a custom target.
- Chat Completions targets already drop `namespace` tools, because their JSON function protocol cannot carry them, and log `unsupported_tool_definitions_omitted`. Responses targets forward them.

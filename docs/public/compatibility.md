# Compatibility matrix

| Component | v0.2.0 status |
|---|---|
| macOS | Supported |
| Node.js 22 | Supported; Node currently labels built-in SQLite experimental |
| Codex CLI 0.153.4 | Automated and local integration baseline |
| Codex App | App-server integration baseline; UI reload must be verified for each installed build |
| ChatGPT subscription Responses | Supported |
| OpenCode Go Responses | Supported for the accepted DeepSeek target |
| Generic OpenAI-compatible Responses | Configuration support; provider capability requires live probe |
| Generic OpenAI-compatible Chat Completions | Configuration support with JSON function tools |
| Linux / Windows | Not supported in v0.2.0 |

The DeepSeek preset records the accepted provider-model combination. A configured context window or capability does not prove an unrelated provider offers the same behavior.

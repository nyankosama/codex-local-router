# Data flow and privacy

| Data | Destination | Persistence |
|---|---|---|
| Official subscription request or auxiliary API | Fixed ChatGPT Codex backend | Successful Responses are observed into encrypted local history; auxiliary bodies are not archived |
| Custom-model request | The target's configured third-party provider | Encrypted local history plus that provider's processing |
| Standalone search from a custom GPT turn | ChatGPT Codex backend only | Search result may enter the custom model's subsequent conversation input |
| ChatGPT credential | Official subscription adapter only | Managed by Codex, not copied into router configuration |
| Third-party credential | Its configured provider only | Environment variable or macOS Keychain |
| Conversation and tool history | Local SQLite archive | AES-256-GCM until explicit prune |
| Images | Capable target, or a configured source model for lossy description | Original stays encrypted locally |
| Operational logs | User-level log directory | Metadata only; no body, image, credential, or encrypted state |
| Configuration-space revision | Local Router data directory only | Immutable Router policy or managed official projection, content-addressed by SHA-256 |
| Space-switch transaction | Local Router data directory only | Source/target refs and hashes, stage, sanitized failure, and Router config recovery data; no Codex auth or user MCP/prompt/history body |

Before a third-party GPT generation request leaves the machine, the router may remove confirmed Plugin tool definitions outside the effective allowlist. Codex core tools, user-configured MCP tools, and uncertain/colliding sources remain. The diagnostic records policy reason, counts, and normalized Plugin identities only; it does not record tool schemas. The filter does not modify prompt text, Skills, Hooks, or historical tool content.

This boundary intentionally treats search and generation differently:

```text
Codex App
  |-- /subscription/v1/alpha/search --> OpenAI subscription backend
  `-- custom model generation -------> configured third-party provider
             ^ search results can be included in the next turn input
```

The subscription bearer and account header are retained only on the fixed official leg. Provider credentials are retained only on their configured provider leg. The router never upgrades a local `/v1` API-key request into subscription identity.

The default archive quota is 10 GiB and is measured from the archive files on disk. At 80% the router logs a warning. At the quota it rejects new durable history rather than deleting old content. Export never includes provider or subscription credentials.

The router is a local routing boundary, not an anonymity layer. A custom provider receives the conversation content required for that request. Users must decide whether the provider is appropriate for their data.

Space switching changes only Router-managed Codex keys and Router-owned configuration fields. User MCP, Skills, Hooks, prompts, history, and authentication files remain in place. If Codex App is open, the switch has no data-plane effect until the App exits normally and the pending transaction succeeds.

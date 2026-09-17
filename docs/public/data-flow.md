# Data flow and privacy

| Data | Destination | Persistence |
|---|---|---|
| Official subscription request or auxiliary API | Fixed ChatGPT Codex backend | Successful Responses are observed into encrypted local history; auxiliary bodies are not archived |
| Custom-model request | The target's configured third-party provider | Encrypted local history plus that provider's processing |
| Standalone search from a `lite-search` custom GPT turn | Selected ChatGPT Codex backend or explicit Provider endpoint; `standard-tools` does not advertise it | Search result may enter the custom model's subsequent conversation input |
| ChatGPT credential | Official subscription adapter only | Managed by Codex, not copied into router configuration |
| Third-party credential | Its configured provider only | Environment variable or macOS Keychain |
| Third-party GPT cache affinity | Opaque `clr-pc-v1-*` key to that configured Provider only | Dedicated Keychain secret plus bounded, derived-only encrypted lineage state |
| Conversation and tool history | Local SQLite archive | AES-256-GCM until explicit prune |
| Explicit rollout recovery | Selected local Codex JSONL files to the same encrypted archive | Streams metadata/events locally; writes only validated portable checkpoints |
| Images | Capable target, or a configured source model for lossy description | Original stays encrypted locally |
| Operational logs | User-level log directory | Metadata only; no body, image, credential, or encrypted state |
| Configuration-space revision | Local Router data directory only | Immutable Router policy or managed official projection, content-addressed by SHA-256 |
| Space-switch transaction | Local Router data directory only | Source/target refs and hashes, stage, sanitized failure, and Router config recovery data; no Codex auth or user MCP/prompt/history body |

Before a third-party generation request using the standard policy leaves the machine, the router may remove confirmed structured Plugin definitions outside the effective allowlist. Codex core tools, user-configured MCP tools, uncertain/colliding sources and definitions embedded in code-mode documentation remain. Diagnostics never record schemas. Prompt text, Skills, Hooks and historical tool content are unchanged.

When `gateway-opaque` cache affinity is enabled, the original client cache key and Codex account/thread/turn/session/install metadata stay local. The router derives a Provider/model/lineage-scoped HMAC key without hashing the prompt, freezes it for the turn, and sends only that opaque key. Logs contain source enums and token counts/ratios, never the key or prompt. A pooled relay can use the opaque key for stable upstream-account or cache-shard selection; see the [Provider contract](provider-cache-affinity.md).

This boundary intentionally treats search and generation differently:

```text
Codex App
  |-- custom model turn -------------> freezes a search-route lease
  |-- /subscription/v1/alpha/search --> OpenAI subscription backend (default)
  |                                `--> explicit Provider search endpoint
  `-- custom model generation --------> configured third-party provider
             ^ search results can be included in the next turn input
```

The subscription bearer and account header are retained only on the fixed official leg. Provider credentials are retained only on their configured provider leg. When Provider search is selected, the Router removes the subscription identity and inserts only that Provider's key. It stores only the route source, target, endpoint reference, credential-reference name, configuration digest, correlation identifiers, and TTL—not the search query, result, or credential. The router never upgrades a local `/v1` API-key request into subscription identity.

There is no automatic failover between subscription, Provider, Tavily, or Exa search. The selected source either succeeds or returns a typed error. Search observations used by the acceptance harness stay in memory and persist only response/URL hashes, byte counts, destinations, and booleans.

The deterministic L0-L2 and capability-profile qualification gates do not use this production data flow. They give Codex a temporary synthetic identity, strip ambient network and credential variables from its child process, and inject local official, Provider, and search transports. Explicit live canaries are separate, budgeted operations; they copy only the required auth material into a temporary 0600 file and persist metadata-only receipts.

The default archive quota is 10 GiB and is measured from the archive files on disk. At 80% the router logs a warning. At the quota it rejects new durable history rather than deleting old content. Export never includes provider or subscription credentials.

The router is a local routing boundary, not an anonymity layer. A custom provider receives the conversation content required for that request, including any standalone-search result that Codex includes in a later generation. Users must decide whether that provider is appropriate for their data.

Space switching changes only Router-managed Codex keys and Router-owned configuration fields. User MCP, Skills, Hooks, prompts, history, and authentication files remain in place. If Codex App is open, the switch has no data-plane effect until the App exits normally and the pending transaction succeeds.

Rollout recovery makes no model or network request and never modifies the source JSONL. Preview output and recovery diagnostics contain only thread references, hashes, counts, status and error types. Message, tool, compaction and credential contents remain local and encrypted.

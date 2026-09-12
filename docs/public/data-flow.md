# Data flow and privacy

| Data | Destination | Persistence |
|---|---|---|
| Official GPT request | ChatGPT subscription backend | Encrypted local history plus upstream processing |
| Custom-model request | The target's configured third-party provider | Encrypted local history plus that provider's processing |
| ChatGPT credential | Official subscription adapter only | Managed by Codex, not copied into router configuration |
| Third-party credential | Its configured provider only | Environment variable or macOS Keychain |
| Conversation and tool history | Local SQLite archive | AES-256-GCM until explicit prune |
| Images | Capable target, or a configured source model for lossy description | Original stays encrypted locally |
| Operational logs | User-level log directory | Metadata only; no body, image, credential, or encrypted state |

The default archive quota is 10 GiB. At 80% the router logs a warning. At the quota it rejects new durable history rather than deleting old content. Export never includes provider or subscription credentials.

The router is a local routing boundary, not an anonymity layer. A custom provider receives the conversation content required for that request. Users must decide whether the provider is appropriate for their data.

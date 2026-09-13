# Architecture

```text
Codex request
  -> loopback HTTP or WebSocket
  -> origin, local API, or trusted subscription authentication
  -> immutable turn configuration lease
  -> official subscription route or configured custom target
  -> protocol and provider adapter
  -> normalized stream
  -> encrypted history transaction
  -> completion event
```

Official GPT model IDs accepted from the Codex model catalog are routed only to the ChatGPT Codex subscription backend. App-enabled custom model IDs map to one configured target, which includes the upstream model, provider, protocol, window, modalities, tool behavior, reasoning levels, and compression mode. Subscription headers are never copied to a custom provider. OpenCode-specific session headers are emitted only by its adapter.

Each provider has a concurrency limit. A slow provider cannot consume every global request slot. Responses and Chat Completions share the same normalized event and durable-history boundary, while channel-specific stream fixes remain provider-scoped.

The service listens only on loopback. Raw `/v1` access can require an independent local bearer token. `/subscription/v1` validates the bearer and optional account claim against the current trusted Codex credential document. The router supports Codex file and macOS Keychain credential stores; ephemeral credentials cannot provide restart-stable identity. File credentials are re-read when `auth.json` changes, Keychain credentials are re-read every 30 seconds, and any bearer mismatch forces an immediate re-read before the request is rejected.

History uses SQLite WAL and AES-256-GCM. Version 3 stores encrypted events once and records immutable prefix references and suffixes for each version. A v2 archive is copied with SQLite's consistent backup API, retained as a recovery snapshot, and remains readable without eagerly rewriting every historical version; new versions use incremental storage immediately. Original history and the active model view remain separate. Completion is published only after the response index and history version commit together.

Codex owns compaction decisions. The router executes `native`, `summary`, or `unsupported` behavior declared by the source target. Cross-model requests try full history first when capacity is uncertain. A source-model migration summary is permitted once only for an adapter-classified context-limit rejection before output.

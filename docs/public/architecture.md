# Architecture

```text
immutable space revision
        | validate + candidate preflight
        v
pending hash-bound transaction -- App running --> one-shot switcher waits
        | App closed + Gateway turns drained
        v
materialize config + Codex integration + service state
        | verify all three
        `--> commit active/previous pointers last
```

Configuration spaces form a control plane around the request data plane below. The transaction records source and target revision hashes plus expected file hashes. It never force-quits or reopens Codex App. Concurrent edits fail closed; rollback writes only when files still match the transaction's own hashes. Machine access, history, listener, and resource-limit fields remain global and are not swapped.

```text
Codex request
  -> loopback HTTP or WebSocket
  -> origin, local API, or trusted subscription authentication
  -> immutable turn configuration lease
  -> subscription classifier
       |-- explicit custom model / virtual history -> Engine
       `-- other /subscription/v1 traffic --------> official relay
  -> Engine: target policy -> protocol adapter -> normalized stream
  -> Relay: fixed official origin -> unchanged body/message and status
  -> encrypted history transaction
  -> completion event
```

An App-enabled custom model ID maps to exactly one configured target, which includes the upstream model, provider, protocol, window, modalities, tool behavior, reasoning levels, and compression mode. This explicit map is evaluated first. Every other model under `/subscription/v1/responses` is left for the official backend to accept or reject; the router no longer needs a complete list of official model IDs.

All other `/subscription/v1/**` HTTP and WebSocket traffic uses the dedicated official relay. Its destination is fixed to `https://chatgpt.com/backend-api/codex/`; configuration and request input cannot override it. The relay preserves the query, method, response status, entity bytes, compression, error body, and WebSocket message payload/type/order. It strips hop-by-hop headers and proxy credentials, rejects absolute URLs and path traversal, and does not follow redirects or retry. HTTP chunking, WebSocket masking, and handshake bytes remain hop-by-hop rather than end-to-end contracts. `/v1/**` keeps independent local authentication and third-party routing; `/v1/alpha/search` is not opened by this feature.

Ordinary official Responses are observed through a bounded side path so successful completed turns can join the encrypted cross-provider history. Observation or archive failure never changes the official response. A later cross-provider switch waits only for the bounded observation commit and fails with `history_observation_incomplete` when the required chain is absent. Router-generated virtual response IDs and checkpoints always return to the Engine and are never sent to the official backend.

Subscription headers are never copied to a custom provider. OpenCode-specific session headers are emitted only by its adapter. Standalone search under the subscription namespace always goes to OpenAI even when the model-generation turn uses a third-party GPT target.

## Tool-policy boundary

The target is selected before Plugin filtering, and every retry/fallback derives a fresh view from the original request. Official targets are transparent. Third-party GPT targets use the standard allowlist unless explicitly overridden; non-GPT and legacy targets remain transparent.

Source classification combines a trusted built-in map, enabled Plugin manifests, and read-only parsing of the user's MCP configuration. No Plugin is started merely to identify its tools, and a generic `mcp__*` prefix is not treated as proof that a tool belongs to a Plugin. Confirmed user MCP and Codex core sources pass; unknown or colliding sources pass with diagnostics. The per-turn configuration/source snapshot is fixed, and filtering never rewrites archived input, historical tool results, Skills, Hooks, or prompts.

Each provider has a concurrency limit. A slow provider cannot consume every global request slot. Responses and Chat Completions share the same normalized event and durable-history boundary, while channel-specific stream fixes remain provider-scoped.

The service listens only on loopback. Raw `/v1` access can require an independent local bearer token. `/subscription/v1` validates the bearer and optional account claim against the current trusted Codex credential document. The router supports Codex file and macOS Keychain credential stores; ephemeral credentials cannot provide restart-stable identity. File credentials are re-read when `auth.json` changes, Keychain credentials are re-read every 30 seconds, and any bearer mismatch forces an immediate re-read before the request is rejected.

History uses SQLite WAL and AES-256-GCM. Version 3 stores encrypted events once and records immutable prefix references and suffixes for each version. A v2 archive is copied with SQLite's consistent backup API, retained as a recovery snapshot, and remains readable without eagerly rewriting every historical version; new versions use incremental storage immediately. Original history and the active model view remain separate. Completion is published only after the response index and history version commit together.

The protected official space stores only the four Router-managed Codex settings and a hashed local catalog snapshot. Leaving official first compares the live managed projection and appends a new official revision if it changed; `official@1` is never replaced. Router revisions contain normalized Router-owned policy and credential references, not Codex account or extension data.

Codex owns compaction decisions. The router executes `native`, `summary`, or `unsupported` behavior declared by the source target. Cross-model requests try full history first when capacity is uncertain. A source-model migration summary is permitted once only for an adapter-classified context-limit rejection before output.

# CLI reference

The v0.2.1 executable is `codex-local-router`. The previous `llm-auto-gateway` name remains an equivalent compatibility alias.

| Command | Purpose |
|---|---|
| `setup` | Discover Codex, create or migrate configuration, prepare integration, and start the service |
| `status` | Show configuration, service, integration, catalog, and pending App state |
| `provider add/list/edit/remove` | Manage provider endpoints, adapters, credentials, and concurrency |
| `model add/list/edit/remove/probe` | Manage target capabilities and optional live verification |
| `integration enable/sync/status/disable` | Apply or remove the managed Codex configuration transaction |
| `doctor` | Read-only checks; never calls a model |
| `logs` | Read redacted service logs |
| `service start/stop/restart/status` | Manage the macOS LaunchAgent |
| `upgrade` | Health-check a candidate, drain active turns, and restart safely |
| `rescue --subscription` | Restore pre-integration subscription settings without contacting the Gateway |
| `history inspect/export/import/resume/prune` | Inspect, move, continue, or explicitly remove history |
| `uninstall` | Remove integration and service while retaining history and credentials |

### provider and model flags

`provider add|edit` requires `--id` and `--base-url`, and accepts `--adapter` (`opencode-go` or `openai-compatible`, default `openai-compatible`), `--api-key-env`, `--credential-prompt` / `--credential-stdin` with `--keychain-service` / `--keychain-account`, `--concurrency`, and `--responses-endpoint` / `--chat-endpoint`. `provider remove` refuses while a target uses the provider.

`model add|edit` requires `--id` and accepts `--provider`, `--upstream-model`, `--protocol` (`responses` or `chat_completions`), `--context-window`, `--max-context-window`, `--input-modalities`, `--compression` (`native`, `summary`, or `unsupported`), `--display-name`, `--app-model`, `--reasoning-levels`, `--preset`, `--no-streaming`, `--no-tools`, `--freeform-tools`, `--native-search`, and `--no-app`. `model probe --id ID` validates configuration only; add `--live` to spend quota on one real request through the Gateway. Provider and model changes take effect after `codex-local-router service restart`; `codex-local-router integration sync` refreshes the Codex App catalog.

The service is a login-scoped LaunchAgent (`~/Library/LaunchAgents/com.nyankosama.codex-local-router.plist`) with `RunAtLoad`, a `KeepAlive` rule that restarts it after an unsuccessful exit, and a five second throttle. It therefore starts when you log in, recovers from a crash on its own, and stays down after a clean exit so that `service stop` and `upgrade` remain in effect. It is not a LaunchDaemon: the archive key and provider credentials live in macOS Keychain, which needs a logged-in session. The plist records the Node.js path used at install time, so after changing your Node.js installation run `codex-local-router upgrade` (or `service stop` then `service start`) to rewrite it. On macOS 13 and later, confirm the background item is allowed under System Settings, General, Login Items and Extensions, "Allow in the Background".

All query commands accept `--json`. Mutating commands show a diff or scope and ask for confirmation; automation can pass `--yes`. `model probe` is configuration-only unless `--live` is present. `history prune` is a dry run unless both `--apply` and confirmation are present.

`setup` and `provider add/edit` accept `--credential-prompt` for hidden Keychain input or `--credential-stdin` for non-interactive input. Environment references work for foreground processes, but the managed LaunchAgent does not import shell environment variables; `doctor` reports this as a warning.

Encrypted history packages use `--passphrase-env NAME`. Plaintext export requires `--plaintext`. `history resume` creates a new Codex session and installs archived tool calls as completed facts; it does not alter the original rollout or reuse its session ID.

Errors include a stable code, correlation ID, impact, and a diagnostic next command.

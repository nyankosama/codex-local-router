# CLI reference

The v0.2.0 executable is `llm-auto-gateway`.

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

All query commands accept `--json`. Mutating commands show a diff or scope and ask for confirmation; automation can pass `--yes`. `model probe` is configuration-only unless `--live` is present. `history prune` is a dry run unless both `--apply` and confirmation are present.

`setup` and `provider add/edit` accept `--credential-prompt` for hidden Keychain input or `--credential-stdin` for non-interactive input. Environment references work for foreground processes, but the managed LaunchAgent does not import shell environment variables; `doctor` reports this as a warning.

Encrypted history packages use `--passphrase-env NAME`. Plaintext export requires `--plaintext`. `history resume` creates a new Codex session and installs archived tool calls as completed facts; it does not alter the original rollout or reuse its session ID.

Errors include a stable code, correlation ID, impact, and a diagnostic next command.

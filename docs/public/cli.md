# CLI reference

The executable is `codex-local-router`. The previous `llm-auto-gateway` name remains an equivalent compatibility alias.

| Command | Purpose |
|---|---|
| `setup` | Discover Codex, create or migrate configuration, prepare integration, and start the service |
| `status` | Show configuration, service, integration, catalog, and pending App state |
| `space init/list/current/show/history/diff/create/capture/set-default-model/set-search-source/use/rollback/resume/cancel` | Version, inspect, activate, recover, and roll back complete configuration combinations |
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

`provider add|edit` requires `--id` and `--base-url`, and accepts `--adapter` (`opencode-go` or `openai-compatible`, default `openai-compatible`), `--api-key-env`, `--credential-prompt` / `--credential-stdin` with `--keychain-service` / `--keychain-account`, `--concurrency`, `--responses-endpoint` / `--chat-endpoint`, and `--standalone-search-endpoint RELATIVE_PATH`. `provider edit --no-standalone-search-endpoint` removes that endpoint. Absolute, query-bearing, fragment-bearing, traversal, encoded-traversal, and cross-origin search paths are rejected. `provider remove` refuses while a target uses the provider. Provider and model mutations accept `--space NAME`; without it they edit the active Router space, and refuse when `official` is active.

`model add|edit` requires `--id` and accepts `--provider`, `--upstream-model`, `--protocol` (`responses` or `chat_completions`), `--context-window`, `--max-context-window`, `--input-modalities`, `--compression` (`native`, `summary`, or `unsupported`), `--display-name`, `--app-model`, `--reasoning-levels`, `--preset`, `--no-streaming`, `--no-tools`, `--freeform-tools`, `--native-search`, `--search-source subscription|provider|disabled`, `--supports-search-tool` / `--no-supports-search-tool`, `--responses-lite` / `--no-responses-lite`, `--model-family` (`openai-gpt` or `other`), `--plugin-policy` (`passthrough`, `third-party-gpt-default`, or `allowlist`), `--allowed-plugins`, and `--no-app`. The old supports-search flags map to subscription/disabled and cannot be combined with `--search-source`. Active standalone search defaults to Responses Lite because current Codex exposes it as `web.run`; an explicit `--no-responses-lite` conflict is rejected. `--native-search` remains an independent embedded hosted-search capability. `--allowed-plugins` is a comma-separated list used only with the explicit `allowlist` mode.

`model list --json` and the non-live `model probe --id ID --json` report the normalized model family, effective Plugin policy, effective standalone-search source/reason, App advertisement, Provider-endpoint status, credential readiness, allowlist, and source-recognition status. `status --json` and `doctor --json` include the same search summary. A live probe is still opt-in: add `--live` to spend quota on one real request through the Gateway. A confirmed edit appends an immutable revision. Editing the active space starts its activation transaction; editing a dormant space only appends the revision.

## Configuration spaces

For end-to-end workflows, pending-switch behavior, drift recovery, and the exact data boundary, see the [configuration-space guide](configuration-spaces.md).

References use `NAME@REV`; omitting `@REV` resolves the latest immutable revision. `official` is reserved and cannot be deleted, renamed, or edited through Provider/model commands. `space rollback` targets the previous successful activation pointer, not the numerically previous revision.

`space capture [NAME]` is the only command that adopts validated manual drift from the materialized Router config. `space set-default-model MODEL [--space NAME]` changes the persistent default; choosing another model for one App or CLI session does not create a revision. Only one switch transaction can exist. `space resume` retries the same hash-bound transaction, while `space cancel` removes a pending or already-recovered transaction but never discards unresolved recovery material.

`space set-search-source subscription|provider|disabled [--space NAME]` changes the third-party GPT default in that space. Provider mode still requires each selected target to satisfy its Provider endpoint and Responses/App constraints; there is no automatic fallback.

When Codex App is running, a switch writes only its pending transaction and installs `com.nyankosama.codex-local-router.space-switcher`. This LaunchAgent has `KeepAlive=false`: it waits for normal App exit, executes once, and removes itself after success. It neither force-quits nor reopens Codex App. `service start` refuses while `official` is active.

The Router service is a login-scoped LaunchAgent (`~/Library/LaunchAgents/com.nyankosama.codex-local-router.plist`) with `RunAtLoad`, a `KeepAlive` rule that restarts it after an unsuccessful exit, and a five second throttle. It therefore starts when you log in, recovers from a crash on its own, and stays down after a clean exit so that `service stop` and `upgrade` remain in effect. It is separate from the one-shot space switcher. Neither is a LaunchDaemon: the archive key and provider credentials live in macOS Keychain, which needs a logged-in session. The plist records the Node.js path used at install time, so after changing your Node.js installation run `codex-local-router upgrade` (or `service stop` then `service start`) to rewrite it. On macOS 13 and later, confirm the background item is allowed under System Settings, General, Login Items and Extensions, "Allow in the Background".

All query commands accept `--json`. Mutating commands show a diff or scope and ask for confirmation; automation can pass `--yes`. `model probe` is configuration-only unless `--live` is present. `history prune` is a dry run unless both `--apply` and confirmation are present.

`setup` and `provider add/edit` accept `--credential-prompt` for hidden Keychain input or `--credential-stdin` for non-interactive input. Environment references work for foreground processes, but the managed LaunchAgent does not import shell environment variables; `doctor` reports this as a warning.

Encrypted history packages use `--passphrase-env NAME`. Plaintext export requires `--plaintext`. `history resume` creates a new Codex session and installs archived tool calls as completed facts; it does not alter the original rollout or reuse its session ID.

Errors include a stable code, correlation ID, impact, and a diagnostic next command.

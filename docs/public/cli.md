# CLI reference

New eligible third-party App models use `codex-general-v1`; see [third-party templates](third-party-templates.md). Multi-agent metadata can be configured directly with `--multi-agent-version v1|v2|client-default` or pinned from an official model with the existing snapshot commands.

The executable is `codex-local-router`. The previous `llm-auto-gateway` name remains an equivalent compatibility alias.

Fresh `setup` requires an explicit `--preset`; a complete existing configuration can instead be supplied with `--config`. Omitting both fails before writing configuration, credentials, spaces, or service files. Provider and target IDs default to neutral names when the selected preset does not define them.

| Command | Purpose |
|---|---|
| `setup` | Discover Codex, create or migrate configuration, prepare integration, and start the service |
| `status` | Show configuration, service, integration, catalog, and pending App state |
| `space init/list/current/show/history/diff/create/capture/set-default-model/set-search-source/use/rollback/resume/cancel` | Version, inspect, activate, recover, and roll back complete configuration combinations |
| `provider add/list/edit/remove` | Manage provider endpoints, adapters, credentials, and concurrency |
| `model add/list/edit/remove/probe` | Manage target capabilities and optional live verification |
| `model sync-instructions --ids ID,... [--space NAME]` | Preview or atomically pin corresponding official instruction snapshots; add `--yes` to confirm |
| `model set-tool-mode --ids ID,... --tool-mode code_mode_only\|default [--space NAME]` | Preview or atomically set/clear code mode for multiple models; add `--yes` to confirm |
| `model apply-template --ids ID,... --template codex-general-v1\|legacy [--space NAME]` | Preview or materialize a template for existing targets |
| `space set-third-party-template codex-general-v1\|legacy` | Set the creation default without rewriting existing targets |
| `integration enable/sync/status/disable` | Apply or remove the managed Codex configuration transaction |
| `doctor` | Read-only checks; never calls a model |
| `logs` | Read redacted service logs |
| `service start/stop/restart/status` | Manage the macOS LaunchAgent |
| `upgrade` | Health-check a candidate, drain active turns, and restart safely |
| `rescue --subscription` | Restore pre-integration subscription settings without contacting the Gateway |
| `history inspect/recover/export/import/resume/prune` | Inspect, reconstruct, move, continue, or explicitly remove history |
| `uninstall` | Remove integration and service while retaining history and credentials |

### provider and model flags

`model add|edit --tool-mode code_mode_only|default` sets or clears the explicit code-mode catalog override. It requires an App-enabled third-party Responses target with tool calling and freeform tools. Diagnostics expose the mode and the `structured-only; embedded-exec-opaque` filtering boundary. Qualify the actual tool-context size before activation; embedded exec schemas are not trimmed.

Instruction sources are mutually exclusive: `--instructions-template codex-generic-v1`, `--instructions-file FILE`, or `--instructions-from OFFICIAL_MODEL|none`. Model diagnostics include source/hash/status/update availability without printing text.

`model add|edit` also accepts `--subscription-search standard-tool|disabled`. The standard-tool bridge is distinct from `--search-source`, `--native-search`, and Lite. Exact GLM-style standardization can additionally use `--no-freeform-tools`, `--shell-type shell_command|unified_exec`, and `--default-reasoning-level LEVEL`; conflicting capability declarations fail before a space revision is written. `--native-migration-summary` / `--no-native-migration-summary` explicitly enable or disable a one-call, tool-free migration summary for trusted official opaque compaction windows; enabling it requires `--compression summary`.

`provider add|edit` requires `--id` and `--base-url`, and accepts `--adapter` (`opencode-go` or `openai-compatible`, default `openai-compatible`), `--api-key-env`, `--credential-prompt` / `--credential-stdin` with `--keychain-service` / `--keychain-account`, `--concurrency`, `--responses-endpoint` / `--chat-endpoint`, `--standalone-search-endpoint RELATIVE_PATH`, and `--prompt-cache-affinity none|gateway-opaque`. `provider edit --no-standalone-search-endpoint` removes that endpoint. Cache affinity is opt-in and applies to compatible third-party Responses targets: `openai-gpt`, or a non-GPT target that explicitly materialized `codex-general-v1`. Absolute, query-bearing, fragment-bearing, traversal, encoded-traversal, and cross-origin search paths are rejected. `provider remove` refuses while a target uses the provider. Provider and model mutations accept `--space NAME`; without it they edit the active Router space, and refuse when `official` is active.

`model add|edit` also accepts `--template codex-general-v1|legacy` and `--multi-agent-version v1|v2|client-default`. New eligible App-enabled third-party targets default to `codex-general-v1`; Chat Completions and targets without freeform tools must select `legacy`. A preset may further restrict qualification: `opencode-go/deepseek-v4.1-flash` currently auto-selects `legacy` when no template is specified and rejects Code-mode or multi-agent overrides. Explicit model flags override materialized template defaults only within the preset's qualified surface. `lite-search` remains an explicit Responses Lite plus search-source choice.

`model list --json` and the non-live `model probe --id ID --json` report the normalized model family, effective Plugin policy, App capability profile/reason/tool surface, effective standalone-search source/reason, App advertisement, Provider-endpoint status, credential readiness, prompt-cache mode/reason/carrier/lineage capability/restart stability, allowlist, and source-recognition status. `status --json` and `doctor --json` include profile, search, and prompt-cache summaries. A live probe is still opt-in: add `--live` to spend quota on one real request through the Gateway. A confirmed edit appends an immutable revision. Editing the active space starts its activation transaction; editing a dormant space only appends the revision.

## Configuration spaces

For end-to-end workflows, pending-switch behavior, drift recovery, and the exact data boundary, see the [configuration-space guide](configuration-spaces.md).

References use `NAME@REV`; omitting `@REV` resolves the latest immutable revision. `official` is reserved and cannot be deleted, renamed, or edited through Provider/model commands. `space rollback` targets the previous successful activation pointer, not the numerically previous revision.

`space capture [NAME]` is the only command that adopts validated manual drift from the materialized Router config. `space set-default-model MODEL [--space NAME]` changes the persistent default; choosing another model for one App or CLI session does not create a revision. Only one switch transaction can exist. `space resume` retries the same hash-bound transaction, while `space cancel` removes a pending or already-recovered transaction but never discards unresolved recovery material.

`space set-search-source subscription|provider|disabled [--space NAME]` changes the third-party GPT default in that space. Provider mode still requires each selected target to satisfy its Provider endpoint and Responses/App constraints; there is no automatic fallback.

When Codex App is running, a switch writes only its pending transaction and installs `com.nyankosama.codex-local-router.space-switcher`. This LaunchAgent has `KeepAlive=false`: it waits for normal App exit, executes once, and removes itself after success. It neither force-quits nor reopens Codex App. `service start` refuses while `official` is active.

The Router service is a login-scoped LaunchAgent (`~/Library/LaunchAgents/com.nyankosama.codex-local-router.plist`) with `RunAtLoad`, a `KeepAlive` rule that restarts it after an unsuccessful exit, and a five second throttle. It therefore starts when you log in, recovers from a crash on its own, and stays down after a clean exit so that `service stop` and `upgrade` remain in effect. It is separate from the one-shot space switcher. Neither is a LaunchDaemon: the archive key and provider credentials live in macOS Keychain, which needs a logged-in session. The plist records the Node.js path used at install time, so after changing your Node.js installation run `codex-local-router upgrade` (or `service stop` then `service start`) to rewrite it. On macOS 13 and later, confirm the background item is allowed under System Settings, General, Login Items and Extensions, "Allow in the Background".

All query commands accept `--json`. Mutating commands show a diff or scope and ask for confirmation; automation can pass `--yes`. `model probe` is configuration-only unless `--live` is present. `history prune` is a dry run unless both `--apply` and confirmation are present.

`setup` and `provider add/edit` accept `--credential-prompt` for hidden Keychain input or `--credential-stdin` for non-interactive input. Environment references work for foreground processes, but the managed LaunchAgent does not import Provider credential variables; it only preserves its proxy variables and an explicitly configured `NODE_EXTRA_CA_CERTS` path. `doctor` reports credential references as a warning.

Encrypted history packages use `--passphrase-env NAME`. Plaintext export requires `--plaintext`. `history resume` creates a new Codex session and installs archived tool calls as completed facts; it does not alter the original rollout or reuse its session ID.

`history recover --thread THREAD_ID [--source ROLLOUT.jsonl]` is a metadata-only preview by default. Add `--yes` only after Codex App is closed and the Gateway is idle. The apply path stops a loaded managed service, rechecks every source hash, commits all exact recoverable checkpoints atomically, and restores the prior service state. `history inspect --thread THREAD_ID --target TARGET_ID --json` reports direct compatibility, summary-needed checkpoints and hard blockers without returning history content. See [fork and compacted-history recovery](compaction-recovery.md).

Errors include a stable code, correlation ID, impact, and a diagnostic next command.

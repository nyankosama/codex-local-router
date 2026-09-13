# Changelog

## Unreleased

## 0.4.0 - 2026-09-13

- Added a general standalone-search policy for third-party OpenAI GPT targets: subscription search by default, explicit Provider or disabled overrides, configuration-space versioning, CLI management, and effective catalog/diagnostic reporting while keeping embedded hosted search separate.
- Added correlation-scoped search-route leases for HTTP and WebSocket turns plus an explicit Provider search relay that preserves response bytes and status while replacing subscription identity with the Provider credential; unavailable, disabled, or ambiguous routes now fail without cross-source fallback or retry.
- Replaced the ai.feei-specific search boolean with the shared `openai-gpt` default, and added deterministic safety coverage plus a two-turn, privacy-preserving live acceptance harness with hard generation/search budgets and hashed search-result correlation evidence.
- Switched standalone-search targets to the Codex Responses Lite `web.run` carrier, rejected mismatched hosted-search requests instead of silently changing the selected source, and live-validated the split path: Sol/Astra generation to ai.feei with search only through the user's OpenAI subscription.

## 0.3.1 - 2026-09-13

- Made the official subscription WebSocket relay honor WebSocket, HTTP(S), generic proxy, and `NO_PROXY` environment settings instead of bypassing the machine proxy while HTTP relay traffic used it.
- Added redacted official-WebSocket transport attribution and a two-turn official-only search canary covering the normal cached default and the explicit live override without changing user search settings.
- Updated the focused acceptance driver for Codex CLI versions where `--search` is a top-level one-run option.

## 0.3.0 - 2026-09-13

- Added immutable, content-addressed configuration spaces containing providers, models, default model, routing, Plugin, search, compression, and subscription-routing policy, while machine listener/access/history/resource settings remain global.
- Added protected `official@1`, legacy migration to `default@1`, cloning, history, diff, drift capture, explicit historical activation, and rollback to the previous successful activation.
- Added a hash-bound space-switch transaction and one-shot non-KeepAlive LaunchAgent. Running Codex App now leaves switching pending until normal exit; active Gateway turns drain before materialization, and concurrent file changes fail closed with recovery material retained.
- Added `space` CLI commands, `--space` editing for Provider/model/config operations, Schema 4 integration references, official-space service guards, and an App-closed `official@1` subscription rescue path.
- Added a fixed-destination, query-preserving HTTP and WebSocket relay for official `/subscription/v1/**` traffic, including standalone search, model discovery, future auxiliary endpoints, cancellation, and bounded side-channel history observation.
- Changed subscription model routing so explicit custom App model mappings win while all other model IDs are left for the official backend to accept or reject.
- Added target-level `modelFamily` and `pluginToolPolicy`, a configurable third-party GPT Plugin allowlist, read-only Plugin/MCP source discovery, tool-choice conflict handling, and a downstream guard for disallowed Plugin calls. Codex core tools, user MCP, unknown sources, Skills, Hooks, and prompt text are preserved.
- Added ai.feei Responses presets for `feei-gpt-5.6-sol` and `feei-gpt-6-astra`, with conservative 272,000-token windows and standalone App search capability kept separate from provider-native hosted search.
- Added deterministic A1-A10 coverage and an opt-in five-turn focused acceptance runner with hard turn/generation budgets and metadata-only evidence.

## 0.2.1 - 2026-09-13

- Added an end-to-end acceptance harness (`npm run e2e`, `e2e:l0|l1|l2|live`) that drives the Codex App core and reports PASS/ANOMALY/FAIL from machine-checkable criteria, with isolated `CODEX_HOME`, a random loopback port, external-process health sampling, and per-case evidence under `artifacts/e2e/<runId>/`.
- Fixed a full-table scan of the encrypted history database on every recorded response: the quota check ran `SUM(bytes)` over the whole archive, which blocked the main thread for seconds and stalled health checks, upstream reads, and request setup under concurrency. Quota now uses the O(1) on-disk size.
- Cached subscription identity resolution, which previously spawned two Keychain probes per request and could consume the full 5s probe timeout; validation stays per request and a credential mismatch still forces one re-read before rejecting.
- Classified curl partial-file failures (exit code 18) as `truncated` instead of `other` so upstream truncation is attributable in logs.

- Added privacy-safe App request, queue, upstream timing, and curl failure diagnostics.
- Avoided re-reading freshly persisted response history from SQLite on the main thread.
- Treated App switches between managed catalog models as valid integration state.
- Added the primary `codex-local-router` command while retaining `llm-auto-gateway` as a compatibility alias.
- Isolated test Gateway state from installed user services and ignored stale state from unrelated configurations.
- Made public exports refuse unsafe, Git, symlink, and non-empty destinations; derived release contents from the package manifest; and added a whole-public-tree sensitive-content audit.
- Made tag-to-version validation, artifact naming, checksums, clean installation, and generated release notes part of the GitHub Release workflow.

## 0.2.0 - 2026-09-12

- Productized the project as Codex Local Router for macOS Codex CLI and App.
- Added versioned provider-model presets, capability-consistent catalog generation, configurable endpoint paths, and provider concurrency limits.
- Added transactional Codex integration with idempotent sync, pending App updates, field-level restore, and subscription rescue.
- Added a local API token, file and macOS Keychain Codex authentication support, user-level runtime paths, LaunchAgent service management with proxy propagation, candidate health checks, and graceful drain.
- Migrated history to encrypted incremental event storage with atomic v2 snapshots, resumable lazy upgrades, exact positional checkpoint expansion, authenticated migration packages, and continuation prompts.
- Added setup, status, provider, model, integration, doctor, logs, service, upgrade, rescue, history, and uninstall commands.
- Added hidden Keychain credential input and diagnostics for subscription, provider, and LaunchAgent credential availability.
- Kept Codex-led compression and the one-attempt explicit context-limit fallback.
- Preserved mixed search and external-tool continuations in provider order, including legacy-session repair and bounded page extraction.
- Kept old configurations usable through in-memory migration and emitted protocol-valid apply-patch metadata for Chat Completions targets.

# Changelog

## Unreleased

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

# Changelog

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

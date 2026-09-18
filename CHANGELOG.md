# Changelog

## Unreleased

## 0.5.5 - 2026-09-18

- Refresh the English and Chinese README, compatibility matrix, search guide and acceptance overview so current release behavior is separated from frozen historical candidate records.
- Document hidden internal subscription-search calls, bounded multi-search rounds and immediate streaming of client-visible text and ordinary tools. Runtime routing behavior is unchanged from v0.5.4.

## 0.5.4 - 2026-09-18

- Stream ordinary text and client tool events immediately when subscription search or legacy search fallback is enabled, including turns that never search. Hide only internal search calls, keep one client response lifecycle across internal generations, and preserve private search results for continuation.
- Measure downstream text after the HTTP/WS send boundary, not inside the upstream sampler. Streaming errors produce a sanitized error terminal instead of silently ending the socket. No fabricated progress or reasoning-to-commentary conversion.
- Make client-acknowledged HTTP/WS streaming probes part of default release qualification, and record real app-server text delta timing alongside live bridge closure. Context windows remain explicit per-user settings; this release does not silently migrate GLM or any other target.

## 0.5.3 - 2026-09-18

- Add an explicit, model-family-neutral `standard-tool` subscription-search bridge for third-party Standard Responses targets. It preserves the current Codex search mode and restrictions, executes only against the fixed OpenAI subscription endpoint, returns bounded untrusted results through the existing tool loop, and never lends subscription identity to `/v1` or a model Provider.
- Preserve user MCP search as a client-owned path, distinguish exact hosted-search types from ordinary functions such as Tavily, and retain namespace identity across the Chat Completions adapter. Current deferred `tool_search` behavior remains visible instead of copying user MCP configuration or credentials into the Router.
- Add explicit CLI controls needed to move GLM 5.3 Flash from Lite/Code mode to Standard Responses tools, `shell_command`, client-default agents, `low|high|max` reasoning with default `max`, and the subscription bridge. Version the candidate as 0.5.3 and add hash-bound source-only activation/rollback tooling.
- Correct the OpenAI `/alpha/search` request to use the current object-shaped `commands.search_query` contract. Isolated live evidence proved GLM and ai.feei subscription bridge closure; GLM deferred-MCP discovery and the CA-isolated Tavily case remain unaccepted, so local activation is still blocked.
- Add a fail-closed release qualification command and protected self-hosted GitHub Release job. The default real matrix is limited to five equivalence-class turns, thirteen model generations and seven searches across non-GPT/GPT subscription bridges, one client-owned MCP path, and official cached/live regression.

## 0.5.2 - 2026-09-17

- Allow a trusted direct fork to inherit an exact same-account portable parent checkpoint, persist its own encrypted copy, and remain fail-closed when the parent is missing, mismatched, or summary-only.
- Add preview-first `history recover` for losslessly reconstructable Codex rollouts, including bounded parent-chain traversal, strict ordinal/tool-pair validation, atomic encrypted writes, idempotency, metadata-only diagnostics, and checkpoint counts in `history inspect`.
- Separate public product code from local evidence and private operations: public export and package audits now inspect the actual npm file list file-by-file, reject selected symlinks and sensitive paths, and keep raw acceptance output outside the checkout.
- Require an explicit preset or complete existing config for fresh setup, use neutral fallback IDs, and report preset restrictions as restrictions or unverified state instead of qualification evidence. Existing spaces and preset expansion remain unchanged.
- Move feature-specific rollout/rollback helpers to source-only `scripts/maintainer/`, add a hash-verified legacy recovery-bundle preparer, and remove production support for test-only App/launchctl environment switches in favor of injected test substitutes.

## 0.5.1 - 2026-09-17

- Add the versioned `codex-general-v1` default for new eligible third-party App models: provider-neutral base instructions, Standard Responses, code mode, configured multi-agent v2 metadata and the existing standard Plugin allowlist. Existing targets remain unchanged until explicitly updated, while incompatible targets require `legacy` instead of silently downgrading.
- Make code mode, capability profiles, direct multi-agent metadata, managed instruction sources and explicitly configured cache affinity depend on protocol capabilities rather than GPT family alone. Official instruction snapshots, Lite delivery, standalone search and cache affinity remain explicit options.
- Add space/model template CLI operations, built-in/custom instruction sources, metadata-only diagnostics, current-client context/protocol gates, a 12-generation live harness and hash-bound activation/rollback scripts that preserve GPT targets and both default-model states.
- Keep the OpenCode Go DeepSeek preset on its accepted legacy path after the real generic-template payload returned HTTP 400. Default setup remains usable, while generic templates, direct Code mode and direct multi-agent metadata fail closed until that Provider path is requalified.

- Add explicit, versioned official multi-agent capability snapshots for eligible third-party GPT targets, atomic `model sync-multi-agent`, shared catalog projection and metadata-only diagnostics. Preserve user agent settings, model routing and both default-model states; no automatic migration or prompt injection.

- Add explicit `app.toolMode: "code_mode_only"` catalog projection and atomic `model set-tool-mode` updates for eligible third-party GPT Responses targets. Preserve defaults and existing configurations, retain structured Plugin filtering, and document a context-size qualification gate rather than parsing exec-embedded schemas or promising runtime context limits.
- Add explicit, versioned official instruction snapshots for eligible third-party GPT targets, batch `model sync-instructions`, source diagnostics, tamper checks and body-redacted CLI previews. Existing configurations do not migrate on load.
- Add opt-in `gateway-lite` delivery for pinned, variable-free third-party GPT snapshots. It inserts one developer input only on actual Lite user turns, includes the bytes in context budgeting, stays out of archives/history, rejects conflicting top-level instructions, and leaves Standard Responses and official relay traffic unchanged.
- Preserve Codex's current selected model separately from the configuration-space default during same-space instruction updates, including pending/resume and rollback. Add hash-bound activation and rollback scripts that require an idle, drift-free App-closed window.
- The current Codex CLI/app-server loopback gate now proves matching synthetic instruction hashes exactly once for Standard custom-provider and Gateway Lite paths while retaining official Lite omission as a control observation. Real-channel generation and App UI sign-off remain separate gates.

- Preserve the current Responses Lite negotiation bit per HTTP request or WebSocket frame when routing third-party OpenAI GPT Responses, remove stale/false values instead of inheriting a connection handshake, and keep internal summary/image requests explicitly non-Lite.
- Emit one redacted terminal `prompt_cache_usage` event for third-party GPT Responses in both `none` and `gateway-opaque` modes, retaining missing usage as unknown and emitting no terminal usage for errors or cancellations.
- Add a 24-generation Sol/Astra direct-versus-anonymous cache comparison, a current-App-binary six-generation MCP continuation gate, and hash-bound local activation/rollback scripts that preserve the previous package and exact configuration-space revision.
- Replace the unverified requirement for one particular relay consistency-hashing algorithm with a conditional interoperability recommendation; observed ai.feei field effects do not disclose its internal account-pool implementation or promise a fixed natural-session hit rate.
- Attribute nested namespace tools to their confirmed parent source and report metadata-only source counts in route diagnostics without changing filtering behavior or logging tool names and schemas.
- Preserve the current Responses Lite `input[].additional_tools` carrier when a conversation switches from another Provider to a Lite third-party target. Historical carriers remain non-portable, Plugin filtering still runs before dispatch, migration summaries omit tool schemas, and route diagnostics now count Lite definitions separately from top-level tools.
- Added an opt-in `gateway-opaque` prompt-cache affinity policy for third-party OpenAI GPT Responses targets. The router derives a provider/model/lineage-scoped `prompt_cache_key` with a dedicated local Keychain secret while keeping Codex account, thread, turn, session, installation, and original cache identifiers off the provider wire.
- Added bounded encrypted lineage state with same-turn freezing, verified parent/fork inheritance, 30-minute expiry, restart stability, safe `prompt_cache_options` filtering, metadata-only cache-usage diagnostics, and no retry or fallback caused by cache-field rejection.
- Added Provider CLI configuration and effective diagnostics, deterministic HTTP/WebSocket/config-space/security/performance gates, a fail-closed live harness, and conditional account-pool interoperability guidance for stable upstream selection.
- The bounded ai.feei feasibility probe stopped after its first no-affinity request returned HTTP 403, with no retry. Generic Gateway behavior is validated locally, while ai.feei end-to-end cache effectiveness remains `EXTERNAL_UNRESOLVED` until the Provider implements or proves the account-pool contract.
- Canonicalize completed `tool_search_call` / `tool_search_output` pairs into a fixed, schema-free history marker before replaying them across providers or protocols. Function and custom-tool calls/results remain ordered and portable, while provider IDs, search arguments, execution metadata, and dynamically loaded tool schemas never enter the destination view or history-resume prompt.
- Reject missing, duplicated, malformed, or reversed dynamic-tool-search pairs with `tool_search_history_incomplete` before any destination request. Original encrypted history remains immutable so repeated switches do not accumulate lossy rewrites.

## 0.5.0 - 2026-09-16

- Keep Engine-managed, local-prewarm, compaction, and legacy unlabelled official response IDs on Gateway history replay, while allowing only successfully observed opaque official-relay responses to retain native `previous_response_id` continuation. This prevents an Engine response from being handed to a fresh official WebSocket session that cannot resolve it.
- Preserve an explicitly configured `NODE_EXTRA_CA_CERTS` path with proxy variables in the Router and one-shot switcher LaunchAgents, combine Node default and system trust for official WSS without disabling certificate or hostname verification, and expose only allowlisted TLS error codes for diagnosis.
- Make G3.5 fail closed when per-case local/upstream timing, byte accounting, archive observation, health, or lifecycle evidence is missing; WebSocket turns finalize response bytes and total time on terminal or close, and pre-header transport failures explicitly settle at zero response bytes without converting external degradation into a Core failure.
- Detect Router-injected model-cache state from stable catalog fields (and fail closed on invalid JSON) instead of relying only on product/port text.
- Ship every declared test, package-audit, and E2E script target in the tarball, and make package audit reject dangling script entries.
- Bound the official natural-search canary to one requested search and give the official-only run a strict 2-turn / 6-generation / 1-search hard budget, so provider-driven multi-query exploration cannot consume the general live-call allowance before producing its short acceptance answer.

- Rebuilt L1/L2 qualification around injected deterministic official, Provider, and search transports; default E2E commands are credential-free and network-isolated, while installed-service and real-channel cases now require an explicit live confirmation.
- Isolated Codex harness children from ambient proxy and credential variables, distinguished WebSocket prewarm from generation evidence, and tightened official cancellation accounting so a zero-generation prewarm cannot satisfy a live generation-cancel claim.
- Forced every Codex acceptance child to temporary HOME, Codex, XDG, Router config/state, and instance-ID roots; made qualification receipts create-once and bound promotion evidence to both the exact commit and Git tree.
- Preserved legacy transport-only Responses Lite targets without mislabeling them as the qualified `lite-search` profile, and tightened live channel attribution so a truncated HTTP 200 or any ambiguous retry remains `UNVERIFIED` instead of being blamed on the Provider.
- Corrected official WebSocket cancellation qualification to permit a separate non-generating prewarm while still requiring exactly one real generation send before client cancellation.
- Required explicit upstream event provenance before a synthetic Gateway error status can classify a third-party channel as externally degraded; a successful HTTP response followed by a locally detected truncated stream remains `UNVERIFIED`.
- Made the bounded live qualification gate fail closed on disallowed `models_cache.json` drift and every case-local routing, identity, catalog, payload-adaptation, search-result forwarding, and lifecycle invariant; on macOS it now write-denies real Codex, Router, installed-Skill, LaunchAgent, and Keychain roots while keeping Codex state in temporary roots.
- Added bounded Gateway Core qualification receipts with independent official, Provider-channel, local-gray, local-use, and release outcomes plus normal-health performance attribution; external channel instability no longer hides or automatically fails deterministic Core behavior.
- Added explicit `standard-tools` and `lite-search` capability profiles for third-party GPT App targets. New CLI-created GPT targets default to Standard Responses with the policy-filtered core/Plugin/user-MCP surface and no standalone-search advertisement; Lite search is an explicit, visibly reduced-tool-surface opt-in.
- Added capability-profile validation and effective profile/reason/tool-surface reporting to the generated custom catalog, `model list`, non-live `model probe`, `status`, and `doctor`, while preserving existing explicit or legacy-implied Responses Lite configurations.
- Split focused acceptance evidence by capability profile: Standard tool-definition preflight can no longer be promoted to call/result qualification, while Lite search cases disclose their reduced tool surface and cannot be combined into a full-tools-plus-search claim.
- Applied capability invariants to inferred as well as explicit profiles, reported the new Standard default without a false legacy label, and kept non-Responses legacy targets unprofiled instead of overstating their tool surface.
- Preserved explicit space-level search defaults as Lite compatibility signals, rejected non-boolean transport flags, and exposed profile/reason/tool-surface details in both JSON and human-readable diagnostics.
- Limited CLI profile defaults to Responses targets and made `--no-app` transitions clear all target-level App profile/search state while retaining the hidden routing target; App-disabled GPT targets no longer re-inherit space-level or legacy native-search advertisement and report that state truthfully, app-absent legacy targets remain distinguishable, and persisted CLI defaults are documented as `target-explicit` versus inferred `standard-default`.

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

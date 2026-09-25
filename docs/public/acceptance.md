# Release qualification policy

This document defines the stable public release contract. Version-specific clients, model matrices, budgets, hashes, and outcomes belong in GitHub Release notes or [frozen evidence](evidence/README.md).

## Evidence layers

| Layer | Required for | What it proves |
|---|---|---|
| Deterministic | Every pull request and release | Tests, audits, export, packaging, and clean installation pass without external model calls |
| Live protocol | Runtime-impacting releases | Selected real channels complete routing, tools, search, continuation, and lifecycle checks within a declared budget |
| Installed environment | Releases selected for local rollout | The exact package and configuration activate without drift or credential crossover |
| App UI | Separate user sign-off | Model visibility and actual App interaction work; app-server evidence is not a substitute |

Documentation-only releases may skip live protocol checks only when the release classifier proves that the full diff contains no runtime, dependency, protocol, configuration, or harness change. Deterministic checks still run, and Release Notes must disclose the skip and name the latest runtime release with live evidence.

## Deterministic gate

The default gate must:

- run the complete test suite in isolated temporary homes and ports;
- audit production dependencies and the package manifest;
- export a clean public tree and scan every exported and packaged file;
- repeat installation, tests, audits, packaging, and both CLI alias checks from the exported tree;
- make no real model request and never read the user's Keychain, Codex history, configuration, or running service.

Canonical commands:

```bash
npm test
npm audit --omit=dev --registry=https://registry.npmjs.org
npm run audit:package
node scripts/audit-public.mjs
git diff --check
```

## Runtime-impacting release gate

Live cases use the current supported Codex client and a bounded, declared matrix. They cover only changed or release-critical boundaries rather than every model-option permutation. A passing receipt must show:

- the selected model request reached the intended Provider;
- subscription and Provider credentials never crossed destinations;
- tool or search calls completed and their results reached continuation generation;
- streaming, cancellation, errors, retries, history, fork, and compression behave as declared where relevant;
- no hidden retry, fallback, or extra network request was used to manufacture a pass;
- failures distinguish Gateway defects, external channel failures, and unresolved attribution.

Missing execution evidence is not a pass. Capability declarations, configured compression modes, and catalog visibility do not prove live support. `npm run e2e:compression-capability -- --run` probes DeepSeek and GLM Main once through the Provider's standard `/responses/compact` endpoint, then validates the result through an isolated Gateway. A successful endpoint response must contain a compaction item; the temporary target then uses `native` and must complete a Provider-visible trigger, continuation, Gateway restart, and credential checks. An explicit 400, 404, 405, 422, or 501 marks `provider-unsupported`; the unchanged target must then reject compaction locally without calling the Provider and still pass continuation and restart recovery. Any 502, timeout, retry, authentication failure, successful non-compaction response, or unclassified Provider failure remains inconclusive. The probe never edits the active configuration.

The default runtime Release gate first freezes that capability receipt, then runs a bounded HTTP-only official compaction observation and verifies that a checkpoint was persisted. Current Codex builds select this transport through an isolated custom provider with `supports_websockets = false`; removed legacy feature flags are not used. Three WebSocket lifecycle chains cover `official → third-party GPT → official`, `official → GLM Flash → official`, and `FEEI Sol → FEEI Astra → GLM Flash → DeepSeek → FEEI Sol`. Each capable target compacts before leaving it; GLM uses Gateway-owned summary, the first GLM chain carries a local image through automatic summary and restart, and DeepSeek follows the frozen capability result. The third-party GPT official chain also restarts from a synthetic legacy metadata-only checkpoint. A pass requires all nine source/target equivalence cells, preserved facts and completed tool results, exactly one tool execution per chain, summary reuse, restart continuation, explicit unsupported rejection when applicable, no hidden retry, credential separation, no cross-target opaque state, and no Gateway virtual checkpoint sent to OpenAI.

An independent App-server smoke reruns `GLM Flash automatic summary → official GPT → official native compaction` with a fresh Home, archive, and receipt. It must complete without `provider_error` or hidden retry. Actual App UI sign-off remains separate.

Channel-owned compaction changes additionally use `npm run e2e:native-compaction -- --run`. The isolated gate tests FEEI Sol and Astra under both forced Standard and the source configuration's current Lite profile: two manual native compactions, one Codex threshold-triggered automatic compaction, one read-only tool closure, continuation, Gateway/App-server restart, and same-checkpoint reuse. The harness counts every outbound generation and accepts an explicit positive ceiling without the former 24-call cap. A pass requires zero `summary_started` calls, every expected Provider-visible compaction trigger, preserved facts after automatic compaction, stable opaque-checkpoint fingerprints across restart, credential separation, complete upstream terminals, and no Gateway error. An unsupported channel or missing source Lite profile is reported as a failed capability qualification; the gate never enables Gateway summary fallback. This four-case receipt is part of the default Release qualification and must match the same commit and Codex core as the other stages.

Native failure or an unverified capability never falls back to Gateway summary, another model, or another channel. The gates perform no implicit retry, recursive summary, or automatic configuration change.

Reported-history repair candidates can additionally use `npm run e2e:native-continuation-faults -- --run` with explicit thread and rollout paths. The gate copies rollout files into an isolated Codex home, reproduces a missing trusted checkpoint against an empty archive before applying explicit rollout recovery, and copies only the selected thread scope from one consistent read transaction into a new encrypted SQLite archive for an existing-migration continuation. Optional `--thread-first-migration` and `--source-first-migration` inputs add a first-migration case: it proves no target migration exists, normalizes provider-private reasoning before the target budget check, generates exactly one authorized source summary, persists it, and reaches the target once. It sends read-only, no-tool prompts and persists only hashes, counts and terminal metadata; the source rollout, archive, App configuration and running service are never written.

## Security and evidence handling

Live work uses isolated homes, state, credentials, ports, and synthetic or public content. Public evidence may include versions, hashes, counts, timing, redacted destinations, and result categories. It must not include credentials, private conversations, raw history databases, local configuration, request or response bodies, search queries or results, runner host configuration, or rollback packages.

App UI acceptance, local activation, merge, publication, and npm publication are separate decisions and must be reported separately.

[中文](acceptance.zh-CN.md)

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

Missing execution evidence is not a pass. Capability declarations and catalog visibility do not prove live support.

The default runtime Release gate first runs a bounded HTTP-only official compaction observation and verifies that a checkpoint was persisted. Current Codex builds select this transport through an isolated custom provider with `supports_websockets = false`; the removed legacy feature flags are not used. Two WebSocket history-lifecycle chains then cover official model → two native compactions → fork → GLM Flash or third-party GPT → one read-only tool call/result/continuation → same-provider summary reuse → Gateway and App-server restart → official continuation. The third-party GPT chain restarts from a synthetic legacy metadata-only checkpoint before its first cross-provider turn. This split keeps HTTP observation real without pretending that a custom provider supplies the built-in OpenAI provider's dynamic thread and fork metadata. The harness counts every outbound generation and accepts an explicit positive ceiling without the former 18-call harness cap. It does not retry failed samples. A pass requires completed HTTP official compaction observation and persisted checkpoint, recovery before routing, preserved synthetic facts, the latest instruction and tool result; exactly one tool execution; exactly one source-model migration summary per preparation and none on reuse; no Gateway or reconnect error; credential separation; no official opaque state sent to the third party; and no Gateway virtual checkpoint sent back to OpenAI.

Channel-owned compaction changes additionally use `npm run e2e:native-compaction -- --run`. The isolated gate tests FEEI Sol and Astra under both forced Standard and the source configuration's current Lite profile: two manual native compactions, one Codex threshold-triggered automatic compaction, one read-only tool closure, continuation, Gateway/App-server restart, and same-checkpoint reuse. The harness counts every outbound generation and accepts an explicit positive ceiling without the former 24-call cap. A pass requires zero `summary_started` calls, every expected Provider-visible compaction trigger, preserved facts after automatic compaction, stable opaque-checkpoint fingerprints across restart, credential separation, complete upstream terminals, and no Gateway error. An unsupported channel or missing source Lite profile is reported as a failed capability qualification; the gate never enables Gateway summary fallback.

Reported-history repair candidates can additionally use `npm run e2e:native-continuation-faults -- --run` with explicit thread and rollout paths. The gate copies rollout files into an isolated Codex home, reproduces a missing trusted checkpoint against an empty archive before applying explicit rollout recovery, and copies only the selected thread scope from one consistent read transaction into a new encrypted SQLite archive for an existing-migration continuation. Optional `--thread-first-migration` and `--source-first-migration` inputs add a first-migration case: it proves no target migration exists, normalizes provider-private reasoning before the target budget check, generates exactly one authorized source summary, persists it, and reaches the target once. It sends read-only, no-tool prompts and persists only hashes, counts and terminal metadata; the source rollout, archive, App configuration and running service are never written.

## Security and evidence handling

Live work uses isolated homes, state, credentials, ports, and synthetic or public content. Public evidence may include versions, hashes, counts, timing, redacted destinations, and result categories. It must not include credentials, private conversations, raw history databases, local configuration, request or response bodies, search queries or results, runner host configuration, or rollback packages.

App UI acceptance, local activation, merge, publication, and npm publication are separate decisions and must be reported separately.

[中文](acceptance.zh-CN.md)

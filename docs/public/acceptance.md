# Acceptance harness

The current configuration-space candidate record is [configuration-spaces-acceptance.md](configuration-spaces-acceptance.md).

The published package ships the end-to-end acceptance harness that verifies a real installation. It drives the Codex App core and reports `PASS` / `ANOMALY` / `FAIL` from machine-checkable criteria. It never drives the App UI.

## Requirements

- macOS with Node.js 22 and `curl` on `PATH` (the upstream transport is curl-based).
- Codex App installed, or `codex` on `PATH` as a fallback: the harness prefers `/Applications/ChatGPT.app/Contents/Resources/codex`.
- A signed-in ChatGPT subscription (`~/.codex/auth.json`) and at least one configured third-party provider target.
- For the search-continuation coverage, a reachable web-search backend.

## Layers

| Layer | Driver | Covers |
|---|---|---|
| A | `codex exec` from the App bundle | official subscription passthrough, second entry point, non-Responses protocols |
| B | the same binary as `app-server --stdio` | App client protocol: WebSocket turns, prewarm, Lite requests, tool continuation |
| D | manual App check (never automated) | model menu and reasoning levels, image attachment, credential display |

The official-relay and Plugin-policy change uses ten bounded equivalence groups rather than a model × Plugin × protocol Cartesian product:

| Group | Boundary |
|---|---|
| A1 | policy precedence, legacy defaults, explicit overrides, extension conflicts |
| A2 | core, user MCP, allowed/forbidden Plugin, alias, unknown source, collision |
| A3 | function, namespace, additional-tools carrier, empty set, tool choice, idempotence |
| A4 | allowed call/result loop and forbidden direct calls in streaming/final output |
| A5 | official HTTP search/models/future paths, query, binary, compression, SSE, status/error fidelity |
| A6 | official/custom WebSocket turns, switching, prewarm, cancel, backpressure, disconnect cleanup |
| A7 | subscription/local/provider credential and fixed-destination boundaries |
| A8 | official/custom history switching, virtual state, observation gap/failure, restart/repeat |
| A9 | CLI configuration/reporting, command aliases, package/export/test isolation |
| A10 | byte accounting, redacted diagnostics, hard live budget, no implicit request/retry |

Pure logic and local simulated upstream coverage for A1-A10 is part of `npm test`; real providers are not called by the PR gate.

Configuration spaces add deterministic cases for fresh and legacy migration, applied/disabled/pending/ambiguous state, immutable revisions, official auto-capture, clone/diff/default-model/drift capture, official↔Router and Router↔Router switching, historical activation and rollback, one-shot coordinator recovery, active-turn timeout, missing credentials, candidate/service/hash failures, staged rollback, and preservation of non-managed Codex data. Every case uses temporary Codex/Router homes, config/state/LaunchAgent paths, random ports, simulated launchctl, and local upstreams.

The configuration-space candidate gate intentionally performs zero real model calls and does not run `e2e:focused -- --run`. Before and after the gate, operators verify that the installed Router and switcher remain unloaded, port 8788 remains closed, integration remains disabled, and the real Codex config still selects its built-in OpenAI provider. App-server coverage cannot replace a later App UI sign-off.

## Commands

```bash
npm run e2e:l0     # gate: npm test, package audit, source scan
npm run e2e:l1     # isolated cases E2E-1/2/3/5
npm run e2e:l2     # pre-release capacity case E2E-4
npm run e2e:live   # concurrency against a running service (E2E-6)
npm run e2e        # gate plus every case, pre-release last
npm run e2e:focused -- --run  # explicit five-turn official + ai.feei candidate acceptance
```

The live case only runs outside your own usage window, requires `activeTurns == 0` before it starts, uses four short sessions, and can be aborted at any time. It does not restart the service and does not change configuration.

`e2e:focused` is a separate release-candidate check. It requires a signed-in subscription, an existing production Router configuration used only as a base, and `FEEI_API_KEY` in the invoking environment. It copies the public GitHub Plugin into an isolated Codex home, installs a synthetic read-only MCP fixture there, adds the two ai.feei presets only to an in-memory isolated configuration, uses a random Router port and encrypted temporary archive, and removes its temporary working tree at the end. It does not restart or edit the installed service.

The runner permits exactly five short turns and at most ten observed generation requests:

1. official CLI answer plus standalone search;
2. ai.feei Sol CLI text plus synthetic image;
3. ai.feei Astra CLI text plus synthetic image;
4. ai.feei Sol App protocol with allowed Plugin, user MCP, and standalone search;
5. ai.feei Astra App protocol with the same category checks.

It has no retry loop. The outbound hook rejects a generation beyond the budget and rejects any standalone-search request whose destination is not OpenAI. A passing App-protocol case also requires evidence that at least one forbidden Plugin was present before policy evaluation and absent afterward, while GitHub and the user MCP definition remain; the unpredictable MCP marker must appear in the final answer; completed tool calls and a successful official search must be observed. Missing evidence is `FAIL`, never an inferred pass.

## Isolation and privacy

Every automated case uses an isolated `CODEX_HOME` whose `auth.json` is symlinked rather than copied, a random loopback port, an isolated history namespace, and a work root under the operating system's temporary directory. The harness records timing, model ids, byte counts, header names, event/tool types, status, counts, and booleans only. It never records request or response bodies, credentials, image content, tool schemas, or local paths.

## Criteria

Hard contracts — a violation fails the case: `H1` completion, `H4` tool integrity, `H5` protocol contract, `H6` credential isolation, `H7` idempotent side effects, `H9` error attribution, `H10` evidence completeness.

Tripwires — a breach is reported for attribution, not treated as a failure: `H2` first-output progress and silence gaps, `H3` repeated requests per turn, `H8` health latency, event-loop delay, and drain time.

Tripwire values live in `docs/e2e/thresholds.json` (shipped with the harness) and are deliberately loose: they are anomaly tripwires, not performance targets. A breach that cannot be attributed fails the case.

## Evidence

```
artifacts/e2e/<runId>/summary.json   # per-case verdict, criteria results, harness kind/version/sha256
artifacts/e2e/<runId>/<case>.json    # observation and assertions for that case
artifacts/e2e/<runId>/raw/<case>.jsonl
```

Evidence is written under `artifacts/e2e/`; pass `--out DIR` to write it elsewhere.

Each case records the harness kind, the driver binary source label, its version, and its SHA-256, so a verdict is bound to an exact build without publishing a local absolute path. The harness never rewrites existing evidence.

The focused summary deliberately omits the driver path and stores only its source kind, version, and SHA-256. It also separates implementation/automated results from `appUi: "not-tested"`; app-server evidence cannot sign off the actual menu, label, image picker, or visible account state.

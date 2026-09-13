# Acceptance harness

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

## Commands

```bash
npm run e2e:l0     # gate: npm test, package audit, source scan
npm run e2e:l1     # isolated cases E2E-1/2/3/5
npm run e2e:l2     # pre-release capacity case E2E-4
npm run e2e:live   # concurrency against a running service (E2E-6)
npm run e2e        # gate plus every case, pre-release last
```

The live case only runs outside your own usage window, requires `activeTurns == 0` before it starts, uses four short sessions, and can be aborted at any time. It does not restart the service and does not change configuration.

## Isolation and privacy

Every automated case uses an isolated `CODEX_HOME` whose `auth.json` is symlinked rather than copied, a random loopback port, an isolated history namespace, and a work root under the operating system's temporary directory. The harness records timing, model ids, byte counts, header names, event types, and booleans only. It never records request or response bodies, credentials, image content, or local paths.

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

Each case records the harness kind, the driver binary path, its version, and its SHA-256, so a verdict is bound to an exact build. The harness never rewrites existing evidence.

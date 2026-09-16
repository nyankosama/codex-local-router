# Acceptance harness

The current configuration-space candidate record is [configuration-spaces-acceptance.md](configuration-spaces-acceptance.md).
The v0.4.0 third-party standalone-search record is [third-party-openai-search-acceptance.md](third-party-openai-search-acceptance.md). Its isolated CLI/App-protocol live gate passed; App UI and installed-environment activation remain separate.

The published package ships the end-to-end acceptance harness and its runtime tests. The installed tarball supports `npm test`, `npm run audit:package`, and the documented `e2e:*` scripts; package audit fails when a declared Node script target or the packaged test suite is missing. The three repository-only public-export tests run in the source/public-export tree and are explicitly skipped in an installed tarball, where the repository export inputs do not exist. The harness drives the Codex App core and reports `PASS` / `ANOMALY` / `FAIL` from machine-checkable criteria. It never drives the App UI.

## Requirements

- macOS with Node.js 22 and `curl` on `PATH` (the upstream transport is curl-based).
- Codex App installed, or `codex` on `PATH` as a fallback: the harness prefers `/Applications/ChatGPT.app/Contents/Resources/codex`.
- The deterministic L0-L2 and capability-profile gates require no subscription or Provider credential and make no external request. They inject local official, Provider, and search fixtures while still driving the current Codex core.
- Explicit live canaries require the credentials and reachable upstreams named by that canary. Those credentials are read only into an isolated test root and are never required by the default test or E2E commands.

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
npm run e2e:l1     # credential-free local fixtures: E2E-1/2/3/5
npm run e2e:l2     # credential-free local capacity fixture: E2E-4
npm run e2e:profiles  # credential-free standard-tools and lite-search closure
npm run e2e        # L0-L2 only; the live case is excluded
npm run e2e:live -- --run  # explicit installed-service concurrency (E2E-6)
npm run e2e -- --include-live --run  # explicit L0-L2 plus live E2E-6
npm run e2e:official-search -- --run  # two-turn official cached-default + explicit-live search
npm run e2e:third-party-search -- --run  # two-turn ai.feei + subscription-search acceptance
npm run e2e:focused -- --run  # explicit five-turn official + ai.feei candidate acceptance
```

`e2e:official-search` is the narrow official-only canary. It first makes a zero-generation handshake probe through the Router's production official-WebSocket client and requires HTTP 101. Its first isolated CLI turn then leaves `web_search` unset and verifies the normal cached default without requiring a new user flag. Its second turn passes the one-run `--search` override to verify live search. Both turns require a successful official Responses exchange over the transport selected by the current Codex build, a successful fixed-origin `/alpha/search` request, a completed `web_search` client item, a source hostname in the answer, and no non-OpenAI outbound destination. The runner allows exactly two turns and at most six generation requests because one search turn can require multiple model/tool continuations; it stores no prompt or response body.

The live case only runs outside your own usage window, requires `activeTurns == 0` before it starts, uses four short sessions, and can be aborted at any time. It does not restart the service and does not change configuration.

`e2e:third-party-search` is the bounded `lite-search` canary for this routing feature. It explicitly selects that profile in an isolated Codex home, Router config/state/archive, workspace, random port, and the current App-bundled Codex core. The first turn selects ai.feei Sol from the CLI while leaving `web_search` unset, so normal cached-default behavior is exercised without `--search`. The second uses ai.feei Astra through `app-server` with `web_search = "live"`. It allows exactly two turns, twelve generation sends, and eight search sends, with no retry loop; an exact repeated generation payload is blocked before its second send. The larger bound accommodates the normal Responses Lite search/open/read phases observed in real runs. It does not prove the `standard-tools` surface in the same turn.

A case passes only when the client reports a completed search; every search request reaches `chatgpt.com`; every custom-model generation reaches `ai.feei.cn`; the subscription and Provider credentials are each observed only on their own leg; at least one URL fingerprint extracted in memory from the successful search response appears in a later third-party request; and the final answer contains source information. It persists only URL/response hashes, counts, hosts, status, bytes, timing, and booleans. Missing execution or correlation evidence is `FAIL`. A Provider Key may come from `FEEI_API_KEY` or the existing read-only Keychain reference; neither is printed or copied to the artifact.

`e2e:focused` is a separate routing and channel canary, not the capability-profile qualification gate. It requires a signed-in subscription, an existing production Router configuration used only as a base, and `FEEI_API_KEY` in the invoking environment. It copies the public GitHub Plugin into an isolated Codex home, installs a synthetic read-only MCP fixture there, adds the two ai.feei presets only to an in-memory isolated configuration, uses a random Router port and encrypted temporary archive, and removes its temporary working tree at the end. It does not restart or edit the installed service.

The runner permits exactly five short turns and at most ten observed generation requests:

1. official CLI answer plus standalone search;
2. ai.feei Sol CLI text plus synthetic image;
3. ai.feei Astra CLI text plus synthetic image;
4. ai.feei Sol App protocol explicitly using the reduced `lite-search` profile;
5. ai.feei Astra App protocol with the same explicit profile and search check.

It has no retry loop. The outbound hook rejects a generation beyond the budget and rejects any standalone-search request whose destination is not OpenAI. Before the live turns, a `standard-tools` preflight confirms only that allowed Plugin and user-MCP definitions are forwarded and a forbidden Plugin definition is removed; its result is labelled `DEFINITION_PREFLIGHT_ONLY` and never counts as call/result closure. The two App cases require the Responses Lite search carrier and a successful official search, disclose `reduced-responses-lite`, and make no full Plugin/MCP compatibility claim. The summary explicitly says that combined Standard-tools-plus-search capability is not established. Missing expected cases or evidence is `FAIL`, never an inferred pass.

Full profile qualification is a separate deterministic gate. It must prove an actual `standard-tools` core/allowed-Plugin/user-MCP call-and-result chain and a separate `lite-search` completed search chain with the current App-bundled Codex binary against isolated local fixtures. Results from different profiles are reported separately and cannot be combined into a single capability claim. This gate, like L1 and L2, strips ambient proxy and Provider variables from Codex child processes; all outbound observations terminate at injected in-process fixtures.

## Isolation and privacy

Every automated case uses a temporary `HOME`, `CODEX_HOME`, XDG root, Router home/state/history namespace, random loopback port, and work root. Deterministic gates create a harmless synthetic auth fixture and never read a Provider key. An explicit live canary copies the required Codex auth file into its isolated root with mode 0600 rather than symlinking the real file. Codex child processes never inherit ambient Provider, proxy, shell-agent, App-tools-pipe, or custom-CA variables unless a case supplies an explicitly harmless fixture value.

On macOS the bounded G3 runner re-executes itself under an outer write-deny sandbox for the real Codex, Router, installed-Skill, LaunchAgent and Keychain roots. Codex keeps its own read-only sandbox and uses a temporary home. The receipt records the sandbox-profile hash and expands the before/after authority boundary to the managed catalog, space index and pending transaction. A changed `models_cache.json` fails Core unless an App refresh was observed, the test tree was write-denied, managed authority stayed unchanged, and the refreshed cache contains no Router state.

The harness records timing, model ids, byte counts, header names, event/tool types, status, counts, hashes, and booleans only. It never records request or response bodies, search queries/results/URLs, credentials, image content, tool schemas, or local paths. L0 also verifies that the full test process tree cannot write the real Codex, Router, LaunchAgent, MCP, Skill, Hook, prompt, or session roots.

## Criteria

Hard contracts — a violation fails the case: `H1` completion, `H4` tool integrity, `H5` protocol contract, `H6` credential isolation, `H7` idempotent side effects, `H9` error attribution, `H10` evidence completeness.

Tripwires — a breach is reported for attribution, not treated as a failure: `H2` first-output progress and silence gaps, `H3` repeated requests per turn, `H8` health latency, event-loop delay, and drain time.

Tripwire values live in `docs/e2e/thresholds.json` (shipped with the harness) and are deliberately loose: they are anomaly tripwires, not performance targets. A breach that cannot be attributed fails the case.

The bounded G3 gate is stricter about evidence completeness than it is about latency. Every successful case must account for local route/policy or transparent-relay setup, identity/history work where applicable, archive/observation work, upstream first byte, first substantive event, first text, search and total time where applicable, request/response/tool bytes, retries, reconnects, health, event-loop delay, and final lifecycle state. A cancellation may omit first-byte/text timing only when the receipt proves a generation was sent, the socket then closed before those observations, response bytes and total time were still finalized, and lifecycle state returned to zero. Missing required evidence fails Gateway Core; it is never treated as a fast result.

## Evidence

```
artifacts/e2e/<runId>/summary.json   # per-case verdict, criteria results, harness kind/version/sha256
artifacts/e2e/<runId>/<case>.json    # observation and assertions for that case
artifacts/e2e/<runId>/raw/<case>.jsonl
```

Evidence is written under `artifacts/e2e/`; pass `--out DIR` to write it elsewhere.

Each case records the harness kind, the driver binary source label, its version, and its SHA-256, so a verdict is bound to an exact build without publishing a local absolute path. Promotion runs additionally set `ACCEPTANCE_COMMIT`; the harness rejects a dirty or different checkout and records both the exact commit and Git tree. Run directories and JSON receipts are create-once: an existing path fails rather than being overwritten.

Live channel attribution also fails closed. A truncated HTTP 200 by itself is `UNVERIFIED`, not proof of Provider degradation. `EXTERNAL_DEGRADED` requires a stable Provider status/transport category or an equivalent isolated direct reproduction, with clean identity, lifecycle, and zero retry/replay evidence.

`UNVERIFIED` is reserved for genuinely ambiguous external ownership. A false case-local assertion for routing, destination credentials, catalog truth, payload adaptation, completed-search-result forwarding, or cleanup is `GATEWAY_DEFECT` and fails Gateway Core even when the upstream channel is unavailable.

The focused summary deliberately omits the driver path and stores only its source kind, version, and SHA-256. It also separates implementation/automated results from `appUi: "not-tested"`; app-server evidence cannot sign off the actual menu, label, image picker, or visible account state.

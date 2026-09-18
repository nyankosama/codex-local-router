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

Tool-search history migration adds a focused deterministic matrix: valid single, multiple, interleaved and empty-result pairs; missing, duplicated, reversed and malformed pairs; third-party Responses → official → third-party → Chat Completions switching; function/custom-tool result preservation; encrypted original/view separation; schema/query/ID redaction; and a 10,000-item linear-scan sanity case. The engine uses only local simulated upstreams, and malformed history must fail before the outbound hook is called. This gate does not retry a real retained conversation.

Configuration spaces add deterministic cases for fresh and legacy migration, applied/disabled/pending/ambiguous state, immutable revisions, official auto-capture, clone/diff/default-model/drift capture, official↔Router and Router↔Router switching, historical activation and rollback, one-shot coordinator recovery, active-turn timeout, missing credentials, candidate/service/hash failures, staged rollback, and preservation of non-managed Codex data. Every case uses temporary Codex/Router homes, config/state/LaunchAgent paths, random ports, simulated launchctl, and local upstreams.

Compacted-history recovery adds deterministic cases for current-thread lookup, exact direct-parent inheritance and restart persistence; account, parent and compaction-hash isolation; summary-only failure; complete single-file and parent/child rollout reconstruction; repeated recovery; missing bases, bad boundaries, incomplete tool pairs, corrupt JSON, ambiguous files and existing-record conflicts. Validation failures must write zero checkpoints. A recovered checkpoint is expanded before the one simulated third-party request, so the opaque official compaction never reaches that upstream and no retry occurs. Parent lookup p95 is enforced below 10 ms locally and adds no network request.

The configuration-space candidate gate intentionally performs zero real model calls and does not run `e2e:focused -- --run`. Before and after the gate, operators verify that the installed Router and switcher remain unloaded, port 8788 remains closed, integration remains disabled, and the real Codex config still selects its built-in OpenAI provider. App-server coverage cannot replace a later App UI sign-off.

## Commands

```bash
npm run e2e:l0     # gate: npm test, package audit, source scan
npm run e2e:l1     # credential-free local fixtures: E2E-1/2/3/5
npm run e2e:l2     # credential-free local capacity fixture: E2E-4
npm run e2e:profiles  # credential-free standard-tools and lite-search closure
npm run e2e:tool-search-history  # current app-server plus retained-history migration, all local
npm run e2e        # L0-L2 only; the live case is excluded
npm run e2e:live -- --run  # explicit installed-service concurrency (E2E-6)
npm run e2e -- --include-live --run  # explicit L0-L2 plus live E2E-6
npm run e2e:official-search -- --run  # two-turn official cached-default + explicit-live search
npm run e2e:third-party-search -- --run  # two-turn ai.feei + subscription-search acceptance
npm run e2e:universal-search -- --run  # three third-party bridge/MCP equivalence cases
npm run e2e:release -- --run  # default pre-release gate: profiles + third-party + official search
npm run e2e:prompt-cache  # zero-network derivation/adapter performance gate
npm run e2e:prompt-cache -- --live-feasibility --run  # max 8 direct Provider calls
npm run e2e:prompt-cache -- --live-comparison --run  # 24-call Sol/Astra direct-vs-candidate comparison
npm run e2e:prompt-cache -- --live-app-candidate --run  # current App binary, max 6 Provider generations
npm run e2e:focused -- --run  # explicit five-turn official + ai.feei candidate acceptance
```

## Default GitHub Release qualification

Search-enabled streaming is a mandatory local delivery gate: HTTP and WebSocket,
subscription bridge and legacy fallback, zero and two internal searches (eight
small probes, zero real generations). The synthetic upstream waits for the client
to receive each text delta before continuing. A buffered stream cannot pass.
The gate checks one response lifecycle, ordered unique item IDs, hidden search
calls, exact history replay, and downstream delivery metrics. Live bridge cases
also record text delta counts/timing; the GLM app-server case requires multiple
client text deltas before completion. This is protocol evidence, not App UI signoff.

`sample_first_output_text` measures sampler release only;
`downstream_first_output_text` now measures successful HTTP/WS sending, with
`downstream_stream_completed` reporting counts, bytes and timing without content.
Sending is not a claim about UI paint time. No progress messages are invented:
models that emit tools but no commentary still have no narrative progress.

Every `v*` tag is fail-closed behind two jobs before assets can be published:

1. GitHub-hosted deterministic gates run the full unit/protocol suite, dependency and package audits, and public-source scan.
2. A protected `release-live` environment runs `e2e:release` on a dedicated macOS runner labelled `codex-local-router-release` with the current Codex App, subscription login, Router source configuration, Provider credential and Tavily credential available locally.

The live matrix covers equivalence classes rather than every model × client × search-source combination:

| Case | Why it exists |
|---|---|
| GLM Flash App + subscription bridge | non-GPT Standard Responses function call, fixed OpenAI search and Provider continuation |
| ai.feei Sol CLI + subscription bridge | GPT/Provider regression and independent credential leg |
| ai.feei Sol App + Tavily MCP | client-owned MCP discovery, call/result and continuation without copying MCP authority into Gateway |
| official cached default | unchanged first-party default behavior |
| official explicit live | unchanged first-party live-search override |

The deterministic profile stage adds five local HTTP/WS, tool, lifecycle and performance cases. The entire real gate is capped at five turns, sixteen model generations and nine searches. The third-party stage is capped at `3 / 8 / 3`, including its single client-owned MCP search and the four sends required by a deferred MCP call/result closure; the official stage is capped at `2 / 8 / 6`, allowing at most three first-party searches and therefore four model sends per cached/live turn. Repeated payloads, blocked requests, implicit retries, a missing case, a different Codex binary or commit, incomplete MCP inventory, credential crossing, or any non-PASS stage rejects the tag. Stages run sequentially and stop after the first failure, so a local defect cannot consume the remaining external budget.

The release runner must be dedicated and protected; pull requests never execute live credentials on it. OpenAI/Provider credentials remain in its local login, Keychain or service environment and are not GitHub workflow inputs. `TAVILY_API_KEY` and any required `NODE_EXTRA_CA_CERTS` must be available to the runner service. The machine-readable receipt is written outside the checkout, hashed in the workflow log, and contains only the redacted fields described below. App UI remains a separate manual sign-off and is not a GitHub Release blocker.

Prompt-cache affinity has a staged, fail-closed gate. The default `e2e:prompt-cache` command makes zero network calls and checks HMAC derivation p95 below 5 ms, body-adaptation p95 below 25 ms, and wire growth below 128 bytes. The current effect gate uses `--live-comparison --run`: 24 interleaved, no-retry Sol/Astra generations compare the direct client shape with the candidate anonymous key under an otherwise fixed request. `--live-app-candidate --run` then uses the current App-bundled Codex binary, a temporary Codex/Router home and an isolated Gateway for at most six Provider generations. It must close one read-only MCP call/result plus a following turn per model, observe a stable anonymous-key fingerprint and the per-frame Lite header, and keep subscription/provider identity separated. Missing usage remains unknown rather than zero. Older `--live-feasibility`, `--live-gateway` and `--live-app-protocol` modes remain available for earlier candidate reproduction but are not the current 30-generation gate.

The historical ai.feei feasibility attempt that stopped on its first HTTP 403 remains recorded. A later 35-request causal diagnostic did not overwrite it: all 35 synthetic calls completed, and a strict single-variable toggle moved Sol from 30.11% weighted cache reuse without a key to 98.55% with the Gateway-derived anonymous key. That result establishes a Gateway-controlled field effect for that workload, not ai.feei's internal account-pool algorithm and not a universal natural-session hit-rate guarantee. The current candidate must still pass its own Sol/Astra and App-protocol gates before local activation.

`e2e:tool-search-history` drives the current App-bundled app-server through a
new-session model switch, then reproduces the affected retained-response path
through the real Gateway HTTP identity and encrypted-archive boundary. It uses
synthetic auth and credentials, a loopback Provider, an injected official
response, a random port, and temporary homes. It asserts that the destination
receives one fixed marker, no dynamic schema/query/provider identifiers, while
the original encrypted pair remains byte-equivalent. It never retries a real
conversation or contacts an external upstream.

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

Full profile qualification is a separate deterministic gate. It must prove an actual `standard-tools` core/allowed-Plugin/user-MCP call-and-result chain and, after an official-to-third-party switch in the same task, a `lite-search` core-tool result plus completed-search chain with the current App-bundled Codex binary against isolated local fixtures. The Lite case still does not claim the full Plugin/MCP surface of `standard-tools`. Results from different profiles are reported separately and cannot be combined into a single capability claim. This gate, like L1 and L2, strips ambient proxy and Provider variables from Codex child processes; all outbound observations terminate at injected in-process fixtures.

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

By default, evidence is written below the local Router data directory as `evidence/e2e/<runId>/`. Legacy acceptance scripts use `evidence/legacy/`. Pass `--out DIR` to choose another private location. Raw evidence cannot be written inside the source checkout and is never part of a public export or npm package.

Each case records the harness kind, the driver binary source label, its version, and its SHA-256, so a verdict is bound to an exact build without publishing a local absolute path. Promotion runs additionally set `ACCEPTANCE_COMMIT`; the harness rejects a dirty or different checkout and records both the exact commit and Git tree. Run directories and JSON receipts are create-once: an existing path fails rather than being overwritten.

Live channel attribution also fails closed. A truncated HTTP 200 by itself is `UNVERIFIED`, not proof of Provider degradation. `EXTERNAL_DEGRADED` requires a stable Provider status/transport category or an equivalent isolated direct reproduction, with clean identity, lifecycle, and zero retry/replay evidence.

`UNVERIFIED` is reserved for genuinely ambiguous external ownership. A false case-local assertion for routing, destination credentials, catalog truth, payload adaptation, completed-search-result forwarding, or cleanup is `GATEWAY_DEFECT` and fails Gateway Core even when the upstream channel is unavailable.

The focused summary deliberately omits the driver path and stores only its source kind, version, and SHA-256. It also separates implementation/automated results from `appUi: "not-tested"`; app-server evidence cannot sign off the actual menu, label, image picker, or visible account state.

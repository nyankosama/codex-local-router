# Codex Local Router Quality Gate Acceptance Record

Record status: **frozen previous run; incomplete for promotion**. Candidate
`ffbc003` passes the
deterministic suite, the isolated protocol suite and the capacity boundary.
It is not a claim that the real Gateway is enabled, that the App UI is signed
off, or that a release is ready.

The next Goal uses revision 2 of
[`goal_spec.md`](goal_spec.md). It separates Gateway Core qualification from
external channel health, but that new contract does not retroactively turn any
FAIL in this record into PASS. The next run must create a new immutable receipt
directory and append a new dated candidate section to this file.

The new immutable receipt is
[`receipt.json`](../../../artifacts/e2e/quality-gate-20260914T143657Z-final/receipt.json)
for execution commit
`ffbc003518381694da23f2bc239236c57e6a25a5` (tree
`baf639d7e3f2ca084c9294188e4fc14deb96cad2`). The receipt records only
structured, hashed and redacted evidence. Earlier receipts remain frozen.

## 0. Contract transition for the next run

The next candidate must report these conclusions separately:

| Outcome | Required values |
| --- | --- |
| Gateway Core | `PASS` / `FAIL` |
| Official Subscription | `PASS` / `FAIL` / `NOT_RUN` |
| Each third-party channel | `HEALTHY` / `EXTERNAL_DEGRADED` / `GATEWAY_DEFECT` / `UNVERIFIED` |
| Local App Gray Run | `PASS` / `FAIL` / `NOT_RUN` |
| Local Use Ready | `YES` / `NO` |
| Release Ready | `YES` / `NO` |

For the new run only, an upstream-only ai.feei or OpenCode Go failure may be
classified `EXTERNAL_DEGRADED` and remain non-blocking for Gateway Core when the
full attribution contract is satisfied. It still cannot be reported as a
healthy or ready channel. An ambiguous failure is `UNVERIFIED`; a Gateway-owned
failure is `GATEWAY_DEFECT` and blocks Core.

Likewise, future `models_cache.json` drift is an environment observation rather
than an automatic blocker only when the revised G0 isolation and authoritative
file invariants are freshly proven. The unresolved drift below remains an
accurate result of the previous contract and run.

## 1. Execution boundary

| Item | Evidence |
| --- | --- |
| Codex core | `codex-cli 0.154.0-alpha.6.2`, SHA-256 `ecad78db…b94bcb` |
| Harness | 均衡 `Auto + Auto`; Root requested `gpt-5.6-luna/max` |
| Independent review | Final `gpt-5.6-sol/xhigh` read-only review of exact HEAD `a4e579b` (tree `66a3d912`) returned **FAIL for promotion**; provenance was closed, but the L3 blockers remained |
| Consultant | `gpt-6-astra/medium` consulted for isolation and tool evidence |
| Test roots | temporary `HOME`, `CODEX_HOME`, XDG, Router home, state, history, fixture and random ports |
| Credentials | copied to an isolated 0600 auth file; provider, shell, SSH-agent, app-tools-pipe and CA credential variables stripped |
| Real machine | Gateway and switcher unloaded; 8788 not listening; App not restarted or stopped |

The App-server tool test cannot run inside the outer macOS write-deny sandbox:
its `exec_command` child invokes a nested `sandbox-exec`, which fails closed
with `Operation not permitted`. The L1 run therefore used the same temporary
roots, copied auth, local fixture, random ports and isolated child environment,
but omitted only that outer write-deny layer. L0 separately proves that a
write probe against the real Codex root returns `EPERM`; this boundary
difference is recorded rather than hidden as a pass.

## 2. Gate summary

| Gate | Result | Evidence |
| --- | --- | --- |
| L0 deterministic safety | PASS | 256/256 tests, package audit and architecture scan; summary SHA `43661383…9f69a8` |
| L1 protocol/boundary | PASS | E2E-1, E2E-2, E2E-3 and E2E-5; serial rerun summary SHA `9d19a77b…17b688` |
| L2 capacity boundary | PASS | E2E-4; summary SHA `35a14b17…fe49b7` |
| `npm audit --omit=dev` | PASS | Explicit official registry: `https://registry.npmjs.org`; zero advisories |
| Public package audit | PASS | 78 package files, 194115 bytes; both CLI commands present |
| Public export audit | PASS | 120 files, 119 text files; no private evidence included |
| Historical real catalog attribution | **FAIL / unresolved** | The real `models_cache.json` snapshot changed while App was active; writer was not directly observed |
| Live L3 promotion | **FAIL** | Run `20260914154543`; official search and Astra CLI image passed, but Sol live transport and App Plugin/MCP evidence failed; standard Responses was blocked by current Lite-only validation; see the redacted receipt |
| Final independent review | **FAIL for promotion** | Exact HEAD `a4e579b069c9a9cc89011a5e4a2cd9863827dcf0`, tree `66a3d912c424e84e97da2956eb55f130596d3044`; the reviewer accepted the corrected provenance but not the unresolved L3/product blockers |
| Real App UI/L4 | not run | Requires user-operated App sign-off |
| GitHub/npm release | not run | Outside this candidate |

The overall verdict is therefore **incomplete**, not PASS.

## 3. Deterministic gate details

`npm test` is **256/256 PASS** under the real-root write-deny profile.
`npm audit --omit=dev --registry=https://registry.npmjs.org`,
`npm run audit:package`, `node scripts/audit-public.mjs` and `git diff --check`
also pass.

The L0 profile hash is
`1d5abc225e75a771807b7895413011ed2b913ad33b834436438263f47c6f9a6c`.
The child-process regression now strips provider and shell boundary variables,
including `LOCAL_PROXY_KEY`, `SSH_AUTH_SOCK`,
`CODEX_APP_TOOLS_PIPE_PATH` and `NODE_EXTRA_CA_CERTS`, while retaining only
explicitly harmless fixture values. No test process is allowed to write the
real Codex, Router or LaunchAgent roots.

The fresh read-only machine snapshot associated with this receipt was:

- integration active: `false`; active space: `official@1`;
- Gateway/switcher loaded: `false`/`false`;
- 8788: not listening;
- App: running and not touched by the gate;
- `config.toml` SHA-256:
  `fcad838d9bd415be476d4a23d7b71d0bd3f0cf3f93781daab9d17a78fed132e4`;
- `models_cache.json` SHA-256:
  `ef01d8758c30b11653566a2b72e346d96b0ede5a20f57a1de35b58f390d908f5`.

These are observations, not a new official baseline. The catalog changed in
the active-App period, but no process-level writer observation exists, so the
quality gate keeps the promotion blocker.

## 4. Isolated L1 cases and performance health

The final serial L1 run used 19 bounded model-generation calls in temporary roots:

| Case | Coverage | Result | Health p95 | Event-loop p99 |
| --- | --- | --- | ---: | ---: |
| E2E-1 | official subscription CLI/WebSocket transparent relay | PASS | 10 ms | 23 ms |
| E2E-2 | third-party Responses, native image and image-to-text migration | PASS | 3 ms | 23 ms |
| E2E-3 | cross-model history, tool call/result and prewarm | PASS | 4 ms | 23 ms |
| E2E-5 | `/v1` local auth, Chat target and continuation | PASS | 4 ms | 23 ms |

These are health lines, not optimization targets. The run stays within the
bounded acceptance budget and has no implicit retry or external user data.

### E2E-3 tool evidence rule

The previous global “call exists + result exists” check was too weak. The
current assertion is scoped to the first DeepSeek thread and turn and requires:

1. a tool definition in that first routed request;
2. exactly one `function_call` entry and exactly one
   `function_call_output` entry;
3. the output `call_id` to match the call `call_id`;
4. the only tool name to be `exec_command`;
5. the synthetic fixture marker in the tool result;
6. the marker in the source answer before file deletion and in each expected
   cross-model recall request/answer;
7. no duplicate tool execution and at least four recorded migrations.

The public receipt records only counts, booleans and hashes; it does not expose
tool schemas, commands, output, prompts, call IDs or credentials.

## 5. Live L3 canary

The final bounded real-channel canary ran on candidate `ffbc003` with the
contracted maximum of five short turns and ten model generations. The redacted
record is [`l3-focused-ffbc003.json`](../../../artifacts/e2e/quality-gate-20260914T143657Z-final/l3-focused-ffbc003.json).
It stopped at the hard budget: four turns, ten generations, 11 attempts, one
blocked generation, one detected implicit retry and two search requests. No
automatic retry was added after the budget was reached.

| Case | Result | Evidence |
| --- | --- | --- |
| Official CLI search | PASS | Search completed through `chatgpt.com`; no third-party credential crossing |
| ai.feei Sol CLI | FAIL | One `/v1/responses` request reached `ai.feei.cn`, then the run ended with `ws_error`/`upstream_transport_error`; the image prompt used the corrected `--` separator |
| ai.feei Astra CLI | PASS | One `/v1/responses` request completed and synthetic image recognition passed |
| ai.feei Sol App protocol | FAIL | Search completed, but the Lite App payload carried only core/dynamic tool names; no direct allowed Plugin or user-MCP definition/result was observed |
| ai.feei Astra App protocol | not run | The hard generation budget was exhausted before this case; it is not counted as PASS |

The tool-shape preflight itself passed: 18 forwarded tool definitions included
an allowed Plugin and a user MCP, and a confirmed forbidden Plugin was removed.
The identity boundary also passed: official requests were observed only at
`chatgpt.com`, third-party generation only at `ai.feei.cn`, and no subscription
credential reached the third party. These facts do not turn the failed Sol/App
cases into PASS; live reliability and direct tool-result evidence remain open.

The requested standard-Responses App variant was not substituted: current
configuration validation rejects `useResponsesLite=false` whenever an
App-enabled target advertises standalone search. The observed Lite search path
is therefore evidence for the supported current protocol only; it does not
close the standard-Responses design gap.

## 6. Destination and credential boundaries

| Flow | Required boundary | Observed |
| --- | --- | --- |
| Official generation/search | OpenAI `chatgpt.com` only | E2E-1 and relay tests PASS |
| Third-party generation | configured provider only | E2E-2 credential-boundary assertion PASS |
| Local `/v1` | local token; no subscription identity | E2E-5 auth assertion PASS |
| Plugin policy | core and user MCP preserved; confirmed disallowed Plugin blocked | deterministic policy tests PASS |
| Search lease | official/provider/disabled/unresolved explicit; no fallback | deterministic lease tests PASS |

## 7. Patch records

| Patch | Root cause | Change | Verification |
| --- | --- | --- | --- |
| P-008 | CLI uses Responses WebSocket; HTTP capture grouped all turns | Opaque WebSocket capture with per-`response.create` streams and structural frames | harness regression; E2E-1 PASS |
| P-009 | App-server model-switch frames may omit `previous_response_id` | Engine uses per-thread last target and migrates only for cross-provider history/tool shapes | relay regression; E2E-3 migrations/recall PASS |
| P-010 | App notifications omit some internal tool items; outer sandbox rejects nested sandbox | Thread/turn markers, redacted tool evidence and documented boundary | E2E-3 PASS; L0 write probe EPERM |
| P-011 | L1 inherited shell/app boundary variables; tool evidence allowed mismatched IDs | Strip four additional variables; require exact call/result ID pairing and one `exec_command` | targeted harness tests, 256/256, new L1 PASS |
| P-012 | Codex CLI treats `-i/--image` values as a variadic list; appended prompt text was consumed as another image | Terminate the image list with `--`; recursively aggregate nested `additional_tools` names for redacted App evidence | 256/256; Astra CLI image PASS; Sol live transport remains FAIL |
| P-013 | Focused Harness replaced App-enabled FEEI targets with minimal objects, losing catalog metadata | Preserve existing target/app metadata and only redirect provider/preset; retain current Lite policy instead of bypassing validation | L3 run bound to `ffbc003`; standard Responses false rejected explicitly |

## 8. Independent review and remaining gates

After the receipt provenance fix, a final independent `gpt-5.6-sol/xhigh`
Reviewer inspected exact HEAD
`a4e579b069c9a9cc89011a5e4a2cd9863827dcf0` (tree
`66a3d912c424e84e97da2956eb55f130596d3044`) with a clean worktree. The
reviewer confirmed that the provenance issue was closed and returned **FAIL for
promotion** because the live L3 and capability-profile blockers below remained.
The receipt's older `pending-review-of-ffbc003` field is preserved as immutable
run-time evidence and is superseded only by this later candidate-bound review
record; it is not edited in place. The `gpt-6-astra/medium` consultation was
diagnostic only and did not replace the final Reviewer.

Still not accepted:

- direct attribution of the real `models_cache.json` writer;
- a passing real-machine L3 canary (the recorded run is FAIL);
- stable ai.feei Sol live transport and direct App Plugin/MCP tool-result evidence;
- a supported standard-Responses + standalone-search App contract, if that remains a required product target;
- manual Codex App model-menu/search/UI sign-off;
- production enablement, GitHub Release or npm publication.

The rollback command remains
`codex-local-router rescue --subscription --yes` and requires the App to be
closed. It was not run because the current official configuration was left
untouched.

## 9. 2026-09-15 revision-2 Gateway Core candidate

This is a new append-only checkpoint under revision 2 of `goal_spec.md`; it
does not rewrite Sections 1-8 or retroactively change their verdicts. The
implementation candidate is `e62e9a64c5119563138e0a4ae4c428f55deb7ed7`
(tree `7dd447113159b13ffdeae8443194b4a5a6aa6738`). A later documentation-only
receipt commit must be revalidated and independently reviewed before G4.

### 9.1 Closed review findings

| Patch | Finding | Resolution | Deterministic evidence |
| --- | --- | --- | --- |
| P-014 | Legacy `useResponsesLite: true` plus disabled search was rejected | Preserve its transport as unprofiled `legacy-responses-lite-transport-only`; explicit `lite-search` remains strict | capability-profile regression |
| P-015 | Codex children could inherit Router and XDG state paths | Force HOME, Codex, all XDG, Router config/state, and instance ID below the temporary child root | environment regression and L0 |
| P-016 | HTTP 200 plus a truncated stream was blamed on the Provider | Require stable status/transport or an equivalent direct reproduction; any ambiguous retry is `UNVERIFIED` | channel-attribution regression |
| P-017 | Run receipts could be overwritten and were commit-only | Create-once directories/files and exact clean commit plus Git-tree binding | evidence immutability regression |
| P-018 | Official cancellation treated a legitimate prewarm as a second generation | Count `generate:false` prewarm separately and require exactly one real generation before cancellation | classification regression and one hypothesis-driven live rerun |

### 9.2 Deterministic and package gates

The first four receipts are bound to clean commit
`12fe86265ce6f04c1061e2c99f52eb1f25484263` (tree
`c30c00e8ccaf78fd5e7acd203d5de2360437f5c8`). The only subsequent source
change in `e62e9a6` is the P-018 acceptance-classifier correction and its test.
All gates must be repeated against the final receipt commit before promotion.

| Gate | Result | Immutable receipt SHA-256 |
| --- | --- | --- |
| L0 | PASS; 284/284 tests, package/source scan | `b21c131a953f072ee5280661b4e122bdec4443af4d62e4de9cf2827a89e9eec4` |
| L1 | PASS; E2E-1/2/3/5 | `7c50601162e83c7f7c192e79b89e44280f1b15bb8cbf69217a6a58cdbeaf50bc` |
| L2 | PASS; E2E-4 capacity boundary | `dccd8e698c41e737c6fc8da41463431ae48e514f2a49bc62e1da560959c206b8` |
| G2 | PASS; Standard tools, Lite search, CLI HTTP, WS switching | `fbcec6baf75dc3d99136589069c2356b08e552cfb515d59d124d26d91ace5bad` |

The clean public export repeated 284/284 tests, zero production-dependency
advisories, package/public audits, tarball creation, and both command aliases.
The tarball SHA-256 was
`8dbbf71884512857353798160150c025d8165ad819c8faf9f044dfca4f3dc231`.

Performance remained within the non-optimization health lines. G2 recorded
route/setup p95 6 ms, health p95 2 ms, event-loop p99 24 ms, and zero leaked
turns/WS connections. L1 loop p99 stayed in the mid-20 ms range. L2's large
shared-process fixture recorded external health 501 ms and explicitly marked
same-process loop timing not applicable.

### 9.3 Real-channel evidence and classification

The official cancellation rerun is stored at
`artifacts/e2e/gateway-core-qualification-v2-20260915/g3/official-ws-e62e9a6.json`
with SHA-256
`dbcbfbb0c70442794d4275a8cbe1a71f1770ca48f007eefddba174415608b71a`.
It used the App-bundled `codex-cli 0.154.0-alpha.6.2` binary (SHA-256
`ecad78dbf98adb89ec475edac86630406cbe59d9f3070b17d88065f136b94bcb`):
one prewarm, exactly one real generation, cancellation before any terminal
client event, OpenAI-only destination, no retry, and zero remaining active
turns or WS connections. Health p95 was 4 ms and event-loop p99 25 ms.

The prior immutable `bd43485` live receipt remains the official normal-answer
and natural-search evidence: its official CLI case passed with generation and
search only at `chatgpt.com`, a completed search item/source, no retry, and
clean lifecycle. Between `bd43485` and this candidate the only `src/` change is
the third-party legacy Lite compatibility branch, so no official relay code is
being silently substituted.

Channel verdicts under revision 2 are deliberately separate:

| Path | Verdict | Basis |
| --- | --- | --- |
| Official subscription | PASS pending final candidate-bound Review Gate | prior normal/search PASS plus current generation-cancel PASS |
| ai.feei Sol `lite-search` | HEALTHY historical canary; not required for Core | completed App/search/result-correlation path with clean identities |
| ai.feei Astra | UNVERIFIED | no current revision-2 live path; excluded from ready set |
| OpenCode DeepSeek | UNVERIFIED | one HTTP 200 stream ended early and the client attempted a repeat; insufficient Provider/Gateway attribution, no rerun |

The OpenCode observation is no longer mislabeled `GATEWAY_DEFECT`, but it is
not promoted to `EXTERNAL_DEGRADED` or `HEALTHY`. Deterministic transport,
image/max-reasoning, identity, and retry-boundary coverage remains part of Core.

### 9.4 Current outcomes

| Outcome | Checkpoint verdict |
| --- | --- |
| Gateway Core | PASS pending final exact-HEAD rerun and Review Gate |
| Official Subscription | PASS pending final Review Gate |
| Local App Gray Run | NOT_RUN |
| Local Use Ready | NO until G4 passes |
| Release Ready | NO; outside this Goal |

The real machine remained on `official@1`: integration disabled, Router and
switcher unloaded, port 8788 closed, and authoritative Codex/Router hashes
unchanged. The running App refreshed `models_cache.json`; revision 2 explicitly
allows that cache drift when the isolated process tree cannot write the real
root. G4 still requires the user's separate confirmation immediately before
activation. No installation, merge, GitHub Release, npm publication, App quit,
or App restart occurred in this checkpoint.

## 10. 2026-09-15 provider-failure provenance correction

This append-only section records the correction required by the independent
review of `6506a87`. That review found that a generic Gateway `ws_error` or
`request_error` carrying a locally synthesized HTTP 502 could be mistaken for a
stable Provider failure. In the concrete counterexample the Provider had
returned HTTP 200 before the stream ended without a terminal event, so the
contract requires `UNVERIFIED`, not `EXTERNAL_DEGRADED`.

### 10.1 P-019 and deterministic evidence

| Patch | Finding | Resolution | Regression |
| --- | --- | --- | --- |
| P-019 | Error-side status and transport fields lacked event provenance | Count a non-2xx status only from `provider_error`, and a stable network category only from `upstream_transport_error`; direct captured outbound status remains authoritative | HTTP 200 plus `ws_error`/`upstream_stream_incomplete`/502 stays `UNVERIFIED`; Provider 429 and upstream timeout remain externally attributable |

The corrected implementation commit is
`91596d24108d92918128ae70ed0ff0da67c1ed81` (tree
`cc6ad1f544327d041b01d8a4407617268317cfab`). Its clean, create-once receipts
are:

| Gate | Result | Immutable receipt SHA-256 |
| --- | --- | --- |
| L0 | PASS; 286/286 tests plus package/source scan | `c0ca8bf9716d5f01c2434a616f68b96ae996cf18e5245793d233861f7f66920e` |
| L1 | PASS; E2E-1/2/3/5 | `5697249b0f21577d4b177cdeb46b32a66dd8441fc0cf127fe69543bef4ec9fb8` |
| L2 | PASS; E2E-4 capacity boundary | `02352dd482317f53218fbb48d2f07bf465cbf6e3bfb9bd8e7b2f1e89a1b2adb5` |
| G2 | PASS; Standard tools, CLI HTTP, Lite search, WS switching/lifecycle | `dbdda9c50353a0e07ffa0465f8ecfe0c6da9327bc3de3ba090c1ae4a945f4322` |

Production dependency audit reported zero advisories. Package and public-tree
audits passed. A fresh public export repeated 286/286 tests, dependency and
package/public audits, tarball creation, clean install, and both command aliases;
the tarball SHA-256 was
`2bc8df1b602df2aa8f42e37e1193ef02e1f2f26f4fff43dd736df35b2f24ea19`.

G2 recorded request setup p95 3 ms, health p95 1 ms, event-loop p99 23 ms,
zero active turns, and zero WebSocket connections after completion. These are
normal-health observations, not optimization targets.

### 10.2 Live evidence reuse and channel verdicts

P-019 changes only the acceptance classifier and its regression; it does not
change Router, relay, adapter, identity, search, App protocol, history, or
transport implementation. No additional real Provider call was made. The
bounded live evidence in Section 9.3 therefore remains the applicable G3
evidence:

- Official subscription: normal generation/search plus generation/cancel remain
  PASS and OpenAI-only.
- ai.feei Sol `lite-search`: `HEALTHY` for the recorded historical canary; it is
  not required for Gateway Core.
- ai.feei Astra: `UNVERIFIED` and excluded from the ready set.
- OpenCode DeepSeek: `UNVERIFIED`; HTTP 200 followed by a truncated stream and a
  client repeat is insufficient to attribute the failure to either Provider or
  Gateway.

The current real machine is still official-direct. `config.toml`, Router
`config.json`, integration state, and space index retain SHA-256 values
`fe72dc540d…9982`, `2d0978dceb…301b3`, `211ae05e10…6374`, and
`223ba9e105…172c`; Router and switcher LaunchAgents are unloaded, port 8788 is
closed, and there is no pending space-switch transaction. The running App may
refresh `models_cache.json` under the revision-2 G0 exception.

The exact final candidate is the clean commit containing this section. Because
a Git commit cannot embed its own identity, the Goal checkpoint and independent
Review Gate must bind the resolved HEAD/tree and the freshly repeated receipt
hashes after this section is committed. Until that Review Gate passes, G4 remains
closed; no installation, activation, App restart, merge, or publication is
authorized.

## 11. 2026-09-15 fail-closed G3 correction and replacement official receipt

This section supersedes only the current-candidate conclusions in Sections
9-10; all older receipts remain immutable. The independent review of `b6cb88d`
found two further false-PASS paths in the live qualification driver:

1. a disallowed `models_cache.json` drift was reported but not included in the
   Gateway Core boolean; and
2. case-local Gateway assertions such as catalog truth, payload adaptation,
   search-result forwarding, identity and cleanup were not all included in
   third-party attribution or the Core boolean.

The old `bd43485` receipt recorded cache drift while its process-level App probe
reported false before and after. Its own `modelCacheDriftAllowed=false` was
correct, so that receipt remains a G0/Core FAIL and is no longer used as the
current machine-boundary proof. The earlier statement that this specific drift
was an observed running-App refresh is withdrawn for current qualification; it
does not rewrite the old receipt.

### 11.1 P-020 and P-021

| Patch | Finding | Resolution | Deterministic evidence |
| --- | --- | --- | --- |
| P-020 | G3 excluded model-cache legality and several managed files from the Core boundary | Include cache drift legality in Core; require observed App activity, real-root write denial, unchanged authority and no Router state when drift occurs; also track managed catalog, space index and pending transaction | cache/no-cache, App, write-deny, authority and Router-state matrix |
| P-021 | Local catalog/payload/result/identity/lifecycle failures could become `UNVERIFIED` | Freeze explicit Gateway-owned assertions for official CLI/WS, FEEI and OpenCode cases; any false local assertion forces `GATEWAY_DEFECT` and Core FAIL | per-case assertion matrix plus classifier/Core false-PASS regressions |

On macOS the G3 driver now re-executes under an outer Seatbelt profile that
denies writes to the real Codex, installed-Skill, Router, LaunchAgent and
Keychain roots. Codex keeps its own read-only sandbox and uses temporary state.
The receipt records only the profile hash and protected-root classes, not local
paths.

The implementation commit is
`e0c851cbcad987413bb7d16494c43cbe6e9ab2f0` (tree
`1183f701684c2d1450c058cde648737fa41abb9b`). Its create-once automated
receipts are:

| Gate | Result | Immutable receipt SHA-256 |
| --- | --- | --- |
| L0 | PASS; 291/291 tests plus package/source scan | `e19ede6849df7873356d8ba4356eadab229c9ea9296394fd7a45233f8c0390e4` |
| L1 | PASS; E2E-1/2/3/5 | `5a7b64cd7364c97fca6a0c3456ef8c17c68210c2d3796f98f17850eb67f41261` |
| L2 | PASS; E2E-4 capacity boundary | `2768adfbb7f6a4d3039a51d5bb28f21c4ba26b80344bac671d1bf09835323c80` |
| G2 | PASS; four separate capability-profile cases | `133246a7487ef66c8a9b673be1319501003e264310f01e605c4db5338c0dc3f2` |
| G3A official-only replacement | PASS; Core and Official Subscription | `4cb174a3bbef626392ab2b6a3e329533e2d7f5495a146af1e5c6f9decc1b4a98` |

### 11.2 Replacement G3A evidence

The replacement G3A run used the App-bundled `codex-cli
0.154.0-alpha.6.2` binary (SHA-256
`ecad78dbf98adb89ec475edac86630406cbe59d9f3070b17d88065f136b94bcb`).
It consumed two short turns, three generation sends and one search request,
with zero blocked sends and zero implicit retries:

- the normal official CLI turn completed independent search without `--search`
  or a persisted override, observed a completed search item and source, and sent
  generation/search traffic only to `chatgpt.com`;
- the official WebSocket turn observed one real generation after a separate
  prewarm, cancelled before any terminal client event, and returned active turns
  and WebSocket connections to zero;
- every official case-local Gateway assertion passed, including destination,
  identity and lifecycle boundaries.

The outer write-deny profile was active. The real App runtime signal was
observed without exposing its pipe path. The model cache did not drift during
this replacement run and contained no Router state. `config.toml`, Router
config, integration, managed catalog, space index, pending transaction,
LaunchAgents and port 8788 were unchanged; Router and switcher remained
unloaded.

G3A performance stayed inside the soft health lines: health p95 1 ms,
event-loop p99 23 ms, zero remaining active turns and zero remaining WebSocket
connections. The observed official search upstream time is external network
time and is not treated as local Gateway overhead.

The channel conclusions remain separate: ai.feei Sol `lite-search` is
`HEALTHY` only for its earlier bounded canary; ai.feei Astra and OpenCode
DeepSeek remain `UNVERIFIED` and excluded from the ready set. The replacement
official-only run intentionally made no third-party call.

The exact final candidate is the clean commit containing this appended section.
All deterministic/package gates must be repeated against that exact HEAD/tree,
followed by a fresh independent `gpt-5.6-sol/xhigh` Review Gate. G4 remains
closed until that review passes and the user separately approves real-machine
activation.

## 12. 2026-09-15 G3.5 and package-completeness Review Gate correction

The fresh independent `gpt-5.6-sol/xhigh` Review Gate for final candidate
`bd463d9039e0ed20b4334518246878a50d7a5bda` (tree
`73961382617210c4a8f2697bbd668807a3b499c0`) recomputed all six supplied hashes
and found three further P1 false-PASS paths. The candidate therefore remains an
immutable failed checkpoint and does not authorize G4:

1. the G3.5 boolean accepted missing per-case local/upstream timing and WebSocket
   byte/total-time evidence;
2. the tarball declared `test`, package-audit and E2E commands whose supporting
   files were not included; and
3. model-cache Router-state detection relied on product/port text even though a
   custom catalog has stable `gateway_*` semantic fields.

The next candidate closes these paths by:

- associating every official WebSocket request with response bytes, first-byte,
  first-substantive, first-text, terminal/close and total-time observations;
- requiring a complete, case-specific performance evidence matrix before Core
  can pass, with only a narrowly proven post-send cancellation absence recorded
  as expected;
- timing local route, policy, identity/history, archive/observation and
  transparent-relay setup without retaining request or response content;
- parsing the model cache for stable Router catalog fields and treating invalid
  JSON as unresolved rather than absent; and
- shipping the test tree and all declared script targets, while teaching package
  audit to reject dangling Node scripts.

The exact final candidate is the clean commit containing this section. L0-L2,
G2, G3A official-only, package/public-export checks and a fresh independent
`gpt-5.6-sol/xhigh` Review Gate must all be regenerated against that exact
HEAD/tree. No G4 activation, merge, installation, or publication is authorized
by this section.

## 13. 2026-09-15 external-failure accounting Review Gate correction

The independent final Review Gate for candidate
`d7f95cb71dac481aa19d0f61ad4642e16a0885b9` (tree
`a5043067fcd8e17e8f56556a892456822f09b7a9`) verified the previous three
corrections and all supplied hashes, but found one further P1 false-Core-failure
path. A third-party connection or timeout failure before response headers set a
total time but left response bytes unset. The performance gate correctly
required explicit byte accounting, so a channel otherwise attributable as
`EXTERNAL_DEGRADED` or `UNVERIFIED` incorrectly made Gateway Core fail.

The next candidate explicitly finalizes every pre-header HTTP transport failure
with zero response bytes, an incomplete-response marker, a structural
termination reason and total time. Regression coverage proves both sides of the
contract: an externally degraded or unresolved channel with complete zero-byte
accounting does not fail performance health, while missing accounting still
fails closed. This does not loosen route, identity, retry, lifecycle, or local
performance requirements and does not change production traffic handling.

The exact final candidate is the clean commit containing this section. All
deterministic/package gates and the one justified exact-candidate official G3A
rerun must be regenerated, then reviewed by a fresh independent
`gpt-5.6-sol/xhigh` Reviewer. G4 remains unauthorized until that review passes
and the user separately approves activation.

## 14. 2026-09-15 bounded official-search canary correction

The exact-candidate G3A rerun for `dfe0a960d7949bdbebabd58aabee02ff117a3a03`
(tree `272af65999635d502081df10a9fe7cfb04c1dd45`) preserved all safety and
Gateway invariants but did not pass. The official model completed four OpenAI
search requests and then requested a fifth before producing the required short
answer. The Harness correctly blocked that fifth search at the hard budget;
there were no implicit retries, credential crossings, local performance
anomalies, resource leaks, Router writes, or real-machine drift. The immutable
failed receipt remains evidence and is not rewritten.

This is classified as a canary cost-control gap, not a Gateway data-plane
defect. The canary previously requested documentation discovery without bounding
the model's search strategy. The next candidate asks the normal first-party
search capability for exactly one search, explicitly forbids a second search
even when results are incomplete, and retains the same completion, source,
destination, identity, lifecycle and performance assertions. Its official-only
hard budget is narrowed to two turns, six generation sends and one search; the
general five/ten/four budget remains available only to the full multi-channel
qualification.

No further live call is authorized by this record. After deterministic/package
checks freeze the next candidate, an additional bounded G3A call requires the
user's explicit budget approval. G4, installation, merge and publication remain
unauthorized.

## 15. 2026-09-15 approved bounded official-search G3A receipt

The user explicitly approved one additional live G3A call for the exact
candidate `a85c9d4e8c2d97339725b0d24abe787d254ea607` (tree
`8501a888f82f9a9feec3e7d7b5fcfb29bdab76fb`). The isolated run is recorded at
`artifacts/e2e/gateway-core-qualification-v2-20260915/g3/official-a85c9d4.json`;
the complete source receipt has SHA-256
`1383cd4c2307cf2d269d4b94530ffe8858112d46e53211a89ef0db2df69ae402`.

The App-bundled `codex-cli 0.154.0-alpha.6.2` (SHA-256
`ecad78dbf98adb89ec475edac86630406cbe59d9f3070b17d88065f136b94bcb`) completed
both official cases: the normal CLI turn performed one independent search
without a `--search` flag or persisted override, and the WebSocket case
performed one real generation after prewarm and cancelled cleanly. The run
used two turns, three generation sends and one search request, with zero
blocked requests and zero implicit retries. Search and generation traffic went
only to `chatgpt.com`; the required source marker and completed search item
were observed.

The G3A result is `Gateway Core=PASS` and `Official Subscription=PASS`.
Health p95 was 6 ms and event-loop delay p99 was 24 ms; all case-local
performance and lifecycle assertions passed. The outer write-deny profile was
active. Authoritative Codex/Router/integration/space/LaunchAgent state and
port 8788 were unchanged; the App refreshed `models_cache.json`, which is
allowed by G0, and no Router state was present. The complete boundary proof is
in the source receipt; only its redacted structural summary is committed here.

This receipt does not yet authorize G4. Because the acceptance document and
receipt summary are now appended to the candidate, all deterministic and
package gates must be repeated against the new exact HEAD/tree, followed by a
fresh independent read-only `gpt-5.6-sol/xhigh` Review Gate. Until that review
passes and the user separately approves real-machine activation, Local Use
Ready remains `NO`; no installation, merge or publication is authorized.

## 16. 2026-09-15 real-machine G4 WebSocket trust failure and patch loop

This section preserves the first real-machine G4 result as a failed checkpoint.
Candidate `d09e3a7f71b26b5f62805dbfc10ddb40d340c4d7` activated `default@5`
successfully, but an official-subscription CLI turn encountered repeated TLS
failures on the official WebSocket path before the HTTP fallback completed. The
bounded G4 therefore failed on `repeated_reconnect`; HTTP success did not mask
the WebSocket defect. The redacted failure receipt is
`artifacts/e2e/gateway-core-qualification-v2-g4-20260915/g4-d09e3a7-official-ws-failure.json`
with SHA-256
`2c0893626dca79fe90ece20a70951e0c95e580a7d16b815b85b688e95d9b54bb`.

The user closed Codex App, ran the documented rescue command, and reopened the
App. The post-recovery boundary is `official@1`, with no pending transaction or
drift, inactive integration, no managed catalog, unloaded Router and switcher,
and no listener on port 8788. The authoritative post-recovery hashes are:

| State | SHA-256 |
| --- | --- |
| Codex config | `6c319d6aae31535a0dbe1f017cc63cc8f809f62e17144327af3131b3e97ea7e3` |
| Router config | `2d0978dceb8cc4f7e03211e940c3f3ecac2a13facb40fa21e8ee66c7ee9301b3` |
| Integration state | `620fd9c33677a99c833abe30ae353945726b33f6b1a30c6fe7ba90da85d579d2` |
| Space index | `6698db468ae228051753de05cb69f9d1092636dc5fc0b260de8006386f095bfe` |

### 16.1 P-022 and P-023

| Patch | Finding | Resolution | Evidence |
| --- | --- | --- | --- |
| P-022 | The managed Router inherited proxy variables but omitted the explicit extra CA used by the same proxy boundary; Node WSS failed certificate-chain validation while system curl HTTP succeeded | Preserve only `NODE_EXTRA_CA_CERTS` in addition to the existing proxy whitelist, merge Node default/system CA sets when supported without losing runtime defaults, keep hostname/certificate verification enabled, and log only allowlisted TLS codes | real no-auth TLS probes; local CONNECT-to-WSS certificate fixture; relay, productization and redaction tests |
| P-023 | The one-shot pending switcher preserved the CA but not proxy variables, so a coordinator-applied Router service could lose its proxy boundary | Use one shared network-boundary whitelist for the Router and switcher LaunchAgents; cover upper/lower HTTP(S), WS(S), ALL and NO proxy variants while still excluding `NODE_OPTIONS` and Provider secrets | productization regression covering the complete proxy-key set plus CA and secret exclusion |

The intermediate source candidate
`75eb78a2781a6cc5373b2322eab01a0b27180ac7` (tree
`0b9df28c7a8d2a06bda4b47904a68e3314d7031b`) passed 303/303 tests and its
exact-candidate gates:

| Gate | Result | Immutable receipt SHA-256 |
| --- | --- | --- |
| L0 | PASS; 303/303 tests plus package/source scan | `ee9cab4da4f01731ea84acc015e3a9d9c8a56b2cae7f5857af653da0378c24a5` |
| L1 | PASS; E2E-1/2/3/5 | `2f66211b04ac4f75adc77db30cc5cfb8a6f3ef340d0a7f8afa57e42c03a7b767` |
| L2 | PASS; E2E-4 capacity boundary | `c76925451e35c58734f7bbd77479359f74d505e0375bd977945e9be6fa02a723` |
| G2 | PASS; four capability profiles | `02dbb73937e4898cb8225a27a016ed12cbb2748c2151ac6232764f9493885ad4` |
| G3A official-only | PASS; two turns, three generations, one search, zero implicit retries | `f13e65c7623e53d8262d69d1734b3d9dcb20c79f9129fb8d6fc3d88389892461` |

Its clean public export repeated 303/303 tests, production audit, package/public
audits and both CLI aliases. The tarball SHA-256 was
`facabe2848a7f477ffde2f5e716b6f4ce752be8a6b06ad4f56eda0d7109b991a`.
The independent Reviewer recomputed those hashes but rejected promotion after
finding P-023, so `75eb78a` remains an immutable failed review checkpoint.

The exact final candidate is the clean commit containing P-023 and this
append-only section. L0-L2, G2 and clean-package checks must be regenerated
against its exact HEAD/tree, and a fresh independent `gpt-5.6-sol/xhigh`
Reviewer must approve it. G3A may be related to the new candidate only after
proving that the diff is limited to the pending-coordinator environment fix,
its tests and this receipt; no new live model call is justified by that change.
Until those gates pass and a new user-operated G4 succeeds, Gateway Core is not
promoted and Local Use Ready remains `NO`.

## 17. 2026-09-15 real-machine G4 continuation failure and patch loop

Candidate `5e9aa4c23790fc501703aa8140ebffaf448dc4d9` (tree
`c85e81e3c56d827c89c59f169b6ebf55e640fccb`) passed the deterministic,
package and independent Review Gates for the proxy/CA repair. It activated
`default@5` successfully with the expected service and integration state, and
the installed files matched the candidate package. The new G4 no longer showed
the prior TLS/502 failure. During ordinary Codex App use, however, the client
reported `Invalid previous_response_id.` immediately after an official
continuation crossed from an Engine-managed response to the opaque official
WebSocket relay. The redacted immutable receipt is
`artifacts/e2e/gateway-core-qualification-v2-g4-20260915-previous-response/g4-5e9aa4c-invalid-previous-response.json`
with SHA-256
`d176fa8cee752d017925f94dff888bb30bab3a8867ae74b42450360bcebd4392`.

The live log sequence proves an Engine official-subscription response was
committed, followed by an opaque official WebSocket relay and a terminal
observation failure; no TLS/502 failure or third-party Provider was present.
Because production logs intentionally omit response IDs, the exact failing ID
cannot be linked in retained live evidence. A deterministic production-entry
reproduction closes the mechanism: before the patch, an Engine-managed official
response was classified as transparent and opened the fake opaque WebSocket;
after the patch, the same function/custom-tool continuation replays the complete
history without `previous_response_id`, makes exactly one upstream send per
turn, and never opens the opaque relay.

### 17.1 P-024 continuation provenance

State records now distinguish `official-relay` from `gateway-replay` continuation
provenance. Only a successfully observed opaque official response receives the
former marker. Engine generation, local prewarm, compaction and ordinary state
saves default to `gateway-replay`; legacy records without a marker fail safe to
the same replay path. The classifier requires both an official target and an
explicit `official-relay` marker before preserving native continuation. A
completely unknown response ID keeps the prior transparent official behavior,
while cross-provider history requirements continue to fail closed when the
necessary observation is absent.

Deterministic coverage includes two consecutive WebSocket tool continuations
(function and custom), one provider send per continuation, full item ordering,
encrypted archive reload, legacy-marker compatibility, and two consecutive
byte-transparent official WebSocket relay turns. This repair does not change
credentials, official destination, retry policy, search routing, or real-machine
configuration.

The user closed the App, executed the documented subscription rescue, and
reopened the App. Post-recovery state is `official@1`, with inactive integration,
no pending transaction or drift, unloaded Router and switcher, no managed
catalog, and no listener on port 8788. The current authoritative hashes are:

| State | SHA-256 |
| --- | --- |
| Codex config | `45a7b53e91104cbc61271eae707252b2e81a80eb83d2aa6986a8777a4eb3e5ce` |
| Router config | `2d0978dceb8cc4f7e03211e940c3f3ecac2a13facb40fa21e8ee66c7ee9301b3` |
| Integration state | `2b78acdeae5a9615d7d0a98f7974505354129e2cbb580ca32c3df069b35778d1` |
| Space index | `5267373d461b4dc05cdd5a7108d8cb5960774cbe8575c4b63d1a6d8f261b41cb` |

The exact next candidate is the clean commit containing P-024, its tests,
documentation and this append-only record. All deterministic/package gates must
be regenerated against its exact HEAD/tree, followed by a fresh independent
read-only `gpt-5.6-sol/xhigh` Review Gate. A new G4 requires another explicit
user-operated activation window. Until that G4 passes, Gateway Core and Local
App Gray Run remain failed for promotion, and Local Use Ready remains `NO`.

## 18. 2026-09-16 successful real-machine G4 gray run

The user installed source candidate
`9c24aa8051e4a91f5f28a7a8719e678c779f9d5d` (tree
`68cb1118b49b3b74e2de9c50f966ba35ada989c9`) from the reviewed tarball and
activated `default@5` while the App was closed. The installed `state.mjs` and
`engine.mjs` hashes matched the candidate. Integration, catalog and service
verification passed with no pending transaction or configuration drift.

The formerly failing same-task tool continuation completed through Engine
replay without `Invalid previous_response_id`, duplicate side effects or an
opaque-relay handoff. The installed CLI completed a short official task. Four
new App tasks then covered ordinary continuation, official search, explicit
cancel, a fresh task after a normal App restart and an official-to-ai.feei Sol
model switch. The ai.feei request migrated full history, received HTTP 200 and
completed in 4.764 seconds without a Gateway retry. The search task issued nine
distinct read-only official search requests; all used
`/subscription/v1/alpha/search` and returned HTTP 200. This is retained as a
model-strategy cost warning, not misclassified as a retry.

The requested cancel produced one expected `cancelled`/499 terminal. During a
later App reopen, one Engine HTTP TLS handshake failed and the client resent
that turn once; the resend completed. This remains below the contract's
two-reconnect anomaly threshold. A follow-up production-implementation WSS
probe reached `chatgpt.com` with status 101 in 1.739 seconds, so the explicit CA
chain was not persistently broken. Separate official Luna activity observed an
upstream 530 and a post-header timeout; those records are retained as external
official-upstream warnings and are not used to manufacture a G4 PASS.

While the App was closed, the user ran the documented read-only status command
and captured `appRunning=false`, `activeTurns=0` and
`websocketConnections=0`. After reopening, the Router remained healthy on
`default@5`; integration and catalog were current, with no pending transaction
or drift. The previously executed subscription rescue remains the verified
rollback path.

The immutable redacted receipt is
`artifacts/e2e/gateway-core-qualification-v2-g4-20260916-pass/g4-9c24aa8-gray-run.json`
with SHA-256
`41b2ba13c31a88cb931323e22ab59cb430ca35c47e4630e9e18b3fbe07135d93`.
It retains no prompts, queries, search results, response text, credentials or
absolute user paths.

The G4 outcome is therefore Gateway Core `PASS`, Official Subscription `PASS`
with a single-reconnect warning, and Local App Gray Run `PASS`. ai.feei Sol is
kept `EXTERNAL_DEGRADED` despite this successful canary; ai.feei Astra and
OpenCode DeepSeek remain `UNVERIFIED`. The G4 receipt deliberately leaves Local
Use Ready and Release Ready at `NO` until G5 is rerun against the exact evidence
HEAD and a fresh independent `gpt-5.6-sol/xhigh` Reviewer approves that HEAD.
The Router must not be left active after qualification without the user's
separate confirmation.

### 18.1 G5 evidence-head verification

Evidence HEAD `0a61dfa6fe2732976ab87ce4e25a649f2e9ead47` (tree
`9c3f2dec0f45c68d71029b7b32a95b8707ffc728`) passed G5. The source tree
completed 307/307 tests, package and public audits, `git diff --check`, and a
production-dependency audit against the official npm registry with zero known
vulnerabilities. The user's configured npm mirror does not implement the audit
API; that environment error was preserved and the one-command registry override
did not modify user configuration.

A fresh public export repeated `npm ci`, 307/307 tests, the dependency,
package and public audits, packing, isolated installation, and both command
aliases. The installed commands both reported `Codex Local Router 0.4.0`. The
exported tarball remained `codex-local-router-0.4.0.tgz` with SHA-256
`af8a01133904fe75616fdbcbc6c95648f28cc76ea0a93dbf340af1b1b331e47a`.

The next commit only appends this G5 record. It is the final evidence candidate
and must remain frozen while a fresh independent read-only
`gpt-5.6-sol/xhigh` Reviewer verifies the exact HEAD/tree, recomputes the G4
receipt and package hashes, checks the evidence-only relation to the reviewed
source candidate, and independently decides whether the recorded warnings are
compatible with Gateway Core, Official Subscription and Local App Gray Run
PASS. Local Use Ready and Release Ready remain `NO` until that Review Gate
passes.

# Prompt cache affinity candidate record

Date: 2026-09-16

Scope: isolated branch `codex/provider-cache-affinity`, based on clean `master@dd7470acd29a078f5933274fde16100bcd0e9656`. This record does not authorize merge, release, installation, Keychain mutation, configuration-space activation, service restart, or App UI changes.

## Feasibility gate

The direct ai.feei Sol feasibility run used a synthetic approximately 26K-token stable prefix, `max_output_tokens=16`, no tools, no user data, and no automatic retry. The first control request returned HTTP 403 in 925 ms. The run stopped immediately:

- planned generations: 8;
- executed generations: 1;
- automatic retries: 0;
- fixed-key calls: 0;
- result: `EXTERNAL_UNRESOLVED`.

This result does not attribute the 403 to prompt caching because the failing request carried no affinity key. It prevents the later ai.feei Gateway/App effect gates from running under the approved budget.

## Candidate conclusions

| Area | Required conclusion |
|---|---|
| Gateway Cache Affinity Core | Deterministic gates and final repository checks decide independently of ai.feei availability |
| Security Boundary | Must prove original identity absence, dedicated lazy secret, safe options, and metadata-only logs |
| Fork Lineage | Must prove matching client key or verified parent inheritance; otherwise independent child lineage |
| ai.feei Cache Effectiveness | `EXTERNAL_UNRESOLVED` because feasibility did not pass |
| App Protocol | Local simulated HTTP/WS only; no real ai.feei App-protocol effect gate |
| Local App UI | Not tested |
| Release Ready | No; merge/release/install are outside this candidate task |

The final exact commit and complete deterministic/package gate results are recorded in the task handoff after the third planned commit. No prompts, answers, cache keys, credentials, local absolute paths, or user identifiers are retained in this record.

## 2026-09-16 causal diagnostic retained for the enablement candidate

The earlier HTTP 403 receipt above remains immutable evidence for that earlier attempt. A later bounded diagnostic used the current App-bundled Codex binary (`codex-cli 0.154.0-alpha.6.2`, SHA-256 `a1d2f191e70023ed7afd619bc70530f26067a085926e03bae50cf5c0f8298bcf`), isolated homes, synthetic stable prefixes, no tools, a 16-token output cap, and no automatic retry. It made 35 successful ai.feei Sol requests and retained only aggregate usage/status/timing evidence.

| Stage | Calls | Post-warm result |
|---|---:|---|
| field split | 15 | direct shape 98.56%; current Gateway `none` 30.12%; Gateway anonymous key 98.56% |
| strict key-only toggle | 12 | no key 30.11%; anonymous key 98.55%; body and headers otherwise deep-equal |
| observed App WebSocket header shape | 8 | no key 30.11%; anonymous key 75.73%, including one unexpected partial miss |

Across the 35 calls, upstream reported 490,950 input tokens, 268,416 cached tokens and 175 output tokens. All returned HTTP 200 / completed; minimum, median and maximum latency were 2,138 ms, 3,078 ms and 17,952 ms. This establishes that the Gateway-controlled standard `prompt_cache_key` materially changed cache reuse for that synthetic Sol workload. It does not establish a universal natural-session hit rate, explain every historical miss, or reveal ai.feei's internal account/shard selection algorithm.

The same App-shape capture found an independent protocol loss: current WebSocket frames carried `client_metadata.ws_request_header_x_openai_internal_codex_responses_lite=true`, while the third-party Provider path only inspected the connection handshake before deleting `client_metadata`. The enablement candidate therefore freezes Lite state per HTTP request or WebSocket frame, normalizes only `true` onto the applicable third-party GPT Responses request, removes the Header for standard frames, and keeps explicit internal non-Lite requests authoritative.

This section is diagnosis input, not candidate acceptance. The candidate-bound 24-call Sol/Astra comparison, six-generation App protocol gate, deterministic/package gates, installation state, rollback and App UI sign-off are recorded separately and must not be inferred from these 35 calls.

## Enablement-candidate live gate receipt

The first candidate-bound comparison was run from committed candidate `cd116a4`. Its first planned direct Sol request used an underspecified minimal HTTP shape rather than the captured current-Codex Provider shape and returned HTTP 403 after 542 ms. The harness stopped at the authentication boundary with one of 24 generations executed, zero automatic retries, and no usable cache-usage sample. Astra, the App-protocol gate, installation, configuration activation, and App UI validation were not run.

This receipt is retained as a failed harness attempt, not attributed to caching or ai.feei. The comparison harness now captures the current Codex Provider body and headers against an isolated local upstream, uses the Router's shared Provider adaptation and curl transport, and has a zero-external-network preflight for the Lite/header/privacy shape. The approved live budget was stopped, so the corrected harness has not been rerun. The candidate's Sol/Astra cache-effect and real App-protocol gates therefore remain unaccepted until a new bounded run is explicitly authorized.

The next explicitly authorized run executed two of 24 planned generations with zero retries. The direct Sol shape returned HTTP 200 with 36,960 input tokens and 4,224 cached tokens; the candidate shape returned HTTP 403 after 959 ms, so the run stopped before Astra or App-protocol work. Offline comparison then found that the harness invoked the production Provider adapter with an empty `ctx.headers`, omitting the captured Codex non-identity compatibility headers that the real Gateway supplies. The preflight now verifies those headers reach the shared adapter while identity headers remain excluded. This is retained as a second failed harness receipt; it is not counted as a Provider or cache-effect sample, and no further external call was made under that authorization.

After that correction, the 24-generation cache comparison completed with zero retries and no 4xx/5xx. Sol and Astra each produced five of five post-warm cache hits; candidate and direct weighted reuse were equal at 99.39% and 99.40%, respectively. The following App-protocol gate sent six requests and blocked a seventh attempt before Provider transmission. All six sent requests carried the Lite Header, stable anonymous-key fingerprint and one cache-usage event. The gate still failed because it required a user MCP under the deliberately reduced `lite-search` surface: Sol did not invoke it, while Astra completed the MCP call/result before its next turn reached the cap. The acceptance requirement asks only for a read-only tool call/result, so the corrected gate now uses the Lite-guaranteed core `exec_command`, requires exactly two sends for call/result plus one continuation per model, and counts only requests admitted past the outbound budget hook as executed generations.

The corrected App-protocol gate then completed six of six admitted generations with zero blocked attempts and zero automatic retries, using App-bundled `codex-cli 0.154.0-alpha.6.2` (SHA-256 `a1d2f191e70023ed7afd619bc70530f26067a085926e03bae50cf5c0f8298bcf`). Sol and Astra each used exactly three Provider requests: the core `exec_command` call, its result continuation, and the next turn. Both models completed the command exactly once, forwarded the matching synthetic result, recalled it on the next turn, carried the normalized Lite Header on every request, reused one anonymous-key fingerprint, and emitted one cache-usage event per request.

The accepted evidence is the successful 24-generation comparison plus the final six-generation App gate. Across all candidate-bound attempts, including the two failed harness shapes and the superseded MCP gate, 39 Provider requests reached ai.feei; the reported seventh MCP-gate attempt was rejected locally before transmission. Every harness run used zero automatic retries. The additional final six-generation gate was explicitly approved under the user's delegated bounded-run authority.

## Local rollout and App UI receipt

Candidate `1ac3eaedb13b8b1b1e253ba462fb2d30c62a22de` was installed in a quiescent App window. The transactional rollout activated `default@6` from `default@5`, retained `gpt-5.6-sol` as the default model, left no pending transaction or drift, and produced mode-`0600` rollback state. The installed server SHA-256 is `b6ef1c763778422a4ca688cd677203488997c00b54886e50c910b6665f8bbb56`.

After reopening the App, the user completed one new read-only core-tool task with each ai.feei model and confirmed the expected command result. The redacted Gateway events show:

| Model | First request | Tool-result continuation | Outcome |
|---|---:|---:|---|
| Sol | 31,627 input / 0 cached | 31,744 input / 31,488 cached (99.19%) | both HTTP 200 / completed |
| Astra | 31,625 input / 0 cached | 31,743 input / 31,488 cached (99.20%) | both HTTP 200 / completed |

All four WebSocket Provider requests used `gateway-opaque` with `client_prompt_cache_key` lineage; the continuation requests carried one tool result and completed without retry, fallback, or protocol error. Production logs intentionally omit the anonymous key and Lite Header value. Direct Lite-Header evidence therefore remains bound to the isolated App-protocol gate above, while this receipt establishes that the exact installed candidate completed the corresponding real App tool round trip.

Final status: Gateway Cache Affinity Core PASS; Security Boundary PASS; Fork Lineage PASS for the covered client-key lineage; ai.feei Cache Effectiveness PASS for the bounded synthetic comparison and these two tool continuations; App Protocol PASS; Local App UI PASS by user observation. Merge and release remain outside this rollout.

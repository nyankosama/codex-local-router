# Third-party GPT instruction snapshot and Lite delivery candidate

Date: 2026-09-16

Scope: isolated branch `codex/gpt-instruction-inheritance`, incrementally based on candidate `5f6a907`. This record does not authorize merge, GitHub/npm publication, local installation, configuration-space activation, service restart, or App UI changes.

## Historical control

The earlier catalog-only candidate copied official instruction fields into the custom catalog but did not rewrite a Lite request. On the current Codex client, the Gateway alias plus `openai` Lite path omitted the synthetic base instruction on the observed client wire. That failed result remains evidence; it is not overwritten by the later adapter.

The omission does not prove that the official subscription service lacks server-side instructions. It only proves that catalog pinning alone could not enforce the intended client snapshot on this path.

## Deterministic candidate result

The explicit `gateway-lite` adapter is opt-in and limited to App-enabled third-party `openai-gpt` Responses Lite user turns with a valid, variable-free official snapshot. Standard Responses remains client-delivered and official subscription requests remain transparent.

Current App-bundled driver:

- version: `codex-cli 0.154.0-alpha.6.2`;
- binary SHA-256: `a1d2f191e70023ed7afd619bc70530f26067a085926e03bae50cf5c0f8298bcf`;
- external model calls: 0.

The loopback harness covered CLI and app-server for official, raw custom-provider and Gateway-alias paths under Standard Responses and Lite. Every non-control delivered path contained the synthetic instruction exactly once with SHA-256 `d3066106c80edcb8a8c2e86ba34c0e79a09ebfa2059f5c805a83bd2f40d39d40`. AGENTS.md and user markers remained present; `persistent_instructions` was not injected.

The repository regression suite passed 359 tests. Dedicated cases cover HTTP/WS delivery, ordering after `additional_tools`, idempotence, conflicting top-level instructions, runtime-variable rejection, archive/history exclusion, current-model preservation through apply/rollback, and a local p95 adapter guard below 25 ms.

## Remaining gates

| Dimension | Status |
|---|---|
| Source implementation | PASS in isolated worktree |
| Deterministic protocol compatibility | PASS |
| Full repository/package/public-export gates | PASS: 359/359 in source and clean export; audits and both installed aliases passed |
| Sol/Astra bounded live comparison | PASS: corrected run completed 6/6 comparison generations before entering the tool phase |
| Sol/Astra real App-protocol tool continuation | PASS: separately authorized tools phase completed 6/6 generations with zero retry or blocked attempt |
| Local installation/configuration activation | PASS: candidate `a3bc602` activated as `default@7`; rollback source is `default@6` |
| App UI sign-off | PASS: user confirmed new Sol and Astra read-only tool tasks behaved normally |
| Merge or release | Out of scope |

No live or UI status may be inferred from the deterministic result. Activation must remain hash-bound and App-closed, preserve the exact prior package and configuration-space reference, and separately preserve Codex's selected model and the space default model.

The opt-in live driver is `npm run e2e:instructions:live -- --run`. It hard-limits the full run to 12 admitted model generations with zero automatic retry: six official/current/candidate comparisons and three candidate App-protocol generations per model for one read-only command call/result plus continuation. `--phase comparison` and `--phase tools` each cap their isolated half at six generations, so a failed half can be re-authorized without repeating accepted evidence. The driver records only route/credential booleans, counts, byte counts and hashes; instruction and answer text are not retained.

The first invocation stopped before client startup because its temporary Codex-home directory had not been created before catalog export. External model generations: 0. The directory preflight was corrected; this receipt is a Harness setup failure, not a model or Gateway sample.

The corrected real-channel run completed all six comparison generations, then stopped after the Sol tool sequence because the Harness required three Gateway `instruction_snapshot_delivered` events. The same App protocol and actual multiline snapshot reproduced the identical stop locally with a deterministic upstream: every Sol request contained the snapshot, tool execution/result and continuation all passed, but the event count was zero because Codex had already supplied the exact snapshot and the Router correctly avoided duplicate injection. The gate now checks that the snapshot occurs exactly once on every Provider request and reports Gateway injection count only as a diagnostic.

After separate authorization, only the tools phase was rerun. It admitted exactly six generations with zero retry and zero blocked attempt: three for Sol and three for Astra. For both models the first response and continuation completed, one read-only command completed exactly once, its result reached the following Provider request, and every request contained the pinned snapshot exactly once. The earlier stopped run remains part of the failure record; the successful phase result does not erase it.

## Local activation receipt

The hash-bound activation installed candidate `a3bc602422297e2aebfab5a4aaec6f9b44636cb9` and created `default@7` from `default@6`. The installed `src/server.mjs` SHA-256 is `b6ef1c763778422a4ca688cd677203488997c00b54886e50c910b6665f8bbb56`. Both targets report `pinned` plus `gateway-lite`, with content hashes `e234cdd10cf412dddfa1747fa0bbb688e8911453e747b30578e6dbce6056dcb0` for Sol and `97d6b1c9cd983c4b0ef8c195ba94d39121d7712388728d05bd53902f1bead1b6` for Astra.

The activation preserved both pre-activation model states as `gpt-5.6-sol`. After the user deliberately selected Astra for the UI check, the Codex selected model became `gpt-6-astra` while the configuration-space default remained `gpt-5.6-sol`; this post-activation user choice is not transaction drift. The service was healthy and accepting, with zero active turns, no pending transaction and no configuration drift. The exact rollback state is stored under the Router home at `rollouts/instruction-snapshot-20260916-a3bc602/rollback.json`.

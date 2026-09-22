# Code mode compatibility — 2026-09-16

## Decision and scope

Option A: explicitly advertise code mode and qualify context size before activation. Keep structured Plugin filtering; do not parse exec documentation or JavaScript. No automatic migration, capability inheritance, transport change, default-model change, installed-service change, merge or release.

Base: `46872769ffe3c036685eab4aa95c2d0250415140`. Candidate branch: `codex/gpt-code-mode-compat`.

Runtime change is limited to validation, the shared custom-catalog projection and CLI configuration/diagnostics. Batch `model set-tool-mode` reuses the existing immutable-space and selection-preserving switch transaction. All catalog consumers use the same projector. Existing configurations omit the field; `default` removes it.

## Client and method

- Codex CLI/app-server: `0.154.0-alpha.6.2`.
- Binary SHA-256: `a1d2f191e70023ed7afd619bc70530f26067a085926e03bae50cf5c0f8298bcf`.
- Local mock Provider through the actual Gateway WebSocket/Engine path. Standard and Lite, default tools and code mode, two turns per case with two synthetic read-only shell operations per turn.
- Code mode emits one `exec` call batching those operations; the control emits two `exec_command` calls. Results return before completion. This demonstrates protocol support, not a model's propensity to batch.
- Isolated HOME/CODEX_HOME/XDG/Router state and synthetic auth/instructions/AGENTS/prompt. The client sandbox permits only that case's random loopback port, not external destinations or the installed Gateway. Official upstream transports are injected to fail. No live generation.
- Measure UTF-8 bytes of serialized `{instructions, tools, input}` at Provider egress. This is not actual token usage; mock usage is not performance evidence.

## Preflight findings retained

The initial synthetic matrix completed 12 cases / 24 turns / 48 mock generations. An inventory with 80 disallowed Plugin definitions grew from 52,472 to 124,698 context bytes under Lite code mode because those definitions became opaque exec documentation. This **does not qualify** for activation and is why mode enablement is not a universal default.

The two scoped historical task tool sets measured 70,649 bytes (custom) and 70,151 bytes (official); the existing structured Plugin filter removed zero definitions from either set. This is descriptive evidence only: other client metadata differed, so it is not a mode-only causal comparison.

For a controlled check, 36 external function descriptions/parameter schemas from that scoped inventory were retained in memory. The public app-server API rejects reserved App namespaces, so the four namespace names were normalized to synthetic names. Native core tools were supplied by the same binary; the original dynamic tool-search surface was not reproduced. No external tool was executed and no real schema was saved into this repository.

## Candidate results

The candidate uses `app.toolMode` and the actual shared catalog projector, not a test-only injected catalog bit. Four cases, eight turns, sixteen mock generations:

| Transport | Default context bytes | Code-mode context bytes | Delta | Default tool bytes | Code-mode tool bytes |
|---|---:|---:|---:|---:|---:|
| Standard | 91,492 | 88,926 | −2,566 (−2.8%) | 69,258 | 66,693 |
| Lite | 91,885 | 89,319 | −2,566 (−2.8%) | 69,325 | 66,760 |

Pass conditions independently checked against the receipt:

- Four requests per case; two completed turns with two completed commands each.
- Tool results present in each subsequent generation; no error result or Gateway failure.
- Stable tool-definition hash across all four requests; one base-instruction occurrence; project instruction retained.
- First-context increase within `max(8 KiB, 10% of control)`; no repeated schema growth.
- Real managed file hashes unchanged; installed service PID/version unchanged; zero external model generations.

The qualification applies to this binary and normalized inventory. It does not establish every installed Plugin, exact App UI parity, `wait` yielding, or provider/model batching behavior. Material tool/client changes require another preflight.

## Automated checks and artifacts

- `npm test`: 362/362, including explicit/default catalog behavior, invalid carriers, atomic batch changes, idempotence, dormant edits, drift, historical materialization, pending activation and independent preservation of both default-model states.
- Explicit boundary regression: structured disallowed Plugins are removed; embedded exec documentation and indirect code calls remain opaque in both carriers.
- Dependency audit: zero vulnerabilities. Package/public scans and `git diff --check`: pass.
- Fresh public export: `npm ci`, 362/362 tests, dependency/package/public audits: pass.
- Clean temporary installation: both executable aliases return `Codex Local Router 0.5.0`; no global install.
- Candidate tarball SHA-256: `dd897b32b01e5b644deeca8c5cad9dc988630e105ea91f4bc9245b1179f2589e`.

Private temporary evidence root: `/tmp/clr-code-mode-preflight-PX0QP6/`; candidate protocol receipt: `candidate-actual-schemas/results.json`; test logs: `candidate-tests.log`, `export-tests.log`; installation receipt: `package-check.json`. The eight temporary profiles used for actual-schema probes were deleted after aggregate receipts were checked. User source state was not deleted or changed. Prior diagnostic/preflight failures are retained separately and are not counted as qualified runs.

## Deployment status

Implementation and scoped offline qualification: **PASS**. The corrected bounded live Provider gate below is **PASS**. Candidate activation was subsequently attempted and automatically rolled back due to the packaging-hash error documented below; it is **NOT ACTIVE**. App UI: **NOT RUN**. Current App/Gateway remain on the previous configuration with no pending transaction. No new release or npm publication.

Before deployment: bind the package hash to the candidate commit, retain the old installed package and exact active space reference, close App normally, verify idle/no-pending/no-drift and source hashes, install only in that safe window, then preview/confirm one batch for the two GPT targets. Do not refresh instruction snapshots or change either default model. Verify the generated catalog field and reopen with new tasks. Keep exact-space rollback plus `codex-local-router rescue --subscription --yes` available. App UI sign-off remains separate from this protocol evidence.

## Follow-up: deployment preparation and live gate

Candidate/package and client hashes were rechecked unchanged. Production remains `default@7`, no pending/drift, both default-model values unchanged, and no install or service restart.

The first live attempt made three Sol generations, all HTTP 200 with the intended code-mode carrier and safe Provider credential routing. It did **not** pass: zero shell commands completed and no fixture markers were returned. Astra was not called; there was no upstream retry. Preserve `code-mode-live-failed-sandbox.json` as failed evidence, not a successful protocol gate.

A zero-live-call reproduction with the same binary showed that combining an outer OS sandbox and Codex's own `read-only` sandbox returns `sandbox-exec: sandbox_apply: Operation not permitted`. The corrected fixture uses one outer OS sandbox: network access only to the isolated Gateway port, filesystem writes only to the temporary fixture tree and device handles. It does not add a second nested Codex sandbox. Two local mock turns then completed all four read-only commands with their results forwarded; production hashes/PID remained unchanged. This fixes the test environment, but does not substitute for a corrected live run.

Three earlier setup failures spent zero generations (stale custom-model mapping after narrowing the isolated target set, and nested sandbox startup). They are retained separately. At that checkpoint, actual live spend was three, not nine; the six additional short generations were awaiting approval. The later approved run is recorded separately below.

Private deployment materials preserve the installed proxy/TLS settings and bind source config, Codex config, catalog, installed code, client binary, and candidate package hashes. The source space is read at preparation time; the destination revision is returned by the CLI, not hardcoded. The App-open guard was executed and rejected activation before backup, installation, or rollback-state creation. At that checkpoint, the failed live receipt also blocked activation. These materials are preparation only; activation/rollback on the real machine and App UI acceptance are still unexecuted.

## Approved corrected live gate — 2026-09-17

The user approved six additional generations. Product code/package remain bound to `7b319eefd0e5298f4838a4fac3a2ff4525eaee50`; later commits only update this evidence. The current client binary and package hashes matched the values above before execution.

| Model | Generations | Completed read-only commands | Tool turn | Continuation | Result |
|:--|--:|--:|--:|--:|:--|
| ai.feei Sol | 3 | 2 | 12.407 s | 7.641 s | PASS |
| ai.feei Astra | 3 | 2 | 12.663 s | 4.197 s | PASS |

Each model emitted `functions.exec`, batched the two synthetic file reads, received both marker results, and used those results in its final answer and next turn. All six upstream responses were HTTP 200. Tool definitions stayed at 12,753 bytes with the same hash across both models and all sends. These durations are whole-turn observations, not first-token or production latency guarantees.

There were no blocked sends, automatic retries, or additional model generations. All model traffic used the configured ai.feei Provider credential; no ChatGPT bearer or account header was sent. Official and search transports were disabled in this fixture. Installed-service PID/version and all watched real managed-file hashes remained unchanged; the temporary client profile was removed after retaining aggregate evidence.

The live fixture intentionally disables Plugins and supplies only synthetic files. It verifies real model code-mode execution and continuation, not the full App tool inventory. The separate normalized-inventory preflight above is the context-size qualification; App UI sign-off is still required.

Total live spend is **9 generations**: the retained failed sandbox attempt (3) plus this corrected passing run (6). Setup and reproduction probes used no external model calls. Receipts: `code-mode-live-failed-sandbox.json` and `code-mode-live-result.json`; corrected run log: `code-mode-live-corrected.log` in the private evidence root.

At this preparation checkpoint, deployment materials carried the passing receipt and remained locked until App was fully exited and source hashes matched. Prepared source was `default@7`; both existing default-model values were preserved. No candidate installation, real-space mutation, pending switch, master merge, or publication had yet occurred.

## Activation failure and corrected deployment materials — 2026-09-17

The first real activation installed the candidate, failed the pre-switch code-hash assertion, and successfully restored the old installed code/service. The active space stayed `default@7`; no new revision was created. The rollback receipt is `rolled_back_after_failure`, with no rollback error. Independent checks confirmed exact pre-upgrade hashes for installed code, Router config, Codex config and managed catalog, a healthy service, and no pending transaction or drift.

Root cause is in deployment preparation, not Provider execution: the expected code hash was calculated from the public **export tree**, but installed code is produced from the **npm tarball**. The export additionally contains `scripts/audit-public.mjs` and `scripts/export-public.mjs`, which intentionally are not included by `package.json.files`. Therefore the old expected hash `096e3c15a002d58583d3e0281a2743db0b13aeb74d2f164c827f301692eb259f` cannot match the correctly installed package hash `9e961a3be1d4823f038c4d745b2baf202fd72e54be291a4c49d247d7d9ce0cf9`.

A new isolated npm installation reproduced the mismatch and proved that the extracted tarball and installed package have the same code hash; both command aliases also passed. The package itself, its SHA-256, product code and six-generation live evidence are unchanged. No additional model calls were needed.

Corrected preparation derives the expected hash from the checksum-verified tarball and cross-checks the isolated installation receipt. It uses a separate `-v2` rollout directory; the first attempt, rollback receipt and backup remain untouched. Deployment errors now retain a safe stage enum so another failure identifies installation, package verification, space activation or final verification without exposing credentials.

The real deployment coordinator additionally passed ten isolated scenarios with package/service side effects injected: successful activation plus rollback; App-open, source-conflict, failed-live and corrupt-package refusal; reproduction of the old export-hash failure; install failure; switch failure; final-verification rollback; concurrent-edit refusal. These tests validate coordinator decisions, not real LaunchAgent side effects. Actual tarball installation is covered separately. Receipts and runnable checks are `package-hash-check.{mjs,json}` and `rollout-check.{mjs,json}` in the private evidence root. The `-v2` materials are prepared only; the next real activation still requires App to be closed.

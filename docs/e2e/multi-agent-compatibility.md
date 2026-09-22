# Third-party GPT multi-agent qualification — 2026-09-17

## Candidate and boundaries

Runtime implementation: `c175accff8069682cc0c2300a5ce5b7558299745`, based on code-mode candidate `1a22327`, isolated branch `codex/gpt-multi-agent-compat`. No merge, release, production installation or UI acceptance is implied. The subsequent delivery commit adds documentation and an offline lifecycle probe, not runtime behavior.

The opt-in snapshot copies only `multi_agent_version` and optional `multi_agent_reasoning_effort`. Codex, not Gateway, generates collaboration tools and role instructions. Sol and Astra aliases retain their Provider routing. No higher concurrency, prompt injection, default-model changes or automatic migration.

## Evidence

| Gate | Result |
| --- | --- |
| Full deterministic suite | 367/367 PASS |
| Current Codex protocol matrix | 48/48 PASS: CLI/app-server, standard/Lite, official/alias, absent/v2/disabled |
| Candidate Gateway protocol matrix | 24/24 PASS; alias maps to matching upstream model |
| Explicit child effort override | 4 focused cases PASS |
| Full-history fork | 2 focused Gateway cases PASS |
| Native collaboration lifecycle | 2 focused Gateway cases PASS: spawn, wait, send, followup, interrupt, list |
| Tool and role parity | Matching official/alias synthetic metadata produces matching collaboration schema and runtime role hashes |
| Live App-server | Sol 6 + Astra 6 = 12 generations, all HTTP 200, zero retries, PASS |
| Live tool/result closure | Both parent tasks received child read-only synthetic-file result and used it; next turn retained result |
| Live route boundary | All parent/child generations to ai.feei; no subscription bearer/account identity at Provider |
| Package/export | Clean exported tree: npm ci, 367 tests, package/public audits, both command aliases PASS |
| Dependency audit | 0 vulnerabilities, official npm registry |
| Local snapshot projection | p95 0.0210 ms for 1,000 iterations; below 25 ms guard |
| Production preservation | Managed file hashes, service PID and both default/selected models unchanged; default@8, no pending/drift |

Client: `codex-cli 0.154.0-alpha.6.2`, SHA-256 `a1d2f191e70023ed7afd619bc70530f26067a085926e03bae50cf5c0f8298bcf`.
Normalized role-block SHA-256: `54bad2fb861b27ddb3f8747121b133774eebc8e154a7378226e0ad693e4b79a0`.
Live parent task durations: Sol 26,862 ms; Astra 23,626 ms. These are observations, not a general latency guarantee.

Private local receipts (not exported): `clr-multi-agent-protocol-final.json`, `clr-multi-agent-gateway-final.json`, `clr-multi-agent-override.json`, `clr-multi-agent-fork.json`, `clr-multi-agent-lifecycle.json`, `clr-multi-agent-live-acceptance-1.json`. All are under the local temporary evidence directory; deployment preparation copies the live receipt into durable private rollout materials. No authentic instruction body, user tool schema, credential or conversation is committed.

## Interpretation and limitations

- Low-effort parents produced low-effort children, including Astra with official xhigh metadata. The metadata is not a forced per-child effort override. Explicit high override worked.
- User-disabled agents exposed no collaboration namespace. Bare unknown function names are not automatically trusted as core; namespace collisions retain diagnostic fail-open behavior.
- The focused lifecycle probe interrupts an already idle/completed child; it does not establish active-child cancellation timing. Existing Gateway cancellation/transport regressions remain separate evidence.
- Protocol probes use an OS network sandbox permitting only their loopback port and isolated temporary homes. Live probes use synthetic tasks and auth, random ports, injected cache secret and isolated state; existing Provider credentials are read only.
- Early fixture failures remain recorded: synthetic-auth plugin lookup 401, macOS temporary-path alias denial, incomplete mock response envelope, prewarm-only Lite tool definitions, and display-metadata-dependent schema hashes. The corrected harness blocks external traffic and compares equivalent metadata. These were not production fixes or extra live model retries.
- Isolated live budget is exhausted and passed; do not repeat successful samples. App-server acceptance is not App UI acceptance. Subsequent user-operated deployment and UI signoff are recorded below separately.

## Subsequent local activation and user UI signoff

User executed the prepared activation after exiting App, then reopened it. Read-only verification confirmed `default@9` active, previous `default@8`, rollout phase `active`, no pending/drift, healthy service, exact installed candidate code hash, and current integration/catalog. Both selected model and space default remained `gpt-5.6-sol`; Sol/Astra catalog entries retained code mode and received the expected official multi-agent snapshots.

User reported both new-task App checks passed. Task records independently show one child started and completed, the parent waited and produced the requested three-point README summary, and both turns completed without an error:

- `01a0adc6-e15d-7b83-b254-2740972e8c98`: child `01a0adc7-0864-7e21-ac70-a7f172800459`; 65,864 ms.
- `01a0adc7-dcdd-7583-9e82-03167171af03`: child `01a0adc8-0c0f-7443-8e0e-94d8ea5c0cf3`; 54,550 ms.

These are user-confirmed Sol/Astra UI checks; the compact task API does not independently expose each selected model. UI signoff is therefore based on the user's confirmation plus observed delegation closure, not inferred from response style. No additional automated live requests were made. Rollback reference remains `default@8`. No master merge or GitHub/npm publication was performed.

## Reproduction

Run `npm test`, `npm run audit:package`, `npm audit --omit=dev --registry=https://registry.npmjs.org`, `node scripts/audit-public.mjs`, and `git diff --check`. Protocol matrices: `node scripts/e2e/multi-agent-compatibility.mjs` and the same with `--gateway`. Focused options `--override`, `--fork`, `--lifecycle` exercise native delegation behavior against synthetic providers. Live execution requires explicit `--run`, passing full protocol receipts and a strict shared 12-generation budget; it is not a CI command.

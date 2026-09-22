# Official Relay, GPT Plugin Policy, and ai.feei Candidate Acceptance

Date: 2026-09-13

## Candidate scope

- Branch: `codex/official-relay-gpt-tool-policy`
- Baseline: clean `master` at `d5e9ba8`
- Worktree: isolated sibling worktree
- Publication: no GitHub Release and no npm publication in this change
- Installed service: no automatic restart while Codex App has an active window

## Deterministic evidence

| Group | Main evidence | Status |
|---|---|---|
| A1 | policy precedence, explicit modes, legacy passthrough, alias conflict | PASS |
| A2 | trusted core/plugin map, Plugin manifests, user MCP, collision/unknown passthrough | PASS |
| A3 | functions, namespaces, additional tools, tool choice, idempotence, fresh fallback view | PASS |
| A4 | streaming/final forbidden-call guard, no policy fallback | PASS |
| A5 | fixed URL, search/models/future paths, query, binary, gzip, SSE/status fidelity | PASS |
| A6 | official WS payload/sequence, official/custom switching regressions, cancellation cleanup | PASS |
| A7 | subscription authentication, path/method rejection, credential separation | PASS |
| A8 | official observation, cross-provider restore, missing chain, archive failure isolation | PASS |
| A9 | CLI/config/catalog/package/export and test runtime isolation | PASS |
| A10 | metadata-only diagnostics, byte accounting, opt-in hard-budget runner | PASS |

Final deterministic source-tree result: 178 tests passed, 0 failed. The same 178 tests passed in a fresh public export after `npm ci`.

Package content audit, public export audit, dependency audit, sensitive-content scanning, `git diff --check`, clean exported-tree installation, and both installed command aliases passed. `e2e:l0` also passed with the same 178-test count.

## Current Codex driver

- Source: installed Codex App bundle
- Version: `codex-cli 0.154.0-alpha.6.2`
- SHA-256: `ecad78dbf98adb89ec475edac86630406cbe59d9f3070b17d88065f136b94bcb`

The local simulated-upstream fixture reflects the current observed client carriers: ordinary function definitions, `mcp__codex_apps__*` namespaces, and `input[].additional_tools.tools`. No user tool schema is copied into this report.

## Focused live budget

The opt-in `npm run e2e:focused -- --run` controller permits five turns and ten observed model-generation requests, has no retry loop, and stops on budget overflow. It records only the driver version/hash, target and tool identities, status/count/boolean evidence, and destination hosts.

| Turn | Required result | Status |
|---|---|---|
| Official CLI | normal answer and successful standalone search | FAIL: timed out; no completed search evidence |
| ai.feei Sol CLI | answer and synthetic image recognition | FAIL: client exit 1 |
| ai.feei Astra CLI | answer and synthetic image recognition | FAIL: client exit 1 |
| ai.feei Sol App protocol | allowed Plugin, user MCP result, official search, forbidden Plugin removed | FAIL: turn failed before tool/search evidence |
| ai.feei Astra App protocol | same category checks | FAIL: turn failed before tool/search evidence |

Focused run `20260913055549` is retained locally as a FAIL. The tool-shape preflight passed on the current core: one captured carrier payload forwarded 19 tools, retained GitHub and the user MCP, and observed then removed `plugin_management` before the local simulated upstream.

The first live controller version also exposed a harness defect: it blocked third-party outbound after the tenth permitted request, but continued starting/servicing cases and reported 21 attempted generations as if they had all been sent. Official WebSocket traffic was not included in that counter. The candidate runner was corrected to force HTTP for focused acceptance, distinguish sent from blocked attempts, abort the active client when an eleventh generation is attempted, and stop before starting another case once the budget is exhausted. Per the no-retry rule, the live suite was not rerun in this candidate session. Therefore the failed run is not valid evidence that the ten-generation total was respected and no live item is accepted.

The final report must not convert a missing live result into PASS. App-server completion is not App UI sign-off.

## Local rollout and rollback

The local rollout is transactional:

1. prepare a candidate config with the `feei` Keychain reference and both presets;
2. build the candidate catalog and run focused acceptance against an isolated Router;
3. inspect installed health and `activeTurns`;
4. if Codex App is running or a turn is active, leave integration pending;
5. after normal App exit, run the existing safe upgrade/integration transaction;
6. verify health, both command aliases, catalog IDs, and one App UI model-menu reload.

Rollback uses the existing upgrade transaction backup and `integration disable`/subscription rescue. It never moves official tags or modifies a published release.

## Completion dimensions

| Dimension | Current status |
|---|---|
| Implementation complete | Complete on the isolated feature branch |
| Automated acceptance | Deterministic groups pass; focused live suite FAIL |
| Local installation effective | Not applied; installed service remains 0.2.0 while Codex App is running |
| App UI confirmed | Not tested |

# Fork compaction recovery acceptance

Candidate branch: `codex/fork-compaction-recovery`

This record contains only synthetic fixture results. No real Codex rollout, credential, installed archive, App session, Gateway service, or external model was read or changed by the acceptance run.

## Gates

| Gate | Required result |
|---|---|
| Direct fork | Exact same-account parent checkpoint with the same compaction digest is copied into the fork scope and survives a new state store |
| Isolation | Wrong account, wrong parent, different digest and non-portable parent fail before outbound work |
| Rollout parser | One file and bounded parent/child chains rebuild exact originals at exclusive ordinal boundaries |
| Integrity | Missing base, malformed JSON, conflicting lineage, bad boundary and incomplete tool pairs write zero checkpoints |
| Idempotency | Repeating the same source hash creates no duplicate record; a different existing record conflicts |
| Privacy | CLI/result objects contain hashes, counts and status only |
| Performance | Parent lookup p95 < 10 ms; streaming recovery is linear in relevant JSONL bytes |
| Regression | HTTP, WebSocket, compaction/history, search, cache affinity and official relay suites pass |

## Candidate result

- Source tree: 381/381 tests passed.
- The 10,000-item streaming fixture completed in 111.0 ms on the candidate host; the 200-sample direct-parent lookup guard stayed below its 10 ms p95 limit.
- Runtime dependency audit reported zero vulnerabilities; package audit, public-tree scan and `git diff --check` passed.
- Clean public export: 381/381 tests passed, followed by dependency/package/public scans and both installed command aliases.
- No external request or real model generation was made.

## Excluded

- The real conversation that exposed a credential is not a fixture and is not recoverable without its missing ancestor rollout.
- No real model call, App UI validation, local installation, service restart, merge, GitHub release or credential rotation is part of this candidate.

# Configuration spaces candidate acceptance

Date: 2026-09-13
Implementation baseline: `de0548d`

Reviewed implementation: `74752c6485a754dd6b55100d47b609839533c1c1`

Release candidate: `v0.3.0`

## Result

| Area | Result | Evidence |
|---|---|---|
| Implementation | Complete for the local v1 scope | Immutable space storage, protected official history, transactional switching, one-shot coordinator, CLI and documentation are present |
| Deterministic automation | PASS | 220/220 isolated Node tests passed |
| Dependency audit | PASS | `npm audit --audit-level=high --registry=https://registry.npmjs.org` reported zero vulnerabilities |
| Package/source audit | PASS | Package manifest and whole-public-tree scans found no denied or credential-shaped content |
| Clean public export | PASS | Fresh `npm ci`, 220/220 tests, package audit, public audit, pack, install, and both command-version checks passed |
| Real model calls | NOT RUN | Zero live turns; `e2e:focused -- --run` was intentionally excluded |
| Installed-machine activation | NOT RUN | No candidate install, space initialization, service start, integration change, or Keychain write |
| Codex App UI | NOT RUN | App-server or CLI automation is not treated as menu/UI sign-off |

All automated processes used temporary Codex and Router homes, config/state/LaunchAgent paths, a test instance id, simulated launchctl, local upstreams, and random ports. The test runner fixes `CODEX_APP_RUNNING=0`, and tests that exercise pending behavior override it only inside their temporary fixture.

## Covered boundaries

- Fresh, legacy applied/disabled, pending, and ambiguous migration.
- Protected `official@1`, automatic official revision capture, immutable Router revisions, clone, history, diff, default model, and manual-drift capture.
- Official-to-Router, Router-to-Router, Router-to-official, historical revision activation, and previous-successful-activation rollback semantics.
- App-running pending behavior, single execution, login recovery definition, shared switch mutual exclusion, cancellable coordinator polling, active-turn drain, target/source hash verification, concurrent-edit refusal, and recoverable failures.
- Missing credentials, candidate failure, service failure, and active-turn timeout.
- Preservation of non-managed Codex configuration and exclusion of subscription credentials, `auth.json`, user MCP, Skills, Hooks, prompts, and history from revisions and transactions.
- Primary and compatibility executable names in a clean installed package.

## Real environment guard

Read-only checks before the final source gate found both Router LaunchAgents unloaded, no listener on port 8788, integration status `disabled`, and Codex using its built-in `openai` provider. The same checks are required after the final gate. The user's selected official model is not an acceptance invariant and is never rewritten by this candidate.

An independent `gpt-6-astra/high` review passed against the frozen implementation commit above. The release-only documentation and version commit is covered again by the deterministic and clean-export gates; no live or UI acceptance is inferred from either review.

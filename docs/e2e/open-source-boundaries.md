# Open-source maintenance boundary acceptance

Date: 2026-09-17
Baseline: `master@b75ecc96ffe19f542bb7e04f3701f82d3730e20f`
Branch: `codex/open-source-boundaries`

## Scope and isolation

The candidate separates public product material, local Router data and private operations without changing Gateway Schema 3, configuration-space Schema 1, integration Schema 4, routing, instruction delivery, tool policy, search, cache affinity, history or compression behavior.

The run used an isolated worktree and temporary HOME, CODEX_HOME, XDG, Router state, service substitutes and loopback upstreams. It made zero external model calls and did not install, start, stop or restart the real service; change the real configuration space, Codex config or Keychain; merge `master`; or publish a release.

## Private evidence archive

Before removing tracked raw artifacts, 132 files totaling 5,262,390 bytes were copied outside the repository into the private archive `open-source-boundaries-b75ecc9`. Its manifest records the baseline commit, relative path, byte size and SHA-256 for every file, and archive verification passed. The candidate deletes these files from the current tree and ignores future `artifacts/`; the material remains recoverable from the private archive and Git history.

## Automated gates

| Gate | Result | Evidence |
|---|---|---|
| Source regression | PASS | `npm test`: 379/379 |
| Dependency audit | PASS | `npm audit --omit=dev`: 0 vulnerabilities |
| Public export audit | PASS | 184 files, 183 text files |
| npm package audit | PASS | 165 files, 164 text files, 419,264 bytes |
| Clean public export | PASS | fresh `npm ci`, 379/379 tests, dependency/package audits and packing |
| Installed commands | PASS | both aliases reported `Codex Local Router 0.5.1` |
| Patch hygiene | PASS | `git diff --check` |
| Recovery migration | PASS | synthetic old installation and rollback state produced a separate hash-verified recovery bundle; runtime/state tampering was rejected |

The package is derived from the real `npm pack --dry-run --ignore-scripts --json` file list. Public export adds only the intended tests, CI, contribution material and source-maintainer tools, then applies per-file path, symlink and sensitive-content checks.

## Historical metadata scan

The reachable-history scan completed without emitting file contents. On the final candidate it reported 161 path/category findings across 136 unique paths: 136 denied-path findings, 24 absolute-user-path findings and one credential-shaped match. The additional denied path is this internal acceptance report itself; internal acceptance records are intentionally excluded from public export. The credential-shaped match is associated with:

```text
artifacts/e2e/gateway-core-qualification-v2-g4-20260916-pass/g4-9c24aa8-gray-run.json
```

This is a human-review item, not evidence that a live credential is present. No history rewrite, deletion, revocation or remote mutation was performed. Current public export and package audits exclude the path.

## Completion status

| Area | Status |
|---|---|
| Code implementation | COMPLETE |
| Deterministic automated acceptance | PASS |
| Historical public check | COMPLETE; one credential-shaped match requires human review |
| Recovery migration verification | PASS in isolated synthetic environment |
| Local machine activation | NOT RUN |
| GitHub/npm publication | NOT RUN |

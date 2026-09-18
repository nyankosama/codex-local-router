# Release qualification policy

This document defines the stable public release contract. Version-specific clients, model matrices, budgets, hashes, and outcomes belong in GitHub Release notes or [frozen evidence](evidence/README.md).

## Evidence layers

| Layer | Required for | What it proves |
|---|---|---|
| Deterministic | Every pull request and release | Tests, audits, export, packaging, and clean installation pass without external model calls |
| Live protocol | Runtime-impacting releases | Selected real channels complete routing, tools, search, continuation, and lifecycle checks within a declared budget |
| Installed environment | Releases selected for local rollout | The exact package and configuration activate without drift or credential crossover |
| App UI | Separate user sign-off | Model visibility and actual App interaction work; app-server evidence is not a substitute |

Documentation-only releases may skip live protocol checks only when the release classifier proves that the full diff contains no runtime, dependency, protocol, configuration, or harness change. Deterministic checks still run, and Release Notes must disclose the skip and name the latest runtime release with live evidence.

## Deterministic gate

The default gate must:

- run the complete test suite in isolated temporary homes and ports;
- audit production dependencies and the package manifest;
- export a clean public tree and scan every exported and packaged file;
- repeat installation, tests, audits, packaging, and both CLI alias checks from the exported tree;
- make no real model request and never read the user's Keychain, Codex history, configuration, or running service.

Canonical commands:

```bash
npm test
npm audit --omit=dev --registry=https://registry.npmjs.org
npm run audit:package
node scripts/audit-public.mjs
git diff --check
```

## Runtime-impacting release gate

Live cases use the current supported Codex client and a bounded, declared matrix. They cover only changed or release-critical boundaries rather than every model-option permutation. A passing receipt must show:

- the selected model request reached the intended Provider;
- subscription and Provider credentials never crossed destinations;
- tool or search calls completed and their results reached continuation generation;
- streaming, cancellation, errors, retries, history, fork, and compression behave as declared where relevant;
- no hidden retry, fallback, or extra network request was used to manufacture a pass;
- failures distinguish Gateway defects, external channel failures, and unresolved attribution.

Missing execution evidence is not a pass. Capability declarations and catalog visibility do not prove live support.

## Security and evidence handling

Live work uses isolated homes, state, credentials, ports, and synthetic or public content. Public evidence may include versions, hashes, counts, timing, redacted destinations, and result categories. It must not include credentials, private conversations, raw history databases, local configuration, request or response bodies, search queries or results, runner host configuration, or rollback packages.

App UI acceptance, local activation, merge, publication, and npm publication are separate decisions and must be reported separately.

[中文](acceptance.zh-CN.md)

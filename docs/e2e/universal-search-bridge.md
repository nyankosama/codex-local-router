# Universal search bridge acceptance

Date: 2026-09-17

Scope: isolated branch `codex/universal-search-bridge`, based on `master@9ce8f01`. This record does not authorize merge, publication, installation, configuration-space activation, service restart or App UI claims.

## Deterministic protocol gate

The current App-bundled `codex-cli 0.154.0-alpha.6.2` (SHA-256 `a1d2f191e70023ed7afd619bc70530f26067a085926e03bae50cf5c0f8298bcf`) was exercised against loopback Providers and a synthetic MCP server. The five-case profile gate passed and covered:

- non-GPT Standard Responses tools and user-MCP call/result continuation;
- exact hosted-search identification, without treating Tavily-like functions as hosted search;
- the subscription bridge call, fixed OpenAI destination and bounded result continuation;
- HTTP/WS selection, credential separation, cancellation and existing history behavior;
- GLM target normalization to Standard Responses, `shell_command`, ordinary tools, `client-default`, no freeform claim, and `low|high|max` with default `max`.

This gate uses no external model or search request. Final repository and package results belong in the task handoff because documentation and packaging changes occur after the protocol fixture is frozen.

## Bounded live evidence

All live inputs were synthetic or public, isolated from the user's real Codex and Router homes. Across diagnostic and corrected runs, 19 model generations and 8 search executions reached an external destination, with no automatic retry used to manufacture a pass. That exhausts the approved search budget, so no further live request may be made in this candidate.

| Case | Result | Evidence boundary |
|---|---|---|
| GLM Flash App protocol + subscription bridge | PASS | two Provider generations, one successful fixed-origin OpenAI search, result returned to the model, source in final answer, credentials separated |
| ai.feei Sol CLI + subscription bridge | PASS | two Provider generations, one successful fixed-origin OpenAI search, result returned to the model, source in final answer, credentials separated |
| ai.feei Sol App protocol + Tavily MCP | FAIL | Codex discovered and selected `tavily_search`; the MCP item failed because the isolated child did not inherit the operator CA path. The harness now passes that path explicitly, but budget prevents a rerun |
| GLM Flash CLI + Tavily MCP | FAIL | Codex exposed MCP through deferred `tool_search`; GLM did not reliably select that discovery function, so no successful Tavily result entered a continuation |
| Official cached/live exact-candidate regression | NOT RUN | search budget was exhausted; existing deterministic official Relay regression remains required but is not a substitute for this missing live receipt |

The corrected OpenAI search carrier is the current object shape `commands.search_query`, not the rejected array-shaped carrier. The successful bridge cases prove Gateway routing and credential boundaries for the tested versions; they do not qualify arbitrary Providers or MCP servers.

## Release decision

| Area | Status |
|---|---|
| Universal subscription-search core | PASS for deterministic gates and the two covered live channels |
| User MCP preservation | PASS deterministically |
| GLM Flash subscription bridge | PASS in isolated App protocol |
| GLM Flash Tavily MCP | FAIL / model did not reliably use deferred discovery |
| ai.feei Tavily MCP | FAIL / harness environment corrected but not rerun |
| Official exact-candidate live regression | NOT RUN |
| Local installation and App UI | NOT RUN |
| Release ready | NO |

The source-only activation tool now consumes one combined, exact-commit release receipt. The stabilized matrix retains both subscription-bridge families, uses the ai.feei Sol case for the client-owned deferred MCP equivalence class, and keeps both official cached/live cases. Its total hard limit is five turns, sixteen model generations and nine searches, including the single external MCP execution; the deferred MCP closure may use four model sends, and each official turn may use at most three first-party searches plus the four corresponding model sends. The historical evidence above remains FAIL and cannot be reused as the combined receipt; the corrected release gate must pass once on the final commit before installation or publication.

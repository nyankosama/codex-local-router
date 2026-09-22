# History migration lifecycle acceptance — 0.5.10

This is the runtime Release gate for compaction and cross-provider history. Evidence is metadata-only and must not contain prompts, tool output, credentials, local configuration, rollout bodies, or opaque compaction content.

## Deterministic classes

- Standalone and inline compaction replace the active window; retained tails are not duplicated.
- Segmented and multi-level forks follow exact `history_base` boundaries with depth, cycle, account, ordinal, source-hash and atomic-write checks.
- Visible agent messages, completed search history, function/custom-tool calls and results retain order; private encrypted and unknown malformed items fail closed.
- Native migration summaries are default-off, target-scoped, tool-free, single-attempt, restart-stable and never repair missing lineage.
- Recovery requires a closed App and idle managed service, stops the service before writing, rechecks every source hash, commits once and restores the previous service state.

## Default live Release cases

1. Official → two native compactions → fork → GLM Flash → one read-only tool call/result/continuation → Gateway and app-server restart → official.
2. Official → two native compactions → fork → third-party GPT → the same tool and restart/return closure.

The two chains share a hard ceiling of 18 upstream model requests. There is no automatic retry or replacement sample. Both cases must preserve the synthetic base fact, latest requirement and tool result; execute the tool exactly once; generate at most one migration summary per preparation; keep subscription and Provider credentials separated; omit official opaque state from third-party payloads; and omit Gateway virtual checkpoints from official payloads. App UI confirmation remains separate.

Run only with explicit live authorization:

```bash
ACCEPTANCE_COMMIT=$(git rev-parse HEAD) npm run e2e:history-migration -- --run
```

## 2026-09-18 live receipt

The isolated gate passed on commit `2b822e13151cfee0b0ee1cf63a9463f9042ba28d` with the App-bundled `codex-cli 0.155.0-alpha.2.6` (`805f2102d573c580d8cad2fc774b81837e68f7e9bdd1adb559d67801bbc1f9bd`). It used 17 of 18 allowed generations, 13 turns, zero implicit retries and zero blocked sends.

Both lifecycle chains passed every assertion: two native compactions, trusted fork, one migration summary, one tool execution, restart continuation, return to official, fact preservation, identity isolation and no opaque-state or virtual-ID leakage. The current Codex client marks its legacy WebSocket feature flags as removed, so App traffic was verified over its actual WebSocket path and the third-party GPT case added one bounded direct HTTP+SSE probe. App UI confirmation and installation of the candidate remain separate and were not performed by this receipt.

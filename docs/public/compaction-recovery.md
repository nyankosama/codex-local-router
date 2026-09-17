# Fork and compacted-history recovery

Codex may represent an older conversation with an opaque official compaction item. A third-party Provider cannot decode that item. The Router therefore switches providers only when it has an exact portable checkpoint containing the original history.

For a direct fork, the Router first checks the fork's own checkpoint. On a miss it performs one local lookup under the explicitly declared parent thread. Inheritance requires the same verified subscription account, the exact encrypted-compaction SHA-256, and a non-empty original history. A successful match is encrypted into the fork's own scope, so later turns and service restarts no longer depend on the parent lookup. A missing or summary-only checkpoint returns HTTP 409 `compaction_history_unavailable`; it is never sent to a third party, summarized, retried, or routed elsewhere.

## Recovering an older rollout

Preview recovery while Codex App may remain open:

```bash
codex-local-router history recover --thread THREAD_ID --json
```

Use `--source /absolute/path/to/rollout.jsonl` to select one exact file. Without it, the command searches the current `CODEX_HOME/sessions` tree by thread ID and refuses zero or multiple matches. The preview reports only thread references, hashes, record/file/checkpoint counts, and the number of writes it would make.

Apply only after reviewing the preview:

```bash
codex-local-router history recover --thread THREAD_ID --yes --json
```

Application requires Codex App to be closed and the Gateway to have zero active turns and WebSocket connections. The command streams JSONL, follows at most 16 explicit `history_base` / `forked_from_id` links, enforces each exclusive ordinal boundary, verifies every compaction and tool call/result pair, preflights every existing checkpoint, then writes all new records in one encrypted SQLite transaction. Repeating the same recovery is idempotent and never changes the Codex rollout.

Recovery stops without writes when an ancestor is missing (`rollout_history_base_missing`), events or tool results are incomplete (`rollout_history_incomplete`), or lineage, boundaries, source selection, or an existing checkpoint conflict (`rollout_lineage_conflict`). Such a conversation must continue on its official model, or be replaced by a new task containing a reviewed, credential-free handoff. Revoking any credential exposed in the old conversation remains an external account action; recovery does not copy or validate it.

`history inspect --thread THREAD_ID --json` reports portable and unrecoverable checkpoint counts plus the most recent recovery source hash. It never prints messages, tool contents, compaction contents, or credentials.


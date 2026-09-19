# Fork and compacted-history recovery

Codex may represent an older conversation with an opaque official compaction item. A third-party Provider cannot decode that item. The Router keeps the complete encrypted archive, the active compacted window, and the target-visible migration view as separate records; metadata alone is never treated as portable history.

For a direct fork, the Router first checks the fork's own checkpoint and then an explicitly declared parent. Some Codex runtimes omit parent-thread metadata on the wire; in that case the Router may resolve only the exact encrypted-compaction SHA-256 previously observed under the same verified subscription account. It never infers lineage from prompt text or crosses account boundaries. A successful match is encrypted into the fork's own scope, so later turns and service restarts no longer depend on the lookup. Missing lineage or an unexplained gap returns HTTP 409 and is never sent to a third party, retried, or routed elsewhere.

If the fork arrives while the official compaction observer is still committing, cross-provider routing waits for the bounded same-account observation window before making that decision. It does not wait on another account or turn this wait into an upstream retry.

Official observation writes are committed in verified-account order because current Codex runtimes may change thread metadata between adjacent turns. This ordering applies only to the local sidecar archive; official responses remain transparent and are not delayed by archive I/O.

Official WebSocket prewarm responses are observed as lineage state as well: current Codex clients can use a `generate: false` response as the next request's `previous_response_id`. The original prewarm request and response still pass through unchanged.

Official response IDs are also resolved by exact ID within the same verified account when Codex changes or omits thread metadata between turns. The ID remains scoped to the account; Gateway-generated response IDs are not promoted to this official lineage.

Official compaction output replaces the preceding active context window; it is not appended to the pre-compaction history. The Router recognizes both standalone compaction requests and compaction emitted by an ordinary response. Exact retained tails are removed positionally so repeated legitimate messages and tool results are not lost.

## Recovering an older rollout

Preview recovery while Codex App may remain open:

```bash
codex-local-router history recover --thread THREAD_ID --json
```

Use `--source /absolute/path/to/rollout.jsonl` to select one exact file. Without it, the command selects the latest matching segment from `CODEX_HOME/sessions`; ancestor lookup also covers `CODEX_HOME/archived_sessions`. The preview reports only thread references, hashes, record/file/checkpoint counts, and the number of writes it would make.

Apply only after reviewing the preview:

```bash
codex-local-router history recover --thread THREAD_ID --yes --json
```

Application requires Codex App to be closed and the Gateway to have zero active turns and WebSocket connections. The command stops a loaded managed service, streams JSONL, follows at most 16 explicit `history_base` links (using `forked_from_id` only when no history base exists), supports segmented rollouts and multi-level forks, enforces every ordinal and exclusive boundary, and verifies compaction and tool call/result relationships. Source-file hashes are checked again immediately before one encrypted SQLite transaction, after which the prior service state is restored. A matching metadata-only checkpoint may be enriched with its validated portable history. Repeating the same recovery is idempotent and never changes the Codex rollout.

An interrupted tool call is retained as an explicit “execution result unknown” historical fact. It is not silently deleted or automatically executed again. Visible agent messages and completed search sources can be projected as untrusted history; Provider-private encrypted state is not sent to another Provider.

Recovery stops without writes when an ancestor is missing (`rollout_history_base_missing`), events or tool results are incomplete (`rollout_history_incomplete`), or lineage, boundaries, source selection, or an existing checkpoint conflict (`rollout_lineage_conflict`). Such a conversation must continue on its official model, or be replaced by a new task containing a reviewed, credential-free handoff. Revoking any credential exposed in the old conversation remains an external account action; recovery does not copy or validate it.

`history inspect --thread THREAD_ID --json` reports complete-original, metadata-only, observing, gap, reusable-summary and failed-summary counts plus the most recent recovery source hash. Add `--target TARGET_ID` to report how many checkpoints are directly compatible, need a controlled migration summary, or remain blocked. It never prints messages, tool contents, compaction contents, or credentials.

## Controlled native migration summary

`compression.nativeMigrationSummary` is off by default and is valid only with `compression.mode: "summary"`. Enable it explicitly for one target with `model edit --id TARGET --native-migration-summary`; use `--no-native-migration-summary` to disable it.

When a trusted official opaque window cannot be projected directly, the Router asks the original official model once, with tools disabled, to summarize that saved active window. The result is persisted by source-window hash and target, reused after reconnect or restart, and combined with the unsummarized latest user input and necessary tail. The opaque item and subscription credential never go to the third-party Provider. A missing lineage, source gap, uncertain result, or tail that already exceeds the target budget fails before destination generation; there is no automatic retry, fallback, recursive chunking, or claim of lossless recovery.

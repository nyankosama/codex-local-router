# Fork and compacted-history recovery

Codex may represent an older conversation with an opaque official compaction item. A third-party Provider cannot decode that item. The Router keeps the complete encrypted archive, the active compacted window, and the target-visible migration view as separate records; metadata alone is never treated as portable history.

For a direct fork, the Router first checks the fork's own checkpoint and then an explicitly declared parent. Some Codex runtimes omit parent-thread metadata on the wire; in that case the Router may resolve only the exact encrypted-compaction SHA-256 previously observed under the same verified subscription account. It never infers lineage from prompt text or crosses account boundaries. A successful match is encrypted into the fork's own scope, so later turns and service restarts no longer depend on the lookup. Missing lineage or an unexplained gap returns HTTP 409 and is never sent to a third party, retried, or routed elsewhere.

If the fork arrives while the official compaction observer is still committing, cross-provider routing waits for the bounded same-account observation window before making that decision. It does not wait on another account or turn this wait into an upstream retry.

Official observation writes are committed in verified-account order because current Codex runtimes may change thread metadata between adjacent turns. This ordering applies only to the local sidecar archive; official responses remain transparent and are not delayed by archive I/O.

HTTP SSE and WebSocket observation both rebuild the archive copy from completed `response.output_item.done` events when the terminal response omits `output`; a non-empty terminal `output` remains authoritative. If an HTTP response omits `Content-Type`, only a bounded observation-copy prefix may identify an unambiguous JSON object or SSE frame; an explicit unsupported media type or unknown body still fails closed. Unfinished or conflicting items, a missing terminal, cancellation, parse failure, or an incomplete response cannot install a successful compaction checkpoint. The relayed bytes and event order are never rewritten. A 409 asks the client to wait only while the same-account observation is actually still running; an observation failure or missing trusted checkpoint instead requires the explicit rollout recovery below (or continued use of the official model).

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

`compression.nativeMigrationSummary` is off by default and is independent from same-target `compression.mode`. Enable it explicitly for a destination with `model edit --id TARGET --native-migration-summary`; use `--no-native-migration-summary` to disable it. It authorizes migration only, never a same-target fallback from `native` to Gateway `summary`.

When a trusted official opaque window cannot be projected directly, the Router asks the original official model once, with tools disabled, to summarize that saved active window. The result is persisted by source-window hash and target, reused after reconnect or restart, and combined with the unsummarized latest user input and necessary tail. The opaque item and subscription credential never go to the third-party Provider. A missing lineage, source gap, uncertain result, or tail that already exceeds the target budget fails before destination generation; there is no automatic retry, fallback, recursive chunking, or claim of lossless recovery.

Same-target native checkpoints and already completed, still-authorized migration views are recognized before any new migration-size estimate. Reusing a persisted migration view makes no summary call. If the destination then reports a real context overflow, the Router returns `context_after_summary_exceeded` and does not generate a second summary for the same checkpoint-to-target migration.

Current Responses Lite tool declarations are request configuration, not history: they are excluded from migration summaries and covered-tail fingerprints. Incremental requests may inherit declarations from a trusted same-account, same-target prewarm response; explicit current declarations take precedence. Codex-initiated compaction retains current tools and its `compaction_trigger`.

`native_migration_reuse_rejected` / `covered_history_mismatch` means the summary completed but the supplied history does not match the saved coverage fingerprint. Waiting or reopening the App does not repair it. Do not rewrite the fingerprint, clear protective state, or silently summarize again. A recovery option is to return to the checkpoint's native source model, let Codex successfully compact there, then verify the destination switch. This requires separate acceptance, not merely a successful configuration change.

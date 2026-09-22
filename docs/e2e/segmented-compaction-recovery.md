# Segmented compaction recovery acceptance — 0.5.9

This record contains no message, tool, credential, local path or opaque compaction body.

## Deterministic coverage

- Same-thread rollout segments and archived ancestors follow exact ordinal boundaries.
- `history_base` takes precedence over older fork provenance.
- An explicitly aborted pending tool call is omitted; incomplete un-aborted pairs still fail closed.
- Matching metadata-only checkpoints are enriched atomically; conflicts remain zero-write and repeated recovery is idempotent.
- Official WebSocket payloads containing `access_programs` remain byte-identical.

## Local reproduction

A metadata-only preview of the reported legacy conversation followed seven exact rollout segments and found 16 target-thread checkpoints. Applying the plan to an encrypted database copy enriched all 16, a second application wrote zero, and inspection reported 16 portable, zero unrecoverable checkpoints. The source rollouts and installed Gateway were not changed during this gate.

Full deterministic tests, package/public audits and clean-install validation are required before deployment. App UI continuation remains a separate post-deployment check.

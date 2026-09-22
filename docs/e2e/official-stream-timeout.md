# Official compaction and long-stream regression — 0.5.8

Date: 2026-09-18. Base: `0859d54`. Scope: local runtime candidate, not GitHub publication.

## Incident and correction

Observed official generations entered Engine after compaction and were interrupted by the shared curl total deadline near 180 seconds, although upstream headers/events had arrived. This is not evidence that the compaction operation itself timed out or that OpenAI would necessarily have completed the generation.

- Reuse the routing/checkpoint changes first explored in unmerged candidate `15ab00b`, adapted to current fork, search and continuation behavior. Native official opaque state/compaction triggers alone stay on Relay; virtual checkpoints, Engine-generated response IDs and cross-provider history still require Engine.
- Observe portable checkpoint originals on successful official compaction, without changing response bytes or making native continuation depend on portable-history availability.
- Replace the total deadline only for upstream HTTP SSE with an inactivity deadline. Finite JSON/binary responses retain their total deadline; connect timeout, cancellation, downstream backpressure and sanitized errors remain enforced. Native WebSocket Relay is unchanged. No retry or provider fallback was added.
- Preserve runtime/space schemas and every user configuration field. No new configuration space revision is needed.

## Deterministic acceptance

| Surface | Evidence |
| --- | --- |
| Native compaction | Trigger and opaque item classification; HTTP zstd body preservation; repeated compaction keeps original portable history |
| Migration safety | Virtual/malformed checkpoints and cross-provider continuation still enter Engine; existing fork/recovery/provenance regressions run |
| Long streams | Loopback HTTP Relay, Engine HTTP and Engine-over-client-WS complete after configured timeout with exactly one upstream send |
| Timeout distinction | Active SSE exceeds deadline; silent headers/stalled SSE fail; trickling non-SSE still hits total deadline |
| Lifecycle | Backpressure does not count as upstream silence; AbortSignal and consumer close disconnect upstream |
| Product | Full suite, clean public export, audit, package content and both installed command aliases |

Production-duration local check: `timeoutMs=180000`, heartbeat every second, terminal at 190 seconds; completed at **190033 ms**, 2503 received bytes, zero model calls. This reproduces the timing boundary without depending on a model's response duration.

One legacy fallback test had a 20 ms deadline that could expire before the mock server received the primary request. It was stabilized with flushed headers and a 500 ms deadline versus a 1500 ms body delay; its fallback assertions were retained.

Final automatic results and exact package hash are recorded in the private rollout receipt. Raw evidence, installed recovery code and machine-specific activation material remain outside the public source tree.

## Boundaries

No live model, app-server or App UI acceptance is claimed by these tests. A heartbeat can keep an otherwise unproductive SSE alive; the user can cancel, and fully silent streams still time out. Historical Engine response IDs remain on safe replay, rather than being relabeled as official Relay IDs. The reported task must be retried after safe activation to verify its real upstream completion; no task history is rewritten.

The candidate can be merged and locally installed with user approval. This report is not a replacement for the separate GitHub live release qualification contract.

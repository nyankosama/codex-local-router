# Third-party GPT cache-affinity contract

Prompt caching and account-pool affinity are two different layers:

```text
Codex lineage
    | local HMAC
    v
Gateway opaque key
    | consistent hash before account selection
    v
Provider pool account / cache shard
```

Codex Local Router can make the first boundary stable and private. A relay backed by multiple API keys or subscription accounts may use the second boundary to improve locality; otherwise identical Gateway keys can still land on different account-scoped caches.

## Gateway contract

For a third-party `openai-gpt` Responses target whose Provider explicitly selects `gateway-opaque`, the Router:

- derives one `clr-pc-v1-*` key from a local 32-byte secret, account hash, verified lineage, Provider ID, and upstream model;
- prefers an HMAC of the client's cache key, then an existing same-account parent mapping, then the current thread;
- freezes the result for each turn, including HTTP/WebSocket and tool continuations;
- keeps different accounts, Providers, models, and unverified forks separate;
- sends no original cache key, ChatGPT account, thread, turn, session, installation, or window identifier;
- never scans or hashes the prompt, adds a network request, retries without the field, or changes Provider/model because of cache handling.

Missing stable lineage safely omits the derived field. An unavailable dedicated Keychain secret fails before provider transmission. Key rotation, TTL expiry, Provider change, and model change may cold-start once.

## Account-pool relay interoperability

A relay that wants the best chance of preserving upstream cache locality should:

1. accept the top-level standard `prompt_cache_key` on its Responses endpoint;
2. use that opaque key as an input to a stable upstream-account or cache-shard selection before forwarding the request;
3. freeze the selected account for the complete turn, including tool-result continuations;
4. keep the same mapping stable for at least the advertised 30-minute affinity TTL;
5. on account failure, start the turn cold on one replacement and never switch back within that turn;
6. forward or truthfully reconstruct `usage.input_tokens_details.cached_tokens` so effectiveness is observable;
7. never log or expose the opaque key as customer-visible identity.

Consistent hashing is one possible implementation, not a protocol requirement proved by this project. The current ai.feei experiment verifies the observable effect of adding the standard field; it does not reveal or verify ai.feei's internal account-pool algorithm. The key is opaque. A relay must not assume it contains an account, user, thread, or model name, and must not combine it with prompt text to discover identity.

## Acceptance boundary

Deterministic Gateway acceptance proves key stability/isolation, original-identity removal, option filtering, HTTP/WS behavior, encrypted restart/fork lineage, bounded state, no retry, and local performance guards. It does not prove that a remote relay honors the key.

The current comparison gate interleaves 24 bounded synthetic generations: for Sol and Astra, six direct-shape calls and six candidate anonymous-affinity calls, with the first call in each group treated as warm-up. Candidate post-warm samples require at least four of five non-zero cache reads, at least 70% weighted cache reuse, and no regression beyond 15 percentage points versus the same-period direct group. A separate current-App-binary gate permits at most six provider generations for two read-only MCP call/result continuations and requires per-frame Responses Lite negotiation plus stable anonymous-key fingerprints.

If the relay rejects or ignores the field, the correct result is `EXTERNAL_UNRESOLVED`: the Gateway candidate may be complete, but end-to-end cache affinity is not accepted. Do not enable a production configuration space on that evidence.

For maintainers building from source, `scripts/maintainer/cache-affinity-activate.mjs` and its rollback command bind a reviewed rollout to exact package, server, configuration, target IDs and source-space hashes. These tools are intentionally excluded from the npm package. Before replacing an older global installation that a saved rollback references, prepare and verify an independent recovery bundle as described in the [maintenance boundary](open-source-maintenance-boundaries.md). The emergency path remains `codex-local-router rescue --subscription --yes` with the App closed.

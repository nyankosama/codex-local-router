# Universal search for third-party models

Codex Local Router exposes two separate search paths. They are never selected as hidden fallbacks for each other.

| Path | Executor | Gateway responsibility |
|---|---|---|
| User MCP such as Tavily | Codex client | Preserve discovery, call IDs and results; do not copy MCP configuration or credentials |
| OpenAI subscription bridge | Gateway | Present one standard function, call the fixed OpenAI `/alpha/search` endpoint, and return bounded untrusted results to the existing tool loop |

The subscription bridge is explicit and target-scoped:

```json
{
  "targets": {
    "example": {
      "subscriptionSearch": { "delivery": "standard-tool" }
    }
  }
}
```

```bash
codex-local-router model edit --id example \
  --subscription-search standard-tool --yes
```

It applies only to authenticated `/subscription/v1/responses` requests whose current Codex search mode is observable. A disabled client search setting injects nothing. `cached`, `indexed`, `live`, and domain restrictions are preserved; an unsupported shape fails closed. The search request uses only the ChatGPT subscription identity at the fixed OpenAI origin. Model generation uses only the selected Provider credential. `/v1` never borrows subscription identity.

The bridge is independent of Responses Lite, `nativeWebSearch`, model family, and Provider-hosted search. It requires Standard Responses function calls and result continuation. Search results are bounded by count, bytes, timeout and per-turn calls, and remain untrusted tool output. No source, model or credential fallback is performed.

A model may call the bridge repeatedly in one turn. `webSearch.maxRounds` limits successful internal rounds (default 3, valid range 1-10); the next call fails with `tool_loop_limit` instead of retrying or falling back. Internal search calls/results are intentionally hidden from the client transcript, so Codex App normally shows only the answer and its sources. Client-visible text and ordinary tools are still forwarded as soon as they arrive; only the private search lifecycle is consumed inside the Gateway.

Current Codex clients may expose configured MCP tools through the standard `tool_search` discovery function instead of sending every MCP schema in the first model request. This keeps initial context small. The Gateway preserves `tool_search`, the selected dynamic call and its result, but does not read or launch the user's MCP server. A model that does not reliably call `tool_search` cannot be made to use that MCP by the Gateway without copying the user's MCP authority into the Router; this project deliberately does not cross that boundary.

For GLM 5.3 Flash, the accepted target shape is Standard Responses, `shell_command`, standard tools, no forced Code mode, `client-default` multi-agent behavior, no freeform-tool claim, reasoning levels `low`, `high`, `max` with default `max`, and subscription search delivered as `standard-tool`. Provider/model IDs, compression and generic client-delivered instructions stay unchanged. The context window remains a target-local configured value; catalog configuration is not a capacity proof.

The v0.5.4 live candidate established the GLM and ai.feei subscription bridges plus the ai.feei client-owned Tavily path in three turns, seven generations and three searches with zero retries. GLM produced 38 client-visible text deltas in the bridge case; a longer follow-up produced 523 deltas over about 13 seconds. These are protocol and downstream-send observations, not App paint-time guarantees. Together with official cached/live regression, the release matrix covers five bounded equivalence cases without a model-by-protocol Cartesian product.

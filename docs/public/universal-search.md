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

The bridge supports more than one search. A Provider response may request several searches, and the model may request another search after seeing earlier results. `webSearch.maxRounds` limits model/search continuation rounds, not the number of queries in one response; it defaults to `3` and accepts `1` through `10`. Exceeding the limit returns `tool_loop_limit`. The Gateway does not retry, switch search sources, or fall back to another model.

The subscription call and result are intentionally private Engine events, so Codex App does not show a search tool card for this path. Client-visible text and ordinary client tools are streamed as soon as they arrive, including turns that declare search but never call it. The Gateway does not invent progress messages or convert reasoning into commentary, so a model that emits only tool calls can still appear quiet until it starts its answer.

Current Codex clients may expose configured MCP tools through the standard `tool_search` discovery function instead of sending every MCP schema in the first model request. This keeps initial context small. The Gateway preserves `tool_search`, the selected dynamic call and its result, but does not read or launch the user's MCP server. A model that does not reliably call `tool_search` cannot be made to use that MCP by the Gateway without copying the user's MCP authority into the Router; this project deliberately does not cross that boundary.

For GLM 5.3 Flash, the accepted target shape is Standard Responses, `shell_command`, standard tools, no forced Code mode, `client-default` multi-agent behavior, no freeform-tool claim, reasoning levels `low`, `high`, `max` with default `max`, and subscription search delivered as `standard-tool`. Provider/model IDs, compression, instructions and context-window declarations remain target-local settings; enabling this bridge does not migrate or prove a model's capacity.

The v0.5.4 release candidate passed the bounded five-case live matrix with five turns, thirteen model generations, seven searches and zero retries. The matrix proves the GLM and ai.feei subscription bridges, one client-owned Tavily MCP path, result continuation, credential separation, and unchanged official cached/live search. The GLM App protocol case delivered 38 client text deltas before completion; a no-search long-answer canary delivered 523 deltas over about 13 seconds. These are transport/protocol results, not a latency target or a claim that every model will narrate intermediate work.

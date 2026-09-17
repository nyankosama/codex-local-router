# Tool-search history migration

Codex may retain `tool_search_call` and `tool_search_output` items after a model dynamically discovers tool definitions. Those items contain provider control state and tool schemas, so the Router does not replay them unchanged to another provider or protocol.

During a cross-target migration, the Router validates the complete sequence in one linear pass. Every call needs one later output with the same non-empty `call_id`; duplicates, reversed items, and missing halves fail with HTTP 409 `tool_search_history_incomplete` before any destination request. A valid pair becomes this fixed assistant history item:

```text
[Dynamic tool discovery occurred on the previous provider. Provider-specific discovery metadata and tool schemas were omitted during migration; subsequent tool calls and results remain in history.]
```

The marker contains no search arguments, tool names, descriptions, schemas, execution metadata, or provider IDs. Completed function and custom-tool calls/results that follow the discovery remain ordered and portable. The same representation is used by history-resume prompts and works with Responses and Chat Completions targets.

The encrypted original history is never rewritten. Each destination stores a separate portable view, so a later switch rebuilds from the original and does not stack additional markers. Logs record only the pair count plus existing hashed correlation fields and provider identities.

This feature does not reconstruct old opaque official compactions that the Router never observed in full. It also does not retry a malformed history, call a summary model, or fall back to another provider.

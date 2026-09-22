# Third-party generic defaults acceptance

Date: 2026-09-17

## Deterministic client gate

Candidate lineage `ede66d1f7c587640b96dc4b3f1fb376727ff7e88` used the App-bundled `codex-cli 0.154.0-alpha.6.2` (`a1d2f191e70023ed7afd619bc70530f26067a085926e03bae50cf5c0f8298bcf`) with loopback Providers and zero external model calls.

- CLI control/generic context: 24,393 / 28,043 bytes (`+3,650`).
- App-server control/generic context: 21,373 / 25,205 bytes (`+3,832`).
- Both generic paths carried one generic instruction and the expected `exec`, `wait`, and collaboration tools.
- The current-client HTTP/WS, tool continuation and multi-agent protocol fixture passed.

These results qualify the Gateway's generic template mechanics and stay below the `max(8 KiB, 10% of control)` context guardrail. They do not qualify a real Provider.

## OpenCode Go live observation

The bounded live gate sent one synthetic DeepSeek CLI generation. Provider egress contained one generic instruction plus Code mode and collaboration tools, and the Provider returned HTTP 400. No tool result or continuation completed, no automatic retry ran, and the source configuration remained unchanged. The remaining DeepSeek and ai.feei cases were not run after the fail-closed stop.

The current OpenCode Go documentation lists DeepSeek V4.1 Flash through `https://opencode.ai/zen/go/v1/chat/completions`; it does not establish acceptance of the Codex Responses/freeform payload used by the generic template: <https://opencode.ai/docs/go/>.

## Product decision

- `opencode-go/deepseek-v4.1-flash` is legacy-only.
- Default setup and new targets using that preset keep the accepted legacy path.
- `codex-general-v1`, direct Code mode, capability profiles and direct multi-agent metadata fail closed for that preset.
- The space-level default remains `codex-general-v1` for separately qualified Providers.
- Requalification requires a successful real Codex Responses/freeform tool call and continuation; model discovery or static preset metadata is insufficient.

No local package, service, configuration space or Codex App state was changed by this acceptance run.

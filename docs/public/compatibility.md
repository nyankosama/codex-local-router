# Compatibility and qualification

[简体中文](compatibility.zh-CN.md)

This matrix separates configuration availability from evidence. A preset or configurable endpoint is not a blanket support claim, and a live result applies only to the named Provider/model/path.

| Component or path | Availability | Deterministic coverage | Latest runtime live evidence | App UI |
|---|---|---|---|---|
| macOS / Node.js 22 | Supported | Full default suite | Release packaging | Manual installation check |
| Linux / Windows | Not supported | None | None | None |
| ChatGPT subscription HTTP/WS and auxiliary APIs | Built in | Fixed-origin relay, identity, history and search | v0.5.6 bounded official cached/live search | Manual per installed App |
| OpenCode Go DeepSeek preset | Preset available; legacy path | Legacy Responses adapter | No current release case | Not claimed |
| ai.feei GPT 5.6 Sol | Preset available | Responses, GPT policy, search/cache/instruction paths | v0.5.6 subscription bridge and client-owned MCP cases | Manual per installed App |
| ai.feei GPT 6 Astra | Preset available | Same declared protocol family | No current release case | Not claimed by current release |
| BigModel GLM 5.3 Flash | Configuration supported | Standard Responses, tools, continuation and bridge | v0.5.6 subscription-search bridge | Manual per installed App |
| BigModel GLM 5.3 main | Configuration supported | Generic Standard Responses coverage | No model-specific current release case | Not claimed |
| Generic OpenAI-compatible Responses | Configuration supported | Generic adapter and protocol fixtures | Provider-specific probe required | Provider-specific |
| Generic OpenAI-compatible Chat Completions | Configuration supported | JSON function-tool adapter | Provider-specific probe required | Provider-specific |

Exact driver versions, binary hashes, budgets, measurements, and historical failures belong to the corresponding [frozen evidence](evidence/README.md) or GitHub Release. They are intentionally absent from this evergreen matrix.

## Status vocabulary

- **Preset available**: the CLI ships a named preset.
- **Configuration supported**: public schema and CLI can express the channel.
- **Deterministic tested**: credential-free local fixtures cover the declared Gateway behavior.
- **Live release-qualified**: a bounded real-channel case passed for the named release.
- **App UI confirmed**: a user separately verified the rendered App experience after installation.

These states do not imply each other. Channel health is also separate from Gateway ownership: a run may classify a failure as `EXTERNAL_DEGRADED`, `GATEWAY_DEFECT`, or `UNVERIFIED`, but only complete positive evidence supports a live-ready claim.

## Stable compatibility boundaries

- Runtime configuration remains schema 3.
- Configuration-space storage remains schema 1.
- Integration state remains schema 4.
- Official subscription traffic uses a fixed-destination transparent relay; local `/v1` access never borrows subscription identity.
- Standard Responses is the primary third-party App surface. Chat Completions cannot carry namespace or freeform tools.
- Existing configurations do not acquire new templates, Lite, search, cache affinity, or instruction snapshots on load.
- User MCP remains client-owned. The Router does not copy its configuration or credentials.

## Tool and search limits

Third-party providers cannot assume the official backend's server-side tool handling. The generic Plugin policy narrows only confirmed structured Plugin definitions; core tools, allowed Plugins, user MCP, and opaque schemas embedded in `exec` documentation can still consume context. It is a context-control policy, not a sandbox or a fixed token-reduction promise.

The `standard-tool` subscription-search bridge is model-family neutral but still requires Standard Responses function calls and result continuation. It uses only subscription identity at the fixed OpenAI destination and only Provider credentials for model generation. Provider-native hosted search, Responses Lite standalone search, and user MCP search remain distinct paths with no hidden fallback. See [universal search](universal-search.md).

## Before depending on a new combination

1. Confirm the Provider/model declaration in [Provider setup](providers.md).
2. Run `status`, `doctor`, and a non-live `model list` first.
3. Use an explicit live probe only when quota use is acceptable.
4. Treat model menu visibility or app-server completion as different from App UI confirmation.
5. Requalify after a material Codex client, protocol, Provider, or tool-inventory change.

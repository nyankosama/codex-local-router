# Configuration

The default configuration is stored under `~/Library/Application Support/Codex Local Router/config.json`. Override it with `CODEX_LOCAL_ROUTER_CONFIG` or `--config`.

Runtime configuration is schema 4. Configuration-space storage is schema 1 and integration state is schema 4. Ownership is explicit:

- global machine layer: `listen`, `access`, `history`, `maxBodyBytes`, `maxConnections`, `timeoutMs`, and the official catalog source path;
- versioned space layer: route mode and target choice, `providers`, `targets`, `rules`, `pluginTools`, `webSearch`, `standaloneSearch`, subscription routing, available App models, and the default Codex model.

`config.json` is the authority for global fields plus the materialized active Router-space fields. A manual change to the latter is drift and blocks switching until it is captured or reverted.

For initialization, cloning, switching, rollback, drift, pending transactions, and rescue workflows, see the [configuration-space guide](configuration-spaces.md).

## Request timeouts

`timeoutMs` defaults to 180,000 ms; a target may override it. HTTP connection establishment is limited to the smaller of 15 seconds and this value. Before response headers and for non-SSE responses, it is a total request deadline. Once the upstream declares `text/event-stream`, it becomes an inactivity deadline, reset by incoming bytes (including heartbeats). A progressing generation may therefore last longer than three minutes. The inactivity clock pauses while downstream backpressure stops reads; cancellation still closes the upstream. Native official WebSocket relay is not subject to this HTTP deadline.

This is not an automatic retry or an unlimited silent wait: an upstream that sends no bytes for the interval still fails. Heartbeats can keep a request alive even without visible text, and a user can cancel it. No configuration-space migration is required.

## Third-party default template

New App-enabled third-party models default to `codex-general-v1` when they declare Responses, tool calling and freeform tools and their preset is Provider-qualified. The template materializes generic instructions, Standard Responses, code mode, multi-agent v2, disabled standalone search and the standard Plugin policy. `thirdPartyDefaults.template` may be `codex-general-v1` or `legacy`; it affects later creation only. Existing targets change only through `model apply-template`. The current OpenCode Go DeepSeek preset is legacy-only despite its static capability shape. See [third-party templates](third-party-templates.md).

Space metadata lives below the Router data directory:

```text
spaces/index.json                  active, previous, latest revisions
spaces/<name>/<revision>.json      immutable content plus SHA-256
transactions/space-switch.json     one pending/recoverable switch
```

Names match `[a-z0-9][a-z0-9._-]{0,63}`. A revision stores credential references only: environment variable names or Keychain service/account pairs. Plaintext Provider credentials, ChatGPT tokens, `auth.json`, user MCP, Skills, Hooks, prompts, and conversation history are excluded. `official@1` is permanently retained.

Within a Router space, schema 4 keeps three model-routing layers:

- `providers`: base URL, adapter, endpoint paths, credential reference, message-phase policy, timeout, and concurrency.
- `targets`: unique target ID, provider, upstream model, protocol, context window, input modalities, tools, reasoning levels, search, compression, and Codex catalog metadata.
- global policy: routing, local access, history, request limits, subscription routing, and standalone-search defaults.

A target can name a versioned `preset`. Presets fill model/provider capabilities first, the selected template supplies behavior defaults, and explicit target flags win. Loading a preset at runtime never reapplies a template. Provider-model declarations do not prove an unrelated provider offers the same behavior.

## Third-party GPT Plugin policy

`modelFamily` is optional and accepts `openai-gpt` or `other`. Leaving it absent preserves the pre-policy behavior: all client tools pass through. The final upstream target, not the request path or a model-name pattern, selects the policy in this order:

1. the official subscription target is always passthrough;
2. an explicit target `pluginToolPolicy` wins;
3. a third-party `modelFamily: "openai-gpt"` uses the standard allowlist;
4. other and legacy third-party targets are passthrough.

`pluginToolPolicy` accepts `"passthrough"`, `"third-party-gpt-default"`, or an explicit allowlist:

```json
{
  "mode": "allowlist",
  "allowedPlugins": ["github", "my_plugin"]
}
```

There is one standard allowlist: `github`, `figma`, `sites`, and `connected_documents`. `spreadsheets`, `connected_documents`, and `codex_document_control` normalize to the same `connected_documents` identity. `safety_settings` is a Plugin, not an App core tool, and is excluded by default. Extend the standard list globally without editing target definitions:

```json
{
  "pluginTools": {
    "thirdPartyGpt": {
      "additionalAllowedPlugins": ["my_plugin"],
      "excludedDefaultPlugins": ["figma"]
    }
  }
}
```

An alias-normalized name cannot be present in both arrays. Codex built-ins, `codex_app`, `cua_repl`, router search tools, and MCP servers configured by the user always pass. Skills, Hooks, and prompt/history text are never rewritten. A confirmed Plugin outside the list is removed; an unknown or colliding source passes with a metadata-only diagnostic.

The filter covers ordinary functions, namespace tools, and `input[].additional_tools.tools`. An explicit `tool_choice` that selects a removed Plugin fails with `tool_policy_conflict`. If an upstream nevertheless emits a confirmed forbidden Plugin call, the router ends the turn with `disallowed_plugin_tool_call` before the call reaches the client; this policy failure never triggers model fallback.

## Third-party App profiles

### Opt-in code mode

`targets.<id>.app.toolMode: "code_mode_only"` projects the same-named `tool_mode` catalog field. It asks a compatible Codex client to expose its `exec`/`wait` code-mode tools, enabling batched calls. It requires an App-enabled third-party Responses target with `toolCalling` and `freeformTools`, plus Provider qualification for a preset that narrows those claims; model family is not an admission rule. Omit the field to preserve the client's default. Presets and existing installations are not migrated. This option works independently of Standard/Lite transport and instruction delivery; it does not copy other official model capabilities or change defaults, search, cache affinity or prompts. Diagnostics include `appCapabilityProfile.toolMode` (`default` when absent).

The Plugin allowlist still filters structured tool definitions. It does **not** parse or trim schemas embedded in `exec.description`, inspect JavaScript, or block indirect calls. Here the goal is context-size control, not a security sandbox. Do not treat a code-mode wrapper as proof that tool context became smaller.

Before activating code mode, compare the same client binary, target, prompt, instructions, transport and installed tool inventory with and without the option. Record the UTF-8 bytes of serialized `{instructions, tools, input}` and tool-definition hashes at Provider egress; this is a wire-size proxy, not measured tokens. A practical qualification bound is a first-request increase of at most `max(8 KiB, 10% of the original context payload)`, with stable tool hashes across tool continuation and the next turn. If the bound fails or tool call/result evidence is missing, do not activate. Requalify after a material client/tool-inventory change; this is an activation gate, not an automatic runtime limiter or fallback.

Batch preview (add `--yes` only after qualification and in an App-closed rollout window):

```bash
codex-local-router model set-tool-mode --ids target-a,target-b \
  --tool-mode code_mode_only --space default --json
```

The batch commits one immutable space revision and preserves the space default and current Codex selection separately. `--tool-mode default` removes the override; an exact historical space reference restores all prior settings. Client adoption requires a fresh task after the usual safe activation/reopen flow. App-server protocol checks are not App UI acceptance, and fewer round trips are possible, not guaranteed.

Instruction snapshots are separately versioned and do not inherit the source model's capability profile. Standard Responses uses client delivery; eligible Lite targets can explicitly opt into `gateway-lite`. See [instruction snapshots](instruction-snapshots.md) for constraints, evidence and rollout gates.

Eligible App-enabled third-party Responses targets have one explicit capability profile. Existing non-GPT targets remain outside this logic until a profile or generic template is explicitly materialized:

| Profile | Transport and tool surface | Standalone search |
|---|---|---|
| `standard-tools` | Standard Responses; Codex core tools, allowed Plugins, and user MCP follow the configured policy | Not advertised |
| `lite-search` | Responses Lite; the reduced Plugin/MCP surface is reported in diagnostics | Required; uses the selected subscription or Provider source |

New Responses targets created with `model add` persist `standard-tools`, so diagnostics report reason `target-explicit`; newly validated unprofiled App-enabled GPT Responses targets without a Lite compatibility signal resolve to the same profile with reason `standard-default`. A non-GPT target enters only through an explicit profile or generic-template marker. Select `--app-profile lite-search` explicitly when independent search is required. Existing Responses targets with `useResponsesLite: true` retain their transport without an automatic persisted migration. When search is active they resolve to `lite-search`; when search is explicitly disabled they remain unprofiled with reason `legacy-responses-lite-transport-only` and tool surface `legacy-responses-lite`. An explicitly selected `lite-search` without search, or `standard-tools` with search, still fails closed. Legacy non-Responses and unconfigured non-GPT targets keep their old transport behavior and report an unchanged, unprofiled state. JSON and human-readable `model list`, non-live `model probe`, `status`, and `doctor` output expose the effective profile, selection reason, and tool-surface classification. Each generated custom catalog entry exposes the same profile, reason, and tool surface. Official subscription models are outside this split and remain transparent.

The profile is frozen in the target configuration; upstream failures, retries, reconnects, and tool requests never switch it. `standard-tools` plus active standalone search, and an explicitly selected `lite-search` plus disabled search or Standard transport, are rejected rather than silently coerced. The unprofiled legacy transport-only case is a compatibility state, not a third qualified profile.

## Third-party prompt-cache affinity

Provider cache affinity is opt-in and applies to compatible third-party Responses targets: `openai-gpt`, or a non-GPT target that explicitly materialized `codex-general-v1`. Old non-GPT targets remain unchanged:

```json
{
  "providers": {
    "example": {
      "adapter": "openai-compatible",
      "baseUrl": "https://provider.example/v1",
      "promptCaching": { "affinity": "gateway-opaque" }
    }
  }
}
```

`affinity` accepts `none` or `gateway-opaque`. An absent field is the same effective policy as `none`; no preset enables it automatically. Configure it through an immutable space revision:

```bash
codex-local-router provider edit --id example \
  --prompt-cache-affinity gateway-opaque --yes
```

Official subscription traffic keeps the client cache fields unchanged. For an eligible explicitly enabled third-party Responses target, the router removes the original `prompt_cache_key`, Codex metadata, account/thread/turn/session/install identifiers, and `comparison_response_id`, then sends only a `clr-pc-v1-*` HMAC key. Safe `prompt_cache_options.mode` (`implicit` or `explicit`) and `ttl` (`30m`) may remain. Chat Completions, OpenCode Go, and unconfigured legacy non-GPT targets never receive a Gateway affinity key.

For third-party GPT Responses, `prompt_cache_usage` diagnostics are emitted for both `none` and `gateway-opaque` after one successful terminal response. Missing upstream usage remains `null`/unknown rather than becoming a zero hit; errors and cancellations emit no terminal usage event. Responses Lite is negotiated per HTTP request or WebSocket frame. Only normalized `true` is sent to an applicable Provider; a missing or false frame never inherits an earlier connection value, and internal summary/image helper calls remain non-Lite.

The secret is generated lazily only when the feature is first used and stored as a 32-byte value in macOS Keychain under service `com.nyankosama.codex-local-router.prompt-cache-v1`, account `affinity`. Lineage state contains derived IDs only, is bounded, expires after 30 minutes, and uses the encrypted state archive when available. Same-turn tool continuations freeze the first policy/key. A fork inherits only when the client cache key matches or an existing same-account parent mapping verifies the relationship; otherwise it starts an independent lineage.

`model list`, non-live `model probe`, `status`, and `doctor` report the effective mode, selection reason, carrier, supported lineage sources, and restart-stability capability. They never print the derived key or client identifiers. Provider behavior still determines end-to-end effectiveness; the [account-pool interoperability guidance](provider-cache-affinity.md) is conditional, and Gateway configuration alone proves no cache-hit rate.

## Standalone search routing

For Standard Responses targets, a separate model-family-neutral subscription bridge can expose OpenAI subscription search as a normal function tool:

```bash
codex-local-router model edit --id example --subscription-search standard-tool --yes
```

This mode is independent of the legacy/Lite standalone-search policy below and of provider-native hosted search. It requires authenticated subscription entry, an observable client search mode, function calls and result continuation; conflicting Lite, standalone or native-hosted declarations fail validation. See [universal search](universal-search.md).

`webSearch.maxRounds` bounds repeated bridge calls within one turn (default 3, range 1-10). Reaching the next round returns `tool_loop_limit`; it does not trigger a retry or search-source fallback. Internal search events stay private to the Gateway while client-visible text and ordinary tools continue to stream normally.

Standalone client search is separate from `capabilities.nativeWebSearch`, which still means an embedded provider-hosted Responses tool. Current Codex exposes standalone search as the Responses Lite `web.run` namespace. New `standard-tools` targets therefore disable its advertisement; explicit `lite-search` targets use the selected source. Official models always use the fixed ChatGPT subscription backend. Existing Responses targets with `useResponsesLite: true`, or with an explicit legacy search policy that implies Lite, retain the subscription-search behavior provided the user is signed in and the runtime search setting allows it. An unprofiled App-enabled GPT Responses target without those compatibility signals takes the new Standard default. Other, non-Responses, and legacy non-GPT targets keep their prior behavior.

The source precedence is: official model, explicit target policy, legacy explicit `app.supportsSearchTool`, explicit App-disabled cutoff, third-party GPT space/default, legacy `nativeWebSearch` compatibility, then unchanged legacy behavior. The cutoff applies only when neither higher-priority target declaration exists: it prevents an explicitly hidden GPT target from inheriting an App-only search advertisement. Sources are `subscription`, `provider`, and `disabled`:

```json
{
  "standaloneSearch": {
    "thirdPartyGpt": { "defaultSource": "subscription" }
  },
  "providers": {
    "my-provider": {
      "baseUrl": "https://api.example.com/v1",
      "standaloneSearch": { "endpoint": "alpha/search" }
    }
  },
  "targets": {
    "my-gpt": {
      "modelFamily": "openai-gpt",
      "standaloneSearch": { "source": "provider" }
    }
  }
}
```

Provider search is opt-in: it requires an App-enabled Responses target and an explicit endpoint. The endpoint is joined to `baseUrl`; absolute URLs, query/fragment components, traversal, encoded traversal, and cross-origin destinations are rejected. The router never falls back between subscription, Provider, Tavily, or Exa when the selected source is unavailable. A disabled route returns `standalone_search_disabled`; a search that cannot be associated uniquely with a model turn returns `standalone_search_route_unresolved`.

The old `app.supportsSearchTool` field and CLI flags remain input compatibility aliases. `true` maps to subscription and `false` to disabled. New CLI writes remove the old field, and a conflicting old/new declaration is invalid. The generated catalog's `supports_search_tool` is derived from the effective policy.

`history.observationWaitMs` optionally sets the bounded wait for an in-flight official-history observation when the very next turn switches providers; the default is 2,000 ms. Ordinary official responses finish without waiting for observation parsing or disk I/O.

Provider endpoint paths are optional:

```json
{
  "baseUrl": "https://provider.example/api/v1",
  "endpoints": {
    "responses": "/v1/responses",
    "chatCompletions": "/v1/chat/completions"
  }
}
```

The joiner avoids a duplicate `/v1`. Vendor context errors can be classified with `contextErrorCodes`; body and attachment error codes belong in `nonContextErrorCodes`. A generic `request_too_large` never triggers lossy compression by itself.

Credentials may use `apiKeyEnv` or a Keychain reference:

```json
{
  "keychain": {
    "service": "codex-local-router-provider",
    "account": "my-provider"
  }
}
```

Inline `apiKey`, `token`, and `authorization` values are rejected.

Codex 0.153.4 only accepts `freeform` as a non-null `apply_patch_tool_type`.
Targets that have verified freeform tool support receive that value. Chat
Completions targets use `null`, so the catalog does not claim a freeform tool
that their JSON function protocol cannot carry. Codex may still attach plugin
namespace definitions to every request; the Chat adapter omits those definitions
with a metadata-only log entry and forwards the ordinary JSON function tools.
An explicit custom/freeform tool remains a capability error.

## Add a provider and a model

Provider and target changes go through the CLI. It prints a diff and asks for confirmation; pass `--yes` for automation. Routing is not a CLI subcommand and is edited in `config.json`.

```bash
# 1. Provider: endpoint, credential reference, concurrency budget.
codex-local-router provider add --id my-provider \
  --adapter openai-compatible \
  --base-url https://api.example.com/v1 \
  --credential-prompt \
  --concurrency 4 --yes

# 2. Target: start with a conservative Standard Responses contract.
codex-local-router model add --id my-model \
  --provider my-provider \
  --upstream-model the-upstream-model-id \
  --protocol responses \
  --context-window 128000 \
  --input-modalities text \
  --compression unsupported \
  --template legacy \
  --no-freeform-tools \
  --display-name "My Model" \
  --reasoning-levels low,medium,high \
  --yes

# 3. Apply, then refresh what the Codex App sees, then verify end to end.
codex-local-router service restart
codex-local-router integration sync --yes
codex-local-router model probe --id my-model --live
```

Built-in presets, Provider-specific commands, public examples, and their qualification status are maintained in the [Provider guide](providers.md). Keep the generic configuration reference neutral; a preset does not turn capability metadata into live evidence.

Declarations are validated rather than guessed:

- `--context-window` is required by schema 4. It sizes migration and diagnostics; same-target native compaction remains channel-owned.
- `--compression` states who owns same-target compaction: `native` forwards the channel's opaque checkpoint and defaults compatibility to the same account and target, `summary` explicitly authorizes one lossy Gateway summary, and `unsupported` reports that compaction is unavailable. Native failure never falls back to `summary`. `--native-migration-summary` is an independent, default-off authorization for one source-model summary when a trusted opaque or portable history cannot fit an incompatible destination; it never turns an incomplete lineage into a valid source.
- `--input-modalities` must match the channel. `chat_completions` targets cannot accept images. An image sent to a text-only target is described by a configured source model when one exists, otherwise the request is rejected with `image_migration_unavailable`.
- `--no-tools`, `--no-streaming`, `--freeform-tools`, and `--native-search` (Responses only) keep the declared capabilities honest. `--app-profile standard-tools|lite-search` chooses the App contract. `--search-source subscription|provider|disabled` controls standalone search; `--supports-search-tool`, `--no-supports-search-tool`, `--responses-lite`, and `--no-responses-lite` remain compatibility inputs. Contradictory profile/search/transport combinations are invalid. A chat_completions target cannot declare an App capability profile, `--native-search`, or Provider standalone search.
- `--model-family openai-gpt|other` opts a target into the corresponding default. `--plugin-policy passthrough|third-party-gpt-default|allowlist` selects an explicit policy; `--allowed-plugins` is required with `allowlist`.
- Credentials are never inline. `--credential-prompt` or `--credential-stdin` stores the value in macOS Keychain; `--api-key-env` works for foreground runs, but the managed LaunchAgent does not import Provider credential variables, so Keychain is the reliable choice for a service. Proxy variables and an explicitly configured `NODE_EXTRA_CA_CERTS` path are the only network-boundary exceptions.
- A target appears in the Codex App menu only when it is App-enabled; `--no-app` keeps it routable but hidden and clears target-level App profile, Responses Lite, legacy search, and standalone-search state. An explicitly App-disabled target does not inherit the space-level App search default; that default remains available to other App-enabled targets. App profile/search flags cannot be combined with `--no-app`. `model remove` refuses while a target is selected by `defaultTarget`, `fixedTarget`, or `passthroughTarget`.

Routing stays explicit: `defaultTarget` selects the fallback target for `/v1`, `fixedTarget`/`passthroughTarget` pin an entry point, and `rules` map request models to targets. If these advanced fields are edited in the materialized `config.json`, review the reported drift and run `codex-local-router space capture`; the captured revision then becomes the active authority. A new provider, protocol, or capability declaration is a compatibility boundary: re-run the acceptance harness (`npm run e2e:l1`, see [acceptance harness](acceptance.md)) before depending on it.

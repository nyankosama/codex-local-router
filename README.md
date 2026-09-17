# Codex Local Router

[简体中文](README.zh-CN.md)

Codex Local Router is a local, macOS-first multi-model router for Codex CLI and Codex App. It keeps ChatGPT subscription models on the official subscription backend and sends explicitly configured custom models to their own providers.

Codex Local Router is an independent, unofficial community project. It is not affiliated with, sponsored by, or endorsed by OpenAI.

```text
Codex CLI / App
       |
       v
Codex Local Router (loopback only)
       |-- official GPT models --> ChatGPT subscription backend
       `-- custom model IDs -----> configured third-party providers
```

The router preserves the user's Codex login, keeps subscription and third-party credentials separate, archives cross-model history locally, and provides a reversible subscription rescue path. Versioned configuration spaces keep a provider/model/routing/policy combination together without copying accounts, MCP servers, Skills, Hooks, prompts, or history. It does not modify the Codex binary.

Official subscription traffic uses a dedicated transparent relay. Only an explicitly configured custom model, or a request that must restore router-owned virtual history, enters the model engine. This keeps current and future official auxiliary APIs such as model discovery and standalone search compatible without opening the same identity on `/v1`.

The relay does not enable or disable search. Codex keeps its normal search mode (cached by default, or live when the user selects it), while the router forwards official HTTP and WebSocket traffic through the configured `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `WS_PROXY`, or `WSS_PROXY` environment and honors `NO_PROXY`.

New App-enabled third-party models default to the versioned `codex-general-v1` template when they support Responses, tool calling and freeform tools and their preset is Provider-qualified. It uses a short provider-neutral instruction, Standard Responses, code mode, multi-agent v2 metadata and the standard Plugin allowlist. Incompatible targets use `legacy`; the current OpenCode Go DeepSeek preset is explicitly legacy-only, and existing models never migrate on load. Official GPT instruction snapshots, Lite, search and cache affinity remain opt-in. See [third-party templates](docs/public/third-party-templates.md).

The Plugin allowlist reduces only structured Plugin definitions. Codex built-ins and user-configured MCP servers are retained, and schemas embedded in `exec` documentation remain opaque. This is a context-control policy, not a security sandbox or a guarantee that code mode always sends fewer bytes.

Compatible third-party Responses providers may also opt into anonymous prompt-cache affinity. It applies to `openai-gpt`, or to non-GPT targets that explicitly materialized the generic template; existing providers are never enabled automatically. The router replaces Codex cache/session identity with a provider/model/lineage-scoped HMAC key. A pooled relay may use that opaque key for stable account or cache-shard selection; Gateway-side affinity alone does not guarantee cache hits. See the [cache-affinity contract](docs/public/provider-cache-affinity.md).

When a retained conversation crosses providers, provider-specific dynamic tool-search control items are replaced by a fixed schema-free history marker. Completed function/custom-tool calls and results remain in order, while the original encrypted archive stays unchanged. See [tool-search history migration](docs/public/tool-search-history-migration.md).

## Supported scope

- macOS
- Node.js 22 or later
- Codex CLI and Codex App versions listed in the [compatibility matrix](docs/public/compatibility.md)
- Responses and Chat Completions providers
- ChatGPT subscription routing, OpenCode Go, ai.feei GPT presets, and generic OpenAI-compatible providers

Other operating systems and vendor-specific protocols are not claimed as supported in v0.5.2.

## Install from a GitHub Release

Download the `.tgz` and SHA-256 file from the `v0.5.2` release, verify it, and install it locally:

```bash
shasum -a 256 -c codex-local-router-0.5.2.tgz.sha256
npm install -g ./codex-local-router-0.5.2.tgz
codex-local-router --version
```

`codex-local-router` is the primary executable. The legacy `llm-auto-gateway` name remains available as a compatibility alias.

## Set up

Fresh setup has no personal Provider default. Select a preset explicitly; for example, store an OpenCode Go key in macOS Keychain with hidden terminal input:

```bash
codex-local-router setup --preset opencode-go/deepseek-v4.1-flash --credential-prompt
```

For non-interactive setup, pass the key through stdin; it is never placed in the configuration or command arguments:

```bash
printf '%s' "$OPENCODE_GO_API_KEY" | codex-local-router setup \
  --preset opencode-go/deepseek-v4.1-flash --credential-stdin --yes
```

Environment-variable credential references remain supported for foreground use. The managed LaunchAgent never imports Provider credential variables; it preserves only the proxy variables and `NODE_EXTRA_CA_CERTS` needed to reproduce the installer process's network trust boundary. `doctor` reports credential references and recommends Keychain.

Setup discovers the Codex home, configuration, model catalog, and credential-store setting; creates protected `official@1` and the first `default@1` space; then starts a recoverable activation transaction. If Codex App is running, no Codex or service file is changed: a one-shot switcher waits for a normal App exit, applies the transaction once, and exits. It never force-quits or reopens the App. You can also resume explicitly:

```bash
codex-local-router integration sync
```

Create, inspect, switch, and roll back complete Router combinations:

```bash
codex-local-router space list
codex-local-router space create work --from default --yes
codex-local-router space use work --yes
codex-local-router space diff default work
codex-local-router space rollback --yes
```

Each confirmed Provider, model, route, Plugin, search, compression, or default-model edit creates an immutable revision. Use `--space NAME` to edit a dormant Router space. Manual edits to the active Router-owned fields are reported as drift; review and adopt them with `space capture` instead of allowing a later switch to overwrite them silently.

Routine diagnostics never call a model:

```bash
codex-local-router status
codex-local-router doctor
codex-local-router model list
```

A live model probe is explicit and consumes provider quota:

```bash
codex-local-router model probe --id deepseek --live
```

The built-in `feei/gpt-5.6-sol` and `feei/gpt-6-astra` presets use distinct App model IDs (`feei-gpt-5.6-sol` and `feei-gpt-6-astra`), a conservative 272,000-token configured window, and the third-party GPT Plugin policy. New targets created with the CLI use `standard-tools`; add `--app-profile lite-search` only when independent search is more important than the full Plugin/MCP surface. Existing explicit Responses Lite configurations retain their transport behavior. A legacy Lite target with search disabled remains unprofiled instead of being mislabeled as `lite-search`. The API key must be supplied separately through Keychain or `FEEI_API_KEY`; no credential is included in this project. See the [configuration reference](docs/public/configuration.md).

Eligible third-party GPT targets can pin official catalog base instructions. Standard Responses keeps client delivery; Responses Lite requires the explicit `gateway-lite` mode and a variable-free snapshot. Existing targets never migrate automatically. See [instruction snapshots](docs/public/instruction-snapshots.md).

## Safety and recovery

Codex configuration changes use a managed block and a three-way transaction. Disable removes only fields that still match the router's last managed values, preserving unrelated changes made later.

If the Gateway is unavailable, restore the pre-install subscription settings for new sessions without contacting the Gateway:

```bash
codex-local-router rescue --subscription --yes
```

The rescue command requires Codex App to be closed, restores the permanently retained `official@1`, and stops the Router service without relying on the normal switch coordinator.

History is encrypted with AES-256-GCM. The archive key is stored in macOS Keychain. Encrypted exports require a passphrase; plaintext export must be explicitly requested.

```bash
codex-local-router history export --thread THREAD_ID --output history.clr.json --passphrase-env HISTORY_PASSPHRASE
codex-local-router history inspect --thread THREAD_ID
codex-local-router history recover --thread THREAD_ID --json
```

A direct fork can inherit an exact portable parent checkpoint under the same verified account. Older rollouts can be previewed and explicitly recovered only when their full source chain is losslessly reconstructable; applying recovery requires an App-closed, idle Gateway window. See [fork and compacted-history recovery](docs/public/compaction-recovery.md).

See the [configuration-space guide](docs/public/configuration-spaces.md), [CLI reference](docs/public/cli.md), [configuration reference](docs/public/configuration.md), [architecture](docs/public/architecture.md), [data flow](docs/public/data-flow.md), [open-source maintenance boundary](docs/public/open-source-maintenance-boundaries.md), and the [acceptance harness](docs/public/acceptance.md).

## Compression policy

Codex decides when to compact. The router executes the selected model-channel compression mode and preserves the original archive. It sends full history when the destination can accept it. A lossy source-model summary is allowed once only after an explicit destination context-limit rejection and before any output is observed. Request-body, authentication, quota, and network errors do not trigger summary fallback.

## Development

```bash
npm ci
npm test
npm run audit:package
```

Real provider acceptance is separate from the credential-free test suite and must be explicitly requested. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

The default L0-L2 and capability-profile E2E gates use injected local upstreams and do not read Provider credentials or make external requests. Installed-service and real-channel canaries require an explicit `--run`; see the [acceptance guide](docs/public/acceptance.md).

## License

MIT

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

Third-party GPT targets can use a conservative Plugin allowlist to reduce the large client-supplied Plugin surface. Codex built-ins and user-configured MCP servers are not filtered. Non-GPT and legacy targets remain passthrough unless the user explicitly selects a policy.

## Supported scope

- macOS
- Node.js 22 or later
- Codex CLI and Codex App versions listed in the [compatibility matrix](docs/public/compatibility.md)
- Responses and Chat Completions providers
- ChatGPT subscription routing, OpenCode Go, ai.feei GPT presets, and generic OpenAI-compatible providers

Other operating systems and vendor-specific protocols are not claimed as supported in v0.3.1.

## Install from a GitHub Release

Download the `.tgz` and SHA-256 file from the `v0.3.1` release, verify it, and install it locally:

```bash
shasum -a 256 -c codex-local-router-0.3.1.tgz.sha256
npm install -g ./codex-local-router-0.3.1.tgz
codex-local-router --version
```

`codex-local-router` is the primary executable. The legacy `llm-auto-gateway` name remains available as a compatibility alias.

## Set up

The default setup preset configures OpenCode Go with DeepSeek V4.1 Flash. Store its provider key in macOS Keychain with hidden terminal input:

```bash
codex-local-router setup --credential-prompt
```

For non-interactive setup, pass the key through stdin; it is never placed in the configuration or command arguments:

```bash
printf '%s' "$OPENCODE_GO_API_KEY" | codex-local-router setup --credential-stdin --yes
```

Environment-variable credential references remain supported for foreground use. The managed LaunchAgent does not import shell environment variables; `doctor` reports this and recommends Keychain.

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

The built-in `feei/gpt-5.6-sol` and `feei/gpt-6-astra` presets use distinct App model IDs (`feei-gpt-5.6-sol` and `feei-gpt-6-astra`), standard Responses, a conservative 272,000-token configured window, and the third-party GPT Plugin policy. The API key must be supplied separately through Keychain or `FEEI_API_KEY`; no credential is included in this project. See the [configuration reference](docs/public/configuration.md).

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
```

See the [configuration-space guide](docs/public/configuration-spaces.md), [CLI reference](docs/public/cli.md), [configuration reference](docs/public/configuration.md), [architecture](docs/public/architecture.md), [data flow](docs/public/data-flow.md), and the [acceptance harness](docs/public/acceptance.md).

## Compression policy

Codex decides when to compact. The router executes the selected model-channel compression mode and preserves the original archive. It sends full history when the destination can accept it. A lossy source-model summary is allowed once only after an explicit destination context-limit rejection and before any output is observed. Request-body, authentication, quota, and network errors do not trigger summary fallback.

## Development

```bash
npm ci
npm test
npm run audit:package
```

Real provider acceptance is separate from the credential-free test suite and must be explicitly requested. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

MIT

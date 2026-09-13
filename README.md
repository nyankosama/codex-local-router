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

The router preserves the user's Codex login, keeps subscription and third-party credentials separate, archives cross-model history locally, and provides a reversible subscription rescue path. It does not modify the Codex binary.

## Supported scope

- macOS
- Node.js 22 or later
- Codex CLI and Codex App versions listed in the [compatibility matrix](docs/public/compatibility.md)
- Responses and Chat Completions providers
- ChatGPT subscription routing, OpenCode Go, and generic OpenAI-compatible providers

Other operating systems and vendor-specific protocols are not claimed as supported in v0.2.1.

## Install from a GitHub Release

Download the `.tgz` and SHA-256 file from the `v0.2.1` release, verify it, and install it locally:

```bash
shasum -a 256 -c codex-local-router-0.2.1.tgz.sha256
npm install -g ./codex-local-router-0.2.1.tgz
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

Setup discovers the Codex home, configuration, model catalog, and credential-store setting; shows the configuration diff; writes a recoverable transaction; installs a LaunchAgent; and reports each applied or pending stage. If Codex App is running, integration files are prepared and left pending. Quit the App normally and run:

```bash
codex-local-router integration sync
```

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

## Safety and recovery

Codex configuration changes use a managed block and a three-way transaction. Disable removes only fields that still match the router's last managed values, preserving unrelated changes made later.

If the Gateway is unavailable, restore the pre-install subscription settings for new sessions without contacting the Gateway:

```bash
codex-local-router rescue --subscription
```

History is encrypted with AES-256-GCM. The archive key is stored in macOS Keychain. Encrypted exports require a passphrase; plaintext export must be explicitly requested.

```bash
codex-local-router history export --thread THREAD_ID --output history.clr.json --passphrase-env HISTORY_PASSPHRASE
codex-local-router history inspect --thread THREAD_ID
```

See the [CLI reference](docs/public/cli.md), [configuration reference](docs/public/configuration.md), [architecture](docs/public/architecture.md), [data flow](docs/public/data-flow.md), and the [acceptance harness](docs/public/acceptance.md).

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

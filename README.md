# Codex Local Router

[简体中文](README.zh-CN.md)

[![CI](https://github.com/nyankosama/codex-local-router/actions/workflows/ci.yml/badge.svg)](https://github.com/nyankosama/codex-local-router/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/nyankosama/codex-local-router)](https://github.com/nyankosama/codex-local-router/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Codex Local Router lets macOS Codex CLI and Codex App use ChatGPT subscription models and explicitly configured third-party models side by side. Official models stay on the ChatGPT subscription backend; custom model IDs go only to the Provider you configure.

This is an independent, unofficial community project. It is not affiliated with, sponsored by, or endorsed by OpenAI.

```text
Codex CLI / App
       |
       v
Codex Local Router (loopback only)
       |-- official models --> ChatGPT subscription backend
       `-- custom models ---> configured third-party Provider
```

The Router does not modify the Codex binary. It keeps subscription and Provider credentials separate, manages complete routing configurations as versioned spaces, and retains a direct rescue path back to the original subscription setup.

## Supported scope

- macOS and Node.js 22 or later
- Codex CLI and Codex App
- Transparent ChatGPT subscription routing
- OpenAI-compatible Responses providers
- Chat Completions through a compatibility adapter with JSON function-tool limits
- User-owned MCP tools and an explicit subscription-search bridge for qualified Standard Responses targets

Linux, Windows, unknown vendor-private protocols, and every possible Provider/model combination are not claimed as supported. A built-in preset or configurable endpoint is not the same as live release qualification; see the [compatibility and qualification matrix](docs/public/compatibility.md).

## Install

Download the `.tgz` and matching `.sha256` file from the [latest GitHub Release](https://github.com/nyankosama/codex-local-router/releases/latest). Replace `VERSION` below with the downloaded version:

```bash
shasum -a 256 -c codex-local-router-VERSION.tgz.sha256
npm install -g ./codex-local-router-VERSION.tgz
codex-local-router --version
```

`codex-local-router` is the primary command. `llm-auto-gateway` remains an equivalent compatibility alias.

## Add a Provider

Fresh setup has no personal Provider default. Choose an available preset and enter its key through hidden Keychain input:

```bash
codex-local-router setup --preset PROVIDER/MODEL --credential-prompt
```

Use a real preset name from the [Provider guide](docs/public/providers.md). For a generic OpenAI-compatible endpoint, supply an explicit configuration instead of selecting a preset. Credentials can also be read from stdin; they are never placed in command arguments or configuration JSON.

Setup creates protected `official@1` and the first Router space. If Codex App is running, the change stays pending until the App exits normally; the Router never force-quits or reopens it.

## Verify and switch

These commands do not call a model:

```bash
codex-local-router status
codex-local-router doctor
codex-local-router model list
```

Configuration spaces keep Provider, model, routing, search, Plugin, compression, and default-model choices together:

```bash
codex-local-router space list
codex-local-router space create work --from default --yes
codex-local-router space use work --yes
codex-local-router space diff default work
codex-local-router space rollback --yes
```

Only an explicit live probe consumes Provider quota:

```bash
codex-local-router model probe --id TARGET_ID --live
```

## Return to the official subscription

If the Router is unavailable, close Codex App and restore the permanently retained official configuration without contacting the Gateway:

```bash
codex-local-router rescue --subscription --yes
```

This stops the Router service and restores `official@1`. It does not delete Provider configuration, encrypted history, MCP servers, Skills, Hooks, prompts, or conversations.

## Data and security boundary

- Official subscription credentials are sent only to the fixed ChatGPT backend.
- Provider keys are sent only to their configured Provider origin.
- `/v1` requests cannot borrow subscription identity.
- The service listens on loopback and protects raw local API access with a token.
- Router history is encrypted with AES-256-GCM; its key is stored in macOS Keychain.
- User MCP configuration and credentials remain owned by Codex and are not copied into configuration spaces.
- Conversation content sent to a third-party model is governed by that Provider's data policy.

See [architecture](docs/public/architecture.md), [data flow](docs/public/data-flow.md), and [SECURITY.md](SECURITY.md) for the complete boundary.

## Documentation

Start with the [documentation index](docs/public/README.md). It separates user guides, Provider/integration references, maintainer material, and frozen historical evidence.

Common entry points:

- [Provider setup and qualification](docs/public/providers.md)
- [Configuration spaces](docs/public/configuration-spaces.md)
- [Search for third-party models](docs/public/universal-search.md)
- [CLI reference](docs/public/cli.md)
- [Troubleshooting and recovery](docs/public/compaction-recovery.md)
- [Compatibility and qualification](docs/public/compatibility.md)

## Development

```bash
npm ci
npm test
npm run audit:package
```

Credential-free deterministic tests are separate from explicitly authorized real-channel acceptance. See [CONTRIBUTING.md](CONTRIBUTING.md) and the [release qualification policy](docs/public/acceptance.md).

## License

MIT

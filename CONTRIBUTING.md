# Contributing

Codex Local Router changes must preserve the routing and credential boundaries described in the [architecture](docs/public/architecture.md).

1. Create a focused branch.
2. Run `npm ci`, `npm test`, and `npm run audit:package`.
3. Describe the trigger, resulting behavior, compatibility impact, and validation in the pull request.
4. Keep real-account or paid-Provider checks separate from the default suite.

Never commit credentials, Codex rollout files, local configuration, databases, private-conversation screenshots, raw request or response bodies, search results, runner configuration, or rollback packages.

## Documentation rules

- Write README and current documentation for users or integrators. Keep implementation detail only when it defines a public contract or limitation.
- Keep English and Simplified Chinese files in sync under `docs/public/`.
- Use the same support vocabulary everywhere: `Preset available`, `Configuration supported`, `Deterministic tested`, `Live release-qualified`, and `App UI confirmed`.
- Put release-specific client versions, hashes, budgets, channel results, and dated experiments in Release Notes or `docs/public/evidence/`, not evergreen guidance.
- Mark evidence as frozen with its applicable version. Do not link frozen evidence from the normal user journey as if it described current state.
- Use neutral examples in configuration references. Provider-specific instructions belong in the [Provider guide](docs/public/providers.md).

See the [documentation index](docs/public/README.md), [release qualification policy](docs/public/acceptance.md), and [public maintenance boundary](docs/public/open-source-maintenance-boundaries.md).

New providers that reuse an existing protocol should normally be configuration-only. Add an adapter only for protocol, authentication, session, or error-classification behavior that cannot be expressed safely in configuration. Capability declarations require matching deterministic tests; public live-support claims require redacted live evidence.

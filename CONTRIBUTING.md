# Contributing

Codex Local Router changes must preserve the routing and credential boundaries described in `docs/public/architecture.md`.

1. Create a focused branch.
2. Run `npm ci` and `npm test`.
3. Run `npm run audit:package` before opening a pull request.
4. Describe the trigger, resulting behavior, compatibility impact, and validation.

Tests that need real accounts or paid providers must stay separate from the default suite. Never commit credentials, Codex rollout files, local configuration, databases, screenshots of private conversations, or raw provider response bodies.

New providers that reuse an existing protocol should normally be configuration-only. Add an adapter only for protocol, authentication, session, or error-classification behavior that cannot be expressed safely in configuration. Capability declarations require matching tests; public support claims require redacted live acceptance evidence.

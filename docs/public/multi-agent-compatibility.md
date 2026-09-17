# Third-party multi-agent compatibility

`codex-general-v1` directly configures multi-agent v2 metadata for eligible third-party Responses targets:

```sh
codex-local-router model edit --id TARGET --multi-agent-version v2 --space SPACE
codex-local-router model edit --id TARGET --multi-agent-version client-default --space SPACE
```

Official metadata snapshots remain an optional exact-compatibility path.

Explicitly pin the matching official model's Codex multi-agent capability metadata:

```sh
codex-local-router model sync-multi-agent --ids feei-sol,feei-astra --space default --yes --json
codex-local-router model edit --id TARGET --multi-agent-from OFFICIAL_MODEL --space SPACE
codex-local-router model edit --id TARGET --multi-agent-from none --space SPACE
```

Without `--yes`, configuration writes are previews. Batch synchronization is atomic and content-idempotent. `none` removes the managed metadata; it does not disable Codex agents. Use Codex's own agent settings to disable them. Existing configurations do not migrate automatically.

Direct configuration requires an App-enabled third-party Responses target with tool calling. Official source lookup remains exact; it uses no provider-name heuristic or fallback to another model.

`app.multiAgent` records source/upstream models, snapshot version, client version, timestamp, catalog hash, capability hash and exactly `multi_agent_version` plus optional `multi_agent_reasoning_effort`. Absent fields remain absent. The shared catalog projector uses the saved snapshot, not a fresh source lookup on each request. Source updates are reported by list/probe/status/doctor; explicit synchronization creates a space revision. Snapshots participate in drift detection and rollback.

Codex creates the collaboration tools and runtime instructions. Gateway adds no multi-agent prompt, scheduler, automatic model substitution, or higher concurrency limit. User model/effort/role, permission, delegation and disable settings remain authoritative. A child inheriting its parent must retain the third-party model alias; an explicitly selected official model stays official. No changes to Plugin allowlists, MCP, Skills, Hooks, defaults, search or cache policies are implied.

Multi-agent work adds tool/role context and separate child generations. Capability parity does not promise identical decomposition, wording, latency or cost. Current-client protocol qualification and live parent/child qualification are separate from App UI acceptance. Do not activate a candidate until its receipt proves these gates passed. Use new tasks for UI checks; existing task history is not rewritten.

Prepare activation only after isolated qualification. Close App before installation, preserve the exact prior package and space, and verify both Codex selected model and space default. Emergency recovery after closing App: `codex-local-router rescue --subscription --yes`.

# Third-party model templates

`codex-general-v1` is the default for newly created App-enabled third-party models. It requires Responses, tool calling and freeform tools, then materializes these fields into the target's immutable configuration-space revision:

- the short, provider-neutral `codex-generic-v1` base instruction;
- Standard Responses with standalone search disabled;
- `code_mode_only` and configured multi-agent v2 capability metadata;
- the standard Plugin allowlist (`github`, `figma`, `sites`, `connected_documents`).

The template does not change context windows, image support, reasoning levels, compression, credentials, the space default model or the model currently selected in Codex. Codex remains authoritative for whether agents are enabled, their permissions, explicit roles/models/effort and concurrency. Loading or upgrading an old configuration never reapplies a template.

```bash
codex-local-router space set-third-party-template codex-general-v1 --space default
codex-local-router model apply-template --ids compatible-target \
  --template codex-general-v1 --space default
```

Use `--template legacy` when creating a Chat Completions model or a target without freeform tools. It is an explicit compatibility choice; the router does not silently downgrade an incompatible generic target. Applying `legacy` to an existing target is a no-op and does not delete user settings.

Provider qualification can be narrower than a preset's static capability metadata. The current `opencode-go/deepseek-v4.1-flash` preset is legacy-only: its accepted path remains available, but `codex-general-v1`, direct Code mode and direct multi-agent metadata fail closed. Default setup and a new target using that preset select `legacy` without changing the space's creation default. Requalify the preset only after the Provider accepts the real Codex Responses/freeform payload; a model-list entry is not sufficient evidence.

Base-instruction sources are mutually exclusive. New generic targets use the bundled provider-neutral text; users may instead select `--instructions-template codex-generic-v1`, `--instructions-file FILE`, or the existing `--instructions-from OFFICIAL_MODEL`. Official snapshots are optional and are never inferred from a provider name. `gateway-lite` remains an explicit transport adapter for pinned managed instructions.

Direct multi-agent configuration uses `--multi-agent-version v1|v2|client-default`. `client-default` removes target metadata; it does not override a user's global agent setting. The official snapshot commands remain available when exact official model metadata is desired.

Code mode only filters structured Plugin definitions. Tool definitions already embedded in `exec` documentation remain opaque, so diagnostics report `structured-only; embedded-exec-opaque`. Before activation, compare the same client and tool inventory; the first-request increase must stay within `max(8 KiB, 10% of control)` and tool definitions must not grow across continuations.

The compatibility harness uses the current App-bundled Codex binary, synthetic local inputs and a loopback Provider. Live qualification is a separate, explicitly budgeted gate; App-server evidence is not App UI sign-off.

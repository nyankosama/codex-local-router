# Official instruction snapshots

Codex Local Router can explicitly pin matching official catalog instruction fields to a versioned third-party Responses target. A snapshot represents the client-visible base instructions at capture time. It does **not** make provider-side processing, the complete runtime context, or answer style identical to an official subscription.

## Delivery modes

`app.instructionDelivery` has two modes:

- `client` (default): Codex reads the snapshot from the generated catalog. Standard Responses uses this path and the Router does not add instructions to the request.
- `gateway-lite`: for an explicitly enabled third-party, App-visible, Responses Lite target with a valid managed instruction source, the Router inserts the pinned text as one developer input after leading `additional_tools` and before ordinary input messages. Model family is not an admission rule.

Official subscription requests remain transparent. `/v1`, non-Lite requests and internal summaries are not rewritten. Existing targets do not migrate automatically.

```sh
# Preview one target.
codex-local-router model edit --id vendor-sol \
  --instructions-from gpt-5.6-sol \
  --instruction-delivery gateway-lite

# Atomically sync and enable both existing ai.feei targets in one space revision.
codex-local-router model sync-instructions \
  --ids feei-sol,feei-astra --space default \
  --instruction-delivery gateway-lite --json

# Apply only after reviewing the preview and closing Codex App.
codex-local-router model sync-instructions \
  --ids feei-sol,feei-astra --space default \
  --instruction-delivery gateway-lite --yes --json

# Disable inherited delivery and remove only inheritance-owned text.
codex-local-router model edit --id vendor-sol --instructions-from none
```

`gateway-lite` requires a valid pinned snapshot. It prefers a nonempty `instructions_template`, otherwise `base_instructions`. Nonempty `instructions_variables` are rejected because the Router does not guess runtime personality values. `persistent_instructions` remains versioned but is not unconditionally injected.

Injection is computed from the unmodified request for each destination view and is never written back to archived input or history. Re-adaptation and tool continuation are idempotent. An exact existing carrier is reused; a conflicting top-level instruction returns `instruction_delivery_conflict` without retry or fallback. Ordinary developer messages are preserved and are not classified by their text. Snapshot bytes are included before context-budget and compression decisions. Logs contain only mode, source, hashes, sizes and result type.

## Snapshot lifecycle and authority

Official snapshots are optional. New eligible targets use the generic template unless an official source is explicitly selected with `--instructions-from`; loading, preset expansion and service startup never capture or refresh a snapshot. Source matching is exact and never substitutes another model.

`app.instructionSource` distinguishes `official-snapshot`, `builtin-template`, `custom` and `none`. Text is stored only in the existing instruction fields; no official instruction text is bundled in this repository or package. Official snapshots still copy only the documented instruction fields, never approvals, tools, multi-agent policy, token budgets or transport capabilities.

Snapshots live in immutable configuration-space revisions. Catalog updates only report an available refresh; explicit synchronization creates a revision, while identical content remains idempotent. Historical activation uses the saved snapshot. Batch synchronization resolves every target before one atomic commit. Changing the upstream model invalidates the old mapping. Unmanaged custom instructions are never overwritten, and a snapshot content/metadata mismatch fails validation.

`model list/probe`, `status` and `doctor` show source, delivery mode, hashes, status and update availability without printing instruction text. CLI revision views and diffs show instruction field names, byte counts and hashes. Local configuration still contains the snapshot text and must remain private. Gateway/configuration-space/integration schema versions are 4/1/4.

Enabling `gateway-lite` fails when the current managed Codex configuration or selected profile has an observable `model_instructions_file` override. `AGENTS.md`, user prompts and additional developer messages are not conflicts. A temporary command-line override that never reaches the Router cannot be detected; use `client` delivery for that case.

For an instruction-only update to the active revision of the same Router space, the switch transaction preserves both the existence/value of Codex's current top-level `model` and the separate space default model. Normal explicit switches to a different space keep the target space's existing default-model semantics.

## Compatibility evidence

`node scripts/e2e/instruction-inheritance.mjs` is a loopback-only compatibility gate. It uses synthetic catalog text and login state, temporary HOME/CODEX_HOME/XDG roots, a random port, and the current App-bundled Codex binary. It makes zero external model calls and does not read personal instructions or history.

On Codex `0.154.0-alpha.6.2` (binary SHA-256 `a1d2f191e70023ed7afd619bc70530f26067a085926e03bae50cf5c0f8298bcf`), CLI and app-server produced this result:

| Catalog/provider path | Standard Responses | Responses Lite |
|---|---|---|
| Official model, `openai` provider | Template sent once | Client wire omitted the template (control observation) |
| Raw model ID, custom provider | Template sent once | Template sent once |
| Router alias with pinned snapshot | Template sent once | `gateway-lite` inserted the same template once |

All non-control delivered paths matched synthetic instruction hash `d3066106c80edcb8a8c2e86ba34c0e79a09ebfa2059f5c805a83bd2f40d39d40`. AGENTS.md and user markers survived, and persistent instructions were absent as required. The official Lite omission is only a client-wire observation; it does not imply that the official service lacks server-side instructions.

The earlier catalog-only Lite failure remains historical evidence. The explicit adapter now passes the deterministic compatibility gate and 359-test regression suite. Live Sol/Astra comparison, App protocol generations, local installation and App UI sign-off are separate gates and are not implied by this result.

Source maintainers may use `scripts/maintainer/instruction-snapshot-activate.mjs` and its rollback command after explicitly naming every target. They require Codex App to be closed, zero active turns/WebSockets, no pending transaction or drift, and unchanged source/package hashes. These tools are not shipped in the npm package; preserve any older rollback entry first with the recovery workflow in the [maintenance boundary](open-source-maintenance-boundaries.md). Emergency recovery remains `codex-local-router rescue --subscription --yes` from a separate terminal after closing the App.

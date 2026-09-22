# Configuration spaces

A configuration space is a versioned Router profile. It groups providers, models, the third-party creation template, the default model, routing, Plugin policy, search, compression, and subscription-routing settings so a complete working combination can be inspected, cloned, switched, and rolled back as one unit.

It is not a separate Codex account or sandbox. Listener and access settings, encrypted history, request limits, user MCP servers, Skills, Hooks, prompts, and conversations remain machine- or Codex-level data and are not copied into a space.

```text
machine settings (shared)
  + official@REV (protected direct-subscription projection)
  + default@REV  (Router providers, models, and policies)
  + work@REV     (another Router combination)
          |
          `-- one active reference; at most one pending switch
```

## Initialize safely

`setup` initializes spaces as part of its confirmed transaction. Existing installations can initialize explicitly:

```bash
codex-local-router space init
codex-local-router space current
codex-local-router space list
```

The first trusted official projection becomes the permanently retained `official@1`. An existing Router installation is imported as `default@1`. If the current state is ambiguous—for example, a customized Codex configuration has no trusted official baseline—initialization fails closed instead of guessing what to restore.

`official` is reserved and cannot be deleted, renamed, or edited with Provider/model commands. Before leaving the current official state, the Router compares its managed Codex fields and appends another immutable official revision when those settings changed. `official@1` is never replaced.

## Create and edit a combination

Clone an existing space, inspect the result, then edit the dormant copy:

```bash
codex-local-router space create work --from default --yes
codex-local-router provider add --space work --id my-provider \
  --base-url https://api.example.com/v1 --credential-prompt --yes
codex-local-router model add --space work --id my-model \
  --provider my-provider --upstream-model upstream-model \
  --protocol responses --context-window 200000 \
  --input-modalities text --compression unsupported --yes
codex-local-router space set-default-model my-model --space work --yes
codex-local-router space diff default work
```

Each confirmed Provider, model, route, Plugin, search, compression, or default-model change creates a new immutable revision only when content changed. Editing a dormant space appends a revision without changing the active installation. Choosing another model temporarily in Codex does not create a revision.

The standalone-search default is part of the revision and drift boundary:

```bash
codex-local-router space set-search-source subscription --space work --yes
```

Per-target overrides and Provider search endpoints are versioned with the target/Provider. This never copies a search query, result, ChatGPT token, or Provider key into the space.

Only credential references are versioned. Hidden input stores a Provider secret in macOS Keychain; the revision contains its service/account reference, not the secret. Environment references store only the variable name.

## Switch without interrupting Codex App

```bash
codex-local-router space use work --yes
codex-local-router status
```

The switch validates the target and its credential references, preflights it on a random loopback port, and binds a transaction to source and target hashes. If Codex App is running, the command records only the pending transaction. It does not change Codex configuration, restart the Router, force-quit the App, or reopen it.

A one-shot `com.nyankosama.codex-local-router.space-switcher` LaunchAgent waits for a normal App exit, drains active Router turns, applies and verifies the exact transaction once, commits the active/previous pointers last, then exits. It has `KeepAlive=false`.

Inspect or control the transaction explicitly:

```bash
codex-local-router space current
codex-local-router space resume
codex-local-router space cancel --yes
```

`resume` retries the same hash-bound target. A different target, changed source file, changed revision, or a second pending transaction is rejected. `cancel` removes a not-yet-applied transaction, or one whose failed application was already restored; it does not discard unresolved recovery material.

## History, rollback, and drift

```bash
codex-local-router space history work
codex-local-router space show work@2
codex-local-router space use work@2 --yes
codex-local-router space rollback --yes
```

Omitting `@REV` selects the latest revision. A historical reference selects that exact immutable content. `rollback` returns to the previous successful activation reference; it is not equivalent to subtracting one from the current revision number.

Manual edits to Router-owned fields in the active materialized `config.json` are reported as drift. Switching then stops rather than overwriting those edits. After reviewing and validating the change, adopt it explicitly:

```bash
codex-local-router space current
codex-local-router space capture
```

`space capture [NAME]` creates an immutable revision from validated Router-space fields. Machine-global fields remain outside that revision.

## Return to the official subscription

The normal path is a transactional switch:

```bash
codex-local-router space use official --yes
```

The Router service must not run while `official` is active. If normal coordination is unavailable, close Codex App and use the independent escape path:

```bash
codex-local-router rescue --subscription --yes
```

Rescue restores the permanently retained `official@1` and stops the service without contacting the Router. It deliberately requires the App to be closed.

## What a space never contains

- ChatGPT subscription tokens or `auth.json`;
- plaintext Provider credentials;
- user-configured MCP servers, Skills, Hooks, or prompts;
- conversation history or encrypted-history keys;
- machine listener, access, history-storage, connection, request-size, or timeout settings.

Use `codex-local-router status --json` and `doctor --json` for automation. They report the active and pending references, latest revision, drift, default model, and coordinator state without calling a model.

See the [CLI reference](cli.md) for every command and the [configuration reference](configuration.md) for schema and policy details.

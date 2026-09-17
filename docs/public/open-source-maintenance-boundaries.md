# Open-source maintenance boundaries

Codex Local Router keeps one public repository, but not every operational artifact belongs in source control or the npm package.

```text
public repository  -> product code, tests, CI, public docs, maintainer source tools
npm package        -> runtime code, public CLI, deterministic tests and packaged harness
local Router data  -> config spaces, integration state, encrypted history, evidence
private operations -> credentials, raw acceptance data, rollout state and recovery bundles
```

`package.json.files` is the runtime-package authority. Public source export starts from the real `npm pack --dry-run --ignore-scripts --json` result, adds tests, CI, contribution material and source-maintainer tools, then validates every selected file. It rejects path escape, selected symlinks, authentication/config/history/backup files, raw evidence, internal acceptance records and credential-shaped content. Neither export nor audit deletes or reuses a destination containing data or `.git`.

Acceptance output defaults to the Router data directory under `evidence/`; `--out` may select another private directory but cannot point inside the source checkout. Historical tracked evidence is not rewritten from Git history. Maintainers may run `node scripts/audit-public-history.mjs [REF]` for a metadata-only report of suspect path/content categories; findings require human review and credential revocation when applicable.

Fresh setup requires an explicit preset, or an already complete config through `--config`. Public examples use neutral IDs. Provider-specific presets and examples are conveniences, not project-owned credentials, endorsements or proof of live compatibility. Existing configurations and immutable spaces are not migrated merely because these public defaults changed.

Feature-specific activation and rollback tools live in `scripts/maintainer/` and require explicit provider/target IDs. They are public source tools, not installed CLI promises. Before upgrading an old global package referenced by a saved rollback state, create an independent recovery entry:

```bash
node scripts/maintainer/prepare-legacy-recovery.mjs \
  --installed-root /absolute/path/to/old/codex-local-router \
  --state /absolute/path/to/rollback.json \
  --rollback-script cache-affinity-rollback \
  --out /absolute/private/path/recovery

node scripts/maintainer/prepare-legacy-recovery.mjs \
  --verify /absolute/private/path/recovery
```

Use the rollback command recorded in `manifest.json`. The bundle copies only `package.json`, runtime source, scripts and installed dependencies; it never copies Codex authentication, Router history or a user data directory. Hash changes in either the copied runtime or rollback state invalidate verification. The permanent emergency escape remains:

```bash
codex-local-router rescue --subscription --yes
```

Tests inject App and service substitutes through test-only launchers. Production entry points ignore historical test environment switches. If process inspection cannot determine whether Codex App is running, read-only status reports `appRunning: null`; installation, switching and recovery operations fail closed.

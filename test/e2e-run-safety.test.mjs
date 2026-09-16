import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const projectRoot = resolve(import.meta.dirname, "..");

test("A10 live E2E fails closed without explicit --run confirmation", async (t) => {
  const output = await mkdtemp(join(tmpdir(), "router-live-e2e-guard-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  await assert.rejects(
    exec(process.execPath, [
      "scripts/e2e/run.mjs",
      "--group", "live",
      "--out", output,
    ], { cwd: projectRoot }),
    (error) => error.code === 2 && /requires an explicit --run/.test(error.stderr),
  );
});

test("A10 default E2E selects synthetic inputs and reserves real inputs for explicit live cases", async () => {
  const source = await readFile(join(projectRoot, "scripts/e2e/run.mjs"), "utf8");
  assert.match(source, /writeDeterministicCodexInputs\(fixtureRoot\)/);
  assert.match(source, /spec\.group === "live" \? realAuthSource : fixtureInputs\.authPath/);
  assert.match(source, /spec\.group === "live" \? realCatalogSource : fixtureInputs\.catalogPath/);
  assert.match(source, /spec\.group !== "live" \|\| INCLUDE_LIVE/);
});

test("A10 profile qualification defaults to synthetic identity, catalog and Provider configuration", async () => {
  const source = await readFile(join(projectRoot, "scripts/e2e/profile-qualification.mjs"), "utf8");
  assert.match(source, /writeDeterministicCodexInputs\(join\(root, "codex-inputs"\)\)/);
  assert.match(source, /config\.providers = \{/);
  assert.match(source, /config\.targets = \{/);
  assert.doesNotMatch(source, /join\(homedir\(\), "\.codex"/);
});

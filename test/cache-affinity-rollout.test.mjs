import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  argsOf,
  assertExpected,
  assertQuiescent,
  cacheModes,
  instructionModes,
} from "../scripts/maintainer/cache-affinity-rollout-lib.mjs";
import {
  prepareLegacyRecovery,
  verifyRecoveryBundle,
} from "../scripts/maintainer/prepare-legacy-recovery.mjs";

const current = () => ({
  configSha256: "config-hash",
  spaceRef: "default@5",
  space: { pending: null, drift: false },
  status: {
    integration: { appRunning: false, pending: false },
    service: {
      running: true,
      health: { activeTurns: 0, websocketConnections: 0 },
    },
    promptCaching: [
      { target: "feei-sol", mode: "none" },
      { target: "feei-astra", mode: "gateway-opaque" },
    ],
    instructions: [
      { target: "feei-sol", delivery: "client", status: "pinned", contentHash: "a".repeat(64) },
      { target: "feei-astra", delivery: "gateway-lite", status: "pinned", contentHash: "b".repeat(64) },
    ],
  },
});

test("cache-affinity rollout arguments and quiescent guards fail closed", () => {
  const args = argsOf(["--package", "candidate.tgz", "--yes"]);
  assert.equal(args.value("package"), "candidate.tgz");
  assert.equal(args.value("yes"), true);
  assert.doesNotThrow(() => assertQuiescent(current()));
  for (const mutate of [
    (value) => { value.status.integration.appRunning = true; },
    (value) => { value.space.pending = {}; },
    (value) => { value.space.drift = true; },
    (value) => { value.status.service.health.activeTurns = 1; },
    (value) => { value.status.service.health.websocketConnections = 1; },
  ]) {
    const value = current();
    mutate(value);
    assert.throws(() => assertQuiescent(value));
  }
});

test("cache-affinity rollout binds exact space, config and target modes", () => {
  const value = current();
  assert.doesNotThrow(() => assertExpected(value, {
    spaceRef: "default@5",
    configSha256: "config-hash",
  }));
  assert.throws(() => assertExpected(value, {
    spaceRef: "default@6",
    configSha256: "config-hash",
  }));
  assert.deepEqual(cacheModes(value.status, ["feei-sol", "feei-astra"]), {
    "feei-sol": "none",
    "feei-astra": "gateway-opaque",
  });
  assert.deepEqual(instructionModes(value.status, ["feei-sol", "feei-astra"]), {
    "feei-sol": { delivery: "client", status: "pinned", contentHash: "a".repeat(64) },
    "feei-astra": { delivery: "gateway-lite", status: "pinned", contentHash: "b".repeat(64) },
  });
});

test("legacy recovery preparation copies only runtime code and rejects changed recovery inputs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "legacy-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installed = join(root, "installed"), output = join(root, "recovery");
  const state = join(root, "rollback.json");
  await mkdir(join(installed, "scripts"), { recursive: true });
  await mkdir(join(installed, "src"));
  await mkdir(join(installed, "node_modules", "fixture"), { recursive: true });
  await mkdir(join(installed, "node_modules", ".bin"));
  await mkdir(join(installed, "docs"));
  await writeFile(join(installed, "package.json"), JSON.stringify({ name: "codex-local-router", version: "0.5.0" }));
  await writeFile(join(installed, "scripts", "cache-affinity-rollback.mjs"), "console.log('rollback');\n");
  await writeFile(join(installed, "src", "runtime.mjs"), "export default true;\n");
  await writeFile(join(installed, "node_modules", "fixture", "index.js"), "module.exports = true;\n");
  await symlink("../fixture/index.js", join(installed, "node_modules", ".bin", "fixture"));
  await writeFile(join(installed, "auth.json"), "must-not-copy\n");
  await writeFile(join(installed, "docs", "readme.md"), "not runtime\n");
  await writeFile(state, JSON.stringify({ schemaVersion: 1 }));
  const manifest = await prepareLegacyRecovery({
    installedRoot: installed,
    statePath: state,
    rollbackScript: "cache-affinity-rollback",
    output,
  });
  assert.ok(manifest.files.some((entry) => entry.path === "src/runtime.mjs"));
  assert.ok(manifest.files.some((entry) => entry.path === "node_modules/fixture/index.js"));
  assert.equal(manifest.files.some((entry) => entry.path.startsWith("node_modules/.bin/")), false);
  assert.equal(await access(join(output, "package", "auth.json")).then(() => true, () => false), false);
  assert.equal(await access(join(output, "package", "docs", "readme.md")).then(() => true, () => false), false);
  await verifyRecoveryBundle(output);
  await symlink("fixture", join(installed, "node_modules", "linked-fixture"));
  await assert.rejects(prepareLegacyRecovery({
    installedRoot: installed,
    statePath: state,
    rollbackScript: "cache-affinity-rollback",
    output: join(root, "unsafe-recovery"),
  }), /symbolic link/);
  await writeFile(state, JSON.stringify({ schemaVersion: 2 }));
  await assert.rejects(verifyRecoveryBundle(output), /rollback state changed/);
  await writeFile(join(output, "package", "src", "runtime.mjs"), "tampered\n");
  await assert.rejects(verifyRecoveryBundle(output), /hash mismatch/);
  assert.equal(JSON.parse(await readFile(join(output, "manifest.json"))).packageVersion, "0.5.0");
});

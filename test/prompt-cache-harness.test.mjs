import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const exec = promisify(execFile);
const harness = resolve("scripts/e2e/prompt-cache-affinity.mjs");

test("prompt cache harness defaults to a zero-network deterministic performance gate", async () => {
  const { stdout } = await exec(process.execPath, [harness]);
  const result = JSON.parse(stdout);
  assert.equal(result.mode, "deterministic");
  assert.equal(result.networkCalls, 0);
  assert.equal(result.passed, true);
  assert.ok(result.derivationP95Ms < 5);
  assert.ok(result.adaptationP95Ms < 25);
  assert.ok(result.wireDeltaBytes < 128);
});

test("all prompt cache live modes fail closed without explicit run confirmation", async () => {
  for (const mode of [
    "--live-feasibility",
    "--live-gateway",
    "--live-app-protocol",
    "--live-comparison",
    "--live-app-candidate",
  ]) {
    await assert.rejects(
      exec(process.execPath, [harness, mode], {
        env: {
          ...process.env,
          FEEI_API_KEY: "must-not-be-used",
          CODEX_SUBSCRIPTION_TOKEN: "must-not-be-used",
        },
      }),
      /add --run/,
    );
  }
});

test("prompt cache live comparison reuses the current Codex Provider shape", async () => {
  const { stdout } = await exec(process.execPath, [harness, "--shape-preflight"], {
    timeout: 120000,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.mode, "shape-preflight");
  assert.equal(result.externalNetworkCalls, 0);
  assert.equal(result.clientProviderShapeCaptured, true);
  assert.equal(result.liteFrameMetadata, true);
  assert.equal(result.candidateLiteHeader, true);
  assert.equal(result.compatibilityHeadersObserved, true);
  assert.equal(result.compatibilityHeadersPreserved, true);
  assert.equal(result.clientMetadataRemoved, true);
  assert.equal(result.anonymousKeyApplied, true);
  assert.equal(result.inputPreserved, true);
  assert.equal(result.toolsPreserved, true);
  assert.equal(result.passed, true);
});

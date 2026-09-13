import test from "node:test";
import assert from "node:assert/strict";
import { resolve, sep } from "node:path";
import { dataDir, runtimePaths } from "../src/product.mjs";

const isInside = (parent, child) => {
  const root = resolve(parent);
  const candidate = resolve(child);
  return candidate === root || candidate.startsWith(`${root}${sep}`);
};

test("npm test isolates the complete test process tree from user runtime data", () => {
  const testRoot = process.env.CODEX_LOCAL_ROUTER_TEST_ROOT;
  assert.ok(testRoot, "tests must run through scripts/run-tests.mjs");
  assert.equal(isInside(testRoot, process.env.CODEX_HOME), true);
  assert.equal(isInside(testRoot, process.env.CODEX_LOCAL_ROUTER_HOME), true);
  assert.equal(isInside(testRoot, process.env.GATEWAY_STATE_PATH), true);
  assert.match(process.env.GATEWAY_INSTANCE_ID ?? "", /^test-/);
  assert.equal(isInside(testRoot, dataDir()), true);
  assert.equal(isInside(testRoot, runtimePaths().serviceState), true);
});

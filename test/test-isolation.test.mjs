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
  assert.equal(isInside(testRoot, process.env.HOME), true);
  assert.equal(isInside(testRoot, process.env.CODEX_HOME), true);
  assert.equal(isInside(testRoot, process.env.XDG_CONFIG_HOME), true);
  assert.equal(isInside(testRoot, process.env.XDG_CACHE_HOME), true);
  assert.equal(isInside(testRoot, process.env.XDG_DATA_HOME), true);
  assert.equal(isInside(testRoot, process.env.XDG_STATE_HOME), true);
  assert.equal(isInside(testRoot, process.env.XDG_RUNTIME_DIR), true);
  assert.equal(isInside(testRoot, process.env.XDG_CONFIG_DIRS), true);
  assert.equal(isInside(testRoot, process.env.XDG_DATA_DIRS), true);
  assert.equal(isInside(testRoot, process.env.TMPDIR), true);
  assert.equal(isInside(testRoot, process.env.TMP), true);
  assert.equal(isInside(testRoot, process.env.TEMP), true);
  assert.equal(isInside(testRoot, process.env.CODEX_LOCAL_ROUTER_HOME), true);
  assert.equal(isInside(testRoot, process.env.GATEWAY_STATE_PATH), true);
  assert.match(process.env.GATEWAY_INSTANCE_ID ?? "", /^test-/);
  assert.equal(isInside(testRoot, dataDir()), true);
  assert.equal(isInside(testRoot, runtimePaths().serviceState), true);
  for (const name of [
    "OPENAI_API_KEY", "FEEI_API_KEY", "OPENCODE_GO_API_KEY", "TAVILY_API_KEY", "EXA_API_KEY",
    "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "NODE_AUTH_TOKEN", "LOCAL_PROXY_KEY",
    "DEEPSEEK_API_KEY", "OPENCODE_API_KEY", "CODEX_CONFIG_PATH", "CODEX_MODEL_CATALOG_SOURCE",
    "GATEWAY_CONFIG", "SSH_AUTH_SOCK", "CODEX_APP_TOOLS_PIPE_PATH", "NODE_EXTRA_CA_CERTS",
  ]) assert.equal(name in process.env, false, `${name} must not cross into npm test`);
});

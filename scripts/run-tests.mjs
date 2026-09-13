#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const testRoot = await mkdtemp(join(tmpdir(), "codex-local-router-test-"));
const testFiles = (await readdir(join(projectRoot, "test")))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => join("test", name));
const env = {
  ...process.env,
  CODEX_HOME: join(testRoot, "codex-home"),
  CODEX_LOCAL_ROUTER_HOME: join(testRoot, "router-home"),
  CODEX_LOCAL_ROUTER_CONFIG: join(testRoot, "router-home", "config.json"),
  CODEX_LOCAL_ROUTER_LAUNCH_AGENT: join(testRoot, "LaunchAgents", "router.plist"),
  CODEX_LOCAL_ROUTER_SPACE_SWITCHER_LAUNCH_AGENT: join(testRoot, "LaunchAgents", "space-switcher.plist"),
  CODEX_LOCAL_ROUTER_TEST_LAUNCHCTL: "1",
  CODEX_APP_RUNNING: "0",
  CODEX_LOCAL_ROUTER_TEST_ROOT: testRoot,
  GATEWAY_STATE_PATH: join(testRoot, "gateway-state.json"),
  GATEWAY_INSTANCE_ID: `test-${process.pid}-${Date.now()}`,
};

try {
  const child = spawn(process.execPath, ["--test", ...testFiles], {
    cwd: projectRoot,
    env,
    stdio: "inherit",
  });
  const result = await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
  if (result.signal) {
    process.kill(process.pid, result.signal);
  } else {
    process.exitCode = result.code ?? 1;
  }
} finally {
  await rm(testRoot, { recursive: true, force: true });
}

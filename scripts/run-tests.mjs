#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const testRoot = await mkdtemp(join(tmpdir(), "codex-local-router-test-"));
const testFiles = (await readdir(join(projectRoot, "test")))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => join("test", name));

const inheritedEnvNames = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "NO_COLOR", "CI", "TZ", "USER", "LOGNAME", "SHELL"];
const sanitizedParentEnv = Object.fromEntries(
  inheritedEnvNames
    .filter((name) => process.env[name] != null)
    .map((name) => [name, process.env[name]]),
);
await mkdir(join(testRoot, "tmp"), { recursive: true });
const env = {
  ...sanitizedParentEnv,
  HOME: join(testRoot, "home"),
  TMPDIR: join(testRoot, "tmp"),
  TMP: join(testRoot, "tmp"),
  TEMP: join(testRoot, "tmp"),
  CODEX_HOME: join(testRoot, "codex-home"),
  XDG_CONFIG_HOME: join(testRoot, "xdg-config"),
  XDG_CACHE_HOME: join(testRoot, "xdg-cache"),
  XDG_DATA_HOME: join(testRoot, "xdg-data"),
  XDG_STATE_HOME: join(testRoot, "xdg-state"),
  XDG_RUNTIME_DIR: join(testRoot, "xdg-runtime"),
  XDG_CONFIG_DIRS: join(testRoot, "xdg-config-dirs"),
  XDG_DATA_DIRS: join(testRoot, "xdg-data-dirs"),
  CODEX_LOCAL_ROUTER_HOME: join(testRoot, "router-home"),
  CODEX_LOCAL_ROUTER_CONFIG: join(testRoot, "router-home", "config.json"),
  CODEX_LOCAL_ROUTER_LAUNCH_AGENT: join(testRoot, "LaunchAgents", "router.plist"),
  CODEX_LOCAL_ROUTER_SPACE_SWITCHER_LAUNCH_AGENT: join(testRoot, "LaunchAgents", "space-switcher.plist"),
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

import childProcess from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import { PACKAGE_VERSION, runtimePaths } from "../../src/product.mjs";

const original = childProcess.execFile;
const originalAsync = promisify(original);
const appState = process.env.CODEX_LOCAL_ROUTER_TEST_DRIVER_APP_STATE;
const fakeLaunchctl = process.env.CODEX_LOCAL_ROUTER_TEST_DRIVER_LAUNCHCTL === "1";
const fakePid = 2_147_000_001;
const paths = runtimePaths(process.env);
const markers = {
  service: join(paths.runtime, ".test-service-loaded"),
  switcher: join(paths.runtime, ".test-switcher-loaded"),
};
const launchTarget = (args = []) => args.some((value) => String(value).includes("space-switcher"))
  ? "switcher"
  : "service";

function fakeLaunchctlResult(args = []) {
  const target = launchTarget(args), marker = markers[target];
  if (args[0] === "print") {
    if (!existsSync(marker)) throw Object.assign(Error("service is not loaded"), { code: 3 });
    return;
  }
  mkdirSync(paths.runtime, { recursive: true });
  if (args[0] === "bootout") rmSync(marker, { force: true });
  if (args[0] === "bootstrap") writeFileSync(marker, "loaded\n");
  if (args[0] === "kickstart" && target === "service") {
    const configPath = process.env.CODEX_LOCAL_ROUTER_CONFIG ?? paths.config;
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    writeFileSync(paths.serviceState, JSON.stringify({
      pid: fakePid,
      startedAt: Date.now(),
      runningVersion: PACKAGE_VERSION,
      configPath,
      instance: null,
      url: `http://${config.listen?.host ?? "127.0.0.1"}:${config.listen?.port ?? 8788}`,
    }));
  }
}

function stub(file, args, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  if (file === "/bin/launchctl" && fakeLaunchctl) {
    queueMicrotask(() => {
      try {
        fakeLaunchctlResult(args);
        callback(null, "", "");
      } catch (error) {
        callback(error, "", "");
      }
    });
    return { kill() {} };
  }
  if (file === "ps" && args?.includes("args=") && appState) {
    if (appState === "unknown") {
      queueMicrotask(() => callback(Object.assign(Error("simulated ps failure"), { code: "EIO" }), "", ""));
    } else {
      const executable = process.env.CODEX_APP_EXECUTABLE ?? "/Applications/Codex.app/Contents/MacOS/Codex";
      const stdout = appState === "running" ? `${executable}\n` : "/usr/bin/other-process\n";
      queueMicrotask(() => callback(null, stdout, ""));
    }
    return { kill() {} };
  }
  return original(file, args, options, callback);
}

stub[promisify.custom] = async (file, args, options) => {
  if (file === "/bin/launchctl" && fakeLaunchctl) {
    fakeLaunchctlResult(args);
    return { stdout: "", stderr: "" };
  }
  if (file === "ps" && args?.includes("args=") && appState) {
    if (appState === "unknown") throw Object.assign(Error("simulated ps failure"), { code: "EIO" });
    const executable = process.env.CODEX_APP_EXECUTABLE ?? "/Applications/Codex.app/Contents/MacOS/Codex";
    return {
      stdout: appState === "running" ? `${executable}\n` : "/usr/bin/other-process\n",
      stderr: "",
    };
  }
  return originalAsync(file, args, options);
};

childProcess.execFile = stub;
syncBuiltinESMExports();

if (fakeLaunchctl) {
  const originalFetch = globalThis.fetch;
  const originalKill = process.kill;
  process.kill = (pid, signal) => pid === fakePid ? true : originalKill(pid, signal);
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (existsSync(markers.service) && url === `${JSON.parse(readFileSync(paths.serviceState, "utf8")).url}/healthz`) {
      const state = JSON.parse(readFileSync(paths.serviceState, "utf8"));
      return new Response(JSON.stringify({
        ok: true,
        service: "codex-local-router",
        version: state.runningVersion,
        pid: state.pid,
        subscription: true,
        instance: null,
        accepting: true,
        activeTurns: 0,
        websocketConnections: 0,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return originalFetch(input, init);
  };
}

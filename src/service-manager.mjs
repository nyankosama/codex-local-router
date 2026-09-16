import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { atomicJSON, atomicWrite, readJSON, withFileLock } from "./files.mjs";
import { loadConfig } from "./config.mjs";
import { PACKAGE_VERSION, runtimePaths } from "./product.mjs";

const exec = promisify(execFile);
export const SERVICE_LABEL = "com.nyankosama.codex-local-router";
export const SPACE_SWITCHER_LABEL = "com.nyankosama.codex-local-router.space-switcher";

const NETWORK_BOUNDARY_ENV_KEYS = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "WS_PROXY", "WSS_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy", "ws_proxy", "wss_proxy",
  "NODE_EXTRA_CA_CERTS",
];

const xml = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

export function launchAgentPath(env = process.env) {
  return env.CODEX_LOCAL_ROUTER_LAUNCH_AGENT ??
    join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

export function spaceSwitcherLaunchAgentPath(env = process.env) {
  return env.CODEX_LOCAL_ROUTER_SPACE_SWITCHER_LAUNCH_AGENT ??
    join(dirname(launchAgentPath(env)), `${SPACE_SWITCHER_LABEL}.plist`);
}

export function renderLaunchAgent({
  node = process.execPath,
  server,
  config,
  log,
  state = runtimePaths().serviceState,
  env = {},
}) {
  const variables = { GATEWAY_CONFIG: config, GATEWAY_STATE_PATH: state };
  for (const key of NETWORK_BOUNDARY_ENV_KEYS)
    if (env[key]) variables[key] = env[key];
  const environment = Object.entries(variables)
    .map(([key, value]) => `    <key>${key}</key><string>${xml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(node)}</string><string>${xml(server)}</string>
  </array>
  <key>EnvironmentVariables</key><dict>
${environment}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
}

export function renderSpaceSwitcherLaunchAgent({
  node = process.execPath,
  admin,
  log,
  env = {},
}) {
  const variables = {};
  for (const key of [
    "CODEX_HOME",
    "CODEX_CONFIG_PATH",
    "CODEX_MODEL_CATALOG_SOURCE",
    "CODEX_LOCAL_ROUTER_HOME",
    "CODEX_LOCAL_ROUTER_CONFIG",
    "CODEX_LOCAL_ROUTER_LAUNCH_AGENT",
    "CODEX_LOCAL_ROUTER_SPACE_SWITCHER_LAUNCH_AGENT",
    "CODEX_APP_EXECUTABLE",
    ...NETWORK_BOUNDARY_ENV_KEYS,
  ]) if (env[key]) variables[key] = env[key];
  const environment = Object.entries(variables)
    .map(([key, value]) => `    <key>${key}</key><string>${xml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${SPACE_SWITCHER_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(node)}</string><string>${xml(admin)}</string>
    <string>space</string><string>resume</string><string>--coordinator</string><string>--json</string>
  </array>
  <key>EnvironmentVariables</key><dict>
${environment}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Background</string>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
}

async function rotateLog(path) {
  const info = await stat(path).catch(() => null);
  if (!info || info.size < 10 * 1024 * 1024) return;
  for (let index = 4; index >= 1; index--)
    await rm(`${path}.${index + 1}`, { force: true }).then(async () => {
      try { await import("node:fs/promises").then(({ rename }) => rename(`${path}.${index}`, `${path}.${index + 1}`)); } catch {}
    });
  const { rename } = await import("node:fs/promises");
  await rename(path, `${path}.1`).catch(() => {});
}

async function launchctl(args, env = process.env) {
  if (env.CODEX_LOCAL_ROUTER_TEST_LAUNCHCTL === "1") return { stdout: "", stderr: "" };
  return exec("/bin/launchctl", args, { timeout: 15000 });
}

const domain = () => `gui/${process.getuid()}`;

export async function serviceStatus(configPath, env = process.env) {
  const paths = runtimePaths(env);
  const recorded = await readJSON(paths.serviceState, null);
  const installation = await readJSON(paths.serviceInstall, null);
  let health = null, healthUrl = null;
  let saved = null;
  try {
    const currentConfigPath = resolve(configPath ?? paths.config);
    saved = recorded?.instance == null && recorded?.configPath &&
      resolve(recorded.configPath) === currentConfigPath
      ? recorded
      : null;
    const config = await loadConfig(currentConfigPath);
    const configuredUrl = `http://${config.listen?.host ?? "127.0.0.1"}:${config.listen?.port ?? 8788}`;
    for (const url of new Set([configuredUrl, saved?.url].filter(Boolean))) {
      try {
        const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1500) });
        if (!response.ok) continue;
        health = await response.json();
        healthUrl = url;
        break;
      } catch {}
    }
  } catch {}
  const installed = await access(launchAgentPath(env)).then(() => true, () => false);
  const loaded = env.CODEX_LOCAL_ROUTER_TEST_LAUNCHCTL === "1"
    ? env.CODEX_LOCAL_ROUTER_TEST_SERVICE_LOADED === "1"
    : await launchctl(["print", `${domain()}/${SERVICE_LABEL}`], env)
      .then(() => true, () => false);
  return {
    installed,
    loaded,
    running: !!health,
    saved,
    installation,
    health,
    healthUrl,
  };
}

export async function installService(configPath, options = {}) {
  const env = options.env ?? process.env;
  const paths = runtimePaths(env);
  const server = options.serverPath ?? fileURLToPath(new URL("./server.mjs", import.meta.url));
  await loadConfig(configPath);
  await mkdir(dirname(launchAgentPath(env)), { recursive: true, mode: 0o700 });
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  await mkdir(paths.logs, { recursive: true, mode: 0o700 });
  await rotateLog(paths.serviceLog);
  const plist = launchAgentPath(env);
  const prior = await readFile(plist, "utf8").catch(() => null);
  await atomicWrite(
    plist,
    renderLaunchAgent({
      node: process.execPath,
      server,
      config: resolve(configPath),
      log: paths.serviceLog,
      state: paths.serviceState,
      env,
    }),
    0o600,
  );
  try {
    await launchctl(["bootout", domain(), plist], env).catch(() => {});
    await launchctl(["bootstrap", domain(), plist], env);
    await launchctl(["kickstart", "-k", `${domain()}/${SERVICE_LABEL}`], env);
  } catch (error) {
    if (prior) {
      await launchctl(["bootout", domain(), plist], env).catch(() => {});
      await atomicWrite(plist, prior, 0o600);
      await launchctl(["bootstrap", domain(), plist], env).catch(() => {});
      await launchctl(["kickstart", "-k", `${domain()}/${SERVICE_LABEL}`], env).catch(() => {});
    } else await rm(plist, { force: true });
    throw Object.assign(Error("LaunchAgent update failed; the previous definition was restored"), {
      code: "service_upgrade_failed",
      cause: error,
    });
  }
  await atomicJSON(paths.serviceInstall, {
    installedVersion: PACKAGE_VERSION,
    configPath: resolve(configPath),
    serverPath: server,
    launchAgent: launchAgentPath(env),
    installedAt: Date.now(),
  });
  return serviceStatus(configPath, env);
}

export async function stopService(options = {}) {
  const env = options.env ?? process.env;
  const plist = launchAgentPath(env);
  await launchctl(["bootout", domain(), plist], env).catch((error) => {
    if (!options.ignoreMissing) throw error;
  });
  return { stopped: true };
}

export async function uninstallService(options = {}) {
  const env = options.env ?? process.env;
  await stopService({ env, ignoreMissing: true });
  await rm(launchAgentPath(env), { force: true });
  return { removed: true };
}

export async function installSpaceSwitcher(options = {}) {
  const env = options.env ?? process.env;
  const paths = runtimePaths(env);
  return withSpaceSwitcherLock(paths, async () => {
    const control = options.launchctl ?? ((args) => launchctl(args, env));
    const admin = options.adminPath ?? fileURLToPath(
      new URL("../scripts/gateway-admin.mjs", import.meta.url),
    );
    const plist = spaceSwitcherLaunchAgentPath(env);
    await mkdir(dirname(plist), { recursive: true, mode: 0o700 });
    await mkdir(paths.logs, { recursive: true, mode: 0o700 });
    const desired = renderSpaceSwitcherLaunchAgent({
      node: process.execPath,
      admin,
      log: paths.serviceLog,
      env,
    });
    const prior = await readFile(plist, "utf8").catch(() => null);
    const label = `${domain()}/${SPACE_SWITCHER_LABEL}`;
    const loaded = await control(["print", label]).then(() => true, () => false);
    if (prior !== desired) {
      if (loaded) await control(["bootout", domain(), plist]);
      await atomicWrite(plist, desired, 0o600);
    }
    if (!loaded || prior !== desired) {
      try {
        await control(["bootstrap", domain(), plist]);
      } catch (error) {
        if (!(await control(["print", label]).then(() => true, () => false))) throw error;
      }
    }
    await control(["kickstart", label]);
    const state = {
      label: SPACE_SWITCHER_LABEL,
      launchAgent: plist,
      installedAt: Date.now(),
    };
    await atomicJSON(paths.spaceSwitcherInstall, state);
    return state;
  }, options.switcherLockWaitMs);
}

async function withSpaceSwitcherLock(paths, callback, waitMs = 60000) {
  const lock = `${paths.spaceSwitcherInstall}.lock`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return await withFileLock(lock, callback);
    } catch (error) {
      if (error.code !== "operation_locked" || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

export async function uninstallSpaceSwitcher(options = {}) {
  const env = options.env ?? process.env;
  const paths = runtimePaths(env);
  return withSpaceSwitcherLock(paths, async () => {
    const plist = spaceSwitcherLaunchAgentPath(env);
    if (!options.skipBootout)
      await launchctl(["bootout", domain(), plist], env).catch(() => {});
    await rm(plist, { force: true });
    await rm(paths.spaceSwitcherInstall, { force: true });
    return { removed: true };
  }, options.switcherLockWaitMs);
}

export async function spaceSwitcherStatus(env = process.env) {
  const paths = runtimePaths(env);
  return {
    installed: await access(spaceSwitcherLaunchAgentPath(env)).then(() => true, () => false),
    loaded: await launchctl(["print", `${domain()}/${SPACE_SWITCHER_LABEL}`], env)
      .then(() => true, () => false),
    installation: await readJSON(paths.spaceSwitcherInstall, null),
  };
}

export async function drainService(configPath, options = {}) {
  const env = options.env ?? process.env;
  const waitMs = options.waitMs ?? 300000;
  const signal = options.signal ?? process.kill;
  const before = await serviceStatus(configPath, env);
  if (!before.health) {
    if (before.loaded)
      return {
        drained: false,
        wasRunning: true,
        reason: "health_unavailable",
        before,
      };
    return { drained: true, wasRunning: false, before };
  }
  if (!before.health.pid)
    return {
      drained: false,
      wasRunning: true,
      reason: "health_unavailable",
      before,
    };
  signal(before.health.pid, "SIGUSR2");
  const deadline = Date.now() + waitMs;
  for (;;) {
    const state = await serviceStatus(configPath, env);
    if (state.health?.activeTurns === 0)
      return { drained: true, wasRunning: true, before, state };
    if (Date.now() >= deadline) {
      signal(before.health.pid, "SIGUSR1");
      return { drained: false, wasRunning: true, reason: "active_turn_timeout", before };
    }
    await new Promise((done) => setTimeout(done, options.pollMs ?? 500));
  }
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function preflightCandidate(serverPath, configPath, options = {}) {
  const env = options.env ?? process.env;
  const paths = runtimePaths(env);
  const config = structuredClone(await loadConfig(configPath));
  config.listen = { host: "127.0.0.1", port: await freePort() };
  config.history ??= {};
  config.history.persistent = { enabled: false };
  const candidateConfig = join(paths.runtime, `candidate-${process.pid}.json`);
  const candidateState = join(paths.runtime, `candidate-${process.pid}.state.json`);
  await atomicJSON(candidateConfig, config);
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...env,
      GATEWAY_CONFIG: candidateConfig,
      GATEWAY_STATE_PATH: candidateState,
      GATEWAY_INSTANCE_ID: `candidate-${process.pid}`,
    },
    stdio: "ignore",
  });
  try {
    const url = `http://127.0.0.1:${config.listen.port}/healthz`;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (child.exitCode != null) throw Error("candidate exited before health check");
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(300) });
        const health = await response.json();
        if (
          response.ok &&
          health.service === "codex-local-router" &&
          health.version === PACKAGE_VERSION
        ) return health;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw Error("candidate health check timed out");
  } finally {
    child.kill("SIGTERM");
    await rm(candidateConfig, { force: true });
    await rm(candidateState, { force: true });
  }
}

export async function gracefulRestart(configPath, options = {}) {
  const env = options.env ?? process.env;
  const waitMs = options.waitMs ?? 300000;
  const before = await serviceStatus(configPath, env);
  const candidate = await preflightCandidate(
    options.serverPath ?? fileURLToPath(new URL("./server.mjs", import.meta.url)),
    configPath,
    { env },
  );
  if (before.running && before.health?.pid) {
    process.kill(before.health.pid, "SIGUSR2");
    const deadline = Date.now() + waitMs;
    for (;;) {
      const state = await serviceStatus(configPath, env);
      if (!state.health?.activeTurns) break;
      if (Date.now() >= deadline) {
        process.kill(before.health.pid, "SIGUSR1");
        return { upgraded: false, reason: "active_turn_timeout", candidate };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const result = await installService(configPath, { ...options, env });
  return { upgraded: true, candidate, result };
}

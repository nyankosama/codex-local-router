import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { blockValues, removeTopLevelKeys } from "../../src/integration.mjs";

const exec = promisify(execFile);

export function argsOf(argv = process.argv.slice(2)) {
  const values = new Map();
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const name = item.slice(2);
    const next = argv[index + 1];
    values.set(name, next?.startsWith("--") ? true : next ?? true);
    if (next && !next.startsWith("--")) index++;
  }
  return {
    value(name, fallback) {
      return values.has(name) ? values.get(name) : fallback;
    },
  };
}

export async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function runJson(command, args, options = {}) {
  const { stdout } = await exec(command, args, {
    timeout: options.timeout ?? 600000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

export async function snapshot(cli = "codex-local-router") {
  const [status, space] = await Promise.all([
    runJson(cli, ["status", "--json"]),
    runJson(cli, ["space", "current", "--json"]),
  ]);
  const configPath = resolve(status.configPath);
  const integrationState = status.integration?.statePath
    ? JSON.parse(await readFile(status.integration.statePath, "utf8"))
    : null;
  const codexConfigPath = integrationState?.configPath
    ? resolve(integrationState.configPath)
    : null;
  const codexConfigText = codexConfigPath
    ? await readFile(codexConfigPath, "utf8")
    : "";
  const selectedValues = codexConfigText
    ? blockValues(Object.values(removeTopLevelKeys(codexConfigText.split(/\r?\n/)).baseline))
    : {};
  return {
    status,
    space,
    configPath,
    configSha256: await sha256(configPath),
    spaceRef: `${space.active.space}@${space.active.revision}`,
    defaultModel: space.defaultCodexModel ?? null,
    selectedModelPresent: Object.hasOwn(selectedValues, "model"),
    selectedModel: selectedValues.model ?? null,
    codexConfigPath,
    codexConfigSha256: codexConfigPath ? await sha256(codexConfigPath) : null,
  };
}

export function assertQuiescent(current, { requireRunning = true } = {}) {
  const health = current.status.service?.health;
  if (current.status.integration?.appRunning !== false)
    throw Error("Codex App must be fully exited");
  if (current.status.integration?.pending || current.space.pending)
    throw Error("a configuration or integration transaction is pending");
  if (current.space.drift)
    throw Error("the active configuration space has drift");
  if (requireRunning && !current.status.service?.running)
    throw Error("Gateway service is not running");
  if (requireRunning && !health)
    throw Error("Gateway health is unavailable");
  if ((health?.activeTurns ?? 0) !== 0)
    throw Error("Gateway still has active turns");
  if ((health?.websocketConnections ?? 0) !== 0)
    throw Error("Gateway still has WebSocket connections");
}

export function assertExpected(current, expected) {
  if (current.spaceRef !== expected.spaceRef)
    throw Error(`active space changed: expected ${expected.spaceRef}`);
  if (current.configSha256 !== expected.configSha256)
    throw Error("managed configuration hash changed");
}

export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}

export async function packInstalledPackage(current, backupDir, npm = "npm") {
  const serverPath = current.status.service?.installation?.serverPath;
  if (!serverPath) throw Error("installed Gateway server path is unavailable");
  const packageRoot = dirname(dirname(resolve(serverPath)));
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const { stdout } = await exec(
    npm,
    ["pack", packageRoot, "--pack-destination", backupDir, "--json"],
    { timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
  );
  const packed = JSON.parse(stdout);
  const filename = packed?.[0]?.filename;
  if (!filename) throw Error("failed to create installed-package backup");
  const packagePath = resolve(backupDir, filename);
  return {
    packagePath,
    packageSha256: await sha256(packagePath),
    serverPath: resolve(serverPath),
    serverSha256: await sha256(serverPath),
  };
}

export async function installPackage(packagePath, npm = "npm") {
  await exec(npm, ["install", "--global", "--force", resolve(packagePath)], {
    timeout: 300000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

export async function copyManagedConfig(current, backupDir) {
  const target = resolve(backupDir, "config.before.json");
  await copyFile(current.configPath, target);
  return { path: target, sha256: await sha256(target) };
}

export function cacheModes(status, targetIds) {
  if (!Array.isArray(targetIds) || !targetIds.length)
    throw Error("target IDs are required");
  return Object.fromEntries(targetIds.map((id) => [
    id,
    status.promptCaching?.find((item) => item.target === id)?.mode ?? null,
  ]));
}

export function instructionModes(status, targetIds) {
  if (!Array.isArray(targetIds) || !targetIds.length)
    throw Error("target IDs are required");
  return Object.fromEntries(targetIds.map((id) => {
    const item = status.instructions?.find((entry) => entry.target === id);
    return [id, {
      delivery: item?.delivery ?? null,
      status: item?.status ?? null,
      contentHash: item?.contentHash ?? null,
    }];
  }));
}

export async function restore(state, {
  cli = "codex-local-router",
  npm = "npm",
} = {}) {
  let current = await snapshot(cli);
  assertQuiescent(current);
  const safeRefs = new Set([
    state.prior.spaceRef,
    state.candidate?.spaceRef,
  ].filter(Boolean));
  const safeHashes = new Set([
    state.prior.configSha256,
    state.candidate?.configSha256,
  ].filter(Boolean));
  if (!safeRefs.has(current.spaceRef) || !safeHashes.has(current.configSha256))
    throw Error("current files do not match this rollout; refusing to overwrite concurrent changes");

  if (current.spaceRef !== state.prior.spaceRef) {
    const args = ["space", "use", state.prior.spaceRef];
    if (state.prior.selectedModelPresent) args.push("--preserve-current-model");
    args.push("--yes", "--json");
    await runJson(cli, args);
    current = await snapshot(cli);
    if (current.spaceRef !== state.prior.spaceRef ||
        current.configSha256 !== state.prior.configSha256 ||
        current.selectedModelPresent !== state.prior.selectedModelPresent ||
        current.selectedModel !== state.prior.selectedModel)
      throw Error("failed to restore the exact source configuration space");
  }

  if (await sha256(state.prior.packagePath) !== state.prior.packageSha256)
    throw Error("installed-package backup hash mismatch");
  await installPackage(state.prior.packagePath, npm);
  const afterInstall = await snapshot(cli);
  const serverPath = afterInstall.status.service?.installation?.serverPath;
  if (!serverPath) throw Error("restored Gateway server path is unavailable");
  await runJson(cli, [
    "upgrade", "--server", serverPath, "--wait-seconds", "300", "--json",
  ]);
  const restored = await snapshot(cli);
  if (restored.spaceRef !== state.prior.spaceRef ||
      restored.configSha256 !== state.prior.configSha256 ||
      restored.selectedModelPresent !== state.prior.selectedModelPresent ||
      restored.selectedModel !== state.prior.selectedModel ||
      await sha256(serverPath) !== state.prior.serverSha256)
    throw Error("rollback verification failed");
  return restored;
}

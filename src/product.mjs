import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

export const PRODUCT_NAME = "Codex Local Router";
export const PRODUCT_ID = "codex-local-router";
export const PACKAGE_VERSION = packageJson.version;
export const CONFIG_SCHEMA_VERSION = 3;
export const INTEGRATION_SCHEMA_VERSION = 4;
export const SPACE_SCHEMA_VERSION = 1;

export function dataDir(env = process.env) {
  return (
    env.CODEX_LOCAL_ROUTER_HOME ??
    join(homedir(), "Library", "Application Support", PRODUCT_NAME)
  );
}

export function runtimePaths(env = process.env) {
  const root = dataDir(env);
  return {
    root,
    config: env.CODEX_LOCAL_ROUTER_CONFIG ?? join(root, "config.json"),
    state: join(root, "state"),
    runtime: join(root, "run"),
    logs: join(root, "logs"),
    integration: join(root, "integration"),
    spaces: join(root, "spaces"),
    spaceIndex: join(root, "spaces", "index.json"),
    spaceLock: join(root, "spaces", ".lock"),
    spaceTransaction: join(root, "transactions", "space-switch.json"),
    spaceTransactionLock: join(root, "transactions", ".space-switch.lock"),
    spaceSwitcherInstall: join(root, "run", "space-switcher.json"),
    history: join(root, "state", "history.sqlite"),
    serviceState: join(root, "run", "service.json"),
    serviceInstall: join(root, "run", "installation.json"),
    serviceLog: join(root, "logs", "gateway.log"),
    accessToken: join(root, "state", "access-token"),
  };
}

export function codexHome(env = process.env) {
  return env.CODEX_HOME ?? join(homedir(), ".codex");
}

export function legacyPaths(env = process.env) {
  const home = codexHome(env);
  return {
    integrationState: join(home, ".llm-auto-gateway-app-probe.state"),
    history: join(homedir(), ".llm-auto-gateway", "state", "history.sqlite"),
  };
}

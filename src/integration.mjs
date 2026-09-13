import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildModelCatalog } from "./model-catalog.mjs";
import { atomicJSON, atomicWrite, readJSON, withFileLock } from "./files.mjs";
import {
  INTEGRATION_SCHEMA_VERSION,
  codexHome as defaultCodexHome,
  dataDir,
  legacyPaths,
} from "./product.mjs";

const exec = promisify(execFile);
const BEGIN = "# BEGIN codex-local-router managed settings";
const END = "# END codex-local-router managed settings";
const LEGACY_BEGIN = "# BEGIN llm-auto-gateway Codex App probe";
const LEGACY_END = "# END llm-auto-gateway Codex App probe";
const MANAGED_KEYS = [
  "model_provider",
  "model",
  "openai_base_url",
  "model_catalog_json",
];
const digest = (value) => createHash("sha256").update(value).digest("hex");

function tomlValue(value) {
  return JSON.stringify(value);
}

function splitLines(text) {
  return text.replace(/\r\n/g, "\n").split("\n");
}

function removeManagedBlock(lines) {
  const starts = [];
  const ends = [];
  for (let index = 0; index < lines.length; index++) {
    if ([BEGIN, LEGACY_BEGIN].includes(lines[index])) starts.push(index);
    if ([END, LEGACY_END].includes(lines[index])) ends.push(index);
  }
  if (!starts.length && !ends.length) return { lines, block: [] };
  if (starts.length !== 1 || ends.length !== 1 || ends[0] <= starts[0])
    throw Object.assign(Error("Codex config has an invalid router managed block"), {
      code: "integration_marker_invalid",
    });
  return {
    lines: [...lines.slice(0, starts[0]), ...lines.slice(ends[0] + 1)],
    block: lines.slice(starts[0], ends[0] + 1),
  };
}

function blockValues(block) {
  const values = {};
  for (const line of block) {
    const match = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (!match || !MANAGED_KEYS.includes(match[1])) continue;
    try {
      values[match[1]] = JSON.parse(match[2]);
    } catch {
      values[match[1]] = match[2];
    }
  }
  return values;
}

function removeTopLevelKeys(lines) {
  let inTable = false;
  const baseline = {};
  const kept = [];
  for (const line of lines) {
    if (/^\s*\[/.test(line)) inTable = true;
    const match = !inTable && line.match(/^\s*([A-Za-z0-9_]+)\s*=/);
    if (match && MANAGED_KEYS.includes(match[1])) {
      baseline[match[1]] ??= line;
      continue;
    }
    kept.push(line);
  }
  return { lines: kept, baseline };
}

function insertBeforeTables(lines, block) {
  const index = lines.findIndex((line) => /^\s*\[/.test(line));
  const at = index < 0 ? lines.length : index;
  const prefix = lines.slice(0, at);
  while (prefix.at(-1) === "") prefix.pop();
  const suffix = lines.slice(at);
  return [...prefix, ...(prefix.length ? [""] : []), ...block, "", ...suffix]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s*$/, "\n");
}

function renderBlock(managed) {
  return [
    BEGIN,
    "# Managed transactionally. Use `codex-local-router integration disable` to remove.",
    ...MANAGED_KEYS.map((key) => `${key} = ${tomlValue(managed[key])}`),
    END,
  ];
}

export function editCodexConfig(text, managed, previous = null) {
  const removed = removeManagedBlock(splitLines(text));
  const current = blockValues(removed.block);
  const conflicts = [];
  if (previous && Object.keys(current).length) {
    for (const key of MANAGED_KEYS)
      if (current[key] !== previous[key]) conflicts.push(key);
  }
  const cleaned = removeTopLevelKeys(removed.lines);
  return {
    text: insertBeforeTables(cleaned.lines, renderBlock(managed)),
    baseline: cleaned.baseline,
    current,
    conflicts,
  };
}

export function restoreCodexConfig(text, state) {
  const removed = removeManagedBlock(splitLines(text));
  const current = blockValues(removed.block);
  const conflicts = [];
  for (const key of MANAGED_KEYS)
    if (current[key] !== state.managed[key]) conflicts.push(key);
  const cleaned = removeTopLevelKeys(removed.lines);
  const restored = Object.values(state.baseline ?? {});
  return {
    text: insertBeforeTables(cleaned.lines, restored),
    current,
    conflicts,
  };
}

function integrationPaths(env, home = defaultCodexHome(env)) {
  const root = join(dataDir(env), "integration");
  return {
    root,
    state: join(root, "codex.json"),
    lock: join(root, ".lock"),
    pendingConfig: join(root, "pending-config.toml"),
    pendingCatalog: join(root, "pending-model-catalog.json"),
    backups: join(root, "backups"),
    config: env.CODEX_CONFIG_PATH ?? join(home, "config.toml"),
    catalog: join(home, "model-catalogs", "codex-local-router.json"),
    sourceCatalog:
      env.CODEX_MODEL_CATALOG_SOURCE ?? join(home, "models_cache.json"),
  };
}

export async function appIsRunning(env = process.env) {
  if (env.CODEX_APP_RUNNING === "0") return false;
  if (env.CODEX_APP_RUNNING === "1") return true;
  const candidates = [
    env.CODEX_APP_EXECUTABLE,
    "/Applications/Codex.app/Contents/MacOS/Codex",
    "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  ].filter(Boolean);
  try {
    const { stdout } = await exec("ps", ["-axo", "args="], { timeout: 5000 });
    return stdout
      .split(/\r?\n/)
      .some((line) => candidates.some((candidate) => line.trim().startsWith(candidate)));
  } catch {
    return false;
  }
}

async function migrateLegacyState(paths, env) {
  const legacy = legacyPaths(env).integrationState;
  let raw;
  try {
    raw = await readFile(legacy, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const entries = Object.fromEntries(
    raw.trim().split(/\r?\n/).map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1)];
    }),
  );
  let baseline = {};
  if (entries.backup_path) {
    try {
      const backupText = await readFile(entries.backup_path, "utf8");
      baseline = removeTopLevelKeys(removeManagedBlock(splitLines(backupText)).lines).baseline;
    } catch {}
  }
  return {
    schemaVersion: INTEGRATION_SCHEMA_VERSION,
    migratedFrom: legacy,
    status: "applied",
    clients: ["cli", "app"],
    configPath: entries.config_path ?? paths.config,
    catalogPath: entries.catalog_path ?? paths.catalog,
    managed: {
      model_provider: "openai",
      model: entries.custom_model,
      openai_base_url: entries.base_url,
      model_catalog_json: entries.catalog_path ?? paths.catalog,
    },
    baseline,
    configHash: entries.config_hash,
    catalogHash: entries.catalog_hash,
    legacyBackup: entries.backup_path,
    updatedAt: Date.now(),
  };
}

export async function readIntegrationState(env = process.env) {
  const paths = integrationPaths(env);
  return (await readJSON(paths.state, null)) ?? migrateLegacyState(paths, env);
}

export async function discoverCodex(env = process.env) {
  const home = defaultCodexHome(env);
  const paths = integrationPaths(env, home);
  const exists = async (path) => access(path).then(() => true, () => false);
  const credentialsStore = await readFile(paths.config, "utf8")
    .then((text) => text.match(/^\s*cli_auth_credentials_store\s*=\s*"([^"]+)"/m)?.[1] ?? "auto")
    .catch(() => "unavailable");
  return {
    home,
    configPath: paths.config,
    configExists: await exists(paths.config),
    catalogSource: paths.sourceCatalog,
    catalogSourceExists: await exists(paths.sourceCatalog),
    cliPath: env.CODEX_CLI_PATH ?? null,
    appRunning: await appIsRunning(env),
    credentialsStore,
  };
}

function desired(config, paths, baseUrl) {
  const models = Object.keys(config.subscription?.customModels ?? {});
  if (!models.length) throw Object.assign(Error("no App-enabled custom model is configured"), { code: "integration_no_models" });
  return {
    model_provider: "openai",
    model: models[0],
    openai_base_url: baseUrl,
    model_catalog_json: paths.catalog,
  };
}

async function buildCatalog(config, paths) {
  const source = JSON.parse(await readFile(paths.sourceCatalog, "utf8"));
  return Buffer.from(JSON.stringify(buildModelCatalog(source, config), null, 2) + "\n");
}

export async function syncIntegration(config, options = {}) {
  const env = options.env ?? process.env;
  const paths = integrationPaths(env, options.codexHome ?? defaultCodexHome(env));
  const clients = options.clients ?? ["cli", "app"];
  const baseUrl = options.baseUrl ?? `http://${config.listen?.host ?? "127.0.0.1"}:${config.listen?.port ?? 8788}/subscription/v1`;
  return withFileLock(paths.lock, async () => {
    await mkdir(paths.backups, { recursive: true, mode: 0o700 });
    const stored = await readJSON(paths.state, null);
    let previous = stored ?? (await migrateLegacyState(paths, env));
    const configText = await readFile(paths.config, "utf8");
    let managed = desired(config, paths, baseUrl);
    const allowedModels = new Set([
      ...(config.subscription?.models ?? []),
      ...Object.keys(config.subscription?.customModels ?? {}),
    ]);
    const removed = removeManagedBlock(splitLines(configText));
    const current = blockValues(removed.block);
    if (allowedModels.has(current.model)) {
      managed = { ...managed, model: current.model };
    } else if (stored && allowedModels.has(stored.managed?.model)) {
      managed = { ...managed, model: stored.managed.model };
    } else if (!stored) {
      const baseline = blockValues(Object.values(removeTopLevelKeys(removed.lines).baseline));
      const selectedModel = current.model ?? baseline.model;
      if (allowedModels.has(selectedModel)) {
        managed = { ...managed, model: selectedModel };
        if (previous?.migratedFrom && current.model === selectedModel)
          previous = { ...previous, managed: { ...previous.managed, model: selectedModel } };
      }
    }
    const edited = editCodexConfig(configText, managed, previous?.managed);
    const conflicts = edited.conflicts.filter(
      (key) => key !== "model" || !allowedModels.has(edited.current.model),
    );
    if (conflicts.length && !options.force)
      throw Object.assign(Error(`Codex managed settings changed: ${conflicts.join(", ")}`), {
        code: "integration_conflict",
        conflicts,
      });
    const catalog = await buildCatalog(config, paths);
    let catalogCurrent = null;
    try { catalogCurrent = await readFile(paths.catalog); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (previous?.catalogHash && catalogCurrent && digest(catalogCurrent) !== previous.catalogHash && !options.force)
      throw Object.assign(Error("Codex model catalog changed after the last router sync"), { code: "integration_catalog_conflict" });
    const state = {
      schemaVersion: INTEGRATION_SCHEMA_VERSION,
      product: "codex-local-router",
      migratedFrom: previous?.migratedFrom,
      status: "applied",
      clients,
      configPath: paths.config,
      catalogPath: paths.catalog,
      sourceCatalogPath: paths.sourceCatalog,
      managed,
      baseline: previous?.baseline ?? edited.baseline,
      baselineCatalogBackup: previous?.baselineCatalogBackup ?? null,
      configHash: digest(edited.text),
      catalogHash: digest(catalog),
      gatewayConfigPath: options.gatewayConfigPath,
      updatedAt: Date.now(),
    };
    if (!previous && catalogCurrent) {
      const backup = join(paths.backups, `catalog-${Date.now()}.json`);
      await copyFile(paths.catalog, backup);
      state.baselineCatalogBackup = backup;
    }
    const filesUnchanged =
      configText === edited.text &&
      catalogCurrent &&
      Buffer.compare(catalogCurrent, catalog) === 0;
    if (filesUnchanged && previous?.status === "applied") {
      const stateUnchanged = MANAGED_KEYS.every(
        (key) => previous.managed?.[key] === managed[key],
      );
      if (!stateUnchanged) await atomicJSON(paths.state, state);
      return {
        changed: !stateUnchanged,
        pending: false,
        state: stateUnchanged ? previous : state,
      };
    }
    if (clients.includes("app") && (await appIsRunning(env)) && !options.applyWhileRunning) {
      await atomicWrite(paths.pendingConfig, edited.text);
      await atomicWrite(paths.pendingCatalog, catalog);
      state.status = "pending_app_quit";
      state.pendingConfigHash = digest(edited.text);
      state.pendingCatalogHash = digest(catalog);
      await atomicJSON(paths.state, state);
      return { changed: true, pending: true, state };
    }
    await mkdir(dirname(paths.catalog), { recursive: true, mode: 0o700 });
    await atomicWrite(paths.config, edited.text);
    await atomicWrite(paths.catalog, catalog);
    await atomicJSON(paths.state, state);
    await rm(paths.pendingConfig, { force: true });
    await rm(paths.pendingCatalog, { force: true });
    return { changed: true, pending: false, state };
  });
}

export async function integrationStatus(config, options = {}) {
  const env = options.env ?? process.env;
  const paths = integrationPaths(env, options.codexHome ?? defaultCodexHome(env));
  const state = (await readJSON(paths.state, null)) ?? (await migrateLegacyState(paths, env));
  if (!state) return { active: false, statePath: paths.state };
  let configText = "", catalog = null;
  try { configText = await readFile(state.configPath, "utf8"); } catch {}
  try { catalog = JSON.parse(await readFile(state.catalogPath, "utf8")); } catch {}
  const currentBlock = blockValues(removeManagedBlock(splitLines(configText)).block);
  const allowedModels = new Set([
    ...(config.subscription?.models ?? []),
    ...Object.keys(config.subscription?.customModels ?? {}),
  ]);
  const targets = Object.values(config.targets)
    .filter((target) => target.app?.enabled)
    .map((target) => {
      const entry = catalog?.models?.find((model) => model.slug === target.app.modelId);
      return {
        id: target.id,
        modelId: target.app.modelId,
        present: !!entry,
        contextWindow: entry?.context_window,
        inputModalities: entry?.input_modalities ?? [],
        reasoningLevels: entry?.supported_reasoning_levels?.map((x) => x.effort) ?? [],
        compHash: entry?.comp_hash ?? null,
      };
    });
  return {
    active: state.status === "applied",
    pending: state.status === "pending_app_quit",
    statePath: paths.state,
    configCurrent: MANAGED_KEYS.every((key) =>
      key === "model"
        ? allowedModels.has(currentBlock.model)
        : currentBlock[key] === state.managed[key],
    ),
    catalogCurrent: !!catalog && digest(Buffer.from(JSON.stringify(catalog, null, 2) + "\n")) === state.catalogHash,
    appRunning: await appIsRunning(env),
    clients: state.clients,
    targets,
  };
}

export async function disableIntegration(options = {}) {
  const env = options.env ?? process.env;
  const paths = integrationPaths(env, options.codexHome ?? defaultCodexHome(env));
  return withFileLock(paths.lock, async () => {
    const state = (await readJSON(paths.state, null)) ?? (await migrateLegacyState(paths, env));
    if (!state) return { changed: false, conflicts: [] };
    if (state.status === "disabled") return { changed: false, conflicts: [] };
    if ((await appIsRunning(env)) && state.clients?.includes("app") && !options.applyWhileRunning)
      throw Object.assign(Error("Codex App is running; quit it before disabling integration"), { code: "app_running" });
    const current = await readFile(state.configPath, "utf8");
    const restored = restoreCodexConfig(current, state);
    let catalog;
    try {
      const bytes = await readFile(state.catalogPath);
      if (digest(bytes) === state.catalogHash) catalog = JSON.parse(bytes);
    } catch {}
    const selectedModelAllowed = catalog?.models?.some(
      (model) => model.slug === restored.current.model,
    );
    const conflicts = restored.conflicts.filter(
      (key) => key !== "model" || !selectedModelAllowed,
    );
    if (conflicts.length && !options.force)
      throw Object.assign(Error(`Codex managed settings changed: ${conflicts.join(", ")}`), {
        code: "integration_conflict",
        conflicts,
      });
    await atomicWrite(state.configPath, restored.text);
    if (state.baselineCatalogBackup)
      await copyFile(state.baselineCatalogBackup, state.catalogPath);
    else await rm(state.catalogPath, { force: true });
    state.status = "disabled";
    state.disabledAt = Date.now();
    await atomicJSON(paths.state, state);
    return { changed: true, conflicts };
  });
}

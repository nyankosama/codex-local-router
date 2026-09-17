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
export const MANAGED_CODEX_KEYS = [
  "model_provider",
  "model",
  "openai_base_url",
  "model_catalog_json",
];
const MANAGED_KEYS = MANAGED_CODEX_KEYS;
const digest = (value) => createHash("sha256").update(value).digest("hex");

function tomlValue(value) {
  return JSON.stringify(value);
}

function splitLines(text) {
  return text.replace(/\r\n/g, "\n").split("\n");
}

function structuralTomlLines(lines) {
  let multiline = null;
  let squareDepth = 0, curlyDepth = 0;
  return lines.map((line) => {
    const structural = multiline == null && squareDepth === 0 && curlyDepth === 0;
    let single = false, double = false;
    const escaped = (at) => {
      let count = 0;
      for (let index = at - 1; index >= 0 && line[index] === "\\"; index--) count++;
      return count % 2 === 1;
    };
    for (let index = 0; index < line.length;) {
      if (multiline) {
        const quote = multiline[0];
        let run = 0;
        while (line[index + run] === quote) run++;
        const closingRun = run - (quote === '"' && escaped(index) ? 1 : 0);
        if (closingRun >= 3) {
          multiline = null;
          index += run;
        } else index += Math.max(1, run);
        continue;
      }
      if (!single && !double && line[index] === "#") break;
      if (
        !single && !double &&
        (line.startsWith('"""', index) || line.startsWith("'''", index))
      ) {
        multiline = line.slice(index, index + 3);
        index += 3;
        continue;
      }
      if (!single && line[index] === '"' && !escaped(index)) double = !double;
      else if (!double && line[index] === "'") single = !single;
      else if (!single && !double) {
        if (line[index] === "[") squareDepth++;
        else if (line[index] === "]") squareDepth = Math.max(0, squareDepth - 1);
        else if (line[index] === "{") curlyDepth++;
        else if (line[index] === "}") curlyDepth = Math.max(0, curlyDepth - 1);
      }
      index++;
    }
    return structural;
  });
}

function decodeTomlBasic(value) {
  return value.replace(
    /\\(?:[btnfr"\\]|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8})/g,
    (escape) => {
      const simple = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
      if (escape[1] in simple) return simple[escape[1]];
      return String.fromCodePoint(Number.parseInt(escape.slice(2), 16));
    },
  );
}

function tomlAssignment(statement) {
  const match = statement.match(
    /^\s*(?:"((?:\\.|[^"\\])*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*=\s*([\s\S]*?)\s*$/,
  );
  if (!match) return null;
  return {
    key: match[1] != null
      ? decodeTomlBasic(match[1])
      : (match[2] ?? match[3]),
    value: match[4],
  };
}

function withoutTomlComment(value) {
  let multiline = null, single = false, double = false;
  const escaped = (at) => {
    let count = 0;
    for (let index = at - 1; index >= 0 && value[index] === "\\"; index--) count++;
    return count % 2 === 1;
  };
  for (let index = 0; index < value.length;) {
    if (multiline) {
      const quote = multiline[0];
      let run = 0;
      while (value[index + run] === quote) run++;
      const closingRun = run - (quote === '"' && escaped(index) ? 1 : 0);
      if (closingRun >= 3) {
        multiline = null;
        index += run;
      } else index += Math.max(1, run);
      continue;
    }
    if (!single && !double && value[index] === "#") return value.slice(0, index).trimEnd();
    if (
      !single && !double &&
      (value.startsWith('"""', index) || value.startsWith("'''", index))
    ) {
      multiline = value.slice(index, index + 3);
      index += 3;
      continue;
    }
    if (!single && value[index] === '"' && !escaped(index)) double = !double;
    else if (!double && value[index] === "'") single = !single;
    index++;
  }
  return value.trimEnd();
}

function removeManagedBlock(lines) {
  const structural = structuralTomlLines(lines);
  const starts = [];
  const ends = [];
  for (let index = 0; index < lines.length; index++) {
    if (structural[index] && [BEGIN, LEGACY_BEGIN].includes(lines[index])) starts.push(index);
    if (structural[index] && [END, LEGACY_END].includes(lines[index])) ends.push(index);
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

export function blockValues(block) {
  const values = {};
  for (const line of block) {
    const assignment = tomlAssignment(line);
    if (!assignment || !MANAGED_KEYS.includes(assignment.key)) continue;
    const value = withoutTomlComment(assignment.value);
    try {
      values[assignment.key] = JSON.parse(value);
    } catch {
      const raw = value.trim();
      if (raw.startsWith("'''") && raw.endsWith("'''")) {
        values[assignment.key] = raw.slice(3, -3).replace(/^\r?\n/, "");
      } else if (raw.startsWith('"""') && raw.endsWith('"""')) {
        let body = raw.slice(3, -3).replace(/^\r?\n/, "");
        body = body.replace(/\\[ \t]*\r?\n[ \t\r\n]*/g, "");
        values[assignment.key] = decodeTomlBasic(body);
      } else if (raw.startsWith('"') && raw.endsWith('"')) {
        values[assignment.key] = decodeTomlBasic(raw.slice(1, -1));
      } else if (raw.startsWith("'") && raw.endsWith("'")) {
        values[assignment.key] = raw.slice(1, -1);
      } else {
        values[assignment.key] = raw;
      }
    }
  }
  return values;
}

function tomlString(value) {
  const raw = withoutTomlComment(value).trim();
  if (raw.startsWith('"') && raw.endsWith('"'))
    return decodeTomlBasic(raw.slice(1, -1));
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  return null;
}

function profileTable(line) {
  const match = line.match(
    /^\s*\[\s*profiles\s*\.\s*(?:"((?:\\.|[^"\\])*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*\]\s*(?:#.*)?$/,
  );
  if (!match) return null;
  return match[1] != null
    ? decodeTomlBasic(match[1])
    : (match[2] ?? match[3]);
}

export function codexInstructionOverrideStatus(text) {
  const lines = splitLines(text), structural = structuralTomlLines(lines);
  let atTop = true, section = null, selectedProfile = null, topLevel = false;
  const profileOverrides = new Set();
  for (let index = 0; index < lines.length; index++) {
    if (!structural[index]) continue;
    const line = lines[index];
    if (/^\s*\[/.test(line)) {
      atTop = false;
      section = profileTable(line);
      continue;
    }
    const assignment = tomlAssignment(line);
    if (!assignment) continue;
    if (atTop && assignment.key === "profile")
      selectedProfile = tomlString(assignment.value);
    if (assignment.key === "model_instructions_file") {
      if (atTop) topLevel = true;
      else if (section != null) profileOverrides.add(section);
    }
  }
  const selectedProfileOverride =
    selectedProfile != null && profileOverrides.has(selectedProfile);
  return {
    configured: topLevel || selectedProfileOverride,
    topLevel,
    selectedProfile,
    selectedProfileOverride,
  };
}

export function removeTopLevelKeys(lines) {
  const structural = structuralTomlLines(lines);
  let inTable = false;
  const baseline = {};
  const kept = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (structural[index] && /^\s*\[/.test(line)) inTable = true;
    const assignment = structural[index] && !inTable ? tomlAssignment(line) : null;
    if (assignment && MANAGED_KEYS.includes(assignment.key)) {
      let end = index + 1;
      while (end < lines.length && !structural[end]) end++;
      baseline[assignment.key] ??= lines.slice(index, end).join("\n");
      index = end - 1;
      continue;
    }
    kept.push(line);
  }
  return { lines: kept, baseline };
}

function insertBeforeTables(lines, block) {
  const structural = structuralTomlLines(lines);
  const index = lines.findIndex((line, at) => structural[at] && /^\s*\[/.test(line));
  const at = index < 0 ? lines.length : index;
  const prefix = lines.slice(0, at);
  while (prefix.at(-1) === "") prefix.pop();
  const suffix = lines.slice(at);
  const rendered = [...prefix, ...(prefix.length ? [""] : []), ...block, "", ...suffix]
    .join("\n");
  return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
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

export function inspectCodexBaseline(text) {
  const removed = removeManagedBlock(splitLines(text));
  if (removed.block.length)
    throw Object.assign(Error("Codex config is currently managed by the router"), {
      code: "official_baseline_managed",
    });
  const cleaned = removeTopLevelKeys(removed.lines);
  const values = blockValues(Object.values(cleaned.baseline));
  if (
    (values.model_provider != null && values.model_provider !== "openai") ||
    values.openai_base_url != null
  )
    throw Object.assign(Error("Codex config is not an unambiguous official direct configuration"), {
      code: "official_baseline_ambiguous",
    });
  return { managed: cleaned.baseline, values };
}

export function integrationPaths(env, home = defaultCodexHome(env)) {
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

export async function appIsRunning(env = process.env, options = {}) {
  const candidates = [
    env.CODEX_APP_EXECUTABLE,
    "/Applications/Codex.app/Contents/MacOS/Codex",
    "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  ].filter(Boolean);
  try {
    const { stdout } = await (options.exec ?? exec)("ps", ["-axo", "args="], { timeout: 5000 });
    return stdout
      .split(/\r?\n/)
      .some((line) => candidates.some((candidate) => line.trim().startsWith(candidate)));
  } catch {
    return null;
  }
}

async function checkedAppState(options, env) {
  const state = await (options.appRunning ?? (() => appIsRunning(env)))();
  if (state == null)
    throw Object.assign(Error("Codex App state could not be determined"), {
      code: "app_state_unknown",
    });
  return state;
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

export async function discoverCodex(env = process.env, options = {}) {
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
    appRunning: await (options.appRunning ?? (() => appIsRunning(env)))(),
    credentialsStore,
  };
}

function desired(config, paths, baseUrl, selectedModel = null) {
  const models = Object.keys(config.subscription?.customModels ?? {});
  if (!models.length) throw Object.assign(Error("no App-enabled custom model is configured"), { code: "integration_no_models" });
  const model = selectedModel ?? models[0];
  const allowed = new Set([...(config.subscription?.models ?? []), ...models]);
  if (!allowed.has(model))
    throw Object.assign(Error(`default Codex model is not available in this space: ${model}`), {
      code: "space_default_model_unavailable",
    });
  return {
    model_provider: "openai",
    model,
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
    if (
      Object.hasOwn(options, "expectedCodexConfigHash") &&
      digest(Buffer.from(configText)) !== options.expectedCodexConfigHash
    ) throw Object.assign(Error("Codex config changed before integration could be applied"), {
      code: "integration_conflict",
      conflicts: ["file_hash"],
    });
    let managed = desired(config, paths, baseUrl, options.selectedModel);
    const allowedModels = new Set([
      ...(config.subscription?.models ?? []),
      ...Object.keys(config.subscription?.customModels ?? {}),
    ]);
    const removed = removeManagedBlock(splitLines(configText));
    const current = blockValues(removed.block);
    if (options.selectedModel) {
      managed = { ...managed, model: options.selectedModel };
    } else if (allowedModels.has(current.model)) {
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
    if (
      Object.hasOwn(options, "expectedCatalogHash") &&
      (catalogCurrent ? digest(catalogCurrent) : null) !== options.expectedCatalogHash
    ) throw Object.assign(Error("Codex model catalog changed before integration could be applied"), {
      code: "integration_catalog_conflict",
    });
    if (
      previous?.status === "applied" && previous.catalogHash && catalogCurrent &&
      digest(catalogCurrent) !== previous.catalogHash && !options.force
    )
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
      baseline: options.officialBaseline?.managed ?? previous?.baseline ?? edited.baseline,
      baselineCatalog: options.officialBaseline?.catalog ?? previous?.baselineCatalog ?? null,
      baselineCatalogBackup: options.officialBaseline ? null : previous?.baselineCatalogBackup ?? null,
      configHash: digest(edited.text),
      catalogHash: digest(catalog),
      gatewayConfigPath: options.gatewayConfigPath,
      officialSpaceRef: options.officialSpaceRef ?? previous?.officialSpaceRef ?? null,
      materializedSpaceRef: options.spaceRef ?? previous?.materializedSpaceRef ?? null,
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
      ) && previous.officialSpaceRef === state.officialSpaceRef &&
        previous.materializedSpaceRef === state.materializedSpaceRef;
      if (!stateUnchanged) await atomicJSON(paths.state, state);
      return {
        changed: !stateUnchanged,
        pending: false,
        state: stateUnchanged ? previous : state,
      };
    }
    const appRunning = clients.includes("app") && !options.applyWhileRunning
      ? await checkedAppState(options, env)
      : false;
    if (appRunning) {
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
  if (!state) {
    const appRunning = await (options.appRunning ?? (() => appIsRunning(env)))();
    return {
      active: false,
      statePath: paths.state,
      appRunning,
      ...(appRunning == null ? { appRunningError: "app_state_unknown" } : {}),
    };
  }
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
  const appRunning = await (options.appRunning ?? (() => appIsRunning(env)))();
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
    appRunning,
    ...(appRunning == null ? { appRunningError: "app_state_unknown" } : {}),
    clients: state.clients,
    officialSpaceRef: state.officialSpaceRef ?? null,
    materializedSpaceRef: state.materializedSpaceRef ?? null,
    selectedModel: currentBlock.model ?? state.managed?.model ?? null,
    targets,
  };
}

export async function disableIntegration(options = {}) {
  const env = options.env ?? process.env;
  const paths = integrationPaths(env, options.codexHome ?? defaultCodexHome(env));
  return withFileLock(paths.lock, async () => {
    let state = (await readJSON(paths.state, null)) ?? (await migrateLegacyState(paths, env));
    if (!state) {
      if (!options.officialBaseline) return { changed: false, conflicts: [] };
      const current = await readFile(paths.config, "utf8");
      const removed = removeManagedBlock(splitLines(current));
      if (removed.block.length && !options.trustedCurrentFiles)
        throw Object.assign(Error("Codex integration state is missing for a managed configuration"), {
          code: "integration_state_missing",
        });
      state = {
        schemaVersion: INTEGRATION_SCHEMA_VERSION,
        product: "codex-local-router",
        status: "disabled",
        clients: [],
        configPath: paths.config,
        catalogPath: paths.catalog,
        sourceCatalogPath: paths.sourceCatalog,
        managed: options.trustedCurrentFiles ? blockValues(removed.block) : {},
        baseline: options.officialBaseline.managed ?? {},
        baselineCatalog: options.officialBaseline.catalog ?? null,
        updatedAt: Date.now(),
      };
    }
    const requestedOfficialRef = options.officialSpaceRef ?? state.officialSpaceRef ?? null;
    if (
      state.status === "disabled" &&
      !options.officialBaseline
    ) return { changed: false, conflicts: [] };
    const appRunning = state.clients?.includes("app") && !options.applyWhileRunning
      ? await checkedAppState(options, env)
      : false;
    if (appRunning)
      throw Object.assign(Error("Codex App is running; quit it before disabling integration"), { code: "app_running" });
    const current = await readFile(state.configPath, "utf8");
    if (
      Object.hasOwn(options, "expectedCodexConfigHash") &&
      digest(Buffer.from(current)) !== options.expectedCodexConfigHash
    ) throw Object.assign(Error("Codex config changed before integration could be disabled"), {
      code: "integration_conflict",
      conflicts: ["file_hash"],
    });
    const baseline = options.officialBaseline?.managed ?? state.baseline;
    const restored = restoreCodexConfig(current, { ...state, baseline });
    let catalog, catalogBytes = null;
    try {
      catalogBytes = await readFile(state.catalogPath);
    } catch {}
    if (
      Object.hasOwn(options, "expectedCatalogHash") &&
      (catalogBytes ? digest(catalogBytes) : null) !== options.expectedCatalogHash
    ) throw Object.assign(Error("Codex model catalog changed before integration could be disabled"), {
      code: "integration_catalog_conflict",
    });
    if (catalogBytes && digest(catalogBytes) === state.catalogHash)
      catalog = JSON.parse(catalogBytes);
    const selectedModelAllowed = catalog?.models?.some(
      (model) => model.slug === restored.current.model,
    );
    const conflicts = state.status === "disabled" && !Object.keys(restored.current).length
      ? []
      : restored.conflicts.filter(
          (key) => key !== "model" || !selectedModelAllowed,
        );
    if (conflicts.length && !options.force)
      throw Object.assign(Error(`Codex managed settings changed: ${conflicts.join(", ")}`), {
        code: "integration_conflict",
        conflicts,
      });
    await atomicWrite(state.configPath, restored.text);
    if (options.officialBaseline?.catalog?.present) {
      const bytes = Buffer.from(options.officialBaseline.catalog.bytesBase64, "base64");
      if (digest(bytes) !== options.officialBaseline.catalog.sha256)
        throw Object.assign(Error("official catalog snapshot hash mismatch"), {
          code: "official_catalog_tampered",
        });
      await atomicWrite(state.catalogPath, bytes);
    } else if (options.officialBaseline?.catalog) {
      await rm(state.catalogPath, { force: true });
    } else if (state.baselineCatalog?.present) {
      const bytes = Buffer.from(state.baselineCatalog.bytesBase64, "base64");
      if (digest(bytes) !== state.baselineCatalog.sha256)
        throw Object.assign(Error("official catalog snapshot hash mismatch"), {
          code: "official_catalog_tampered",
        });
      await atomicWrite(state.catalogPath, bytes);
    } else if (state.baselineCatalogBackup)
      await copyFile(state.baselineCatalogBackup, state.catalogPath);
    else await rm(state.catalogPath, { force: true });
    state.schemaVersion = INTEGRATION_SCHEMA_VERSION;
    state.status = "disabled";
    state.officialSpaceRef = requestedOfficialRef;
    state.materializedSpaceRef = requestedOfficialRef;
    state.disabledAt = Date.now();
    await atomicJSON(paths.state, state);
    return { changed: true, conflicts };
  });
}

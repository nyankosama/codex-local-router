import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { validate } from "./config.mjs";
import { readJSON, atomicJSON, withFileLock } from "./files.mjs";
import {
  blockValues,
  inspectCodexBaseline,
  readIntegrationState,
} from "./integration.mjs";
import {
  SPACE_SCHEMA_VERSION,
  codexHome as defaultCodexHome,
  runtimePaths,
} from "./product.mjs";

export const OFFICIAL_SPACE = "official";
export const DEFAULT_SPACE = "default";
export const SPACE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const SPACE_CONFIG_KEYS = Object.freeze([
  "mode",
  "defaultTarget",
  "fixedTarget",
  "passthroughTarget",
  "fallbackTarget",
  "providers",
  "targets",
  "rules",
  "pluginTools",
  "thirdPartyDefaults",
  "standaloneSearch",
  "webSearch",
]);

const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stable(value[key])]),
  );
};

export const digestJSON = (value) =>
  createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");

const fileDigest = (value) => createHash("sha256").update(value).digest("hex");

export function validateSpaceName(name) {
  if (!SPACE_NAME_PATTERN.test(name ?? ""))
    throw Object.assign(Error("space name must match [a-z0-9][a-z0-9._-]{0,63}"), {
      code: "space_name_invalid",
    });
  return name;
}

export function parseSpaceRef(input, fallbackRevision = null) {
  const raw = String(input ?? "");
  const index = raw.lastIndexOf("@");
  const name = index < 0 ? raw : raw.slice(0, index);
  validateSpaceName(name);
  const revision = index < 0 ? fallbackRevision : Number(raw.slice(index + 1));
  if (revision != null && (!Number.isInteger(revision) || revision <= 0))
    throw Object.assign(Error("space revision must be a positive integer"), {
      code: "space_revision_invalid",
    });
  return { space: name, revision };
}

export function extractSpaceConfig(config) {
  const result = {};
  for (const key of SPACE_CONFIG_KEYS)
    if (Object.hasOwn(config, key)) result[key] = structuredClone(config[key]);
  result.subscription = { enabled: config.subscription?.enabled === true };
  return result;
}

export function composeRuntimeConfig(current, revision) {
  if (revision.kind !== "router")
    throw Object.assign(Error("official space does not have a Router runtime configuration"), {
      code: "space_not_router",
    });
  const result = structuredClone(current);
  for (const key of SPACE_CONFIG_KEYS) delete result[key];
  Object.assign(result, structuredClone(revision.config));
  const catalogPath = current.subscription?.catalogPath;
  result.subscription = {
    enabled: revision.config.subscription?.enabled === true,
    ...(catalogPath ? { catalogPath } : {}),
  };
  delete result.subscription.models;
  delete result.subscription.customModels;
  validate(result);
  return result;
}

export async function materializeRuntimeConfig(current, revision) {
  const result = composeRuntimeConfig(current, revision);
  if (result.subscription?.enabled && result.subscription.catalogPath) {
    const catalog = JSON.parse(await readFile(result.subscription.catalogPath, "utf8"));
    result.subscription.models = catalog.models
      .filter((model) => model.slug?.startsWith("gpt-"))
      .map((model) => model.slug);
  }
  return structuredClone(validate(result));
}

export function availableCodexModels(config) {
  const result = new Set(config.subscription?.models ?? []);
  for (const target of Object.values(config.targets ?? {}))
    if (target.app?.enabled) result.add(target.app.modelId ?? target.model);
  return result;
}

export function defaultCodexModel(config, preferred = null) {
  const allowed = availableCodexModels(config);
  if (preferred && allowed.has(preferred)) return preferred;
  for (const target of Object.values(config.targets ?? {}))
    if (target.app?.enabled) return target.app.modelId ?? target.model;
  return preferred && allowed.has(preferred) ? preferred : null;
}

export function spacePaths(env = process.env) {
  const paths = runtimePaths(env);
  return {
    ...paths,
    revision: (space, revision) => join(paths.spaces, space, `${revision}.json`),
  };
}

async function exclusiveJSON(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
  } finally {
    await handle.close();
  }
}

function revisionPayload(input) {
  const payload = {
    schemaVersion: SPACE_SCHEMA_VERSION,
    space: input.space,
    revision: input.revision,
    kind: input.kind,
    createdAt: input.createdAt ?? Date.now(),
    source: input.source,
    parent: input.parent ?? null,
    defaultCodexModel: input.defaultCodexModel ?? null,
    ...(input.kind === "router"
      ? { config: structuredClone(input.config) }
      : { codexBaseline: structuredClone(input.codexBaseline) }),
  };
  return { ...payload, contentHash: digestJSON(payload) };
}

function assertRevision(value, expected = {}) {
  if (
    value?.schemaVersion !== SPACE_SCHEMA_VERSION ||
    value.space !== expected.space ||
    (expected.revision != null && value.revision !== expected.revision)
  )
    throw Object.assign(Error("invalid configuration space revision"), {
      code: "space_revision_invalid",
    });
  const { contentHash, ...payload } = value;
  if (contentHash !== digestJSON(payload))
    throw Object.assign(Error("configuration space revision hash mismatch"), {
      code: "space_revision_tampered",
    });
  return value;
}

async function readRevisionAt(paths, space, revision) {
  const value = JSON.parse(await readFile(paths.revision(space, revision), "utf8"));
  return assertRevision(value, { space, revision });
}

export async function readSpaceIndex(env = process.env) {
  const value = await readJSON(spacePaths(env).spaceIndex, null);
  if (!value) return null;
  if (value.schemaVersion !== SPACE_SCHEMA_VERSION || !value.spaces)
    throw Object.assign(Error("invalid configuration space index"), {
      code: "space_index_invalid",
    });
  return value;
}

export async function readSpaceTransaction(env = process.env) {
  return readJSON(spacePaths(env).spaceTransaction, null);
}

export async function resolveSpace(input, env = process.env) {
  const paths = spacePaths(env);
  const index = await readSpaceIndex(env);
  if (!index)
    throw Object.assign(Error("configuration spaces are not initialized"), {
      code: "spaces_not_initialized",
    });
  const parsed = parseSpaceRef(input);
  const entry = index.spaces[parsed.space];
  if (!entry)
    throw Object.assign(Error(`configuration space does not exist: ${parsed.space}`), {
      code: "space_not_found",
    });
  const revision = parsed.revision ?? entry.latestRevision;
  return readRevisionAt(paths, parsed.space, revision);
}

async function catalogSnapshot(path) {
  try {
    const bytes = await readFile(path);
    return {
      present: true,
      sha256: fileDigest(bytes),
      bytesBase64: bytes.toString("base64"),
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { present: false };
  }
}

function baselineFromState(state) {
  return state?.baseline
    ? {
        managed: structuredClone(state.baseline),
        values: blockValues(Object.values(state.baseline)),
        ...(state.baselineCatalog
          ? { catalog: structuredClone(state.baselineCatalog) }
          : {}),
        ...(state.baselineCatalogBackup
          ? { legacyCatalogBackup: state.baselineCatalogBackup }
          : {}),
      }
    : null;
}

async function liveOfficialBaseline(paths, env, codexHome) {
  const configPath = env.CODEX_CONFIG_PATH ?? join(codexHome, "config.toml");
  const text = await readFile(configPath, "utf8");
  const baseline = inspectCodexBaseline(text);
  const routerCatalog = join(codexHome, "model-catalogs", "codex-local-router.json");
  return {
    ...baseline,
    catalog: await catalogSnapshot(routerCatalog),
  };
}

function initialIndex(defaultRevision, active) {
  const now = Date.now();
  return {
    schemaVersion: SPACE_SCHEMA_VERSION,
    spaces: {
      [OFFICIAL_SPACE]: { kind: "official", latestRevision: 1, createdAt: now },
      [DEFAULT_SPACE]: { kind: "router", latestRevision: 1, createdAt: now },
    },
    active,
    previous: null,
    materializedSpaceHash:
      active.space === DEFAULT_SPACE ? digestJSON(defaultRevision.config) : null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function initializeSpaces(options = {}) {
  const env = options.env ?? process.env;
  const paths = spacePaths(env);
  const existing = await readSpaceIndex(env);
  if (existing) return { changed: false, index: existing };
  const codexHome = options.codexHome ?? defaultCodexHome(env);
  const configPath = resolve(options.configPath ?? paths.config);
  const raw = options.config ?? JSON.parse(await readFile(configPath, "utf8"));
  const normalized = validate(raw);
  const integration = options.integrationState ?? (await readIntegrationState(env));
  if (integration?.status === "pending_app_quit")
    throw Object.assign(Error("resolve the existing pending integration before initializing spaces"), {
      code: "space_migration_pending",
    });
  if (integration && !["applied", "disabled"].includes(integration.status))
    throw Object.assign(Error("existing integration state is ambiguous"), {
      code: "space_migration_ambiguous",
    });
  const stateBaseline = baselineFromState(integration);
  const officialBaseline = stateBaseline ??
    (await liveOfficialBaseline(paths, env, codexHome));
  if (stateBaseline?.legacyCatalogBackup) {
    const bytes = await readFile(stateBaseline.legacyCatalogBackup).catch(() => null);
    officialBaseline.catalog = bytes
      ? { present: true, sha256: fileDigest(bytes), bytesBase64: bytes.toString("base64") }
      : { present: false };
    delete officialBaseline.legacyCatalogBackup;
  }
  officialBaseline.catalog ??= { present: false };
  const preferred = integration?.managed?.model ?? null;
  const router = revisionPayload({
    space: DEFAULT_SPACE,
    revision: 1,
    kind: "router",
    source: "migration",
    config: extractSpaceConfig(raw),
    defaultCodexModel: defaultCodexModel(normalized, preferred),
  });
  const official = revisionPayload({
    space: OFFICIAL_SPACE,
    revision: 1,
    kind: "official",
    source: integration ? "integration-baseline" : "official-direct",
    codexBaseline: officialBaseline,
    defaultCodexModel: officialBaseline.values?.model ?? null,
  });
  const active = {
    space: integration?.status === "applied" ? DEFAULT_SPACE : OFFICIAL_SPACE,
    revision: 1,
  };
  const index = initialIndex(router, active);
  const staging = `${paths.spaces}.init-${randomUUID()}`;
  try {
    await exclusiveJSON(join(staging, OFFICIAL_SPACE, "1.json"), official);
    await exclusiveJSON(join(staging, DEFAULT_SPACE, "1.json"), router);
    await exclusiveJSON(join(staging, "index.json"), index);
    await mkdir(dirname(paths.spaces), { recursive: true, mode: 0o700 });
    await rename(staging, paths.spaces);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (error.code === "EEXIST")
      throw Object.assign(Error("configuration space initialization raced with another process"), {
        code: "space_operation_conflict",
      });
    throw error;
  }
  return { changed: true, index, revisions: [official, router] };
}

export async function appendSpaceRevision(name, input, options = {}) {
  validateSpaceName(name);
  const env = options.env ?? process.env;
  const paths = spacePaths(env);
  return withFileLock(paths.spaceLock, async () => {
    const index = await readSpaceIndex(env);
    if (!index)
      throw Object.assign(Error("configuration spaces are not initialized"), {
        code: "spaces_not_initialized",
      });
    const entry = index.spaces[name];
    if (!entry)
      throw Object.assign(Error(`configuration space does not exist: ${name}`), {
        code: "space_not_found",
      });
    if (entry.kind !== input.kind)
      throw Object.assign(Error("configuration space kind cannot change"), {
        code: "space_kind_conflict",
      });
    if (
      options.expectedLatestRevision != null &&
      entry.latestRevision !== options.expectedLatestRevision
    ) throw Object.assign(Error(
      `configuration space changed after it was read: expected ${name}@${options.expectedLatestRevision}, found ${name}@${entry.latestRevision}`,
    ), { code: "space_operation_conflict" });
    const previous = await readRevisionAt(paths, name, entry.latestRevision);
    if (input.kind === "router") validate(input.config);
    const nextData = input.kind === "router"
      ? {
          config: extractSpaceConfig(input.config),
          defaultCodexModel: input.defaultCodexModel,
        }
      : {
          codexBaseline: input.codexBaseline,
          defaultCodexModel: input.defaultCodexModel,
        };
    const comparable = input.kind === "router"
      ? [previous.config, previous.defaultCodexModel]
      : [previous.codexBaseline, previous.defaultCodexModel];
    const nextComparable = input.kind === "router"
      ? [nextData.config, nextData.defaultCodexModel]
      : [nextData.codexBaseline, nextData.defaultCodexModel];
    if (digestJSON(comparable) === digestJSON(nextComparable))
      return { changed: false, revision: previous, index };
    const revisionNumber = entry.latestRevision + 1;
    const revision = revisionPayload({
      space: name,
      revision: revisionNumber,
      kind: input.kind,
      source: input.source,
      parent: { space: name, revision: entry.latestRevision },
      ...nextData,
    });
    await exclusiveJSON(paths.revision(name, revisionNumber), revision);
    const nextIndex = structuredClone(index);
    nextIndex.spaces[name].latestRevision = revisionNumber;
    nextIndex.updatedAt = Date.now();
    await atomicJSON(paths.spaceIndex, nextIndex);
    return { changed: true, revision, index: nextIndex };
  });
}

export async function createSpace(name, sourceRef, options = {}) {
  validateSpaceName(name);
  if (name === OFFICIAL_SPACE)
    throw Object.assign(Error("official is a reserved configuration space"), {
      code: "space_reserved",
    });
  const env = options.env ?? process.env;
  const paths = spacePaths(env);
  return withFileLock(paths.spaceLock, async () => {
    const index = await readSpaceIndex(env);
    if (!index)
      throw Object.assign(Error("configuration spaces are not initialized"), {
        code: "spaces_not_initialized",
      });
    if (index.spaces[name])
      throw Object.assign(Error(`configuration space already exists: ${name}`), {
        code: "space_exists",
      });
    const parsed = parseSpaceRef(sourceRef);
    const sourceEntry = index.spaces[parsed.space];
    if (!sourceEntry)
      throw Object.assign(Error(`configuration space does not exist: ${parsed.space}`), {
        code: "space_not_found",
      });
    const source = await readRevisionAt(
      paths,
      parsed.space,
      parsed.revision ?? sourceEntry.latestRevision,
    );
    if (source.kind !== "router")
      throw Object.assign(Error("new spaces must clone a Router space"), {
        code: "space_source_not_router",
      });
    const revision = revisionPayload({
      space: name,
      revision: 1,
      kind: "router",
      source: "clone",
      parent: { space: source.space, revision: source.revision },
      config: source.config,
      defaultCodexModel: source.defaultCodexModel,
    });
    await exclusiveJSON(paths.revision(name, 1), revision);
    const next = structuredClone(index);
    next.spaces[name] = { kind: "router", latestRevision: 1, createdAt: Date.now() };
    next.updatedAt = Date.now();
    await atomicJSON(paths.spaceIndex, next);
    return { changed: true, revision, index: next };
  });
}

export async function listConfigurationSpaces(env = process.env) {
  const index = await readSpaceIndex(env);
  if (!index) return [];
  return Promise.all(Object.entries(index.spaces).map(async ([name, entry]) => {
    const revision = await resolveSpace(`${name}@${entry.latestRevision}`, env);
    return {
      name,
      kind: entry.kind,
      latestRevision: entry.latestRevision,
      active: index.active?.space === name,
      activeRevision: index.active?.space === name ? index.active.revision : null,
      defaultCodexModel: revision.defaultCodexModel,
    };
  }));
}

export async function spaceHistory(name, env = process.env) {
  validateSpaceName(name);
  const index = await readSpaceIndex(env);
  const entry = index?.spaces?.[name];
  if (!entry)
    throw Object.assign(Error(`configuration space does not exist: ${name}`), {
      code: "space_not_found",
    });
  const result = [];
  for (let revision = entry.latestRevision; revision >= 1; revision--)
    result.push(await resolveSpace(`${name}@${revision}`, env));
  return result;
}

export function diffSpaceRevisions(left, right) {
  const changes = [];
  const walk = (a, b, prefix = "") => {
    if (
      a && b && typeof a === "object" && typeof b === "object" &&
      !Array.isArray(a) && !Array.isArray(b)
    ) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
        walk(a[key], b[key], prefix ? `${prefix}.${key}` : key);
    } else if (JSON.stringify(a) !== JSON.stringify(b))
      changes.push({ path: prefix, before: a, after: b });
  };
  walk(
    left.kind === "router" ? { defaultCodexModel: left.defaultCodexModel, config: left.config } : { defaultCodexModel: left.defaultCodexModel, codexBaseline: left.codexBaseline },
    right.kind === "router" ? { defaultCodexModel: right.defaultCodexModel, config: right.config } : { defaultCodexModel: right.defaultCodexModel, codexBaseline: right.codexBaseline },
  );
  return changes;
}

export async function detectSpaceDrift(options = {}) {
  const env = options.env ?? process.env;
  const paths = spacePaths(env);
  const index = await readSpaceIndex(env);
  if (!index || index.active?.space === OFFICIAL_SPACE)
    return { drift: false, active: index?.active ?? null };
  const active = await resolveSpace(`${index.active.space}@${index.active.revision}`, env);
  const raw = JSON.parse(await readFile(resolve(options.configPath ?? paths.config), "utf8"));
  const actual = extractSpaceConfig(raw);
  const drift = digestJSON(actual) !== digestJSON(active.config);
  return {
    drift,
    active: index.active,
    expectedHash: digestJSON(active.config),
    actualHash: digestJSON(actual),
  };
}

export async function captureRouterSpace(name, options = {}) {
  validateSpaceName(name);
  if (name === OFFICIAL_SPACE)
    throw Object.assign(Error("official space is captured from Codex settings, not Router config"), {
      code: "space_capture_kind_conflict",
    });
  const env = options.env ?? process.env;
  const paths = spacePaths(env);
  const raw = options.config ?? JSON.parse(
    await readFile(resolve(options.configPath ?? paths.config), "utf8"),
  );
  const normalized = validate(raw);
  return appendSpaceRevision(name, {
    kind: "router",
    source: options.source ?? "capture",
    config: raw,
    defaultCodexModel:
      options.defaultCodexModel ?? defaultCodexModel(normalized),
  }, { env, expectedLatestRevision: options.expectedLatestRevision });
}

export async function captureOfficialSpace(options = {}) {
  const env = options.env ?? process.env;
  const paths = spacePaths(env);
  const index = await readSpaceIndex(env);
  if (!index)
    throw Object.assign(Error("configuration spaces are not initialized"), {
      code: "spaces_not_initialized",
    });
  if (index.active?.space !== OFFICIAL_SPACE)
    throw Object.assign(Error("official settings can only be captured while official is active"), {
      code: "official_space_not_active",
    });
  const baseline = options.codexBaseline ?? await liveOfficialBaseline(
    paths,
    env,
    options.codexHome ?? defaultCodexHome(env),
  );
  const activeRevision = await resolveSpace(
    `${OFFICIAL_SPACE}@${index.active.revision}`,
    env,
  );
  const nextDefault = baseline.values?.model ?? null;
  if (
    digestJSON([activeRevision.codexBaseline, activeRevision.defaultCodexModel]) ===
    digestJSON([baseline, nextDefault])
  ) return { changed: false, revision: activeRevision, index };
  const result = await appendSpaceRevision(OFFICIAL_SPACE, {
    kind: "official",
    source: options.source ?? "official-auto-capture",
    codexBaseline: baseline,
    defaultCodexModel: nextDefault,
  }, { env, expectedLatestRevision: index.spaces[OFFICIAL_SPACE].latestRevision });
  const next = await withFileLock(paths.spaceLock, async () => {
    const current = await readSpaceIndex(env);
    if (
      current.active?.space !== OFFICIAL_SPACE ||
      current.active.revision !== index.active.revision
    )
      throw Object.assign(Error("active official space changed during capture"), {
        code: "space_operation_conflict",
      });
    const updated = structuredClone(current);
    updated.active = { space: OFFICIAL_SPACE, revision: result.revision.revision };
    updated.updatedAt = Date.now();
    await atomicJSON(paths.spaceIndex, updated);
    return updated;
  });
  return { ...result, index: next };
}

export async function commitSpaceActivation(target, options = {}) {
  const env = options.env ?? process.env;
  const paths = spacePaths(env);
  return withFileLock(paths.spaceLock, async () => {
    const index = await readSpaceIndex(env);
    if (!index)
      throw Object.assign(Error("configuration spaces are not initialized"), {
        code: "spaces_not_initialized",
      });
    const expected = options.expectedActive;
    if (
      expected &&
      (index.active?.space !== expected.space || index.active?.revision !== expected.revision)
    )
      throw Object.assign(Error("active configuration space changed during switch"), {
        code: "space_operation_conflict",
      });
    const revision = await resolveSpace(`${target.space}@${target.revision}`, env);
    const updated = structuredClone(index);
    if (
      updated.active?.space !== target.space ||
      updated.active?.revision !== target.revision
    ) updated.previous = updated.active ?? null;
    updated.active = { space: target.space, revision: target.revision };
    updated.materializedSpaceHash = revision.kind === "router"
      ? digestJSON(revision.config)
      : null;
    updated.updatedAt = Date.now();
    await atomicJSON(paths.spaceIndex, updated);
    return updated;
  });
}

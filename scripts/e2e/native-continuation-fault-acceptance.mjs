#!/usr/bin/env node
// Isolated replay of the reported missing-observation and oversized-tail tasks.
// Evidence contains hashes, counts and terminal metadata only.
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Archive, defaultStatePath, historyKey } from "../../src/archive.mjs";
import {
  applyRolloutRecovery,
  checkpointScope,
  planRolloutRecovery,
  verifyRolloutRecoverySources,
} from "../../src/rollout.mjs";
import {
  isolatedCodexHome,
  resolveCore,
  startAppServer,
  startIsolatedGateway,
  verifyAcceptanceRevision,
  writeCatalog,
} from "./lib/harness.mjs";
import { FocusedAcceptanceBudget } from "./lib/focused-budget.mjs";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? undefined : argv[index + 1];
};
if (!flag("run")) {
  console.error("Fault-history acceptance copies rollout and archive state into isolated storage. Re-run with --run after reviewing docs/public/acceptance.md.");
  process.exit(2);
}
if (!process.env.ACCEPTANCE_COMMIT) throw Error("ACCEPTANCE_COMMIT is required");

const thread409 = value("thread-409");
const thread413 = value("thread-413");
const source409 = value("source-409");
const source413 = value("source-413");
const threadFirstMigration = value("thread-first-migration");
const sourceFirstMigration = value("source-first-migration");
if (![thread409, thread413, source409, source413].every(Boolean))
  throw Error("--thread-409, --source-409, --thread-413 and --source-413 are required");
if (Boolean(threadFirstMigration) !== Boolean(sourceFirstMigration))
  throw Error("--thread-first-migration and --source-first-migration must be provided together");
const includeFirstMigration = Boolean(threadFirstMigration);

const projectRoot = resolve(import.meta.dirname, "..", "..");
const sourceConfig = value("config") ?? join(homedir(), "Library", "Application Support", "Codex Local Router", "config.json");
const sourceCatalog = value("catalog") ?? join(homedir(), ".codex", "models_cache.json");
const authSource = value("auth") ?? join(homedir(), ".codex", "auth.json");
const sessionsRoot = value("sessions-root") ?? join(homedir(), ".codex", "sessions");
const output = value("out") ? resolve(value("out")) : null;
const maxGenerations = Number(value("max-generations") ?? 64);
if (!Number.isSafeInteger(maxGenerations) || maxGenerations < 1)
  throw Object.assign(Error("--max-generations must be a positive safe integer"), {
    code: "generation_budget_invalid",
  });

const root = await mkdtemp(join(tmpdir(), "codex-router-native-faults-"));
const workspace = join(root, "workspace");
const configPath = join(root, "gateway.json");
const budget = new FocusedAcceptanceBudget({
  maxTurns: includeFirstMigration ? 4 : 3,
  maxGenerations,
});
const gateways = [];
const cases = [];
let source;
let core;
let checkpointTargets = {};
let implementation = { commit: "working-tree" };
let harnessError = null;
let stage = "initialize";

const checkpointFingerprints = (plan) => plan.checkpoints.map(({ item }) =>
  createHash("sha256").update(item.encrypted_content).digest("hex"));

function rolloutLocation(path, sourceSessionsRoot) {
  for (const [directory, root] of [
    ["sessions", sourceSessionsRoot],
    ["archived_sessions", join(dirname(sourceSessionsRoot), "archived_sessions")],
  ]) {
    const sourceRelative = relative(resolve(root), resolve(path));
    if (
      !isAbsolute(sourceRelative) &&
      sourceRelative !== ".." &&
      !sourceRelative.startsWith(`..${sep}`)
    ) return { directory, sourceRelative };
  }
  throw Object.assign(Error("rollout source is outside Codex history roots"), {
    code: "rollout_source_outside_history_roots",
  });
}

async function copyRollouts(plan, home) {
  const sourceRoot = plan.sessionsRoot ?? sessionsRoot;
  for (const file of plan.files) {
    const { directory, sourceRelative } = rolloutLocation(file.path, sourceRoot);
    const destination = join(home, directory, sourceRelative);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(file.path, destination);
  }
}

async function snapshotRolloutPlan(plan, name, { throughReported413 = false } = {}) {
  const snapshotHome = join(root, "source-snapshots", name);
  const snapshotRoot = join(snapshotHome, "sessions");
  let source;
  for (const file of plan.files) {
    const { directory, sourceRelative } = rolloutLocation(file.path, sessionsRoot);
    const destination = join(snapshotHome, directory, sourceRelative);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    if (throughReported413 && file.thread === plan.thread) {
      const lines = (await readFile(file.path, "utf8")).trimEnd().split(/\r?\n/);
      const cutoff = lines.findIndex((line) => {
        const record = JSON.parse(line);
        return record.type === "event_msg" &&
          record.payload?.type === "task_complete" &&
          JSON.stringify(record.payload.error ?? {}).includes(
            "unsummarized continuation tail already occupies the target context",
          );
      });
      if (cutoff < 0)
        throw Object.assign(Error("reported 413 boundary is missing"), {
          code: "reported_413_boundary_missing",
        });
      await writeFile(destination, `${lines.slice(0, cutoff + 1).join("\n")}\n`, {
        mode: 0o600,
      });
    } else {
      await copyFile(file.path, destination);
    }
    if (file.thread === plan.thread) source = destination;
  }
  if (!source) throw Object.assign(Error("rollout source thread is missing"), {
    code: "rollout_source_thread_missing",
  });
  const snapshot = await planRolloutRecovery({
    thread: plan.thread,
    source,
    sessionsRoot: snapshotRoot,
    checkpointTargets,
  });
  await verifyRolloutRecoverySources(snapshot);
  return { ...snapshot, sessionsRoot: snapshotRoot };
}

function insertRows(database, table, rows) {
  if (!rows.length) return;
  const columns = Object.keys(rows[0]);
  const statement = database.prepare(
    `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
  );
  for (const row of rows) statement.run(...columns.map((column) => row[column]));
}

function snapshotArchiveScope(sourcePath, targetPath, key, scope) {
  const sourceArchive = new DatabaseSync(sourcePath, { readOnly: true });
  const targetArchive = new Archive(targetPath, key);
  try {
    sourceArchive.exec("BEGIN");
    const values = [
      targetArchive.opaque(scope.owner),
      targetArchive.opaque(scope.thread),
      targetArchive.opaque(scope.branch),
    ];
    const scoped = (table) => sourceArchive
      .prepare(`SELECT * FROM ${table} WHERE owner=? AND thread=? AND branch=?`)
      .all(...values);
    const rows = {
      branches: scoped("branches"),
      history_versions: scoped("history_versions"),
      history_event_items: scoped("history_event_items"),
      records: scoped("records"),
      operations: scoped("operations"),
    };
    const referencedHistory = rows.records
      .map((row) => sourceArchive
        .prepare("SELECT hash,body FROM blobs WHERE hash=?")
        .get(row.hash))
      .map((row) => targetArchive.decode(row)?.historyRef)
      .filter((ref) =>
        ref?.owner && ref.thread && ref.branch && Number.isSafeInteger(ref.version));
    for (const ref of referencedHistory) {
      const values = [
        targetArchive.opaque(ref.owner),
        targetArchive.opaque(ref.thread),
        targetArchive.opaque(ref.branch),
      ];
      rows.branches.push(...sourceArchive
        .prepare("SELECT * FROM branches WHERE owner=? AND thread=? AND branch=?")
        .all(...values));
      rows.history_versions.push(...sourceArchive.prepare(`
        SELECT * FROM history_versions
        WHERE owner=? AND thread=? AND branch=? AND version<=?
      `).all(...values, ref.version));
      rows.history_event_items.push(...sourceArchive.prepare(`
        SELECT * FROM history_event_items
        WHERE owner=? AND thread=? AND branch=? AND version<=?
      `).all(...values, ref.version));
    }
    for (const table of ["branches", "history_versions", "history_event_items"])
      rows[table] = [...new Map(rows[table].map((row) =>
        [JSON.stringify(row), row])).values()];
    const hashes = new Set([
      ...rows.records.map((row) => row.hash),
      ...rows.history_versions.flatMap((row) => [row.original_hash, row.view_hash]),
      ...rows.history_event_items.map((row) => row.hash),
      ...rows.operations.map((row) => row.result_hash).filter(Boolean),
    ]);
    const blobs = [...hashes].map((hash) =>
      sourceArchive.prepare("SELECT * FROM blobs WHERE hash=?").get(hash));
    if (blobs.some((row) => !row))
      throw Object.assign(Error("scoped archive references a missing blob"), {
        code: "archive_scope_incomplete",
      });
    targetArchive.transaction(() => {
      insertRows(targetArchive.db, "blobs", blobs);
      for (const table of [
        "branches", "history_versions", "history_event_items", "records", "operations",
      ]) insertRows(targetArchive.db, table, rows[table]);
    });
    sourceArchive.exec("COMMIT");
    return Object.fromEntries([
      ["blobs", blobs],
      ...Object.entries(rows),
    ].map(([table, entries]) => [table, entries.length]));
  } catch (error) {
    try { sourceArchive.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    sourceArchive.close();
    targetArchive.close();
  }
}

function mutate(config) {
  config.providers = { feei: structuredClone(source.providers.feei) };
  config.targets = { "feei-sol": structuredClone(source.targets["feei-sol"]) };
  config.defaultTarget = "feei-sol";
  config.rules = [];
  config.subscription.enabled = true;
  config.subscription.catalogPath = sourceCatalog;
  config.subscription.customModels = {
    [config.targets["feei-sol"].app.modelId]: "feei-sol",
  };
}

async function startGateway(archivePath, archiveKey, seed) {
  const instance = await startIsolatedGateway({
    configPath,
    authSource,
    tokenFile: join(root, `access-token-${seed}`),
    archivePath,
    archiveKey,
    seed,
    mutate,
    toolCodexHome: join(root, "tool-registry"),
    beforeOutbound: (event) => budget.beforeOutbound(event),
  });
  gateways.push(instance);
  return instance;
}

async function configureHome(home, gateway, plan) {
  const model = gateway.config.targets["feei-sol"].app.modelId;
  const catalogPath = join(home, "models.json");
  await isolatedCodexHome({
    home,
    baseUrl: `${gateway.url}/subscription/v1`,
    catalogPath,
    authSource,
    model,
    reasoningEffort: "low",
    webSearch: "disabled",
  });
  await copyRollouts(plan, home);
  await writeCatalog({ sourceCatalogPath: sourceCatalog, config: gateway.config, targetPath: catalogPath });
  return model;
}

async function requestCopiedThread(app, thread, model, prompt) {
  budget.beginTurn();
  await app.rpc("thread/resume", {
    threadId: thread,
    model,
    modelProvider: "openai",
    cwd: workspace,
    excludeTurns: true,
    sandbox: "read-only",
    approvalPolicy: "never",
  });
  budget.activeAbort = () => app.close();
  try {
    return await app.request(thread, model, prompt, { timeoutMs: 360000 });
  } finally {
    budget.activeAbort = null;
  }
}

const providerCalls = (gateway) => {
  const host = new URL(gateway.config.providers.feei.baseUrl).host;
  return gateway.outbound.filter((entry) =>
    entry.host === host && entry.path.endsWith("/responses"));
};
const gatewayErrors = (gateway) => gateway.logs.filter((entry) =>
  ["request_error", "ws_error"].includes(entry.event));

async function run409(plan) {
  stage = "409:missing-checkpoint";
  const home = join(root, "fault-409-home");
  const archivePath = join(root, "fault-409.sqlite");
  const key = createHash("sha256").update("fault-409-isolated-archive").digest();
  let gateway = await startGateway(archivePath, key, 409);
  const missingGateway = gateway;
  const model = await configureHome(home, gateway, plan);
  let app = startAppServer({ corePath: core.path, home, cwd: workspace });
  let missingTurn;
  try {
    await app.initialize("codex_local_router_fault_409_missing");
    missingTurn = await requestCopiedThread(
      app,
      thread409,
      model,
      "Do not call tools. Reply with one historical fact already present in this task.",
    );
  } finally {
    await app.close().catch(() => {});
    await gateway.close().catch(() => {});
  }
  const missingErrors = gatewayErrors(gateway).filter((entry) =>
    entry.type === "history_observation_incomplete" && entry.status === 409);
  const blockedBeforeProvider = providerCalls(gateway).length === 0;

  stage = "409:explicit-recovery";
  await verifyRolloutRecoverySources(plan);
  const recoveryArchive = new Archive(archivePath, key);
  const account = `chatgpt:${gateway.subscriptionAccountId}`;
  const recovery = applyRolloutRecovery(recoveryArchive, plan, { account, apply: true });
  recoveryArchive.close();

  gateway = await startGateway(archivePath, key, 410);
  await configureHome(home, gateway, plan);
  app = startAppServer({ corePath: core.path, home, cwd: workspace });
  let recoveredTurn;
  try {
    await app.initialize("codex_local_router_fault_409_recovered");
    recoveredTurn = await requestCopiedThread(
      app,
      thread409,
      model,
      "Do not call tools. Reply with one historical fact already present in this task and end with RECOVERY_OK.",
    );
  } finally {
    await app.close().catch(() => {});
    await gateway.close().catch(() => {});
  }
  const recoveryErrors = gatewayErrors(gateway);
  const summaryEvents = gateway.logs.filter((entry) =>
    ["summary_started", "native_migration_summary_source_terminal",
      "native_migration_summary_completed", "native_migration_summary_reused"].includes(entry.event));
  const summaryStarts = summaryEvents.filter((entry) => entry.event === "summary_started");
  const assertions = {
    missingCheckpointReproduced: missingTurn.status !== "completed" && missingErrors.length > 0,
    blockedBeforeProvider,
    explicitRecoveryApplied: recovery.written > 0,
    recoveredTurnCompleted: recoveredTurn.status === "completed" && recoveredTurn.text.includes("RECOVERY_OK"),
    reachedProviderAfterRecovery: providerCalls(gateway).length > 0,
    toolsNotExecuted: missingTurn.items.length === 0 && recoveredTurn.items.length === 0,
    gatewaySummaryCallsZero: summaryStarts.length === 0,
    noPostRecoveryGatewayError: recoveryErrors.length === 0,
  };
  const passed = Object.values(assertions).every(Boolean);
  cases.push({
    name: "reported-409-rollout-copy",
    compressionOwner: "chatgpt-subscription",
    passed,
    assertions,
    source: {
      files: plan.files.length,
      relevantRecords: plan.relevantRecords,
      checkpoints: plan.checkpoints.length,
      sourceHash: plan.sourceHash,
      checkpointFingerprints: checkpointFingerprints(plan),
    },
    recovery: {
      written: recovery.written,
      existing: recovery.existing,
      enriched: recovery.enriched,
    },
    counts: {
      missingAttemptErrors: missingErrors.length,
      providerCallsAfterRecovery: providerCalls(gateway).length,
      summaryCalls: summaryStarts.length,
      toolExecutions: missingTurn.items.length + recoveredTurn.items.length,
    },
    requestIds: [...new Set([missingGateway, gateway]
      .flatMap((instance) => instance.logs)
      .map((entry) => entry.request_id)
      .filter(Boolean))],
    timings: providerCalls(gateway).map((entry) => ({
      firstSubstantiveMs: entry.firstSubstantiveMs ?? null,
      firstTextMs: entry.firstTextMs ?? null,
      totalMs: entry.totalMs ?? null,
    })),
    terminal: {
      beforeRecovery: missingTurn.status,
      afterRecovery: recoveredTurn.status,
      failureType: recoveredTurn.turnFailure?.type ?? null,
    },
    migration: summaryEvents.map((entry) => ({
      event: entry.event,
      status: entry.status ?? null,
      category: entry.category ?? null,
      terminalType: entry.terminal_type ?? null,
      responseStatus: entry.response_status ?? null,
      incompleteReason: entry.incomplete_reason ?? null,
      errorType: entry.error_type ?? null,
      errorCode: entry.error_code ?? null,
      errorParam: entry.error_param ?? null,
      errorCategory: entry.error_category ?? null,
    })),
    gatewayErrors: recoveryErrors.map((entry) => ({
      type: entry.type ?? null,
      status: entry.status ?? null,
      phase: entry.phase ?? null,
    })),
  });
  return passed;
}

async function run413(plan) {
  stage = "413:archive-snapshot";
  const sourceArchive = source.history?.persistent?.path ?? defaultStatePath();
  const archivePath = join(root, "fault-413.sqlite");
  const key = await historyKey({
    ...source.history?.persistent,
    existing: true,
  });
  const accountId = JSON.parse(await readFile(authSource, "utf8")).tokens?.account_id;
  if (typeof accountId !== "string" || !accountId)
    throw Object.assign(Error("subscription account id is missing"), {
      code: "subscription_account_missing",
    });
  const account = `chatgpt:${accountId}`;
  const { scope } = checkpointScope(account, thread413);
  const snapshot = snapshotArchiveScope(sourceArchive, archivePath, key, scope);
  await verifyRolloutRecoverySources(plan);

  stage = "413:migration-reuse";
  const home = join(root, "fault-413-home");
  const gateway = await startGateway(archivePath, key, 413);
  const model = await configureHome(home, gateway, plan);
  if (gateway.subscriptionAccountId !== accountId)
    throw Object.assign(Error("subscription account changed during archive snapshot"), {
      code: "subscription_account_changed",
    });
  const checkpointStats = gateway.archive.checkpointStats(scope);
  const archivedCheckpoints = checkpointStats.portable + checkpointStats.unrecoverable;
  const app = startAppServer({ corePath: core.path, home, cwd: workspace });
  let turn;
  try {
    await app.initialize("codex_local_router_fault_413_reuse");
    turn = await requestCopiedThread(
      app,
      thread413,
      model,
      "Do not call tools. Reply with one historical fact already present in this task and end with CONTINUATION_OK.",
    );
  } finally {
    await app.close().catch(() => {});
    await gateway.close().catch(() => {});
  }
  const calls = providerCalls(gateway);
  const errors = gatewayErrors(gateway);
  const summaryCalls = gateway.logs.filter((entry) =>
    ["summary_started", "native_migration_summary_completed"].includes(entry.event));
  const reused = gateway.logs.filter((entry) =>
    entry.event === "native_migration_summary_reused");
  const assertions = {
    copiedArchiveHasCheckpoints: archivedCheckpoints > 0,
    existingMigrationReused: reused.length > 0,
    noDuplicateSummary: summaryCalls.length === 0,
    noLocalTail413: errors.every((entry) => entry.status !== 413),
    reachedProvider: calls.length > 0,
    turnCompleted: turn.status === "completed" && turn.text.includes("CONTINUATION_OK"),
    toolsNotExecuted: turn.items.length === 0,
  };
  cases.push({
    name: "reported-413-rollout-and-archive-copy",
    compressionOwner: "chatgpt-subscription",
    passed: Object.values(assertions).every(Boolean),
    assertions,
    source: {
      files: plan.files.length,
      relevantRecords: plan.relevantRecords,
      checkpoints: plan.checkpoints.length,
      sourceHash: plan.sourceHash,
      checkpointFingerprints: checkpointFingerprints(plan),
      archivedCheckpoints,
      snapshot,
    },
    counts: {
      providerCalls: calls.length,
      migrationReuses: reused.length,
      summaryCalls: summaryCalls.length,
      toolExecutions: turn.items.length,
    },
    requestIds: [...new Set(gateway.logs.map((entry) => entry.request_id).filter(Boolean))],
    timings: calls.map((entry) => ({
      firstSubstantiveMs: entry.firstSubstantiveMs ?? null,
      firstTextMs: entry.firstTextMs ?? null,
      totalMs: entry.totalMs ?? null,
    })),
    terminal: {
      status: turn.status,
      failureType: turn.turnFailure?.type ?? null,
      providerStatuses: calls.map((entry) => entry.status ?? null),
      providerComplete: calls.map((entry) => entry.responseComplete ?? false),
      gatewayErrors: errors.map((entry) => ({
        type: entry.type ?? null,
        status: entry.status ?? null,
        phase: entry.phase ?? null,
      })),
    },
  });
}

async function runFirstMigration(plan) {
  stage = "first-migration:archive-snapshot";
  const sourceArchive = source.history?.persistent?.path ?? defaultStatePath();
  const archivePath = join(root, "first-migration.sqlite");
  const key = await historyKey({
    ...source.history?.persistent,
    existing: true,
  });
  const accountId = JSON.parse(await readFile(authSource, "utf8")).tokens?.account_id;
  if (typeof accountId !== "string" || !accountId)
    throw Object.assign(Error("subscription account id is missing"), {
      code: "subscription_account_missing",
    });
  const account = `chatgpt:${accountId}`;
  const { scope } = checkpointScope(account, threadFirstMigration);
  const snapshot = snapshotArchiveScope(sourceArchive, archivePath, key, scope);
  await verifyRolloutRecoverySources(plan);

  stage = "first-migration:portable-budget";
  const home = join(root, "first-migration-home");
  const gateway = await startGateway(archivePath, key, 414);
  const model = await configureHome(home, gateway, plan);
  if (gateway.subscriptionAccountId !== accountId)
    throw Object.assign(Error("subscription account changed during archive snapshot"), {
      code: "subscription_account_changed",
    });
  const before = gateway.archive.checkpoints(scope);
  const completedBefore = before.filter(({ value }) =>
    value.migration?.targetId === "feei-sol" &&
    value.migration?.status === "completed").length;
  const archivedCheckpoints = before.length;
  const app = startAppServer({ corePath: core.path, home, cwd: workspace });
  let turn;
  let completedAfter = completedBefore;
  try {
    await app.initialize("codex_local_router_first_migration_portable_budget");
    turn = await requestCopiedThread(
      app,
      threadFirstMigration,
      model,
      "Do not call tools. Reply with one historical fact already present in this task and end with FIRST_MIGRATION_OK.",
    );
    completedAfter = gateway.archive.checkpoints(scope).filter(({ value }) =>
      value.migration?.targetId === "feei-sol" &&
      value.migration?.status === "completed").length;
  } finally {
    await app.close().catch(() => {});
    await gateway.close().catch(() => {});
  }
  const calls = providerCalls(gateway);
  const errors = gatewayErrors(gateway);
  const summaryStarts = gateway.logs.filter((entry) => entry.event === "summary_started");
  const completed = gateway.logs.filter((entry) =>
    entry.event === "native_migration_summary_completed");
  const reused = gateway.logs.filter((entry) =>
    entry.event === "native_migration_summary_reused");
  const budgetEvents = gateway.logs.filter((entry) =>
    entry.event === "native_migration_summary_budget");
  const portableBudget = budgetEvents.find((entry) =>
    entry.decision === "summary_required" &&
    entry.fixed_tokens < entry.input_budget);
  const assertions = {
    copiedArchiveHasCheckpoints: archivedCheckpoints > 0,
    noExistingMigration: completedBefore === 0,
    oneSummaryGenerated: summaryStarts.length === 1 && completed.length === 1,
    noPrematureSummaryReuse: reused.length === 0,
    portableBudgetApplied: Boolean(portableBudget),
    noLocalTail413: errors.every((entry) => entry.status !== 413),
    reachedProviderExactlyOnce: calls.length === 1,
    turnCompleted: turn.status === "completed" && turn.text.includes("FIRST_MIGRATION_OK"),
    toolsNotExecuted: turn.items.length === 0,
    completedMigrationPersisted: completedAfter > completedBefore,
  };
  cases.push({
    name: "reported-first-migration-private-reasoning-copy",
    compressionOwner: "chatgpt-subscription",
    passed: Object.values(assertions).every(Boolean),
    assertions,
    source: {
      files: plan.files.length,
      relevantRecords: plan.relevantRecords,
      checkpoints: plan.checkpoints.length,
      sourceHash: plan.sourceHash,
      checkpointFingerprints: checkpointFingerprints(plan),
      archivedCheckpoints,
      snapshot,
    },
    counts: {
      providerCalls: calls.length,
      summaryCalls: summaryStarts.length,
      migrationCompletions: completed.length,
      migrationReuses: reused.length,
      persistedMigrationsBefore: completedBefore,
      persistedMigrationsAfter: completedAfter,
      toolExecutions: turn.items.length,
    },
    budget: portableBudget ? {
      inputBudget: portableBudget.input_budget,
      fixedTokens: portableBudget.fixed_tokens,
      projectedTokens: portableBudget.projected_tokens,
      decision: portableBudget.decision,
    } : null,
    requestIds: [...new Set(gateway.logs.map((entry) => entry.request_id).filter(Boolean))],
    timings: calls.map((entry) => ({
      firstSubstantiveMs: entry.firstSubstantiveMs ?? null,
      firstTextMs: entry.firstTextMs ?? null,
      totalMs: entry.totalMs ?? null,
    })),
    terminal: {
      status: turn.status,
      failureType: turn.turnFailure?.type ?? null,
      providerStatuses: calls.map((entry) => entry.status ?? null),
      providerComplete: calls.map((entry) => entry.responseComplete ?? false),
      gatewayErrors: errors.map((entry) => ({
        type: entry.type ?? null,
        status: entry.status ?? null,
        phase: entry.phase ?? null,
      })),
    },
  });
}

try {
  stage = "revision-check";
  implementation = await verifyAcceptanceRevision(projectRoot, process.env.ACCEPTANCE_COMMIT);
  stage = "source-config";
  source = JSON.parse(await readFile(sourceConfig, "utf8"));
  if (!source.providers?.feei || !source.targets?.["feei-sol"] ||
      source.targets["feei-sol"].compression?.mode !== "native")
    throw Object.assign(Error("FEEI Sol native source configuration is missing"), {
      code: "source_configuration_incomplete",
    });
  checkpointTargets = Object.fromEntries(
    Object.entries(source.targets)
      .filter(([, target]) => target.app?.modelId)
      .map(([targetId, target]) => [
        target.app.modelId,
        { provider: target.provider, model: target.model, targetId },
      ]),
  );
  const base = JSON.parse(await readFile(join(projectRoot, "config", "gateway.example.json"), "utf8"));
  base.subscription.enabled = true;
  base.subscription.catalogPath = sourceCatalog;
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await mkdir(join(root, "tool-registry"), { recursive: true, mode: 0o700 });
  await writeFile(configPath, `${JSON.stringify(base)}\n`, { mode: 0o600 });
  core = await resolveCore();

  stage = "rollout-planning";
  const discovered409 = await planRolloutRecovery({
    thread: thread409,
    source: resolve(source409),
    sessionsRoot,
    checkpointTargets,
  });
  const discovered413 = await planRolloutRecovery({
    thread: thread413,
    source: resolve(source413),
    sessionsRoot,
    checkpointTargets,
  });
  const discoveredFirstMigration = includeFirstMigration
    ? await planRolloutRecovery({
      thread: threadFirstMigration,
      source: resolve(sourceFirstMigration),
      sessionsRoot,
      checkpointTargets,
    })
    : null;
  const [plan409, plan413, planFirstMigration] = await Promise.all([
    snapshotRolloutPlan(discovered409, "409"),
    snapshotRolloutPlan(discovered413, "413", { throughReported413: true }),
    discoveredFirstMigration
      ? snapshotRolloutPlan(discoveredFirstMigration, "first-migration")
      : null,
  ]);
  await Promise.all([
    verifyRolloutRecoverySources(plan409),
    verifyRolloutRecoverySources(plan413),
    planFirstMigration ? verifyRolloutRecoverySources(planFirstMigration) : null,
  ]);
  if (!await run409(plan409))
    throw Object.assign(Error("409 fault-copy acceptance failed"), {
      code: "fault_409_acceptance_failed",
    });
  await run413(plan413);
  if (planFirstMigration) await runFirstMigration(planFirstMigration);
} catch (error) {
  const rpc = /^rpc (\{.*\})$/s.exec(String(error?.message ?? ""));
  let rpcError = null;
  try {
    rpcError = rpc ? JSON.parse(rpc[1]) : null;
  } catch {}
  harnessError = {
    type: error?.type ?? error?.code ?? error?.name ?? "acceptance_error",
    stage,
    rpcCode: rpcError?.code ?? null,
    rpcMessage: typeof rpcError?.message === "string" ? rpcError.message.slice(0, 300) : null,
  };
} finally {
  await Promise.allSettled(gateways.map((entry) => entry.close()));
  await rm(root, { recursive: true, force: true });
}

const summary = {
  verdict: !harnessError &&
    cases.length === (includeFirstMigration ? 3 : 2) &&
    cases.every((entry) => entry.passed)
    ? "PASS"
    : "FAIL",
  implementation,
  driver: core ? { source: core.source, version: core.version, sha256: core.sha256 } : null,
  target: "feei-sol",
  profile: source?.targets?.["feei-sol"]?.app?.useResponsesLite ? "source-lite" : "source-standard",
  budget: budget.snapshot(),
  cases,
  harnessError,
  sourceWriteOperations: 0,
  sourceArchiveAccess: "sqlite-read-only-scope-snapshot",
  appUi: "not-tested",
};
if (output) {
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}
console.log(JSON.stringify(summary, null, 2));
if (summary.verdict !== "PASS") process.exitCode = 1;

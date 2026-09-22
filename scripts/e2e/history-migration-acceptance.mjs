#!/usr/bin/env node
// Bounded live lifecycle gate: official compaction -> fork -> third-party tool
// continuation -> Gateway/App restart -> official continuation. Evidence is
// structural metadata only; prompts, tool output and credentials are omitted.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  classifyTurnRepeats,
  isolatedCodexHome,
  hasCompactionEvidence,
  resolveCore,
  startAppServer,
  startIsolatedGateway,
  verifyAcceptanceRevision,
  writeCatalog,
} from "./lib/harness.mjs";
import { FocusedAcceptanceBudget } from "./lib/focused-budget.mjs";
import { checkpointKey, isCompaction } from "../../src/history.mjs";
import { threadOwner } from "../../src/state.mjs";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? undefined : argv[index + 1];
};
if (!flag("run")) {
  console.error("History migration acceptance runs bounded HTTP and WebSocket lifecycle chains. Re-run with --run after reviewing docs/public/acceptance.md.");
  process.exit(2);
}
if (!process.env.ACCEPTANCE_COMMIT) throw Error("ACCEPTANCE_COMMIT is required");

const projectRoot = resolve(import.meta.dirname, "..", "..");
const authSource = value("auth") ?? join(homedir(), ".codex", "auth.json");
const sourceCatalog = value("catalog") ?? join(homedir(), ".codex", "models_cache.json");
const sourceConfig = value("config") ?? join(homedir(), "Library", "Application Support", "Codex Local Router", "config.json");
const officialModel = value("official-model") ?? "gpt-5.6-sol";
const output = value("out") ? resolve(value("out")) : null;
const maxGenerations = Number(value("max-generations") ?? 36);
if (!Number.isSafeInteger(maxGenerations) || maxGenerations < 1)
  throw Object.assign(Error("--max-generations must be a positive safe integer"), {
    code: "generation_budget_invalid",
  });

const root = await mkdtemp(join(tmpdir(), "codex-router-history-migration-"));
const workspace = join(root, "workspace");
const configPath = join(root, "gateway.json");
const budget = new FocusedAcceptanceBudget({ maxTurns: 20, maxGenerations });
const cases = [];
const gateways = [];
let core;
let source;
let implementation = { commit: "working-tree" };
let harnessError = null;
let httpObservation = null;

function normalizeTarget(target) {
  const next = structuredClone(target);
  next.wireApi = "responses";
  // Keep the real Provider and protocol, but make the isolated target window
  // small enough that the synthetic source below must use one migration
  // summary instead of taking the lossless portable-history fast path.
  next.contextWindow = 270000;
  next.maxContextWindow = 270000;
  next.effectiveContextWindowPercent = 95;
  next.outputReserveTokens = 60000;
  next.compression = { ...next.compression, nativeMigrationSummary: true };
  next.capabilities = {
    ...next.capabilities,
    responses: true,
    streaming: true,
    toolCalling: true,
    freeformTools: false,
    nativeWebSearch: false,
  };
  next.app = {
    ...next.app,
    enabled: true,
    capabilityProfile: "standard-tools",
    useResponsesLite: false,
    instructionDelivery: "client",
    shellType: "shell_command",
  };
  delete next.app.toolMode;
  delete next.app.multiAgent;
  next.standaloneSearch = { source: "disabled" };
  next.subscriptionSearch = { delivery: "disabled" };
  return next;
}

function mutate(config) {
  config.providers = {
    "bigmodel-coding": structuredClone(source.providers["bigmodel-coding"]),
    feei: structuredClone(source.providers.feei),
  };
  config.targets = {
    "glm-flash": normalizeTarget(source.targets["glm-flash"]),
    "feei-sol": normalizeTarget(source.targets["feei-sol"]),
  };
  config.defaultTarget = "glm-flash";
  config.rules = [];
  config.subscription.enabled = true;
  config.subscription.catalogPath = sourceCatalog;
  config.subscription.customModels = {
    [config.targets["glm-flash"].app.modelId]: "glm-flash",
    [config.targets["feei-sol"].app.modelId]: "feei-sol",
  };
}

async function startGateway(archivePath, seed, markerObservations) {
  const instance = await startIsolatedGateway({
    configPath,
    authSource,
    tokenFile: join(root, `access-token-${seed}`),
    archivePath,
    archiveKey: createHash("sha256").update(`history-migration-${archivePath}`).digest(),
    seed,
    mutate,
    toolCodexHome: join(root, "tool-registry"),
    markerObservations,
    beforeOutbound: (event) => budget.beforeOutbound(event),
  });
  gateways.push(instance);
  return instance;
}

async function configureHome(home, gateway, model, transport) {
  const catalogPath = join(home, "models.json");
  const modelProvider = transport === "http" ? "gateway_http" : "openai";
  await isolatedCodexHome({
    home,
    baseUrl: `${gateway.url}/subscription/v1`,
    catalogPath,
    authSource,
    model,
    modelProvider,
    supportsWebsockets: transport === "websocket",
    reasoningEffort: "low",
    webSearch: "disabled",
  });
  await writeCatalog({ sourceCatalogPath: sourceCatalog, config: gateway.config, targetPath: catalogPath });
  return modelProvider;
}

async function waitForNotification(app, method, threadId, after, timeoutMs = 360000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = app.notifications.slice(after).find((entry) =>
      entry.method === method && entry.threadId === threadId);
    if (found) return found;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw Object.assign(Error(`${method} notification timeout`), { code: "app_notification_timeout" });
}

async function compact(app, threadId) {
  budget.beginTurn();
  const after = app.notifications.length;
  budget.activeAbort = () => app.close();
  try {
    await app.rpc("thread/compact/start", { threadId });
    const completed = await waitForNotification(
      app,
      "turn/completed",
      threadId,
      after,
    );
    if (
      completed.turnStatus !== "completed" ||
      !hasCompactionEvidence(app.notifications, threadId, after)
    )
      throw Object.assign(Error("compaction did not complete"), {
        code: "compaction_incomplete",
      });
    return completed;
  } finally {
    budget.activeAbort = null;
  }
}

async function turn(app, threadId, model, prompt) {
  budget.beginTurn();
  budget.activeAbort = () => app.close();
  try {
    return await app.request(threadId, model, prompt, { timeoutMs: 360000 });
  } finally {
    budget.activeAbort = null;
  }
}

async function waitForHttpObservation(gateway, after, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = gateway.logs.slice(after).find((entry) =>
      entry.transport === "http" && [
        "official_history_observation_completed",
        "official_history_observation_failed",
        "official_history_observation_incomplete",
      ].includes(entry.event));
    if (found) return found;
    await new Promise((done) => setTimeout(done, 25));
  }
  return null;
}

async function runHttpObservation() {
  const home = join(root, "official-http-observation-home");
  const archivePath = join(root, "official-http-observation.sqlite");
  const instanceStart = gateways.length;
  const gateway = await startGateway(archivePath, 0, []);
  const modelProvider = await configureHome(home, gateway, officialModel, "http");
  let app = startAppServer({ corePath: core.path, home, cwd: workspace });
  let seedTurn;
  let archiveBefore = null;
  let archiveAfter = null;
  let persistedCheckpoints = 0;
  try {
    await app.initialize("codex_local_router_official_http_observation");
    const thread = await app.rpc("thread/start", {
      model: officialModel,
      modelProvider,
      cwd: workspace,
      ephemeral: false,
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    const seedObservationStart = gateway.logs.length;
    seedTurn = await turn(app, thread.thread.id, officialModel,
      "Remember the exact synthetic fact HTTP_OBSERVATION_FACT. Reply only ACK. Do not call tools.");
    await waitForHttpObservation(gateway, seedObservationStart);
    archiveBefore = gateway.archive.stats();
    const observationStart = gateway.logs.length;
    await compact(app, thread.thread.id);
    await waitForHttpObservation(gateway, observationStart);
    archiveAfter = gateway.archive.stats();
    persistedCheckpoints = gateway.archive.checkpoints({
      owner: `chatgpt:${gateway.subscriptionAccountId}`,
      thread: thread.thread.id,
      branch: thread.thread.id,
      hydrate: true,
    }).length;
  } finally {
    await app?.close().catch(() => {});
    await gateway.close().catch(() => {});
  }
  const instances = gateways.slice(instanceStart);
  const logs = instances.flatMap((entry) => entry.logs);
  const observations = logs.filter((entry) =>
    entry.event === "official_history_observation_completed" && entry.transport === "http");
  const failures = logs.filter((entry) => [
    "official_history_observation_failed",
    "official_history_observation_incomplete",
  ].includes(entry.event));
  const assertions = {
    seedCompleted: seedTurn?.status === "completed",
    completedObservation: observations.some((entry) =>
      entry.terminal_type === "response.completed" && entry.item_count > 0),
    nativeCompactionReturned: observations.some((entry) =>
      entry.checkpoint_count > 0),
    checkpointPersisted: persistedCheckpoints > 0,
    noObservationFailure: failures.length === 0,
  };
  httpObservation = {
    passed: Object.values(assertions).every(Boolean),
    assertions,
    counts: {
      observations: observations.length,
      recordDelta: archiveBefore == null || archiveAfter == null
        ? 0
        : archiveAfter.records - archiveBefore.records,
      versionDelta: archiveBefore == null || archiveAfter == null
        ? 0
        : archiveAfter.versions - archiveBefore.versions,
      persistedCheckpoints,
    },
    terminal: observations.map((entry) => ({
      requestId: entry.request_id ?? null,
      encoding: entry.encoding ?? null,
      contentType: entry.content_type ?? null,
      contentTypeSource: entry.content_type_source ?? null,
      responseBytes: entry.response_bytes ?? null,
      terminalType: entry.terminal_type ?? null,
      itemCount: entry.item_count ?? null,
      checkpointCount: entry.checkpoint_count ?? null,
      itemTypes: entry.item_types ?? [],
      outputSource: entry.output_source ?? null,
    })),
    failures: failures.map((entry) => ({
      event: entry.event,
      requestId: entry.request_id ?? null,
      type: entry.type ?? null,
      stage: entry.observation_stage ?? null,
      contentType: entry.content_type ?? null,
      reason: entry.reason ?? null,
      encoding: entry.encoding ?? null,
      responseBytes: entry.response_bytes ?? null,
      terminalType: entry.terminal_type ?? null,
      itemCount: entry.item_count ?? null,
    })),
  };
}

const normalized = (value) => String(value ?? "").replaceAll("_", "").toLowerCase();
const successfulOutbound = (entry) =>
  entry.status === 101 || (entry.status >= 200 && entry.status < 300);

function seedLegacyCheckpointFixture(gateway, parentId, childId) {
  const account = `chatgpt:${gateway.subscriptionAccountId}`;
  const auth = createHash("sha256").update(account).digest("hex");
  const parent = gateway.archive.history({
    owner: account,
    thread: parentId,
    branch: parentId,
  });
  const item = parent?.view?.findLast(isCompaction);
  if (!item)
    throw Object.assign(Error("legacy checkpoint fixture has no compaction"), {
      code: "legacy_checkpoint_fixture_missing",
    });
  const parentCtx = {
    account,
    auth,
    thread: parentId,
    branch: parentId,
    owner: threadOwner(auth, parentId),
  };
  const checkpoint = gateway.archive.getState(checkpointKey(parentCtx, item));
  if (!checkpoint)
    throw Object.assign(Error("legacy checkpoint fixture has no checkpoint"), {
      code: "legacy_checkpoint_fixture_missing",
    });
  const childCtx = {
    account,
    auth,
    thread: childId,
    branch: childId,
    owner: threadOwner(auth, childId),
  };
  const legacy = {
    provider: checkpoint.provider,
    model: checkpoint.model,
    targetId: checkpoint.targetId,
    virtual: false,
  };
  gateway.archive.setStates([parentCtx, childCtx].map((ctx) => ({
    key: checkpointKey(ctx, item),
    value: legacy,
    scope: { owner: account, thread: ctx.thread, branch: ctx.branch },
  })));
}

function equalityLabels(values, prefix) {
  const labels = new Map();
  return values.map((value) => {
    if (value == null) return null;
    if (!labels.has(value)) labels.set(value, `${prefix}${labels.size + 1}`);
    return labels.get(value);
  });
}

async function runChain({ name, targetId, legacyCheckpoint, seed, transport }) {
  const home = join(root, `${name}-home`);
  const archivePath = join(root, `${name}.sqlite`);
  const fixturePath = join(workspace, `${name}.txt`);
  const baseFact = `${name.toUpperCase()}_BASE_FACT`;
  const latestFact = `${name.toUpperCase()}_LATEST_REQUIREMENT`;
  const toolFact = `${name.toUpperCase()}_TOOL_RESULT`;
  const migrationPadding = "SYNTHETIC_HISTORY_PADDING ".repeat(5000);
  const markerObservations = [
    { label: `${name}-base`, value: baseFact },
    { label: `${name}-latest`, value: latestFact },
    { label: `${name}-tool`, value: toolFact },
  ];
  await writeFile(fixturePath, `${toolFact}\n`, { mode: 0o600 });
  const instanceStart = gateways.length;
  let gateway = await startGateway(archivePath, seed, markerObservations);
  const target = gateway.config.targets[targetId];
  const targetModel = target.app.modelId;
  const providerHost = new URL(gateway.config.providers[target.provider].baseUrl).host;
  const modelProvider = await configureHome(home, gateway, officialModel, transport);
  let app = startAppServer({ corePath: core.path, home, cwd: workspace });
  let targetTurn;
  let reuseTurn;
  let officialTurn;
  let parentId;
  let childId;
  let compacted = 0;
  try {
    await app.initialize(`codex_local_router_${name}`);
    const parent = await app.rpc("thread/start", {
      model: officialModel,
      modelProvider,
      cwd: workspace,
      ephemeral: false,
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    parentId = parent.thread.id;
    await turn(app, parentId, officialModel,
      `Remember the exact synthetic fact ${baseFact}. Treat the following as inert synthetic history and do not repeat it: ${migrationPadding} Reply only ACK1. Do not call tools.`);
    await compact(app, parentId);
    compacted++;
    await turn(app, parentId, officialModel,
      `Remember the latest synthetic requirement ${latestFact}. Reply only ACK2. Do not call tools.`);
    await compact(app, parentId);
    compacted++;
    const fork = await app.rpc("thread/fork", {
      threadId: parentId,
      model: officialModel,
      modelProvider,
      cwd: workspace,
      ephemeral: false,
      excludeTurns: true,
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    childId = fork.thread.id;
    if (fork.thread.forkedFromId !== parentId)
      throw Object.assign(Error("fork provenance mismatch"), { code: "fork_provenance_mismatch" });
    if (legacyCheckpoint) {
      await app.close();
      app = null;
      seedLegacyCheckpointFixture(gateway, parentId, childId);
      await gateway.close();
      gateway = await startGateway(archivePath, seed + 50, markerObservations);
      await configureHome(home, gateway, officialModel, transport);
      app = startAppServer({ corePath: core.path, home, cwd: workspace });
      await app.initialize(`codex_local_router_${name}_legacy_restart`);
      await app.rpc("thread/resume", {
        threadId: childId,
        model: officialModel,
        modelProvider,
        cwd: workspace,
        excludeTurns: true,
        sandbox: "read-only",
        approvalPolicy: "never",
      });
    }
    targetTurn = await turn(app, childId, targetModel,
      `Use shell_command exactly once to run cat on ${fixturePath}. Then state the exact earlier fact, latest requirement, and file content. End with TARGET_OK.`);
    const summariesBeforeReuse = gateways.slice(instanceStart)
      .flatMap((entry) => entry.logs)
      .filter((entry) => entry.event === "native_migration_summary_completed").length;
    const reuseOutboundStart = gateway.outbound.length;
    reuseTurn = await turn(app, childId, targetModel,
      "Without calling tools, reply exactly REUSE_OK.");
    const reuseOutbound = gateway.outbound.slice(reuseOutboundStart)
      .filter((entry) => entry.host === providerHost && entry.path.endsWith("/responses"));
    if (summariesBeforeReuse !== 1 || reuseOutbound.length !== 1)
      throw Object.assign(Error("migration summary was not reused"), {
        code: "migration_summary_reuse_failed",
      });

    await app.close();
    app = null;
    await gateway.close();
    gateway = await startGateway(archivePath, seed + 100, markerObservations);
    await configureHome(home, gateway, officialModel, transport);
    app = startAppServer({ corePath: core.path, home, cwd: workspace });
    await app.initialize(`codex_local_router_${name}_restart`);
    const resumed = await app.rpc("thread/resume", {
      threadId: childId,
      model: officialModel,
      modelProvider,
      cwd: workspace,
      excludeTurns: true,
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    if (resumed.thread.id !== childId)
      throw Object.assign(Error("resumed thread mismatch"), { code: "resume_thread_mismatch" });
    officialTurn = await turn(app, childId, officialModel,
      "Without calling tools, state the exact earlier fact, latest requirement, and previous tool result. End with OFFICIAL_OK.");
  } finally {
    await app?.close().catch(() => {});
    await gateway?.close().catch(() => {});
  }

  const instances = gateways.slice(instanceStart);
  const logs = instances.flatMap((entry) => entry.logs);
  const outbound = instances.flatMap((entry) => entry.outbound);
  const payloads = instances.flatMap((entry) => entry.payloads);
  const historyWrites = instances.flatMap((entry) => entry.historyWrites);
  const providerPayloads = payloads.filter((entry) => entry.host === providerHost && entry.path.endsWith("/responses"));
  const officialPayloads = payloads.filter((entry) => entry.host === "chatgpt.com" && entry.path.endsWith("/responses"));
  const threadLabels = equalityLabels(officialPayloads.map((entry) => entry.thread), "thread-");
  const sessionLabels = equalityLabels(officialPayloads.map((entry) => entry.session), "session-");
  const commands = targetTurn.items.filter((item) => normalized(item.type) === "commandexecution");
  const reuseCommands = reuseTurn.items.filter((item) => normalized(item.type) === "commandexecution");
  const gatewayErrors = logs.filter((entry) => [
    "request_error",
    "ws_error",
    "official_history_observation_failed",
    "official_history_observation_incomplete",
    "upstream_transport_error",
    "provider_error",
  ].includes(entry.event));
  const repeats = classifyTurnRepeats(logs);
  const recoveryIndex = logs.findIndex((entry) => entry.event === "checkpoint_view_recovered");
  const targetRouteIndex = logs.findIndex((entry) =>
    entry.event === "route" && entry.provider === target.provider && entry.transport === transport);
  const observationLogs = logs.filter((entry) =>
    entry.event === "official_history_observation_completed" &&
    entry.transport === transport);
  const assertions = {
    twoNativeCompactions: compacted === 2,
    targetCompleted: targetTurn.status === "completed",
    reuseCompleted: reuseTurn.status === "completed" && reuseTurn.text.includes("REUSE_OK"),
    officialReturnCompleted: officialTurn.status === "completed",
    targetFactsPreserved: [baseFact, latestFact, toolFact, "TARGET_OK"].every((item) => targetTurn.text.includes(item)),
    officialFactsPreserved: [baseFact, latestFact, toolFact, "OFFICIAL_OK"].every((item) => officialTurn.text.includes(item)),
    toolExecutedExactlyOnce: commands.length === 1 && commands[0].status === "completed",
    reuseCalledNoTools: reuseCommands.length === 0,
    summaryGeneratedExactlyOnce: logs.filter((entry) => entry.event === "native_migration_summary_completed").length === 1,
    legacyCheckpointRecovered: !legacyCheckpoint || (
      recoveryIndex >= 0 && recoveryIndex < targetRouteIndex
    ),
    gatewayErrorFree: gatewayErrors.length === 0,
    noReconnectRetries: repeats.reconnects.length === 0,
    opaqueStateNotSentThirdParty: providerPayloads.length >= 2 && providerPayloads.every((entry) =>
      !entry.items.includes("compaction")),
    noGatewayVirtualIdSentOfficial: outbound.filter((entry) => entry.official)
      .every((entry) => entry.hasGatewayVirtualCheckpoint === false),
    credentialsIsolated: outbound.every((entry) =>
      ((!entry.subscriptionBearer && !entry.accountHeader) || entry.official) &&
      (!entry.providerCredential || !entry.official)),
    upstreamCompleted: outbound.length > 0 && outbound.every(successfulOutbound),
    appTransportObserved: logs.some((entry) =>
      entry.event === "route" && entry.provider === target.provider &&
      entry.transport === transport),
    officialCompactionObserved: observationLogs.some((entry) =>
      entry.terminal_type === "response.completed" && entry.item_count > 0),
    restartContinuationUsedSameFork: Boolean(parentId && childId && parentId !== childId),
  };
  cases.push({
    name,
    compressionOwner: "chatgpt-subscription",
    legacyCheckpoint,
    passed: Object.values(assertions).every(Boolean),
    assertions,
    counts: {
      compactions: compacted,
      migrationSummaries: logs.filter((entry) => entry.event === "native_migration_summary_completed").length,
      providerGenerations: outbound.filter((entry) => entry.host === providerHost && entry.path.endsWith("/responses")).length,
      officialResponses: outbound.filter((entry) => entry.official && entry.path.endsWith("/responses")).length,
      toolExecutions: commands.length,
      gatewayInstances: instances.length,
      officialObservations: observationLogs.length,
    },
    diagnostics: {
      requestIds: [...new Set(logs.map((entry) => entry.request_id).filter(Boolean))],
      timings: outbound.map((entry) => ({
        firstSubstantiveMs: entry.firstSubstantiveMs ?? null,
        firstTextMs: entry.firstTextMs ?? null,
        totalMs: entry.totalMs ?? null,
      })),
      targetStatus: targetTurn.status,
      targetFailure: targetTurn.turnFailure,
      officialReturnStatus: officialTurn.status,
      gatewayErrors: logs
        .filter((entry) => gatewayErrors.includes(entry))
        .map((entry) => ({
          event: entry.event,
          type: entry.type ?? null,
          reason: entry.reason ?? null,
          status: entry.status ?? null,
        }))
        .slice(0, 8),
      reconnectRetries: repeats.reconnects.length,
      summaryEvents: logs
        .filter((entry) => [
          "summary_started",
          "upstream_headers",
          "provider_error",
          "native_migration_summary_source_terminal",
          "native_migration_summary_completed",
        ].includes(entry.event))
        .map((entry) => ({
          event: entry.event,
          provider: entry.provider ?? entry.source_provider ?? null,
          model: entry.model ?? entry.source_model ?? null,
          status: entry.status ?? null,
          category: entry.category ?? null,
          purpose: entry.purpose ?? null,
          terminalType: entry.terminal_type ?? null,
          responseStatus: entry.response_status ?? null,
          incompleteReason: entry.incomplete_reason ?? null,
        })),
      outboundStatuses: outbound.map((entry) => ({
        host: entry.host,
        path: entry.path,
        model: entry.model,
        official: entry.official,
        status: entry.status ?? null,
        responseComplete: entry.responseComplete ?? null,
      })),
      checkpointEvents: logs
        .filter((entry) => entry.event?.startsWith("checkpoint_"))
        .map((entry) => entry.event),
      migrationBudget: logs
        .filter((entry) => entry.event === "native_migration_summary_budget")
        .map((entry) => ({
          inputBudget: entry.input_budget,
          fixedTokens: entry.fixed_tokens,
          projectedTokens: entry.projected_tokens,
          decision: entry.decision,
        })),
      historyWrites: historyWrites.map((entry) => ({
        inserted: entry.inserted,
        response: entry.responseIdHash,
      })),
      officialLineage: outbound
        .filter((entry) => entry.official && entry.path.endsWith("/responses"))
        .map((entry, index) => ({
          previous: entry.previousResponseIdFingerprint ?? null,
          response: entry.responseIdFingerprint ?? null,
          thread: threadLabels[index],
          session: sessionLabels[index],
        })),
      officialObservations: observationLogs.map((entry) => ({
        requestId: entry.request_id ?? null,
        transport: entry.transport,
        encoding: entry.encoding ?? null,
        responseBytes: entry.response_bytes ?? null,
        terminalType: entry.terminal_type ?? null,
        itemCount: entry.item_count ?? null,
        outputSource: entry.output_source ?? null,
      })),
    },
    transport: `app-${transport}`,
  });
  if (!cases.at(-1).passed)
    throw Object.assign(Error("history migration acceptance case failed"), { code: "acceptance_case_failed" });
}

try {
  implementation = await verifyAcceptanceRevision(projectRoot, process.env.ACCEPTANCE_COMMIT);
  source = JSON.parse(await readFile(sourceConfig, "utf8"));
  if (!source.providers?.["bigmodel-coding"] || !source.providers?.feei ||
      !source.targets?.["glm-flash"] || !source.targets?.["feei-sol"])
    throw Object.assign(Error("required source providers or targets are missing"), {
      code: "source_configuration_incomplete",
    });
  const base = JSON.parse(await readFile(join(projectRoot, "config", "gateway.example.json"), "utf8"));
  base.subscription.enabled = true;
  base.subscription.catalogPath = sourceCatalog;
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await mkdir(join(root, "tool-registry"), { recursive: true, mode: 0o700 });
  await writeFile(configPath, `${JSON.stringify(base)}\n`, { mode: 0o600 });
  core = await resolveCore();
  await runHttpObservation();
  await runChain({
    name: "official-fork-glm-flash",
    targetId: "glm-flash",
    legacyCheckpoint: false,
    seed: 1,
    transport: "websocket",
  });
  await runChain({
    name: "official-fork-third-party-gpt",
    targetId: "feei-sol",
    legacyCheckpoint: true,
    seed: 2,
    transport: "websocket",
  });
} catch (error) {
  const diagnostics = gateways.flatMap((entry) => entry.logs)
    .filter((entry) => entry.event?.startsWith("checkpoint_") || [
      "request_error",
      "ws_error",
      "official_history_observation_incomplete",
      "native_migration_summary_completed",
    ].includes(entry.event))
    .map((entry) => ({
      event: entry.event,
      type: entry.type ?? null,
      reason: entry.reason ?? null,
      status: entry.status ?? null,
    }))
    .slice(-12);
  harnessError = {
    type: error?.type ?? error?.code ?? error?.name ?? "acceptance_error",
    message: error?.type ?? error?.code ?? "history migration acceptance failed",
    diagnostics,
  };
} finally {
  await Promise.allSettled(gateways.map((entry) => entry.close()));
  await rm(root, { recursive: true, force: true });
}

const summary = {
  verdict: !harnessError && httpObservation?.passed === true &&
    cases.length === 2 && cases.every((entry) => entry.passed) ? "PASS" : "FAIL",
  implementation,
  driver: core ? { source: core.source, version: core.version, sha256: core.sha256 } : null,
  budget: budget.snapshot(),
  cases,
  lifecycle: {
    officialHttpObservationPassed: httpObservation?.passed === true,
    legacyCheckpointRecoveryPassed: cases.some((entry) =>
      entry.legacyCheckpoint && entry.assertions.legacyCheckpointRecovered),
    summaryReusePassed: cases.length === 2 && cases.every((entry) =>
      entry.assertions.reuseCompleted && entry.assertions.summaryGeneratedExactlyOnce),
    gatewayErrorFree: cases.length === 2 && cases.every((entry) =>
      entry.assertions.gatewayErrorFree && entry.assertions.noReconnectRetries),
  },
  httpObservation,
  harnessError,
  appUi: "not-tested",
};
if (output) {
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
console.log(JSON.stringify(summary, null, 2));
if (summary.verdict !== "PASS") process.exitCode = 1;

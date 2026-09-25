#!/usr/bin/env node
// Bounded live lifecycle gate: official compaction -> fork -> third-party tool
// continuation -> Gateway/App restart -> official continuation. Evidence is
// structural metadata only; prompts, tool output and credentials are omitted.
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
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
import { solidPng } from "./lib/png.mjs";
import { checkpointKey, isCompaction } from "../../src/history.mjs";
import { sseEvents } from "../../src/sse.mjs";
import { threadOwner } from "../../src/state.mjs";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const appSmokeOnly = flag("app-smoke-only");
const nonFeeiOnly = flag("non-feei-only");
if (appSmokeOnly && nonFeeiOnly) throw Error("choose one acceptance mode");
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
const capabilityReceiptPath = value("capability-receipt");
const maxGenerations = Number(value("max-generations") ?? (appSmokeOnly ? 24 : 48));
if (!Number.isSafeInteger(maxGenerations) || maxGenerations < 1)
  throw Object.assign(Error("--max-generations must be a positive safe integer"), {
    code: "generation_budget_invalid",
  });

const root = await mkdtemp(join(tmpdir(), "codex-router-history-migration-"));
const workspace = join(root, "workspace");
const configPath = join(root, "gateway.json");
const budget = new FocusedAcceptanceBudget({ maxTurns: appSmokeOnly ? 20 : 40, maxGenerations });
const cases = [];
const gateways = [];
let core;
let source;
let deepseekCapability;
let glmMainCapability;
let capabilityDriverSha;
let implementation = { commit: "working-tree" };
let harnessError = null;
let httpObservation = null;
let stage = "initialize";
const execFileAsync = promisify(execFile);

function normalizeTarget(target, targetId) {
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
  if (targetId === "deepseek" && deepseekCapability === "supported")
    next.compression = {
      mode: "native",
      compatibility: { accountScope: "same", targets: [targetId] },
      nativeMigrationSummary: true,
    };
  if (targetId === "deepseek" && deepseekCapability !== "supported") {
    next.capabilities = { ...next.capabilities };
    next.app = { ...next.app, enabled: true };
  } else {
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
    delete next.app.thirdPartyTemplate;
  }
  next.standaloneSearch = { source: "disabled" };
  next.subscriptionSearch = { delivery: "disabled" };
  return next;
}

function mutate(config) {
  const targetIds = nonFeeiOnly
    ? ["glm-flash", "deepseek", "glm-main"]
    : ["glm-flash", "feei-sol", "feei-astra", "deepseek"];
  const providerIds = [...new Set(targetIds.map((id) => source.targets[id].provider))];
  config.providers = Object.fromEntries(providerIds.map((id) => [
    id,
    structuredClone(source.providers[id]),
  ]));
  config.targets = Object.fromEntries(targetIds.map((id) => [
    id,
    normalizeTarget(source.targets[id], id),
  ]));
  config.defaultTarget = "glm-flash";
  config.rules = [];
  config.subscription.enabled = true;
  config.subscription.catalogPath = sourceCatalog;
  config.subscription.customModels = Object.fromEntries(targetIds.map((id) => [
    config.targets[id].app.modelId,
    id,
  ]));
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

async function configureHome(home, gateway, model, transport, { automaticCompaction = false } = {}) {
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
    extra: automaticCompaction
      ? "model_context_window = 40000\nmodel_auto_compact_token_limit = 10000"
      : "",
  });
  await writeCatalog({ sourceCatalogPath: sourceCatalog, config: gateway.config, targetPath: catalogPath });
  return modelProvider;
}

async function injectCompletedToolPair(home, threadId, fixturePath, expected) {
  const { stdout } = await execFileAsync("/bin/cat", [fixturePath], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (stdout.trim() !== expected)
    throw Object.assign(Error("tool fixture output mismatch"), {
      code: "tool_fixture_output_mismatch",
    });

  const sessionsRoot = join(home, "sessions");
  const names = await readdir(sessionsRoot, { recursive: true });
  const candidates = names
    .filter((name) => name.endsWith(".jsonl") && name.includes(threadId))
    .map((name) => join(sessionsRoot, name));
  if (candidates.length !== 1)
    throw Object.assign(Error("tool rollout source is ambiguous"), {
      code: "tool_rollout_source_ambiguous",
    });
  const path = candidates[0];
  const records = (await readFile(path, "utf8"))
    .trimEnd()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(JSON.parse);
  const lastOrdinal = records.at(-1)?.ordinal;
  if (!Number.isSafeInteger(lastOrdinal))
    throw Object.assign(Error("tool rollout ordinal is missing"), {
      code: "tool_rollout_ordinal_missing",
    });
  const suffix = createHash("sha256")
    .update(`${threadId}\0${expected}`)
    .digest("hex")
    .slice(0, 24);
  const callId = `call_${suffix}`;
  const timestamp = new Date().toISOString();
  const rows = [
    {
      timestamp,
      ordinal: lastOrdinal + 1,
      type: "response_item",
      payload: {
        type: "function_call",
        id: `fc_${suffix}`,
        call_id: callId,
        name: "shell_command",
        arguments: JSON.stringify({ command: `/bin/cat ${fixturePath}` }),
      },
    },
    {
      timestamp,
      ordinal: lastOrdinal + 2,
      type: "response_item",
      payload: {
        type: "function_call_output",
        id: `fco_${suffix}`,
        call_id: callId,
        output: stdout,
      },
    },
  ];
  await appendFile(path, `${rows.map(JSON.stringify).join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return {
    execution: "direct-read-only",
    executions: 1,
    pairs: 1,
    callIdHash: createHash("sha256").update(callId).digest("hex"),
  };
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

async function compactAttempt(app, threadId) {
  budget.beginTurn();
  const after = app.notifications.length;
  budget.activeAbort = () => app.close();
  try {
    try {
      await app.rpc("thread/compact/start", { threadId });
    } catch {
      return { completed: null, observed: false, rpcRejected: true };
    }
    const completed = await waitForNotification(app, "turn/completed", threadId, after);
    return {
      completed,
      observed: hasCompactionEvidence(app.notifications, threadId, after),
      rpcRejected: false,
    };
  } finally {
    budget.activeAbort = null;
  }
}

async function turn(app, threadId, model, prompt, options = {}) {
  budget.beginTurn();
  budget.activeAbort = () => app.close();
  try {
    return await app.request(threadId, model, prompt, {
      timeoutMs: 360000,
      ...options,
    });
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

async function officialHttpTurn(gateway, threadId, turnId, input) {
  budget.beginTurn();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 360000);
  budget.activeAbort = () => controller.abort();
  try {
    const turnMetadata = {
      root_turn_id: turnId,
      session_id: threadId,
      thread_id: threadId,
      turn_id: turnId,
    };
    const response = await fetch(`${gateway.url}/subscription/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${gateway.subscriptionToken}`,
        "chatgpt-account-id": gateway.subscriptionAccountId,
        "content-type": "application/json",
        originator: "Codex Desktop",
        "session-id": threadId,
        "thread-id": threadId,
        "turn-id": turnId,
        "user-agent": core.version,
        "x-client-request-id": randomUUID(),
        "x-codex-turn-metadata": JSON.stringify(turnMetadata),
      },
      body: JSON.stringify({
        model: officialModel,
        input,
        include: ["reasoning.encrypted_content"],
        parallel_tool_calls: true,
        prompt_cache_key: `history-migration-${threadId}`,
        reasoning: { effort: "low", summary: "auto" },
        stream: true,
        store: false,
        tool_choice: "auto",
        tools: [],
        client_metadata: turnMetadata,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      let upstreamType = null;
      let upstreamCode = null;
      let upstreamParam = null;
      let responseKeys = [];
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json"))
        try {
          const result = await response.json();
          responseKeys = Object.keys(result ?? {}).sort();
          upstreamType = result?.error?.type ?? null;
          upstreamCode = result?.error?.code ?? null;
          upstreamParam = result?.error?.param ?? null;
        } catch {}
      else if (contentType.includes("text/event-stream"))
        try {
          for await (const event of sseEvents(response.body))
            upstreamType ??= event?.error?.type ?? event?.type ?? null;
        } catch {}
      else
        await response.arrayBuffer();
      throw Object.assign(Error("official HTTP request failed"), {
        code: "official_http_request_failed",
        status: response.status,
        upstreamType,
        upstreamCode,
        upstreamParam,
        responseKeys,
      });
    }
    let terminal = null;
    for await (const event of sseEvents(response.body))
      if (["response.completed", "response.incomplete"].includes(event.type))
        terminal = event.response;
      else if (["response.failed", "error"].includes(event.type))
        throw Object.assign(Error("official HTTP response failed"), {
          code: "official_http_response_failed",
        });
    if (!terminal)
      throw Object.assign(Error("official HTTP terminal missing"), {
        code: "official_http_terminal_missing",
      });
    return terminal;
  } finally {
    clearTimeout(timer);
    budget.activeAbort = null;
  }
}

async function runHttpObservation() {
  const archivePath = join(root, "official-http-observation.sqlite");
  const instanceStart = gateways.length;
  const gateway = await startGateway(archivePath, 0, []);
  const threadId = "official-http-observation";
  let seedTurn;
  let archiveBefore = null;
  let archiveAfter = null;
  let persistedCheckpoints = 0;
  try {
    const seedInput = [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: "Remember the exact synthetic fact HTTP_OBSERVATION_FACT. Reply only ACK.",
      }],
    }];
    const seedObservationStart = gateway.logs.length;
    seedTurn = await officialHttpTurn(
      gateway,
      threadId,
      "seed",
      seedInput,
    );
    await waitForHttpObservation(gateway, seedObservationStart);
    archiveBefore = gateway.archive.stats();
    const observationStart = gateway.logs.length;
    await officialHttpTurn(
      gateway,
      threadId,
      "compact",
      [...seedInput, ...(seedTurn.output ?? []), { type: "compaction_trigger" }],
    );
    await waitForHttpObservation(gateway, observationStart);
    archiveAfter = gateway.archive.stats();
    persistedCheckpoints = gateway.archive.checkpoints({
      owner: `chatgpt:${gateway.subscriptionAccountId}`,
      thread: threadId,
      branch: threadId,
      hydrate: true,
    }).length;
  } finally {
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

async function runOfficialChain({
  name,
  targetId,
  legacyCheckpoint,
  seed,
  transport,
  automaticSummary = false,
  image = false,
}) {
  const home = join(root, `${name}-home`);
  const archivePath = join(root, `${name}.sqlite`);
  const fixturePath = join(workspace, `${name}.txt`);
  const imagePath = join(workspace, `${name}.png`);
  const baseFact = `${name.toUpperCase()}_BASE_FACT`;
  const latestFact = `${name.toUpperCase()}_LATEST_REQUIREMENT`;
  // The tool pair is injected from a fixture, so the fact is a synthetic token
  // rather than a long temporary path that models may legitimately normalize.
  const toolFact = `${name.toUpperCase()}_TOOL_RESULT`;
  const migrationPadding = "SYNTHETIC_HISTORY_PADDING ".repeat(5000);
  const markerObservations = [
    { label: `${name}-base`, value: baseFact },
    { label: `${name}-latest`, value: latestFact },
    { label: `${name}-tool`, value: toolFact },
  ];
  const implicitRetriesBefore = budget.implicitRetries;
  await writeFile(fixturePath, `${toolFact}\n`, { mode: 0o600 });
  if (image) await writeFile(imagePath, solidPng(64, [220, 20, 20]), { mode: 0o600 });
  const instanceStart = gateways.length;
  let gateway = await startGateway(archivePath, seed, markerObservations);
  const target = gateway.config.targets[targetId];
  const targetModel = target.app.modelId;
  const providerHost = new URL(gateway.config.providers[target.provider].baseUrl).host;
  const modelProvider = await configureHome(home, gateway, officialModel, transport);
  let app = startAppServer({ corePath: core.path, home, cwd: workspace });
  let targetTurn;
  let reuseTurn;
  let targetRestartTurn;
  let officialTurn;
  let toolEvidence;
  let parentId;
  let childId;
  let officialCompactions = 0;
  let targetManualCompactions = 0;
  let automaticCompactionObserved = false;
  let initialMigrationSummaries = 0;
  let migrationSummaryReused = false;
  let preTargetCompactionPayloads = [];
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
    officialCompactions++;
    await turn(app, parentId, officialModel,
      `Remember the latest synthetic requirement ${latestFact}. Reply only ACK2. Do not call tools.`);
    await compact(app, parentId);
    officialCompactions++;
    await app.close();
    app = null;
    toolEvidence = await injectCompletedToolPair(
      home,
      parentId,
      fixturePath,
      toolFact,
    );
    app = startAppServer({ corePath: core.path, home, cwd: workspace });
    await app.initialize(`codex_local_router_${name}_tool_history`);
    await app.rpc("thread/resume", {
      threadId: parentId,
      model: officialModel,
      modelProvider,
      cwd: workspace,
      excludeTurns: true,
      sandbox: "read-only",
      approvalPolicy: "never",
    });
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
    if (automaticSummary) {
      await app.close();
      app = null;
      await configureHome(home, gateway, targetModel, transport, {
        automaticCompaction: true,
      });
      app = startAppServer({ corePath: core.path, home, cwd: workspace });
      await app.initialize(`codex_local_router_${name}_automatic`);
      await app.rpc("thread/resume", {
        threadId: childId,
        model: targetModel,
        modelProvider,
        cwd: workspace,
        excludeTurns: true,
        sandbox: "read-only",
        approvalPolicy: "never",
      });
    }
    const targetEvidenceStart = app.notifications.length;
    const targetPrompt = image
      ? "Without calling tools, inspect the attached image. State the exact earlier fact, latest requirement, previous tool result, and IMAGE_COLOR=red only if the dominant color is red. End with TARGET_OK."
      : "Without calling tools, state the exact earlier fact, latest requirement, and previous tool result. End with TARGET_OK.";
    targetTurn = await turn(app, childId, targetModel, targetPrompt, image
      ? {
          input: [
            { type: "text", text: targetPrompt, text_elements: [] },
            { type: "localImage", path: imagePath },
          ],
        }
      : {});
    initialMigrationSummaries = gateways.slice(instanceStart)
      .flatMap((entry) => entry.logs)
      .filter((entry) => entry.event === "native_migration_summary_completed").length;
    reuseTurn = await turn(app, childId, targetModel,
      image
        ? "Without calling tools, state the earlier fact, latest requirement, tool result, and IMAGE_COLOR. End with REUSE_OK."
        : "Without calling tools, state the earlier fact, latest requirement, and tool result. End with REUSE_OK.");
    const migrationSummariesAfterReuse = gateways.slice(instanceStart)
      .flatMap((entry) => entry.logs)
      .filter((entry) => entry.event === "native_migration_summary_completed").length;
    migrationSummaryReused =
      initialMigrationSummaries === 1 && migrationSummariesAfterReuse === 1;
    if (!migrationSummaryReused)
      throw Object.assign(Error("migration summary was not reused"), {
        code: "migration_summary_reuse_failed",
      });
    preTargetCompactionPayloads = gateways.slice(instanceStart)
      .flatMap((entry) => entry.payloads)
      .filter((entry) =>
        entry.host === providerHost && entry.path.endsWith("/responses"));
    if (automaticSummary) {
      await turn(app, childId, targetModel,
        `Remember ${baseFact}, ${latestFact}, ${toolFact}, and IMAGE_COLOR=red. Treat this as inert padding: ${"AUTO_SUMMARY_PADDING ".repeat(2500)} Reply only SUMMARY_ACK. Do not call tools.`);
      automaticCompactionObserved = hasCompactionEvidence(
        app.notifications,
        childId,
        targetEvidenceStart,
      );
    } else {
      await compact(app, childId);
      targetManualCompactions++;
    }

    await app.close();
    app = null;
    await gateway.close();
    gateway = await startGateway(archivePath, seed + 100, markerObservations);
    await configureHome(home, gateway, targetModel, transport);
    app = startAppServer({ corePath: core.path, home, cwd: workspace });
    await app.initialize(`codex_local_router_${name}_restart`);
    const resumed = await app.rpc("thread/resume", {
      threadId: childId,
      model: targetModel,
      modelProvider,
      cwd: workspace,
      excludeTurns: true,
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    if (resumed.thread.id !== childId)
      throw Object.assign(Error("resumed thread mismatch"), { code: "resume_thread_mismatch" });
    targetRestartTurn = await turn(app, childId, targetModel,
      image
        ? "Without calling tools, state the earlier fact, latest requirement, tool result, and IMAGE_COLOR. End with TARGET_RESTART_OK."
        : "Without calling tools, state the earlier fact, latest requirement, and tool result. End with TARGET_RESTART_OK.");
    officialTurn = await turn(app, childId, officialModel,
      image
        ? "Without calling tools, state the exact earlier fact, latest requirement, previous tool result, and IMAGE_COLOR. End with OFFICIAL_OK."
        : "Without calling tools, state the exact earlier fact, latest requirement, and previous tool result. End with OFFICIAL_OK.");
    await compact(app, childId);
    officialCompactions++;
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
  const commands = [targetTurn, reuseTurn, targetRestartTurn, officialTurn]
    .flatMap((entry) => entry.items)
    .filter((item) => normalized(item.type) === "commandexecution");
  const reuseCommands = reuseTurn.items.filter((item) => normalized(item.type) === "commandexecution");
  const summaryCompletions = logs.filter((entry) =>
    entry.event === "compaction_completed" && entry.mode === "summary");
  const nativeCompactionPayloads = providerPayloads.filter((entry) =>
    entry.items.includes("compaction_trigger"));
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
  const requiredFacts = [baseFact, latestFact, toolFact];
  const factPresence = (entry) => ({
    base: entry.text.includes(baseFact),
    latest: entry.text.includes(latestFact),
    tool: entry.text.includes(toolFact),
  });
  const assertions = {
    officialNativeCompactions: officialCompactions === 3 &&
      observationLogs.length >= 3,
    targetCompleted: targetTurn.status === "completed",
    reuseCompleted: reuseTurn.status === "completed" && reuseTurn.text.includes("REUSE_OK"),
    targetCompressionCompleted: automaticSummary
      ? automaticCompactionObserved && summaryCompletions.length >= 1
      : targetManualCompactions === 1 && nativeCompactionPayloads.length >= 1,
    targetRestartCompleted: targetRestartTurn.status === "completed" &&
      targetRestartTurn.text.includes("TARGET_RESTART_OK"),
    officialReturnCompleted: officialTurn.status === "completed",
    targetFactsPreserved: [...requiredFacts, "TARGET_OK"].every((item) =>
      targetTurn.text.includes(item)) &&
      requiredFacts.every((item) => reuseTurn.text.includes(item)) &&
      requiredFacts.every((item) => targetRestartTurn.text.includes(item)),
    officialFactsPreserved: [...requiredFacts, "OFFICIAL_OK"].every((item) =>
      officialTurn.text.includes(item)),
    imageAcceptedAndPreserved: !image || (
      providerPayloads.some((entry) =>
        entry.contentTypes.some((types) => types.includes("input_image"))) &&
      [targetTurn, reuseTurn, targetRestartTurn, officialTurn]
        .every((entry) => /IMAGE_COLOR\s*=\s*red/i.test(entry.text))
    ),
    toolExecutedExactlyOnce: toolEvidence?.executions === 1 &&
      toolEvidence.pairs === 1 &&
      commands.length === 0,
    reuseCalledNoTools: reuseCommands.length === 0,
    initialMigrationSummaryReused: migrationSummaryReused,
    legacyCheckpointRecovered: !legacyCheckpoint || (
      recoveryIndex >= 0 && recoveryIndex < targetRouteIndex
    ),
    gatewayErrorFree: gatewayErrors.length === 0,
    noReconnectRetries: budget.implicitRetries === implicitRetriesBefore,
    officialOpaqueStateNotSentThirdParty: preTargetCompactionPayloads.length >= 2 &&
      preTargetCompactionPayloads.every((entry) => !entry.items.includes("compaction")),
    noGatewayVirtualIdSentOfficial: outbound.filter((entry) => entry.official)
      .every((entry) => entry.hasGatewayVirtualCheckpoint === false),
    credentialsIsolated: outbound.every((entry) =>
      ((!entry.subscriptionBearer && !entry.accountHeader) || entry.official) &&
      (!entry.providerCredential || !entry.official)),
    upstreamCompleted: outbound.length > 0 && outbound.every(successfulOutbound),
    appTransportObserved: logs.some((entry) =>
      entry.event === "route" && entry.provider === target.provider &&
      entry.transport === transport),
    officialCompactionObserved: officialCompactions === 3,
    restartContinuationUsedSameFork: Boolean(parentId && childId && parentId !== childId),
  };
  cases.push({
    name,
    path: targetId === "glm-flash" ? ["O", "R", "O"] : ["O", "G", "O"],
    compressionOwners: ["chatgpt-subscription", target.provider, "chatgpt-subscription"],
    legacyCheckpoint,
    passed: Object.values(assertions).every(Boolean),
    assertions,
    counts: {
      officialCompactions,
      targetCompactions: automaticSummary
        ? summaryCompletions.length
        : nativeCompactionPayloads.length,
      migrationSummaries: logs.filter((entry) => entry.event === "native_migration_summary_completed").length,
      providerGenerations: outbound.filter((entry) => entry.host === providerHost && entry.path.endsWith("/responses")).length,
      officialResponses: outbound.filter((entry) => entry.official && entry.path.endsWith("/responses")).length,
      toolExecutions: toolEvidence?.executions ?? 0,
      toolPairs: toolEvidence?.pairs ?? 0,
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
      targetRestartStatus: targetRestartTurn.status,
      officialReturnStatus: officialTurn.status,
      factPresence: {
        target: factPresence(targetTurn),
        reuse: factPresence(reuseTurn),
        targetRestart: factPresence(targetRestartTurn),
        officialReturn: factPresence(officialTurn),
      },
      imagePresence: image
        ? {
            target: /IMAGE_COLOR\s*=\s*red/i.test(targetTurn.text),
            reuse: /IMAGE_COLOR\s*=\s*red/i.test(reuseTurn.text),
            targetRestart: /IMAGE_COLOR\s*=\s*red/i.test(targetRestartTurn.text),
            officialReturn: /IMAGE_COLOR\s*=\s*red/i.test(officialTurn.text),
          }
        : null,
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
      toolEvidence,
      reconnects: repeats.reconnects.map((entry) => ({
        kind: entry.key.split(":").at(-1),
        size: entry.size,
      })),
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
      payloadMarkers: payloads
        .filter((entry) => entry.path.endsWith("/responses"))
        .map((entry) => ({
          official: entry.host === "chatgpt.com",
          model: entry.model ?? null,
          markerMatches: entry.markerMatches ?? [],
          toolResultMarkers: entry.toolResultMarkers ?? [],
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

async function runThirdPartyChain({ seed, transport }) {
  const name = "third-party-cross-channel";
  const home = join(root, `${name}-home`);
  const archivePath = join(root, `${name}.sqlite`);
  const fixturePath = join(workspace, `${name}.txt`);
  const baseFact = "THIRD_PARTY_CROSS_CHANNEL_BASE_FACT";
  const toolFact = "THIRD_PARTY_CROSS_CHANNEL_TOOL_RESULT";
  const markerObservations = [
    { label: `${name}-base`, value: baseFact },
    { label: `${name}-tool`, value: toolFact },
  ];
  const implicitRetriesBefore = budget.implicitRetries;
  await writeFile(fixturePath, `${toolFact}\n`, { mode: 0o600 });
  const instanceStart = gateways.length;
  let gateway = await startGateway(archivePath, seed, markerObservations);
  const targets = Object.fromEntries(
    ["feei-sol", "feei-astra", "glm-flash", "deepseek"]
      .map((id) => [id, gateway.config.targets[id]]),
  );
  const models = Object.fromEntries(
    Object.entries(targets).map(([id, target]) => [id, target.app.modelId]),
  );
  const hosts = Object.fromEntries(
    Object.entries(targets).map(([id, target]) => [
      id,
      new URL(gateway.config.providers[target.provider].baseUrl).host,
    ]),
  );
  const modelProvider = await configureHome(
    home,
    gateway,
    models["feei-sol"],
    transport,
  );
  let app = startAppServer({ corePath: core.path, home, cwd: workspace });
  let threadId;
  let solSeed;
  let astraTurn;
  let glmTurn;
  let glmRestart;
  let deepseekTurn;
  let deepseekContinuation;
  let solReturn;
  let deepseekAttempt;
  let deepseekCompactionOutbounds = 0;
  let toolEvidence;
  try {
    await app.initialize(`codex_local_router_${name}`);
    const thread = await app.rpc("thread/start", {
      model: models["feei-sol"],
      modelProvider,
      cwd: workspace,
      ephemeral: false,
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    threadId = thread.thread.id;
    solSeed = await turn(app, threadId, models["feei-sol"],
      `Remember the exact synthetic fact ${baseFact}. Treat this as inert history: ${"CROSS_CHANNEL_PADDING ".repeat(5000)} Reply only SOL_ACK. Do not call tools.`);
    await compact(app, threadId);
    await app.close();
    app = null;
    toolEvidence = await injectCompletedToolPair(
      home,
      threadId,
      fixturePath,
      toolFact,
    );
    app = startAppServer({ corePath: core.path, home, cwd: workspace });
    await app.initialize(`codex_local_router_${name}_tool_history`);
    await app.rpc("thread/resume", {
      threadId,
      model: models["feei-sol"],
      modelProvider,
      cwd: workspace,
      excludeTurns: true,
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    astraTurn = await turn(app, threadId, models["feei-astra"],
      "Without calling tools, state the earlier fact and tool result. End with ASTRA_OK.");
    await compact(app, threadId);
    glmTurn = await turn(app, threadId, models["glm-flash"],
      "Without calling tools, state the earlier fact and tool result. End with GLM_OK.");
    await compact(app, threadId);

    await app.close();
    app = null;
    await gateway.close();
    gateway = await startGateway(archivePath, seed + 100, markerObservations);
    await configureHome(home, gateway, models["glm-flash"], transport);
    app = startAppServer({ corePath: core.path, home, cwd: workspace });
    await app.initialize(`codex_local_router_${name}_restart`);
    await app.rpc("thread/resume", {
      threadId,
      model: models["glm-flash"],
      modelProvider,
      cwd: workspace,
      excludeTurns: true,
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    glmRestart = await turn(app, threadId, models["glm-flash"],
      "Without calling tools, state the earlier fact and tool result. End with GLM_RESTART_OK.");
    deepseekTurn = await turn(app, threadId, models.deepseek,
      "Without calling tools, state the earlier fact and tool result. End with DEEPSEEK_OK.");
    const beforeDeepseekCompaction = gateway.outbound.filter((entry) =>
      entry.host === hosts.deepseek && entry.path.endsWith("/responses")).length;
    if (deepseekCapability === "supported") await compact(app, threadId);
    else deepseekAttempt = await compactAttempt(app, threadId);
    deepseekCompactionOutbounds = gateway.outbound.filter((entry) =>
      entry.host === hosts.deepseek && entry.path.endsWith("/responses")).length -
      beforeDeepseekCompaction;
    deepseekContinuation = await turn(app, threadId, models.deepseek,
      "Without calling tools, state the earlier fact and tool result. End with DEEPSEEK_CONTINUE_OK.");
    solReturn = await turn(app, threadId, models["feei-sol"],
      "Without calling tools, state the earlier fact and tool result. End with SOL_RETURN_OK.");
    await compact(app, threadId);
  } finally {
    await app?.close().catch(() => {});
    await gateway?.close().catch(() => {});
  }

  const instances = gateways.slice(instanceStart);
  const logs = instances.flatMap((entry) => entry.logs);
  const outbound = instances.flatMap((entry) => entry.outbound);
  const payloads = instances.flatMap((entry) => entry.payloads);
  const errors = logs.filter((entry) => [
    "request_error",
    "ws_error",
    "provider_error",
    "upstream_transport_error",
  ].includes(entry.event));
  const repeats = classifyTurnRepeats(logs);
  const providerPayloads = (targetId) => payloads.filter((entry) =>
    entry.host === hosts[targetId] &&
    entry.model === targets[targetId].model &&
    entry.path.endsWith("/responses"));
  const compactionPayloads = (targetId) => providerPayloads(targetId)
    .filter((entry) => entry.items.includes("compaction_trigger"));
  const requiredFacts = [baseFact, toolFact];
  const factTurns = [
    astraTurn,
    glmTurn,
    glmRestart,
    deepseekTurn,
    deepseekContinuation,
    solReturn,
  ];
  const commands = factTurns.flatMap((entry) => entry.items)
    .filter((item) => normalized(item.type) === "commandexecution");
  const expectedUnsupported = errors.filter((entry) =>
    ["request_error", "ws_error"].includes(entry.event) &&
    entry.type === "compaction_unsupported" &&
    entry.status === 400);
  const unexpectedErrors = errors.filter((entry) =>
    !(deepseekCapability === "provider-unsupported" &&
      expectedUnsupported.includes(entry)));
  const deepseekCompressionPassed = deepseekCapability === "supported"
    ? compactionPayloads("deepseek").length === 1 &&
      deepseekCompactionOutbounds === 1
    : deepseekAttempt?.observed === false &&
      deepseekCompactionOutbounds === 0 &&
      expectedUnsupported.length === 1;
  const assertions = {
    allTurnsCompleted: [solSeed, ...factTurns].every((entry) =>
      entry.status === "completed"),
    factsPreservedAcrossAllTargets: factTurns.every((entry) =>
      requiredFacts.every((fact) => entry.text.includes(fact))),
    toolExecutedExactlyOnce: toolEvidence?.executions === 1 &&
      toolEvidence.pairs === 1 &&
      commands.length === 0,
    solNativeCompactedTwice: compactionPayloads("feei-sol").length === 2,
    astraNativeCompactedOnce: compactionPayloads("feei-astra").length === 1,
    glmSummaryCompactedOnce: logs.filter((entry) =>
      entry.event === "compaction_completed" && entry.mode === "summary").length === 1 &&
      logs.filter((entry) =>
        entry.event === "summary_started" &&
        entry.purpose === "same-model:glm-flash").length === 1,
    deepseekCompressionMatchedProbe: deepseekCompressionPassed,
    deepseekContinuedAfterCompressionDecision:
      deepseekContinuation.text.includes("DEEPSEEK_CONTINUE_OK"),
    restartContinuationStayedOnSameThread: Boolean(threadId) &&
      glmRestart.text.includes("GLM_RESTART_OK"),
    everyTransitionRouted: Object.entries(targets).every(([, target]) =>
      logs.some((entry) =>
        entry.event === "route" &&
        entry.provider === target.provider &&
        entry.transport === transport)),
    crossTargetOpaqueStateNotLeaked: ["feei-astra", "glm-flash", "deepseek"]
      .every((targetId) =>
        providerPayloads(targetId)[0]?.items.includes("compaction") !== true),
    credentialsIsolated: outbound.every((entry) =>
      !entry.official &&
      !entry.subscriptionBearer &&
      !entry.accountHeader &&
      entry.providerCredential),
    upstreamCompleted: outbound.length > 0 && outbound.every(successfulOutbound),
    noUnexpectedGatewayErrors: unexpectedErrors.length === 0,
    noReconnectRetries: budget.implicitRetries === implicitRetriesBefore,
  };
  cases.push({
    name,
    path: ["G", "G", "R", "R", "G"],
    targets: ["feei-sol", "feei-astra", "glm-flash", "deepseek", "feei-sol"],
    deepseekCapability,
    compressionOwners: [
      targets["feei-sol"].provider,
      targets["feei-astra"].provider,
      targets["glm-flash"].provider,
      deepseekCapability === "supported" ? targets.deepseek.provider : "gateway-rejection",
      targets["feei-sol"].provider,
    ],
    passed: Object.values(assertions).every(Boolean),
    assertions,
    counts: {
      migrationSummaries: logs.filter((entry) =>
        entry.event === "native_migration_summary_completed").length,
      summaryCompactions: logs.filter((entry) =>
        entry.event === "compaction_completed" && entry.mode === "summary").length,
      providerGenerations: outbound.length,
      toolExecutions: toolEvidence?.executions ?? 0,
      toolPairs: toolEvidence?.pairs ?? 0,
      gatewayInstances: instances.length,
    },
    diagnostics: {
      requestIds: [...new Set(logs.map((entry) => entry.request_id).filter(Boolean))],
      errors: errors.slice(-8).map((entry) => ({
        event: entry.event,
        type: entry.type ?? null,
        status: entry.status ?? null,
        category: entry.category ?? entry.transport_category ?? null,
      })),
      reconnectRetries: repeats.reconnects.length,
      toolEvidence,
    },
    transport: `app-${transport}`,
  });
  if (!cases.at(-1).passed)
    throw Object.assign(Error("third-party cross-channel acceptance failed"), {
      code: "acceptance_case_failed",
    });
}

async function runNonFeeiChain({ seed, transport }) {
  const name = "responses-cross-target";
  const home = join(root, `${name}-home`);
  const archivePath = join(root, `${name}.sqlite`);
  const fixturePath = join(workspace, `${name}.txt`);
  const baseFact = "RESPONSES_CROSS_TARGET_BASE_FACT";
  const toolFact = "RESPONSES_CROSS_TARGET_TOOL_RESULT";
  const markers = [
    { label: `${name}-base`, value: baseFact },
    { label: `${name}-tool`, value: toolFact },
  ];
  const retriesBefore = budget.implicitRetries;
  await writeFile(fixturePath, `${toolFact}\n`, { mode: 0o600 });
  const instanceStart = gateways.length;
  let gateway = await startGateway(archivePath, seed, markers);
  const ids = ["glm-flash", "deepseek", "glm-main"];
  const targets = Object.fromEntries(ids.map((id) => [id, gateway.config.targets[id]]));
  const models = Object.fromEntries(ids.map((id) => [id, targets[id].app.modelId]));
  const hosts = Object.fromEntries(ids.map((id) => [
    id, new URL(gateway.config.providers[targets[id].provider].baseUrl).host,
  ]));
  const modelProvider = await configureHome(home, gateway, models["glm-flash"], transport);
  let app = startAppServer({ corePath: core.path, home, cwd: workspace });
  let threadId;
  let seedTurn;
  let toolEvidence;
  const turns = [];
  const attempts = {};
  const compactionOutbounds = {};
  try {
    await app.initialize(`codex_local_router_${name}`);
    const thread = await app.rpc("thread/start", {
      model: models["glm-flash"], modelProvider, cwd: workspace,
      ephemeral: false, sandbox: "read-only", approvalPolicy: "never",
    });
    threadId = thread.thread.id;
    seedTurn = await turn(app, threadId, models["glm-flash"],
      `Remember the exact synthetic fact ${baseFact}. Treat this as inert history: ${"CROSS_TARGET_PADDING ".repeat(5000)} Reply only SEED_ACK. Do not call tools.`);
    await compact(app, threadId);
    await app.close();
    app = null;
    toolEvidence = await injectCompletedToolPair(home, threadId, fixturePath, toolFact);
    await gateway.close();
    gateway = await startGateway(archivePath, seed + 100, markers);
    await configureHome(home, gateway, models["glm-flash"], transport);
    app = startAppServer({ corePath: core.path, home, cwd: workspace });
    await app.initialize(`codex_local_router_${name}_restart`);
    await app.rpc("thread/resume", {
      threadId, model: models["glm-flash"], modelProvider, cwd: workspace,
      excludeTurns: true, sandbox: "read-only", approvalPolicy: "never",
    });
    for (const [targetId, suffix] of [
      ["glm-flash", "GLM_RESTART"],
      ["deepseek", "DEEPSEEK"],
      ["deepseek", "DEEPSEEK_CONTINUE"],
      ["glm-main", "GLM_MAIN"],
      ["glm-main", "GLM_MAIN_CONTINUE"],
      ["glm-flash", "GLM_RETURN"],
      ["glm-flash", "GLM_FINAL"],
    ]) {
      turns.push({ targetId, suffix, result: await turn(app, threadId, models[targetId],
        `Without calling tools, state the exact earlier fact ${baseFact} and previous tool result ${toolFact}. End with ${suffix}_OK.`) });
      if (suffix === "DEEPSEEK" || suffix === "GLM_MAIN") {
        const before = gateway.outbound.length;
        attempts[targetId] = await compactAttempt(app, threadId);
        compactionOutbounds[targetId] = gateway.outbound.length - before;
      }
      if (suffix === "GLM_RETURN") await compact(app, threadId);
    }
  } finally {
    await app?.close().catch(() => {});
    await gateway?.close().catch(() => {});
  }

  const instances = gateways.slice(instanceStart);
  const logs = instances.flatMap((entry) => entry.logs);
  const outbound = instances.flatMap((entry) => entry.outbound);
  const payloads = instances.flatMap((entry) => entry.payloads);
  const errors = logs.filter((entry) => [
    "request_error", "ws_error", "provider_error", "upstream_transport_error",
  ].includes(entry.event));
  const unsupported = errors.filter((entry) =>
    ["request_error", "ws_error"].includes(entry.event) &&
    entry.type === "compaction_unsupported" && entry.status === 400);
  const providerPayloads = (id) => payloads.filter((entry) =>
    entry.host === hosts[id] && entry.model === targets[id].model &&
    entry.path.endsWith("/responses"));
  const commands = turns.flatMap((entry) => entry.result.items)
    .filter((item) => normalized(item.type) === "commandexecution");
  const repeats = classifyTurnRepeats(logs);
  const assertions = {
    allTurnsCompleted: seedTurn.status === "completed" &&
      turns.every((entry) => entry.result.status === "completed" &&
        entry.result.text.includes(`${entry.suffix}_OK`)),
    factsPreservedAcrossTargets: turns.every((entry) =>
      [baseFact, toolFact].every((fact) => entry.result.text.includes(fact))),
    toolExecutedExactlyOnce: toolEvidence?.executions === 1 &&
      toolEvidence.pairs === 1 && commands.length === 0,
    glmSummaryCompactedTwice: logs.filter((entry) =>
      entry.event === "compaction_completed" && entry.mode === "summary").length === 2,
    unsupportedCompactionRejectedLocally: ids.slice(1).every((id) =>
      attempts[id]?.observed === false && compactionOutbounds[id] === 0) &&
      unsupported.length === 2,
    everyTargetRouted: ids.every((id) => logs.some((entry) =>
      entry.event === "route" && entry.provider === targets[id].provider &&
      entry.transport === transport)) &&
      ids.every((id) => providerPayloads(id).length > 0),
    crossTargetOpaqueStateNotLeaked: ids.slice(1).every((id) =>
      providerPayloads(id)[0]?.items.includes("compaction") !== true),
    credentialsIsolated: outbound.every((entry) =>
      !entry.official && !entry.subscriptionBearer && !entry.accountHeader &&
      entry.providerCredential),
    noFeeiConfiguredOrCalled: !gateway.config.targets["feei-sol"] &&
      !gateway.config.targets["feei-astra"],
    upstreamCompleted: outbound.length > 0 && outbound.every(successfulOutbound),
    noUnexpectedGatewayErrors: errors.length === unsupported.length,
    noReconnectRetries: budget.implicitRetries === retriesBefore &&
      repeats.reconnects.length === 0,
  };
  cases.push({
    name,
    path: ["R", "R", "R", "R"],
    targets: ["glm-flash", "deepseek", "glm-main", "glm-flash"],
    compressionOwners: [targets["glm-flash"].provider, "gateway-rejection",
      "gateway-rejection", targets["glm-flash"].provider],
    passed: Object.values(assertions).every(Boolean),
    assertions,
    counts: {
      summaryCompactions: logs.filter((entry) =>
        entry.event === "compaction_completed" && entry.mode === "summary").length,
      unsupportedRejections: unsupported.length,
      providerGenerations: outbound.length,
      toolExecutions: toolEvidence?.executions ?? 0,
      toolPairs: toolEvidence?.pairs ?? 0,
      gatewayInstances: instances.length,
    },
    diagnostics: {
      requestIds: [...new Set(logs.map((entry) => entry.request_id).filter(Boolean))],
      errors: errors.slice(-8).map((entry) => ({
        event: entry.event, type: entry.type ?? null, status: entry.status ?? null,
      })),
      reconnectRetries: repeats.reconnects.length,
      toolEvidence,
    },
    transport: `app-${transport}`,
  });
  if (!cases.at(-1).passed)
    throw Object.assign(Error("non-FEEI cross-target acceptance failed"), {
      code: "acceptance_case_failed",
    });
}

try {
  implementation = await verifyAcceptanceRevision(projectRoot, process.env.ACCEPTANCE_COMMIT);
  if (!appSmokeOnly && !capabilityReceiptPath)
    throw Object.assign(Error("--capability-receipt is required"), {
      code: "capability_receipt_required",
    });
  if (!appSmokeOnly) {
    const capabilityReceipt = JSON.parse(await readFile(
      resolve(capabilityReceiptPath),
      "utf8",
    ));
    const deepseekCase = capabilityReceipt.cases?.find((entry) =>
      entry.target === "deepseek");
    const glmMainCase = capabilityReceipt.cases?.find((entry) =>
      entry.target === "glm-main");
    if (
      capabilityReceipt.verdict !== "PASS" ||
      capabilityReceipt.implementation?.commit !== implementation.commit ||
      !["supported", "provider-unsupported"].includes(deepseekCase?.result) ||
      (nonFeeiOnly && (deepseekCase?.result !== "provider-unsupported" ||
        glmMainCase?.result !== "provider-unsupported"))
    )
      throw Object.assign(Error("DeepSeek compression capability receipt is not conclusive"), {
        code: "capability_receipt_inconclusive",
      });
    deepseekCapability = deepseekCase.result;
    glmMainCapability = glmMainCase?.result;
    capabilityDriverSha = capabilityReceipt.driver?.sha256;
  }
  source = JSON.parse(await readFile(sourceConfig, "utf8"));
  const requiredTargets = nonFeeiOnly
    ? ["glm-flash", "deepseek", "glm-main"]
    : ["glm-flash", "feei-sol", "feei-astra", "deepseek"];
  if (requiredTargets.some((id) =>
    !source.targets?.[id] || !source.providers?.[source.targets[id].provider]))
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
  if (nonFeeiOnly && capabilityDriverSha !== core.sha256)
    throw Object.assign(Error("capability receipt uses another Codex core"), {
      code: "capability_core_mismatch",
    });
  if (!appSmokeOnly) {
    stage = "official-http-observation";
    await runHttpObservation();
  }
  stage = "official-glm-chain";
  await runOfficialChain({
    name: "official-fork-glm-flash",
    targetId: "glm-flash",
    legacyCheckpoint: false,
    seed: 1,
    transport: "websocket",
    automaticSummary: true,
    image: true,
  });
  if (nonFeeiOnly) {
    stage = "responses-cross-target-chain";
    await runNonFeeiChain({ seed: 3, transport: "websocket" });
  } else if (!appSmokeOnly) {
    stage = "official-third-party-gpt-chain";
    await runOfficialChain({
      name: "official-fork-third-party-gpt",
      targetId: "feei-sol",
      legacyCheckpoint: true,
      seed: 2,
      transport: "websocket",
    });
    stage = "third-party-cross-channel-chain";
    await runThirdPartyChain({
      seed: 3,
      transport: "websocket",
    });
  }
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
    message: String(error?.message ?? error?.type ?? error?.code ??
      "history migration acceptance failed"),
    stage,
    status: error?.status ?? null,
    upstreamType: error?.upstreamType ?? null,
    upstreamCode: error?.upstreamCode ?? null,
    upstreamParam: error?.upstreamParam ?? null,
    responseKeys: error?.responseKeys ?? [],
    diagnostics,
  };
} finally {
  await Promise.allSettled(gateways.map((entry) => entry.close()));
  await rm(root, { recursive: true, force: true });
}

const expectedCases = appSmokeOnly ? 1 : nonFeeiOnly ? 2 : 3;
const summary = {
  verdict: !harnessError && (appSmokeOnly || httpObservation?.passed === true) &&
    cases.length === expectedCases && cases.every((entry) => entry.passed)
    ? "PASS" : "FAIL",
  mode: appSmokeOnly ? "app-smoke" : nonFeeiOnly ? "non-feei-matrix" : "matrix",
  scope: nonFeeiOnly ? {
    includedChannels: ["O", "R"],
    excludedChannel: "G",
    excludedTargets: ["feei-sol", "feei-astra"],
    defaultReleaseGateSatisfied: false,
  } : null,
  implementation,
  driver: core ? { source: core.source, version: core.version, sha256: core.sha256 } : null,
  budget: budget.snapshot(),
  cases,
  lifecycle: {
    officialHttpObservationPassed: appSmokeOnly ? null : httpObservation?.passed === true,
    appSmokePassed: cases.some((entry) =>
      entry.name === "official-fork-glm-flash" && entry.passed),
    legacyCheckpointRecoveryPassed: appSmokeOnly || nonFeeiOnly ? null : cases.some((entry) =>
      entry.legacyCheckpoint && entry.assertions.legacyCheckpointRecovered),
    summaryReusePassed: cases
      .filter((entry) => entry.name.startsWith("official-fork-"))
      .every((entry) =>
        entry.assertions.reuseCompleted &&
        entry.assertions.initialMigrationSummaryReused),
    targetCompressionPassed: cases.length === expectedCases && cases.every((entry) =>
      entry.name === "third-party-cross-channel"
        ? entry.assertions.deepseekCompressionMatchedProbe &&
          entry.assertions.solNativeCompactedTwice &&
          entry.assertions.astraNativeCompactedOnce &&
          entry.assertions.glmSummaryCompactedOnce
        : entry.name === "responses-cross-target"
          ? entry.assertions.glmSummaryCompactedTwice &&
            entry.assertions.unsupportedCompactionRejectedLocally
        : entry.assertions.targetCompressionCompleted),
    imageLifecyclePassed: cases.some((entry) =>
      entry.assertions.imageAcceptedAndPreserved === true),
    gatewayErrorFree: cases.length === expectedCases && cases.every((entry) =>
      (entry.assertions.gatewayErrorFree ??
        entry.assertions.noUnexpectedGatewayErrors) &&
      entry.assertions.noReconnectRetries),
  },
  equivalenceCoverage: {
    "O->O": cases.some((entry) => entry.name === "official-fork-glm-flash" && entry.passed),
    "O->G": cases.some((entry) => entry.path?.join(">") === "O>G>O"),
    "O->R": cases.some((entry) => entry.path?.join(">") === "O>R>O"),
    "G->O": cases.some((entry) => entry.path?.join(">") === "O>G>O"),
    "G->G": cases.some((entry) => entry.path?.join(">") === "G>G>R>R>G"),
    "G->R": cases.some((entry) => entry.path?.join(">") === "G>G>R>R>G"),
    "R->O": cases.some((entry) => entry.path?.join(">") === "O>R>O"),
    "R->G": cases.some((entry) => entry.path?.join(">") === "G>G>R>R>G"),
    "R->R": cases.some((entry) => ["G>G>R>R>G", "R>R>R>R"].includes(entry.path?.join(">"))),
  },
  deepseekCapability,
  glmMainCapability,
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

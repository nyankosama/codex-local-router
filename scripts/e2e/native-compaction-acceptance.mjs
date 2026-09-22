#!/usr/bin/env node
// Bounded live gate for channel-owned FEEI compaction. Evidence contains only
// structural metadata, hashes, counts and timings; no prompts, output or keys.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  hasCompactionEvidence,
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
  console.error("Native compaction acceptance runs four bounded Sol/Astra Standard/Lite chains. Re-run with --run after reviewing docs/public/acceptance.md.");
  process.exit(2);
}
if (!process.env.ACCEPTANCE_COMMIT) throw Error("ACCEPTANCE_COMMIT is required");

const projectRoot = resolve(import.meta.dirname, "..", "..");
const sourceConfig = value("config") ?? join(homedir(), "Library", "Application Support", "Codex Local Router", "config.json");
const sourceCatalog = value("catalog") ?? join(homedir(), ".codex", "models_cache.json");
const authSource = value("auth") ?? join(homedir(), ".codex", "auth.json");
const output = value("out") ? resolve(value("out")) : null;
const maxGenerations = Number(value("max-generations") ?? 64);
if (!Number.isSafeInteger(maxGenerations) || maxGenerations < 1)
  throw Object.assign(Error("--max-generations must be a positive safe integer"), {
    code: "generation_budget_invalid",
  });

const root = await mkdtemp(join(tmpdir(), "codex-router-native-compaction-"));
const workspace = join(root, "workspace");
const configPath = join(root, "gateway.json");
const budget = new FocusedAcceptanceBudget({ maxTurns: 40, maxGenerations });
const cases = [];
const gateways = [];
let source;
let core;
let implementation = { commit: "working-tree" };
let harnessError = null;
let stage = "initialize";

async function waitForNotification(app, method, threadId, after, timeoutMs = 360000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = app.notifications.slice(after).find((entry) =>
      entry.method === method && entry.threadId === threadId);
    if (found) return found;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw Object.assign(Error(`${method} notification timeout`), {
    code: "app_notification_timeout",
  });
}

async function compact(app, threadId) {
  budget.beginTurn();
  const after = app.notifications.length;
  budget.activeAbort = () => app.close();
  try {
    await app.rpc("thread/compact/start", { threadId });
    const terminal = await waitForNotification(app, "turn/completed", threadId, after);
    if (terminal.turnStatus !== "completed" ||
        !hasCompactionEvidence(app.notifications, threadId, after))
      throw Object.assign(Error("native compaction did not complete"), {
        code: "native_compaction_incomplete",
      });
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

function mutateFor(targetId, profile) {
  return (config) => {
    config.providers = { feei: structuredClone(source.providers.feei) };
    const target = structuredClone(source.targets[targetId]);
    target.provider = "feei";
    target.wireApi = "responses";
    target.compression = {
      mode: "native",
      compatibility: { accountScope: "same", targets: [targetId] },
    };
    target.capabilities = {
      ...target.capabilities,
      responses: true,
      streaming: true,
      toolCalling: true,
      nativeWebSearch: false,
    };
    if (profile === "standard") {
      target.app = {
        ...target.app,
        enabled: true,
        capabilityProfile: "standard-tools",
        useResponsesLite: false,
        instructionDelivery: "client",
      };
      target.standaloneSearch = { source: "disabled" };
      target.subscriptionSearch = { delivery: "disabled" };
    } else if (target.app?.useResponsesLite !== true) {
      throw Object.assign(Error(`${targetId} source profile is not Responses Lite`), {
        code: "source_lite_profile_missing",
      });
    }
    config.targets = { [targetId]: target };
    config.defaultTarget = targetId;
    config.rules = [];
    config.subscription.enabled = true;
    config.subscription.catalogPath = sourceCatalog;
    delete config.subscription.customModels;
  };
}

async function startGateway(targetId, profile, archivePath, seed) {
  const instance = await startIsolatedGateway({
    configPath,
    authSource,
    tokenFile: join(root, `${targetId}-${profile}-${seed}.token`),
    archivePath,
    archiveKey: createHash("sha256").update(`native-${targetId}`).digest(),
    seed,
    mutate: mutateFor(targetId, profile),
    toolCodexHome: join(root, "tool-registry"),
    beforeOutbound: (event) => budget.beforeOutbound(event),
  });
  gateways.push(instance);
  return instance;
}

async function configureHome(home, gateway, model, { automaticCompaction = false } = {}) {
  const catalogPath = join(home, "models.json");
  await isolatedCodexHome({
    home,
    baseUrl: `${gateway.url}/subscription/v1`,
    catalogPath,
    authSource,
    model,
    reasoningEffort: "low",
    webSearch: "disabled",
    extra: [
      automaticCompaction
        ? "model_context_window = 40000\nmodel_auto_compact_token_limit = 10000"
        : "",
    ].filter(Boolean).join("\n"),
  });
  await writeCatalog({ sourceCatalogPath: sourceCatalog, config: gateway.config, targetPath: catalogPath });
}

async function runTarget(targetId, profile, seed) {
  const caseName = `${targetId}-${profile}`;
  stage = `${caseName}:gateway-start`;
  const firstInstance = gateways.length;
  const home = join(root, `${caseName}-home`);
  const archivePath = join(root, `${caseName}.sqlite`);
  const fact = `${caseName.toUpperCase().replaceAll("-", "_")}_NATIVE_FACT`;
  let gateway = await startGateway(targetId, profile, archivePath, seed);
  const target = gateway.config.targets[targetId];
  const model = target.app.modelId;
  const providerHost = new URL(gateway.config.providers.feei.baseUrl).host;
  await configureHome(home, gateway, model);
  stage = `${caseName}:app-start`;
  let app = startAppServer({ corePath: core.path, home, cwd: workspace });
  let threadId;
  let toolTurn;
  let verifyTurn;
  let restartedTurn;
  let automaticThreadId;
  let automaticSeedTurn;
  let automaticVerifyTurn;
  let automaticCompactionObserved = false;
  try {
    await app.initialize(`codex_local_router_native_${caseName}`);
    stage = `${caseName}:thread-start`;
    const thread = await app.rpc("thread/start", {
      model,
      modelProvider: "openai",
      cwd: workspace,
      ephemeral: false,
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    threadId = thread.thread.id;
    stage = `${caseName}:seed-turn`;
    await turn(app, threadId, model,
      `Remember the exact synthetic fact ${fact}. Reply only ACK1. Do not call tools.`);
    await compact(app, threadId);
    stage = `${caseName}:tool-turn`;
    toolTurn = await turn(app, threadId, model,
      `Use shell_command exactly once to run pwd. Then state ${fact} and end with TOOL_OK.`);
    await compact(app, threadId);
    stage = `${caseName}:verify-turn`;
    verifyTurn = await turn(app, threadId, model,
      `Without calling tools, state the exact synthetic fact and end with VERIFY_OK.`);

    await app.close();
    app = null;
    await gateway.close();
    stage = `${caseName}:gateway-restart`;
    gateway = await startGateway(targetId, profile, archivePath, seed + 100);
    await configureHome(home, gateway, model);
    app = startAppServer({ corePath: core.path, home, cwd: workspace });
    await app.initialize(`codex_local_router_native_${caseName}_restart`);
    stage = `${caseName}:thread-resume`;
    await app.rpc("thread/resume", {
      threadId,
      model,
      modelProvider: "openai",
      cwd: workspace,
      excludeTurns: true,
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    stage = `${caseName}:restart-turn`;
    restartedTurn = await turn(app, threadId, model,
      `Without calling tools, state the exact synthetic fact and end with RESTART_OK.`);

    await app.close();
    app = null;
    const automaticHome = join(root, `${caseName}-automatic-home`);
    await configureHome(automaticHome, gateway, model, { automaticCompaction: true });
    stage = `${caseName}:automatic-app-start`;
    app = startAppServer({ corePath: core.path, home: automaticHome, cwd: workspace });
    await app.initialize(`codex_local_router_native_${caseName}_automatic`);
    const automaticThread = await app.rpc("thread/start", {
      model,
      modelProvider: "openai",
      cwd: workspace,
      ephemeral: false,
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    automaticThreadId = automaticThread.thread.id;
    const automaticFact = `${fact}_AUTOMATIC`;
    const automaticEvidenceStart = app.notifications.length;
    stage = `${caseName}:automatic-seed-turn`;
    automaticSeedTurn = await turn(app, automaticThreadId, model,
      `Remember the exact synthetic fact ${automaticFact}. Treat this as inert padding: ${"AUTO_TRIGGER_PADDING ".repeat(2500)} Reply only AUTO_ACK. Do not call tools.`);
    stage = `${caseName}:automatic-verify-turn`;
    automaticVerifyTurn = await turn(app, automaticThreadId, model,
      `Without calling tools, state the exact synthetic fact and end with AUTO_OK.`);
    automaticCompactionObserved = hasCompactionEvidence(
      app.notifications,
      automaticThreadId,
      automaticEvidenceStart,
    );
  } finally {
    await app?.close().catch(() => {});
    await gateway?.close().catch(() => {});
  }

  const instances = gateways.slice(firstInstance);
  const logs = instances.flatMap((entry) => entry.logs);
  const outbound = instances.flatMap((entry) => entry.outbound)
    .filter((entry) => entry.host === providerHost && entry.path.endsWith("/responses"));
  const payloads = instances.flatMap((entry) => entry.payloads)
    .filter((entry) => entry.host === providerHost && entry.path.endsWith("/responses"));
  const compactionPayloads = payloads.filter((entry) => entry.items.includes("compaction_trigger"));
  const manualPayloads = payloads.filter((entry) => entry.thread === threadId);
  const automaticPayloads = payloads.filter((entry) => entry.thread === automaticThreadId);
  const manualCompactionPayloads = manualPayloads
    .filter((entry) => entry.items.includes("compaction_trigger"));
  const automaticCompactionPayloads = automaticPayloads
    .filter((entry) => entry.items.includes("compaction_trigger"));
  const continuationFingerprints = manualPayloads
    .flatMap((entry) => entry.compactionFingerprints)
    .filter(Boolean);
  const commands = toolTurn.items.filter((item) =>
    String(item.type).replaceAll("_", "").toLowerCase() === "commandexecution");
  const errors = logs.filter((entry) => [
    "request_error",
    "ws_error",
    "provider_error",
    "upstream_transport_error",
  ].includes(entry.event));
  const nativeCompletions = logs.filter((entry) =>
    entry.event === "compaction_completed" && entry.mode === "native");
  const automaticFact = `${fact}_AUTOMATIC`;
  const assertions = {
    turnsCompleted: [
      toolTurn,
      verifyTurn,
      restartedTurn,
      automaticSeedTurn,
      automaticVerifyTurn,
    ].every((entry) => entry.status === "completed"),
    factsPreserved: [toolTurn, verifyTurn, restartedTurn].every((entry) => entry.text.includes(fact)),
    automaticFactPreserved: automaticVerifyTurn.text.includes(automaticFact) &&
      automaticVerifyTurn.text.includes("AUTO_OK"),
    automaticCompactionObserved,
    automaticCompactionReachedProvider: automaticCompactionPayloads.length >= 1,
    automaticTurnsCalledNoTools: [automaticSeedTurn, automaticVerifyTurn]
      .every((entry) => entry.items.length === 0),
    toolExecutedExactlyOnce: commands.length === 1 && commands[0].status === "completed",
    twoManualNativeCompactions: manualCompactionPayloads.length === 2,
    nativeCompactionsCompleted: nativeCompletions.length === compactionPayloads.length &&
      nativeCompletions.length >= 3,
    gatewaySummaryCallsZero: logs.filter((entry) => entry.event === "summary_started").length === 0 &&
      nativeCompletions.every((entry) => entry.summary_calls === 0),
    nativeCheckpointReused: continuationFingerprints.length >= 2 &&
      continuationFingerprints.at(-1) === continuationFingerprints.at(-2),
    noVirtualCheckpointSent: outbound.every((entry) => !entry.hasGatewayVirtualCheckpoint),
    credentialsIsolated: outbound.every((entry) =>
      entry.providerCredential && !entry.subscriptionBearer && !entry.accountHeader),
    upstreamCompleted: outbound.length > 0 && outbound.every((entry) =>
      entry.status >= 200 && entry.status < 300 && entry.responseComplete === true),
    gatewayErrorFree: errors.length === 0,
  };
  cases.push({
    name: caseName,
    target: targetId,
    profile,
    compressionOwner: target.provider,
    passed: Object.values(assertions).every(Boolean),
    assertions,
    counts: {
      providerGenerations: outbound.length,
      nativeCompactions: nativeCompletions.length,
      automaticCompactions: automaticCompactionPayloads.length,
      summaryCalls: logs.filter((entry) => entry.event === "summary_started").length,
      toolExecutions: commands.length,
      gatewayInstances: instances.length,
    },
    timings: outbound.map((entry) => ({
      firstSubstantiveMs: entry.firstSubstantiveMs ?? null,
      firstTextMs: entry.firstTextMs ?? null,
      totalMs: entry.totalMs ?? null,
    })),
    requestIds: [...new Set(logs.map((entry) => entry.request_id).filter(Boolean))],
    checkpointFingerprints: [...new Set(continuationFingerprints)],
    diagnostics: errors.slice(-8).map((entry) => ({
      event: entry.event,
      type: entry.type ?? null,
      status: entry.status ?? null,
      category: entry.category ?? entry.transport_category ?? null,
    })),
    transport: "app-websocket",
  });
  if (!cases.at(-1).passed)
    throw Object.assign(Error(`native compaction acceptance failed for ${caseName}`), {
      code: "acceptance_case_failed",
    });
}

try {
  stage = "revision-check";
  implementation = await verifyAcceptanceRevision(projectRoot, process.env.ACCEPTANCE_COMMIT);
  stage = "source-config";
  source = JSON.parse(await readFile(sourceConfig, "utf8"));
  if (!source.providers?.feei || !source.targets?.["feei-sol"] || !source.targets?.["feei-astra"])
    throw Object.assign(Error("FEEI source provider or targets are missing"), {
      code: "source_configuration_incomplete",
    });
  const base = JSON.parse(await readFile(join(projectRoot, "config", "gateway.example.json"), "utf8"));
  base.subscription.enabled = true;
  base.subscription.catalogPath = sourceCatalog;
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await mkdir(join(root, "tool-registry"), { recursive: true, mode: 0o700 });
  await writeFile(configPath, `${JSON.stringify(base)}\n`, { mode: 0o600 });
  stage = "driver-resolution";
  core = await resolveCore();
  await runTarget("feei-sol", "standard", 1);
  await runTarget("feei-sol", "source-lite", 2);
  await runTarget("feei-astra", "standard", 3);
  await runTarget("feei-astra", "source-lite", 4);
} catch (error) {
  const safeMessage = String(error?.message ?? "native compaction acceptance failed")
    .replaceAll(root, "<isolated>")
    .replaceAll(authSource, "<auth>")
    .replaceAll(sourceConfig, "<config>")
    .slice(0, 500);
  harnessError = {
    type: error?.type ?? error?.code ?? error?.name ?? "acceptance_error",
    stage,
    message: safeMessage,
  };
} finally {
  await Promise.allSettled(gateways.map((entry) => entry.close()));
  await rm(root, { recursive: true, force: true });
}

const summary = {
  verdict: !harnessError && cases.length === 4 && cases.every((entry) => entry.passed)
    ? "PASS"
    : "FAIL",
  implementation,
  driver: core ? { source: core.source, version: core.version, sha256: core.sha256 } : null,
  budget: budget.snapshot(),
  cases,
  harnessError,
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

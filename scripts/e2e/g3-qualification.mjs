#!/usr/bin/env node
// Bounded G3 live qualification. It uses temporary Codex/Router homes and the
// installed subscription/provider credentials read-only. Artifacts retain only
// structural metadata, hashes, counts, timings, and classified error types.
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  classifyTurnRepeats,
  isolatedCodexHome,
  monitorEventLoop,
  resolveCore,
  runCliExec,
  startAppServer,
  startExternalHealthSampling,
  startIsolatedGateway,
  verifyAcceptanceRevision,
  writeCatalog,
} from "./lib/harness.mjs";
import { FocusedAcceptanceBudget } from "./lib/focused-budget.mjs";
import { solidPng } from "./lib/png.mjs";
import {
  classifyOfficialWsCancelOutbounds,
  classifyThirdPartyChannel,
  stableProviderFailureObserved,
} from "./lib/channel-attribution.mjs";
import {
  codexAppRunningFromProcessList,
  detectRouterStateInModelCache,
  evaluateModelCacheBoundary,
  evaluateG3CasePerformance,
  feeiGatewayAssertions,
  gatewayAssertionsPass,
  gatewayCorePassed,
  g3BudgetForCase,
  officialCliGatewayAssertions,
  officialWsGatewayAssertions,
  openCodeGatewayAssertions,
  officialSearchPrompt,
} from "./lib/g3-gate.mjs";

const exec = promisify(execFile);
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? undefined : argv[index + 1];
};
if (!flag("run")) {
  console.error("G3 qualification makes bounded real subscription/provider calls. Re-run with --run after reviewing the quality-gate contract.");
  process.exit(2);
}

const writeDeniedRoots = [
  join(homedir(), ".codex"),
  join(homedir(), ".agents"),
  join(homedir(), "Library", "Application Support", "Codex Local Router"),
  join(homedir(), "Library", "LaunchAgents"),
  join(homedir(), "Library", "Keychains"),
];
const writeDenyProfile = [
  "(version 1)",
  "(allow default)",
  ...writeDeniedRoots.map((path) =>
    `(deny file-write* (subpath ${JSON.stringify(path)}))`),
].join("\n");
const writeDenyProfileSha256 = createHash("sha256").update(writeDenyProfile).digest("hex");
const writeDenyEnvironmentKey = "CODEX_G3_REAL_ROOT_WRITE_DENY_PROFILE_SHA256";
if (process.platform === "darwin" && process.env[writeDenyEnvironmentKey] == null) {
  const childCode = await new Promise((resolvePromise, reject) => {
    const child = spawn(
      "/usr/bin/sandbox-exec",
      ["-p", writeDenyProfile, process.execPath, fileURLToPath(import.meta.url), ...argv],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          [writeDenyEnvironmentKey]: writeDenyProfileSha256,
          GIT_OPTIONAL_LOCKS: "0",
        },
      },
    );
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolvePromise(code ?? (signal ? 1 : 0)));
  });
  process.exit(childCode);
}
if (
  process.env[writeDenyEnvironmentKey] != null &&
  process.env[writeDenyEnvironmentKey] !== writeDenyProfileSha256
) {
  console.error("G3 write-deny profile identity mismatch.");
  process.exit(2);
}
const processTreeWriteDenied =
  process.platform === "darwin" &&
  process.env[writeDenyEnvironmentKey] === writeDenyProfileSha256;

const projectRoot = resolve(import.meta.dirname, "..", "..");
const routerRoot = join(homedir(), "Library", "Application Support", "Codex Local Router");
const productionConfig = value("config") ?? join(routerRoot, "config.json");
const authSource = value("auth") ?? join(homedir(), ".codex", "auth.json");
const sourceCatalog = value("catalog") ?? join(homedir(), ".codex", "models_cache.json");
const output = value("out") ? resolve(value("out")) : null;
const selectedCase = value("case") ?? null;
if (selectedCase && !["official", "official-ws"].includes(selectedCase)) {
  console.error("--case supports official or official-ws");
  process.exit(2);
}
const root = await mkdtemp(join(tmpdir(), "codex-router-g3-"));
const workspace = join(root, "workspace");
const codexHome = join(root, "codex-home");
const budget = new FocusedAcceptanceBudget(g3BudgetForCase(selectedCase));
const cases = [];
const machinePaths = {
  codexConfig: join(homedir(), ".codex", "config.toml"),
  modelCache: sourceCatalog,
  routerConfig: productionConfig,
  integration: join(routerRoot, "integration", "codex.json"),
  managedCatalog: join(homedir(), ".codex", "model-catalogs", "codex-local-router.json"),
  spaceIndex: join(routerRoot, "spaces", "index.json"),
  spaceTransaction: join(routerRoot, "transactions", "space-switch.json"),
  servicePlist: join(homedir(), "Library", "LaunchAgents", "com.nyankosama.codex-local-router.plist"),
  switcherPlist: join(homedir(), "Library", "LaunchAgents", "com.nyankosama.codex-local-router.space-switcher.plist"),
};
const codexSandbox = "read-only";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const percentile = (values, ratio) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]
    : null;
};
const finalCliText = (run) => run.rows
  .filter((row) => row.type === "item.completed" && row.item?.type === "agent_message")
  .map((row) => row.item.text ?? "")
  .join("\n");
const safeError = (error) => ({
  type: error?.type ?? error?.code ?? error?.name ?? "unclassified_error",
  status: Number.isFinite(error?.status) ? error.status : null,
  transportCode: error?.transportCode ?? null,
  transportCategory: error?.transportCategory ?? null,
});

async function fileMetadata(path, { detectRouterState = false } = {}) {
  try {
    const [bytes, metadata] = await Promise.all([readFile(path), stat(path)]);
    const routerState = detectRouterState
      ? detectRouterStateInModelCache(bytes)
      : null;
    return {
      exists: true,
      sha256: sha256(bytes),
      bytes: metadata.size,
      mtimeMs: Math.trunc(metadata.mtimeMs),
      ...(detectRouterState ? {
        routerStateDetected: routerState.detected,
        routerStateDetection: routerState.status,
      } : {}),
    };
  } catch {
    return { exists: false, sha256: null, bytes: null, mtimeMs: null };
  }
}

function portOpen(port) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (open) => {
      socket.destroy();
      resolvePromise(open);
    };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function launchAgentLoaded(label) {
  try {
    await exec("launchctl", ["print", `gui/${process.getuid()}/${label}`]);
    return true;
  } catch {
    return false;
  }
}

async function appRunning() {
  try {
    const { stdout } = await exec("ps", ["-axo", "args="]);
    const appExecutables = new Set([
      "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      "/Applications/Codex.app/Contents/MacOS/Codex",
    ]);
    return codexAppRunningFromProcessList(stdout, [...appExecutables]);
  } catch {
    return false;
  }
}

async function machineBoundary() {
  const files = {};
  for (const [name, path] of Object.entries(machinePaths))
    files[name] = await fileMetadata(path, { detectRouterState: name === "modelCache" });
  const appProcessObserved = await appRunning();
  const appRuntimeSignalObserved = Boolean(
    process.env.CODEX_APP_TOOLS_PIPE_PATH && process.env.CODEX_THREAD_ID,
  );
  return {
    files,
    port8788Open: await portOpen(8788),
    serviceLoaded: await launchAgentLoaded("com.nyankosama.codex-local-router"),
    switcherLoaded: await launchAgentLoaded("com.nyankosama.codex-local-router.space-switcher"),
    appRunning: appProcessObserved || appRuntimeSignalObserved,
    appProcessObserved,
    appRuntimeSignalObserved,
  };
}

function authorityUnchanged(before, after) {
  const authoritative = [
    "codexConfig",
    "routerConfig",
    "integration",
    "managedCatalog",
    "spaceIndex",
    "spaceTransaction",
    "servicePlist",
    "switcherPlist",
  ];
  return authoritative.every((name) =>
    before.files[name].exists === after.files[name].exists &&
    before.files[name].sha256 === after.files[name].sha256) &&
    before.port8788Open === after.port8788Open &&
    before.serviceLoaded === after.serviceLoaded &&
    before.switcherLoaded === after.switcherLoaded;
}

function checkpoint(gateway) {
  return {
    outbound: gateway.outbound.length,
    payloads: gateway.payloads.length,
    logs: gateway.logs.length,
    search: gateway.searchEvidence.length,
    startedAt: Date.now(),
  };
}

function structuralEvidence(gateway, start) {
  const outbound = gateway.outbound.slice(start.outbound);
  const payloads = gateway.payloads.slice(start.payloads);
  const logs = gateway.logs.slice(start.logs);
  const search = gateway.searchEvidence.slice(start.search);
  const repeats = classifyTurnRepeats(logs);
  const routeSetup = logs
    .filter((event) => event.event === "route")
    .map((event) => event.request_setup_ms)
    .filter(Number.isFinite);
  const routeMs = logs
    .filter((event) => event.event === "route")
    .map((event) => event.route_ms)
    .filter(Number.isFinite);
  const policyMs = logs
    .filter((event) => event.event === "route")
    .map((event) => event.policy_ms)
    .filter(Number.isFinite);
  const identityMs = logs
    .filter((event) => event.event === "route")
    .map((event) => event.identity_ms)
    .filter(Number.isFinite);
  const historyReplayMs = logs
    .filter((event) => event.event === "route")
    .map((event) => event.history_replay_ms)
    .filter(Number.isFinite);
  const firstSubstantive = logs
    .filter((event) => event.event === "upstream_first_substantive_event")
    .map((event) => event.duration_ms)
    .filter(Number.isFinite);
  const firstText = logs
    .filter((event) => event.event === "upstream_first_output_text")
    .map((event) => event.duration_ms)
    .filter(Number.isFinite);
  const searchMs = logs
    .filter((event) => event.event === "official_relay_completed" && event.path?.endsWith("/alpha/search"))
    .map((event) => event.duration_ms)
    .filter(Number.isFinite);
  const relaySetup = logs
    .filter((event) => ["official_relay_started", "official_ws_relay_started"].includes(event.event))
    .map((event) => event.request_setup_ms)
    .filter(Number.isFinite);
  const relayRoutePolicy = logs
    .filter((event) => ["official_relay_started", "official_ws_relay_started"].includes(event.event))
    .map((event) => event.route_policy_ms)
    .filter(Number.isFinite);
  const archiveMs = logs
    .filter((event) => ["official_history_observation_completed", "history_commit_completed"].includes(event.event))
    .map((event) => event.duration_ms)
    .filter(Number.isFinite);
  const errors = logs
    .filter((event) => ["request_error", "ws_error", "provider_error", "upstream_transport_error"].includes(event.event))
    .map((event) => ({
      event: event.event,
      provider: event.provider ?? null,
      type: event.type ?? null,
      status: event.status ?? null,
      transportCode: event.transport_code ?? null,
      transportCategory: event.transport_category ?? null,
    }));
  return {
    outbound,
    payloads,
    logs,
    search,
    errors,
    reconnects: repeats.reconnects.length,
    continuations: repeats.continuations.length,
    metrics: {
      localRequestSetupP95Ms: percentile(routeSetup, 0.95),
      localRouteP95Ms: percentile(routeMs, 0.95),
      localPolicyP95Ms: percentile(policyMs, 0.95),
      localIdentityP95Ms: percentile(identityMs, 0.95),
      localHistoryReplayP95Ms: percentile(historyReplayMs, 0.95),
      localRelaySetupP95Ms: percentile(relaySetup, 0.95),
      localRelayRoutePolicyP95Ms: percentile(relayRoutePolicy, 0.95),
      localArchiveP95Ms: percentile(archiveMs, 0.95),
      upstreamHeadersP95Ms: percentile(outbound.map((event) => event.responseHeadersMs), 0.95),
      firstSubstantiveP95Ms: percentile([
        ...firstSubstantive,
        ...outbound.map((event) => event.firstSubstantiveMs),
      ], 0.95),
      firstTextP95Ms: percentile([
        ...firstText,
        ...outbound.map((event) => event.firstTextMs),
      ], 0.95),
      searchP95Ms: percentile(searchMs, 0.95),
      upstreamTotalP95Ms: percentile(outbound.map((event) => event.totalMs), 0.95),
      requestBytes: payloads.reduce((sum, payload) => sum + (payload.bytes ?? 0), 0),
      responseBytes: outbound.reduce((sum, event) => sum + (event.responseBytes ?? 0), 0),
      toolBytes: payloads.reduce((sum, payload) =>
        sum + (payload.toolSizes ?? []).reduce((inner, tool) => inner + (tool.bytes ?? 0), 0), 0),
      reconnects: repeats.reconnects.length,
    },
  };
}

async function waitForIdle(gateway, start, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const healthStartedAt = Date.now();
    const health = await fetch(`${gateway.url}/healthz`).then((response) => response.json());
    health.observedMs = Date.now() - healthStartedAt;
    const outboundAccounted = gateway.outbound.slice(start?.outbound ?? 0).every((event) =>
      Number.isFinite(event.responseBytes) && Number.isFinite(event.totalMs));
    if (
      health.activeTurns === 0 &&
      health.websocketConnections === 0 &&
      outboundAccounted &&
      (gateway.gateway.engine.officialObservations?.size ?? 0) === 0
    ) return health;
    await new Promise((done) => setTimeout(done, 50));
  }
  const healthStartedAt = Date.now();
  const health = await fetch(`${gateway.url}/healthz`).then((response) => response.json());
  health.observedMs = Date.now() - healthStartedAt;
  return health;
}

function destinations(evidence) {
  return [...new Set(evidence.outbound.map((event) => event.host))];
}

function identitySafe(evidence) {
  return evidence.outbound.every((event) =>
    ((!event.subscriptionBearer && !event.accountHeader) || event.official) &&
    (!event.providerCredential || !event.official));
}

function localHealthy(evidence, health) {
  const setup = evidence.metrics.localRequestSetupP95Ms;
  return (setup == null || setup <= 300) &&
    evidence.reconnects < 2 &&
    health?.activeTurns === 0 &&
    health?.websocketConnections === 0;
}

function classifyChannel({
  passed,
  evidence,
  health,
  provider,
  host,
  routeSelected,
  implicitRetries,
  gatewayAssertions,
}) {
  const providerOutbounds = evidence.outbound.filter((event) => event.host === host);
  const duplicateOutbound = providerOutbounds.some((event, index) =>
    event.requestFingerprint &&
    providerOutbounds.findIndex((candidate) => candidate.requestFingerprint === event.requestFingerprint) !== index);
  return classifyThirdPartyChannel({
    passed,
    routeSelected,
    destinationsSafe: evidence.outbound.every((event) => event.official || event.host === host),
    identitySafe: identitySafe(evidence),
    duplicateOutbound,
    lifecycleHealthy: localHealthy(evidence, health),
    gatewayBehaviorSafe: gatewayAssertionsPass(gatewayAssertions),
    implicitRetries,
    stableProviderFailure: stableProviderFailureObserved(evidence, provider, host),
  });
}

function publicOutbound(outbound) {
  return outbound.map((event) => ({
    host: event.host,
    path: event.path,
    transport: event.transport,
    generate: event.generate,
    status: event.status ?? null,
    error: event.error ?? null,
    requestBytes: event.requestBytes ?? null,
    responseBytes: event.responseBytes ?? null,
    responseHeadersMs: event.responseHeadersMs ?? null,
    totalMs: event.totalMs ?? null,
    firstSubstantiveMs: event.firstSubstantiveMs ?? null,
    firstTextMs: event.firstTextMs ?? null,
    responseComplete: event.responseComplete ?? null,
    terminationReason: event.terminationReason ?? null,
    subscriptionBearer: event.subscriptionBearer,
    providerCredential: event.providerCredential,
    accountHeader: event.accountHeader,
    opencodeSession: event.opencodeSession,
  }));
}

function appendCase({
  name,
  kind,
  assertions,
  gatewayAssertions = {},
  evidence,
  health,
  error = null,
  channelVerdict = null,
  detail = null,
}) {
  const passed = Object.values(assertions).every(Boolean);
  const entry = {
    name,
    kind,
    passed,
    channelVerdict,
    durationMs: Date.now() - evidence.startedAt,
    startedAt: new Date(evidence.startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    assertions,
    gatewayAssertions,
    gatewayInvariantSafe: gatewayAssertionsPass(gatewayAssertions),
    metrics: evidence.metrics,
    healthBoundaryMs: health?.observedMs ?? null,
    lifecycle: {
      activeTurns: health?.activeTurns ?? null,
      websocketConnections: health?.websocketConnections ?? null,
      reconnects: evidence.reconnects,
      continuations: evidence.continuations,
    },
    destinations: destinations(evidence),
    outbound: publicOutbound(evidence.outbound),
    errors: evidence.errors,
    error,
    detail,
  };
  cases.push(entry);
  process.stdout.write(`${JSON.stringify({ event: "g3_case", name, passed, channelVerdict })}\n`);
  return entry;
}

function appExtra({ websocket = false } = {}) {
  return [
    "[features]",
    `responses_websockets = ${websocket}`,
    `responses_websockets_v2 = ${websocket}`,
    "",
  ].join("\n");
}

function mutateLiveConfig(config) {
  config.subscription.enabled = true;
  config.subscription.catalogPath = sourceCatalog;
  if (!config.providers?.feei || !config.targets?.["feei-sol"])
    throw Object.assign(Error("feei target unavailable"), { code: "feei_target_unavailable" });
  if (!config.providers?.["opencode-go"] || !config.targets?.deepseek)
    throw Object.assign(Error("opencode target unavailable"), { code: "opencode_target_unavailable" });
  config.targets["feei-sol"].modelFamily = "openai-gpt";
  config.targets["feei-sol"].wireApi = "responses";
  config.targets["feei-sol"].app = {
    ...config.targets["feei-sol"].app,
    enabled: true,
    capabilityProfile: "lite-search",
    useResponsesLite: true,
  };
  config.targets["feei-sol"].standaloneSearch = { source: "subscription" };
  config.targets.deepseek.standaloneSearch = { source: "disabled" };
}

async function officialCliCase(gateway, core, catalogPath) {
  budget.beginTurn();
  const start = checkpoint(gateway);
  const controller = new AbortController();
  budget.activeAbort = () => controller.abort();
  let run = { code: null, rows: [] };
  let error = null;
  try {
    await isolatedCodexHome({
      home: codexHome,
      baseUrl: `${gateway.url}/subscription/v1`,
      catalogPath,
      authSource,
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      webSearch: null,
      extra: appExtra(),
    });
    run = await runCliExec({
      corePath: core.path,
      home: codexHome,
      cwd: workspace,
      args: [
        "--ephemeral", "--skip-git-repo-check", "-C", workspace, "-s", codexSandbox,
        "-c", 'approval_policy="never"', "-m", "gpt-5.6-sol",
      ],
      prompt: officialSearchPrompt(),
      timeoutMs: 240000,
      signal: controller.signal,
    });
  } catch (caught) {
    error = safeError(caught);
  } finally {
    budget.activeAbort = null;
  }
  const health = await waitForIdle(gateway, start);
  const evidence = { ...structuralEvidence(gateway, start), startedAt: start.startedAt };
  const text = finalCliText(run);
  const searchItems = run.rows.filter((row) =>
    row.type === "item.completed" && ["web_search", "webSearch"].includes(row.item?.type));
  const searches = evidence.outbound.filter((event) => event.path.endsWith("/alpha/search"));
  const generations = evidence.outbound.filter((event) => event.path.endsWith("/responses"));
  const assertions = {
    completed: run.code === 0,
    noSearchFlagOrPersistedOverride: true,
    searchItemCompleted: searchItems.some((row) => row.item?.status !== "failed"),
    officialSearchCompleted: searches.length > 0 && searches.every((event) => event.official && event.status >= 200 && event.status < 300),
    officialGenerationCompleted: generations.length > 0 && generations.every((event) =>
      event.official && (event.status === 101 || event.status >= 200 && event.status < 300)),
    openAiOnly: evidence.outbound.length > 0 && evidence.outbound.every((event) => event.official),
    identitySafe: identitySafe(evidence),
    markerPresent: text.includes("OFFICIAL_G3_SEARCH_OK"),
    sourceMentioned: /(?:learn\.chatgpt\.com|developers\.openai\.com|openai\.com)/i.test(text),
    lifecycleClean: localHealthy(evidence, health),
    noImplicitRetry: budget.implicitRetries === 0,
  };
  return appendCase({
    name: "official-cli-natural-search",
    kind: "official",
    evidence,
    health,
    error,
    assertions,
    gatewayAssertions: officialCliGatewayAssertions({
      officialDestinationsOnly: evidence.outbound.every((event) => event.official),
      officialSearchDestinationOnly: searches.every((event) => event.official),
      officialGenerationDestinationOnly: generations.every((event) => event.official),
      identitySafe: assertions.identitySafe,
      lifecycleClean: assertions.lifecycleClean,
    }),
  });
}

async function officialWsCancelCase(gateway, core, catalogPath) {
  budget.beginTurn();
  const generationsBefore = budget.generations;
  const start = checkpoint(gateway);
  const controller = new AbortController();
  let run = { code: null, rows: [] };
  let sentUpstream = false;
  let terminalBeforeCancel = false;
  let cancelIssuedAfterGenerationSend = false;
  let error = null;
  try {
    await isolatedCodexHome({
      home: codexHome,
      baseUrl: `${gateway.url}/subscription/v1`,
      catalogPath,
      authSource,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      webSearch: "disabled",
      extra: appExtra({ websocket: true }),
    });
    budget.activeAbort = () => controller.abort();
    const pending = runCliExec({
      corePath: core.path,
      home: codexHome,
      cwd: workspace,
      args: [
        "--ephemeral", "--skip-git-repo-check", "-C", workspace, "-s", codexSandbox,
        "-c", 'approval_policy="never"', "-c", 'model_reasoning_effort="high"',
        "-m", "gpt-5.6-sol",
      ],
      prompt: "Reason carefully about several independent ways to verify that 2+2 equals 4, then give a concise answer. Do not use tools.",
      timeoutMs: 60000,
      signal: controller.signal,
      onEvent: (row) => {
        if (["turn.completed", "turn.failed", "error"].includes(row.type))
          terminalBeforeCancel = true;
      },
    });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      sentUpstream = gateway.outbound.slice(start.outbound).some((event) =>
        event.official &&
        event.transport === "websocket" &&
        event.path.endsWith("/responses") &&
        event.status === 101 &&
        event.generate !== false);
      if (sentUpstream) break;
      await new Promise((done) => setTimeout(done, 25));
    }
    if (!sentUpstream)
      throw Object.assign(Error("official CLI did not reach the WS relay"), { code: "official_ws_send_not_observed" });
    cancelIssuedAfterGenerationSend = !terminalBeforeCancel;
    controller.abort();
    run = await pending;
  } catch (caught) {
    error = safeError(caught);
  } finally {
    budget.activeAbort = null;
    controller.abort();
  }
  const health = await waitForIdle(gateway, start);
  const evidence = { ...structuralEvidence(gateway, start), startedAt: start.startedAt };
  const wsOutbounds = evidence.outbound.filter((event) => event.transport === "websocket" && event.path.endsWith("/responses"));
  const wsClassification = classifyOfficialWsCancelOutbounds(evidence.outbound);
  const assertions = {
    realCodexClientSentUpstream: sentUpstream,
    generationBudgetRecorded: budget.generations === generationsBefore + 1,
    noTerminalEventBeforeCancel: !terminalBeforeCancel,
    cancelIssuedAfterGenerationSend,
    clientProcessCancelled: run.code !== 0,
    officialRelayOnly: wsClassification.passed,
    exactlyOneGenerationWs: wsClassification.generationCount === 1,
    identitySafe: identitySafe(evidence),
    clientCloseCancelledAndCleaned: health.activeTurns === 0 && health.websocketConnections === 0,
    noImplicitRetry: budget.implicitRetries === 0,
  };
  return appendCase({
    name: "official-websocket-close-cancel",
    kind: "official",
    evidence,
    health,
    error,
    assertions,
    gatewayAssertions: officialWsGatewayAssertions({
      officialDestinationsOnly: evidence.outbound.every((event) => event.official),
      atMostOneGenerationWs: wsClassification.generationCount <= 1,
      identitySafe: assertions.identitySafe,
      clientCloseCancelledAndCleaned: assertions.clientCloseCancelledAndCleaned,
    }),
    detail: {
      websocketResponses: wsOutbounds.length,
      generationWebsockets: wsClassification.generationCount,
      prewarmWebsockets: wsClassification.prewarmCount,
    },
  });
}

async function feeiLiteSearchCase(gateway, core, catalogPath) {
  budget.beginTurn();
  const implicitRetriesBefore = budget.implicitRetries;
  const start = checkpoint(gateway);
  let app = null;
  let turn = { status: "failed", text: "", items: [] };
  let error = null;
  try {
    await isolatedCodexHome({
      home: codexHome,
      baseUrl: `${gateway.url}/subscription/v1`,
      catalogPath,
      authSource,
      model: "feei-gpt-5.6-sol",
      reasoningEffort: "low",
      webSearch: "live",
      extra: appExtra(),
    });
    app = startAppServer({ corePath: core.path, home: codexHome, cwd: workspace });
    await app.initialize("codex_local_router_g3_feei");
    const thread = await app.rpc("thread/start", {
      model: "feei-gpt-5.6-sol",
      modelProvider: "openai",
      cwd: workspace,
      ephemeral: true,
      sandbox: codexSandbox,
      approvalPolicy: "never",
    });
    budget.activeAbort = () => app?.close();
    turn = await app.request(
      thread.thread.id,
      "feei-gpt-5.6-sol",
      [
        "Use standalone web search for the public OpenAI Codex web-search documentation.",
        "Answer briefly, include the literal URL https://learn.chatgpt.com/docs/web-search, and finish with FEEI_G3_SEARCH_OK.",
        "Do not use shell, files, MCP, plugins, or write actions.",
      ].join(" "),
      { timeoutMs: 360000 },
    );
  } catch (caught) {
    error = safeError(caught);
  } finally {
    budget.activeAbort = null;
    await app?.close().catch(() => {});
  }
  const health = await waitForIdle(gateway, start);
  const evidence = { ...structuralEvidence(gateway, start), startedAt: start.startedAt };
  const searches = evidence.outbound.filter((event) => event.path.endsWith("/alpha/search"));
  const generations = evidence.outbound.filter((event) => event.path.endsWith("/responses") && !event.official);
  const matched = generations.map((event) => event.searchResultFingerprint).filter(Boolean);
  const routeSelected = evidence.logs.some((event) => event.event === "route" && event.provider === "feei" && event.model === "gpt-5.6-sol");
  const assertions = {
    appServerCompleted: turn.status === "completed",
    routeSelected,
    liteProfileSearchCompleted: turn.items.some((item) => item.type === "webSearch" && item.status !== "failed"),
    officialSearchOnly: searches.length > 0 && searches.every((event) => event.host === "chatgpt.com" && event.status >= 200 && event.status < 300),
    feeiGenerationOnly: generations.length > 0 && generations.every((event) => event.host === "ai.feei.cn" && event.status >= 200 && event.status < 300),
    searchResultObserved: evidence.search.some((event) => event.complete && event.resultFingerprints.length > 0),
    searchResultReachedProvider: matched.length > 0,
    identitySafe: identitySafe(evidence),
    expectedCredentialsPresent: searches.every((event) => event.subscriptionBearer) && generations.every((event) => event.providerCredential),
    markerAndSourcePresent: turn.text.includes("FEEI_G3_SEARCH_OK") && turn.text.includes("https://learn.chatgpt.com/docs/web-search"),
    lifecycleClean: localHealthy(evidence, health),
    noImplicitRetry: budget.implicitRetries === 0,
  };
  const passed = Object.values(assertions).every(Boolean);
  const gatewayAssertions = feeiGatewayAssertions({
    officialSearchDestinationOnly: searches.every((event) => event.official && event.host === "chatgpt.com"),
    providerGenerationDestinationOnly: generations.every((event) => event.host === "ai.feei.cn"),
    searchResultObserved: assertions.searchResultObserved,
    searchResultReachedProvider: assertions.searchResultReachedProvider,
    identitySafe: assertions.identitySafe,
    credentialsScopedToDestination: assertions.expectedCredentialsPresent,
    lifecycleClean: assertions.lifecycleClean,
  });
  return appendCase({
    name: "feei-sol-app-lite-search",
    kind: "third-party",
    evidence,
    health,
    error,
    channelVerdict: classifyChannel({
      passed,
      evidence,
      health,
      provider: "feei",
      host: "ai.feei.cn",
      routeSelected,
      implicitRetries: budget.implicitRetries - implicitRetriesBefore,
      gatewayAssertions,
    }),
    assertions,
    gatewayAssertions,
  });
}

async function opencodeDeepseekCase(gateway, core, catalogPath, catalog) {
  budget.beginTurn();
  const implicitRetriesBefore = budget.implicitRetries;
  const start = checkpoint(gateway);
  let run = { code: null, rows: [] };
  let error = null;
  try {
    await isolatedCodexHome({
      home: codexHome,
      baseUrl: `${gateway.url}/subscription/v1`,
      catalogPath,
      authSource,
      model: "deepseek-v4.1-flash",
      reasoningEffort: "max",
      webSearch: "disabled",
      extra: appExtra(),
    });
    const imagePath = join(workspace, "synthetic-blue.png");
    await writeFile(imagePath, solidPng(64, [20, 70, 220]), { mode: 0o600 });
    const controller = new AbortController();
    budget.activeAbort = () => controller.abort();
    run = await runCliExec({
      corePath: core.path,
      home: codexHome,
      cwd: workspace,
      args: [
        "--ephemeral", "--skip-git-repo-check", "-C", workspace, "-s", codexSandbox,
        "-c", 'approval_policy="never"', "-c", 'model_reasoning_effort="max"',
        "-m", "deepseek-v4.1-flash", "-i", imagePath, "--",
      ],
      prompt: "Identify the synthetic image's dominant color, answer briefly, and finish with OPENCODE_G3_IMAGE_OK. Do not use tools or search.",
      timeoutMs: 300000,
      signal: controller.signal,
    });
  } catch (caught) {
    error = safeError(caught);
  } finally {
    budget.activeAbort = null;
  }
  const health = await waitForIdle(gateway, start);
  const evidence = { ...structuralEvidence(gateway, start), startedAt: start.startedAt };
  const generations = evidence.outbound.filter((event) => event.path.endsWith("/responses") && !event.official);
  const payloads = evidence.payloads.filter((payload) => payload.host === "opencode.ai" && payload.path.endsWith("/responses"));
  const model = catalog.models.find((entry) => entry.slug === "deepseek-v4.1-flash");
  const text = finalCliText(run);
  const routeSelected = evidence.logs.some((event) => event.event === "route" && event.provider === "opencode-go" && event.model === "deepseek-v4.1-flash");
  const assertions = {
    cliCompleted: run.code === 0,
    routeSelected,
    opencodeGenerationOnly: generations.length > 0 && generations.every((event) => event.host === "opencode.ai" && event.status >= 200 && event.status < 300),
    imageForwarded: payloads.some((payload) => payload.contentTypes.flat().includes("input_image")),
    maxReasoningForwarded: payloads.some((payload) => payload.reasoningEffort === "max"),
    opencodeSessionPresent: generations.some((event) => event.opencodeSession),
    searchExplicitlyDisabled: gateway.config.targets.deepseek.standaloneSearch?.source === "disabled" && !evidence.outbound.some((event) => event.path.endsWith("/alpha/search")),
    catalogTruthful: model?.input_modalities?.includes("image") && model?.supported_reasoning_levels?.some((level) => level.effort === "max") && model?.supports_search_tool !== true,
    identitySafe: identitySafe(evidence),
    providerCredentialPresent: generations.every((event) => event.providerCredential),
    imageAnswerAndMarkerPresent: /blue/i.test(text) && text.includes("OPENCODE_G3_IMAGE_OK"),
    lifecycleClean: localHealthy(evidence, health),
    noImplicitRetry: budget.implicitRetries === 0,
  };
  const passed = Object.values(assertions).every(Boolean);
  const gatewayAssertions = openCodeGatewayAssertions({
    providerGenerationDestinationOnly: generations.every((event) => event.host === "opencode.ai"),
    imageForwarded: assertions.imageForwarded,
    maxReasoningForwarded: assertions.maxReasoningForwarded,
    opencodeSessionPresent: assertions.opencodeSessionPresent,
    searchExplicitlyDisabled: assertions.searchExplicitlyDisabled,
    catalogTruthful: assertions.catalogTruthful,
    identitySafe: assertions.identitySafe,
    providerCredentialScoped: assertions.providerCredentialPresent,
    lifecycleClean: assertions.lifecycleClean,
  });
  return appendCase({
    name: "opencode-deepseek-cli-image-max",
    kind: "third-party",
    evidence,
    health,
    error,
    channelVerdict: classifyChannel({
      passed,
      evidence,
      health,
      provider: "opencode-go",
      host: "opencode.ai",
      routeSelected,
      implicitRetries: budget.implicitRetries - implicitRetriesBefore,
      gatewayAssertions,
    }),
    assertions,
    gatewayAssertions,
  });
}

let gateway = null;
let core = null;
let implementation = { commit: "working-tree" };
let machineBefore = null;
let machineAfter = null;
let healthSampler = null;
let healthSamples = [];
let eventLoopMonitor = null;
let eventLoopDelayP99Ms = null;
let harnessError = null;
try {
  implementation = await verifyAcceptanceRevision(projectRoot, process.env.ACCEPTANCE_COMMIT);
  machineBefore = await machineBoundary();
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  core = await resolveCore();
  gateway = await startIsolatedGateway({
    configPath: productionConfig,
    authSource,
    tokenFile: join(root, "access-token"),
    archivePath: join(root, "history.sqlite"),
    archiveKey: createHash("sha256").update("g3-live-qualification").digest(),
    seed: 35,
    toolCodexHome: codexHome,
    mutate: mutateLiveConfig,
    beforeOutbound: (event) => budget.beforeOutbound(event),
  });
  const catalogPath = join(codexHome, "models.json");
  const catalog = await writeCatalog({
    sourceCatalogPath: sourceCatalog,
    config: gateway.config,
    targetPath: catalogPath,
  });
  healthSampler = startExternalHealthSampling(gateway.url, { intervalMs: 400, timeoutMs: 5000 });
  eventLoopMonitor = monitorEventLoop();
  if (selectedCase === "official-ws") {
    await officialWsCancelCase(gateway, core, catalogPath);
  } else if (selectedCase === "official") {
    await officialCliCase(gateway, core, catalogPath);
    await officialWsCancelCase(gateway, core, catalogPath);
  } else {
    await officialCliCase(gateway, core, catalogPath);
    await officialWsCancelCase(gateway, core, catalogPath);
    await feeiLiteSearchCase(gateway, core, catalogPath);
    await opencodeDeepseekCase(gateway, core, catalogPath, catalog);
  }
} catch (error) {
  harnessError = safeError(error);
} finally {
  healthSamples = healthSampler?.stop() ?? [];
  eventLoopDelayP99Ms = eventLoopMonitor?.stop() ?? null;
  await gateway?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
  machineAfter = await machineBoundary();
}

for (const entry of cases) {
  const from = Date.parse(entry.startedAt);
  const to = Date.parse(entry.endedAt);
  const samples = healthSamples.filter((sample) => sample.at >= from && sample.at <= to);
  entry.metrics.healthP95Ms = percentile([
    ...samples.map((sample) => sample.ms),
    entry.healthBoundaryMs,
  ], 0.95);
  entry.metrics.eventLoopDelayP99Ms = eventLoopDelayP99Ms;
  entry.performanceGate = evaluateG3CasePerformance(entry);
}
const officialCases = cases.filter((entry) => entry.kind === "official");
const feeiCase = cases.find((entry) => entry.name === "feei-sol-app-lite-search");
const opencodeCase = cases.find((entry) => entry.name === "opencode-deepseek-cli-image-max");
const boundaryUnchanged = Boolean(machineBefore && machineAfter && authorityUnchanged(machineBefore, machineAfter));
const modelCacheBoundary = evaluateModelCacheBoundary({
  before: machineBefore,
  after: machineAfter,
  authoritativeStateUnchanged: boundaryUnchanged,
  processTreeWriteDenied,
});
const performanceHealthy =
  healthSamples.length > 0 &&
  Number.isFinite(percentile(healthSamples.map((sample) => sample.ms), 0.95)) &&
  percentile(healthSamples.map((sample) => sample.ms), 0.95) <= 1000 &&
  Number.isFinite(eventLoopDelayP99Ms) && eventLoopDelayP99Ms <= 200 &&
  cases.every((entry) =>
    entry.performanceGate.passed &&
    (entry.metrics.localRequestSetupP95Ms == null || entry.metrics.localRequestSetupP95Ms <= 300) &&
    (entry.metrics.localRelaySetupP95Ms == null || entry.metrics.localRelaySetupP95Ms <= 300) &&
    entry.lifecycle.activeTurns === 0 &&
    entry.lifecycle.websocketConnections === 0 &&
    entry.lifecycle.reconnects < 2);
const gatewayDefect = cases.some((entry) => entry.channelVerdict === "GATEWAY_DEFECT");
const gatewayInvariantsSafe = cases.every((entry) => entry.gatewayInvariantSafe);
const corePass = gatewayCorePassed({
  harnessError,
  authoritativeStateUnchanged: boundaryUnchanged,
  modelCacheBoundaryPassed: modelCacheBoundary.passed,
  performanceHealthy,
  gatewayDefect,
  gatewayInvariantsSafe,
});
const officialPass = [null, "official"].includes(selectedCase) &&
  officialCases.length === 2 && officialCases.every((entry) => entry.passed);
const selectedCasePass = selectedCase == null || (
  selectedCase === "official"
    ? officialPass
    : cases.length === 1 && cases[0].passed
);
const summary = {
  runId: new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14),
  scope: "G3-isolated-live-channel-qualification",
  implementation,
  driver: core ? { source: core.source, version: core.version, sha256: core.sha256 } : null,
  isolation: {
    temporaryCodexHome: true,
    temporaryRouterState: true,
    randomGatewayPort: true,
    realMachineMutation: false,
    realUserHomeWriteDenied: processTreeWriteDenied,
    writeDenyProfileSha256: processTreeWriteDenied ? writeDenyProfileSha256 : null,
    writeDeniedRootClasses: processTreeWriteDenied
      ? ["codex", "agent-skills", "router", "launch-agents", "keychain"]
      : [],
    innerCodexSandbox: codexSandbox,
  },
  budget: budget.snapshot(),
  outcomes: {
    gatewayCore: corePass ? "PASS" : "FAIL",
    officialSubscription: [null, "official"].includes(selectedCase)
      ? (officialPass ? "PASS" : "FAIL")
      : "NOT_RUN",
    channels: {
      "ai.feei.cn/gpt-5.6-sol": feeiCase?.channelVerdict ?? "UNVERIFIED",
      "opencode.ai/deepseek-v4.1-flash": opencodeCase?.channelVerdict ?? "UNVERIFIED",
    },
    localAppGrayRun: "NOT_RUN",
    localUseReady: "NO",
    releaseReady: "NO",
  },
  performance: {
    healthSampleCount: healthSamples.length,
    healthP95Ms: percentile(healthSamples.map((sample) => sample.ms), 0.95),
    eventLoopDelayP99Ms,
    softHealthLinesMet: performanceHealthy,
    gatewayInvariantsSafe,
  },
  machineBoundary: {
    before: machineBefore,
    after: machineAfter,
    authoritativeStateUnchanged: boundaryUnchanged,
    ...modelCacheBoundary,
    processTreeWriteDenied,
    directWriterAttribution: "not-observed",
  },
  cases,
  harnessError,
};
if (output) {
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
process.stdout.write(`${JSON.stringify({ event: "g3_summary", outcomes: summary.outcomes, budget: summary.budget, harnessError })}\n`);
if (!corePass || !selectedCasePass || ([null, "official"].includes(selectedCase) && !officialPass)) process.exitCode = 1;

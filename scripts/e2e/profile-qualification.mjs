#!/usr/bin/env node
// Deterministic G2 qualification for the two third-party GPT App profiles.
// It uses the App-bundled Codex binary, isolated homes, synthetic plugins/MCP,
// and loopback/fake upstreams. No provider or OpenAI network request is made.
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { WebSocket } from "ws";
import {
  isolatedCodexHome,
  resolveCore,
  runCliExec,
  startAppServer,
  startExternalHealthSampling,
  startIsolatedGateway,
  monitorEventLoop,
  verifyAcceptanceRevision,
  writeImmutableJson,
  writeDeterministicCodexInputs,
  writeCatalog,
} from "./lib/harness.mjs";

const projectRoot = resolve(import.meta.dirname, "..", "..");
const argv = process.argv.slice(2);
const value = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? undefined : argv[index + 1];
};
const output = value("out") ? resolve(value("out")) : null;
const baseConfigPath = join(projectRoot, "config", "gateway.example.json");
const fixtureServer = join(import.meta.dirname, "fixtures", "read-only-mcp.mjs");
const root = await mkdtemp(join(tmpdir(), "codex-router-profile-g2-"));
const deterministicInputs = await writeDeterministicCodexInputs(join(root, "codex-inputs"));
const authSource = value("auth") ?? deterministicInputs.authPath;
const sourceCatalog = value("catalog") ?? deterministicInputs.catalogPath;
const workspace = join(root, "workspace");
const cases = [];
const marker = (name) => `G2_${name}_${createHash("sha256").update(`${name}:${randomUUID()}`).digest("hex").slice(0, 12)}`;
const MARKERS = {
  core: marker("CORE"),
  plugin: marker("PLUGIN"),
  mcp: marker("MCP"),
  final: marker("STANDARD_FINAL"),
  searchUrl: `https://fixture.invalid/${marker("SEARCH_RESULT")}`,
  searchFinal: marker("SEARCH_FINAL"),
  cli: marker("CLI_WS"),
  official: marker("OFFICIAL_WS"),
};
const markerObservations = Object.entries(MARKERS).map(([label, value]) => ({ label, value }));

function completedResponse(model, outputItems, id = randomUUID()) {
  return {
    id: `resp_${id.replaceAll("-", "")}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: "completed",
    output: outputItems,
    usage: { input_tokens: 32, output_tokens: 8, total_tokens: 40 },
  };
}

function message(text) {
  return {
    id: `msg_${randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

function functionCall(name, callId, namespace) {
  return {
    id: `fc_${randomUUID().replaceAll("-", "")}`,
    type: "function_call",
    call_id: callId,
    name,
    ...(namespace ? { namespace } : {}),
    arguments: name === "exec_command"
      ? JSON.stringify({ cmd: `printf %s ${JSON.stringify(MARKERS.core)}`, yield_time_ms: 1000 })
      : "{}",
    status: "completed",
  };
}

function jsonResponse(status, body, headers = {}) {
  const bytes = Buffer.from(JSON.stringify(body));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ "content-type": "application/json", "content-length": String(bytes.length), ...headers }),
    rawHeaders: [["content-type", "application/json"], ["content-length", String(bytes.length)]],
    body: Readable.from([bytes]),
  };
}

function toolNames(body) {
  const direct = (body.tools ?? []).map((tool) => tool.name ?? tool.function?.name ?? tool.type);
  const nested = (body.input ?? [])
    .filter((item) => item?.type === "additional_tools")
    .flatMap((item) => item.tools ?? [])
    .flatMap((tool) => [tool.name ?? tool.namespace, ...(tool.tools ?? []).map((item) => item.name)]);
  return [...new Set([...direct, ...nested].filter(Boolean))];
}

function namespacedTools(body) {
  return (body.tools ?? [])
    .filter((tool) => tool?.type === "namespace")
    .map((tool) => ({
      namespace: tool.name ?? tool.namespace,
      tools: (tool.tools ?? []).map((item) => item.name).filter(Boolean),
    }));
}

async function createSyntheticProvider() {
  const observations = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
    const text = JSON.stringify(body);
    const names = toolNames(body);
    const namespaces = namespacedTools(body);
    const isPrewarm = body.generate === false;
    const record = {
      path: new URL(req.url ?? "/", "http://fixture.invalid").pathname,
      model: body.model ?? null,
      generate: body.generate ?? null,
      toolNames: names,
      namespaces,
      markerLabels: markerObservations.filter((entry) => text.includes(entry.value)).map((entry) => entry.label),
      resultCallIds: (body.input ?? []).filter((item) => item?.type === "function_call_output").map((item) => item.call_id),
    };
    observations.push(record);

    let response;
    if (text.includes("G2_SLOW_DISCONNECT"))
      await new Promise((done) => setTimeout(done, 2000));
    if (isPrewarm) {
      response = completedResponse(body.model ?? "fixture", []);
    } else if (body.model === "fixture-standard") {
      const coreTool = names.find((name) => name === "exec_command");
      const pluginNamespace = namespaces.find((item) => String(item.namespace).includes("acceptance_github"));
      const userNamespace = namespaces.find((item) => String(item.namespace).includes("router_acceptance"));
      const resultIds = new Set(record.resultCallIds);
      if (!resultIds.has("call_g2_core"))
        response = completedResponse(body.model, coreTool ? [functionCall(coreTool, "call_g2_core")] : [message("MISSING_CORE_TOOL")]);
      else if (!resultIds.has("call_g2_plugin"))
        response = completedResponse(body.model, pluginNamespace?.tools[0]
          ? [functionCall(pluginNamespace.tools[0], "call_g2_plugin", pluginNamespace.namespace)]
          : [message("MISSING_PLUGIN_TOOL")]);
      else if (!text.includes(MARKERS.plugin))
        response = completedResponse(body.model, [message("PLUGIN_RESULT_MARKER_MISSING")]);
      else if (!resultIds.has("call_g2_mcp"))
        response = completedResponse(body.model, userNamespace?.tools[0]
          ? [functionCall(userNamespace.tools[0], "call_g2_mcp", userNamespace.namespace)]
          : [message("MISSING_USER_MCP")]);
      else if (!text.includes(MARKERS.mcp))
        response = completedResponse(body.model, [message("USER_MCP_RESULT_MARKER_MISSING")]);
      else
        response = completedResponse(body.model, [message(`${MARKERS.core} ${MARKERS.plugin} ${MARKERS.mcp} ${MARKERS.final}`)]);
    } else if (body.model === "fixture-lite") {
      const resultIds = new Set(record.resultCallIds);
      if (!resultIds.has("call_g2_search"))
        response = completedResponse(body.model, [
          {
            ...functionCall("run", "call_g2_search", "web"),
            arguments: JSON.stringify({ search_query: [{ q: "synthetic gateway qualification" }], response_length: "short" }),
          },
        ]);
      else if (text.includes(MARKERS.searchUrl))
        response = completedResponse(body.model, [message(`${MARKERS.searchUrl} ${MARKERS.searchFinal}`)]);
      else
        response = completedResponse(body.model, [message("SEARCH_RESULT_MARKER_MISSING")]);
    } else {
      response = completedResponse(body.model ?? "fixture", [message(MARKERS.cli)]);
    }
    const bytes = Buffer.from(JSON.stringify(response));
    res.writeHead(200, { "content-type": "application/json", "content-length": bytes.length });
    res.end(bytes);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    observations,
    close: () => new Promise((done) => server.close(done)),
  };
}

async function createPluginFixture(home, { plugin, serverName, toolName, markerValue }) {
  const version = join(home, "plugins", "cache", "fixture-market", plugin, "1.0.0");
  await mkdir(join(version, ".codex-plugin"), { recursive: true, mode: 0o700 });
  await writeFile(join(version, ".codex-plugin", "plugin.json"), JSON.stringify({
    name: plugin,
    version: "1.0.0",
    description: "Synthetic local qualification plugin",
    author: { name: "Codex Local Router acceptance" },
    license: "MIT",
  }), { mode: 0o600 });
  await writeFile(join(version, ".mcp.json"), JSON.stringify({
    mcpServers: {
      [serverName]: {
        command: process.execPath,
        args: [fixtureServer],
        default_tools_approval_mode: "approve",
        env: {
          ROUTER_ACCEPTANCE_MCP_MARKER: markerValue,
          ROUTER_ACCEPTANCE_MCP_TOOL: toolName,
          ROUTER_ACCEPTANCE_MCP_SERVER: serverName,
        },
      },
    },
  }), { mode: 0o600 });
  await writeFile(join(version, ".app.json"), JSON.stringify({
    apps: { [plugin]: { id: `fixture_${plugin}`, required: false } },
  }), { mode: 0o600 });
}

function appExtra({ websockets = false } = {}) {
  return [
    "[features]",
    `responses_websockets = ${websockets}`,
    `responses_websockets_v2 = ${websockets}`,
    "",
    '[plugins."github@fixture-market"]',
    "enabled = true",
    "",
    '[plugins."gmail@fixture-market"]',
    "enabled = true",
    "",
    "[mcp_servers.router_acceptance]",
    `command = ${JSON.stringify(process.execPath)}`,
    `args = [${JSON.stringify(fixtureServer)}]`,
    'approval_mode = "approve"',
    "",
    "[mcp_servers.router_acceptance.env]",
    `ROUTER_ACCEPTANCE_MCP_MARKER = ${JSON.stringify(MARKERS.mcp)}`,
    'ROUTER_ACCEPTANCE_MCP_TOOL = "read_user_marker"',
    'ROUTER_ACCEPTANCE_MCP_SERVER = "router_acceptance"',
    "",
  ].join("\n");
}

function mutateConfig(config, providerUrl) {
  config.subscription.enabled = true;
  config.providers = {
    fixture: {
      baseUrl: providerUrl,
      adapter: "openai-compatible",
      apiKeyEnv: "G2_FIXTURE_API_KEY",
      concurrency: 4,
    },
  };
  const base = {
    provider: "fixture",
    modelFamily: "openai-gpt",
    wireApi: "responses",
    contextWindow: 32000,
    maxContextWindow: 32000,
    inputModalities: ["text"],
    compression: { mode: "summary" },
    capabilities: { responses: true, toolCalling: true, freeformTools: true, streaming: true, nativeWebSearch: false },
  };
  config.targets = {
    "fixture-standard": {
      ...base,
      model: "fixture-standard",
      app: { enabled: true, modelId: "fixture-standard", displayName: "Fixture Standard", capabilityProfile: "standard-tools", useResponsesLite: false },
      standaloneSearch: { source: "disabled" },
    },
    "fixture-lite": {
      ...base,
      model: "fixture-lite",
      app: { enabled: true, modelId: "fixture-lite", displayName: "Fixture Lite", capabilityProfile: "lite-search", useResponsesLite: true },
      standaloneSearch: { source: "subscription" },
    },
  };
  config.defaultTarget = "fixture-standard";
  config.rules = [];
}

async function prepareHome(home, gateway, model, options = {}) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  await createPluginFixture(home, {
    plugin: "github",
    serverName: "acceptance_github",
    toolName: "read_plugin_marker",
    markerValue: MARKERS.plugin,
  });
  await createPluginFixture(home, {
    plugin: "gmail",
    serverName: "acceptance_gmail",
    toolName: "read_forbidden_marker",
    markerValue: "FORBIDDEN_PLUGIN_MARKER",
  });
  const catalogPath = join(home, "models.json");
  await isolatedCodexHome({
    home,
    baseUrl: `${gateway.url}/subscription/v1`,
    catalogPath,
    authSource,
    model,
    reasoningEffort: "low",
    webSearch: options.webSearch ?? "disabled",
    extra: appExtra(options),
  });
  await writeCatalog({ sourceCatalogPath: sourceCatalog, config: gateway.config, targetPath: catalogPath });
}

function recordCase(name, assertions, detail = {}) {
  const passed = Object.values(assertions).every(Boolean);
  cases.push({ name, passed, assertions, ...detail });
  process.stdout.write(`${JSON.stringify({ event: "g2_case", name, passed })}\n`);
  if (!passed) throw Object.assign(Error(`G2 case failed: ${name}`), { code: `g2_${name}_failed` });
}

function percentile(values, ratio) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function closeSocket(socket) {
  return new Promise((resolvePromise) => {
    if (socket.readyState === WebSocket.CLOSED) return resolvePromise();
    socket.once("close", resolvePromise);
    socket.close();
  });
}

function openGatewaySocket(gateway) {
  return new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(
      `${gateway.url.replace("http", "ws")}/subscription/v1/responses`,
      {
        headers: {
          authorization: `Bearer ${gateway.subscriptionToken}`,
          "chatgpt-account-id": gateway.subscriptionAccountId,
        },
        perMessageDeflate: false,
      },
    );
    socket.once("open", () => resolvePromise(socket));
    socket.once("error", reject);
  });
}

function websocketTurn(socket, body, timeoutMs = 15000) {
  return new Promise((resolvePromise, reject) => {
    const events = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(Error("G2 WebSocket turn timeout"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onMessage = (data) => {
      let event;
      try { event = JSON.parse(Buffer.from(data).toString("utf8")); } catch { return; }
      events.push(event);
      if (["response.completed", "response.failed", "response.incomplete", "error"].includes(event.type)) {
        cleanup();
        resolvePromise(events);
      }
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
    socket.send(JSON.stringify({
      type: "response.create",
      stream: true,
      max_output_tokens: 64,
      ...body,
    }));
  });
}

async function waitForGatewayIdle(url, { timeoutMs = 5000, websocketConnections = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${url}/healthz`);
    const health = await response.json();
    if (
      health.activeTurns === 0 &&
      (websocketConnections == null || health.websocketConnections === websocketConnections)
    ) return health;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw Error("Gateway lifecycle state did not drain");
}

class FakeOfficialSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    queueMicrotask(() => { this.readyState = 1; this.emit("open"); });
  }
  send(data, _options, callback) {
    callback?.();
    let request = {};
    try { request = JSON.parse(Buffer.from(data).toString("utf8")); } catch {}
    const response = completedResponse(request.model ?? "official-fixture", [message(MARKERS.official)]);
    const events = [
      { type: "response.created", sequence_number: 0, response: { ...response, status: "in_progress", output: [] } },
      { type: "response.output_item.added", sequence_number: 1, output_index: 0, item: response.output[0] },
      { type: "response.output_item.done", sequence_number: 2, output_index: 0, item: response.output[0] },
      { type: "response.completed", sequence_number: 3, response },
    ];
    queueMicrotask(() => events.forEach((event) => this.emit("message", Buffer.from(JSON.stringify(event)), false)));
  }
  close() { if (this.readyState !== 3) { this.readyState = 3; this.emit("close"); } }
  terminate() { this.close(); }
}

let gateway;
let provider;
let app;
let harnessError = null;
let core = null;
const syntheticSearchRequests = [];
let healthSampler = null;
let healthSamples = [];
let eventLoopMonitor = null;
let eventLoopDelayP99Ms = null;
let finalHealth = null;
let implementation = { commit: "working-tree" };
const startedAt = Date.now();
try {
  implementation = await verifyAcceptanceRevision(projectRoot, process.env.ACCEPTANCE_COMMIT);
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  process.env.G2_FIXTURE_API_KEY = "synthetic-loopback-key";
  provider = await createSyntheticProvider();
  const configPath = join(root, "gateway.json");
  const config = JSON.parse(await readFile(baseConfigPath, "utf8"));
  config.subscription.catalogPath = sourceCatalog;
  mutateConfig(config, provider.url);
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  core = await resolveCore();
  gateway = await startIsolatedGateway({
    configPath,
    authSource,
    tokenFile: join(root, "access-token"),
    archivePath: join(root, "history.sqlite"),
    archiveKey: createHash("sha256").update("profile-g2").digest(),
    toolCodexHome: join(root, "standard-home"),
    markerObservations,
    createOfficialWebSocket: () => new FakeOfficialSocket(),
    officialRequest: async (url, options) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/alpha/search")) {
        try { syntheticSearchRequests.push(JSON.parse(Buffer.from(options.body ?? "{}").toString("utf8"))); } catch {}
        return jsonResponse(200, {
          encrypted_output: null,
          output: `Synthetic qualification result ${MARKERS.searchUrl}`,
          results: [{
            type: "text_result",
            ref_id: "turn0search0",
            title: "Synthetic qualification result",
            url: MARKERS.searchUrl,
            snippet: "Synthetic public result",
          }],
        });
      }
      return jsonResponse(200, completedResponse("official-fixture", [message(MARKERS.official)]));
    },
  });

  const standardHome = join(root, "standard-home");
  await prepareHome(standardHome, gateway, "fixture-standard");
  // Tool discovery happens when the Gateway starts. Restart it after creating
  // the synthetic plugin manifests so policy attribution uses the same home.
  await gateway.close();
  gateway = await startIsolatedGateway({
    configPath,
    authSource,
    tokenFile: join(root, "access-token-2"),
    archivePath: join(root, "history-2.sqlite"),
    archiveKey: createHash("sha256").update("profile-g2-restart").digest(),
    toolCodexHome: standardHome,
    markerObservations,
    createOfficialWebSocket: () => new FakeOfficialSocket(),
    officialRequest: async (url, options) => {
      if (new URL(url).pathname.endsWith("/alpha/search")) {
        try { syntheticSearchRequests.push(JSON.parse(Buffer.from(options.body ?? "{}").toString("utf8"))); } catch {}
        return jsonResponse(200, {
          encrypted_output: null,
          output: `Synthetic qualification result ${MARKERS.searchUrl}`,
          results: [{
            type: "text_result",
            ref_id: "turn0search0",
            title: "Synthetic qualification result",
            url: MARKERS.searchUrl,
            snippet: "Synthetic public result",
          }],
        });
      }
      return jsonResponse(200, completedResponse("official-fixture", [message(MARKERS.official)]));
    },
  });
  await prepareHome(standardHome, gateway, "fixture-standard");
  healthSampler = startExternalHealthSampling(gateway.url, { intervalMs: 250, timeoutMs: 2000 });
  eventLoopMonitor = monitorEventLoop();

  app = startAppServer({ corePath: core.path, home: standardHome, cwd: workspace });
  await app.initialize("codex_local_router_g2_standard");
  const thread = await app.rpc("thread/start", {
    model: "fixture-standard",
    modelProvider: "openai",
    cwd: workspace,
    ephemeral: true,
    sandbox: "read-only",
    approvalPolicy: "never",
  });
  const standardStartedAt = Date.now();
  const standardTurn = await app.request(
    thread.thread.id,
    "fixture-standard",
    "Execute the synthetic qualification steps requested by the upstream fixture.",
    { timeoutMs: 120000 },
  );
  await app.close();
  app = null;
  const standardPayloads = gateway.payloads.filter((item) => item.model === "fixture-standard");
  const forwardedNames = new Set(standardPayloads.flatMap((item) => item.tools));
  const filtered = gateway.logs.filter((event) => event.event === "plugin_tools_filtered");
  recordCase("standard_tools_closure", {
    appServerCompleted: standardTurn.status === "completed",
    coreDefinitionForwarded: forwardedNames.has("exec_command"),
    allowedPluginDefinitionForwarded: [...forwardedNames].some((name) => String(name).includes("acceptance_github")),
    userMcpDefinitionForwarded: [...forwardedNames].some((name) => String(name).includes("router_acceptance")),
    forbiddenPluginDefinitionRemoved: [...forwardedNames].every((name) => !String(name).includes("acceptance_gmail")),
    builtInForbiddenPluginDefinitionRemoved: [...forwardedNames].every((name) => !String(name).includes("plugin_management")),
    filterDiagnosticObserved: filtered.some((event) => event.removed_count > 0),
    coreResultReachedUpstream: standardPayloads.some((item) => item.toolResultMarkers.includes("core")),
    pluginResultReachedUpstream: standardPayloads.some((item) => item.toolResultMarkers.includes("plugin")),
    userMcpResultReachedUpstream: standardPayloads.some((item) => item.toolResultMarkers.includes("mcp")),
    finalAnswerDependsOnAllResults: standardTurn.text.includes(MARKERS.final) && [MARKERS.core, MARKERS.plugin, MARKERS.mcp].every((item) => standardTurn.text.includes(item)),
  }, {
    profile: "standard-tools",
    clientItems: standardTurn.items,
    providerSteps: provider.observations.filter((item) => item.model === "fixture-standard").map((item) => ({
      toolCount: item.toolNames.length,
      markerLabels: item.markerLabels,
      resultCallIds: item.resultCallIds,
    })),
    durationMs: Date.now() - standardStartedAt,
  });

  const cliHome = join(root, "cli-ws-home");
  await prepareHome(cliHome, gateway, "fixture-cli", { websockets: true });
  const cliStartedAt = Date.now();
  const cli = await runCliExec({
    corePath: core.path,
    home: cliHome,
    cwd: workspace,
    args: ["--ephemeral", "--skip-git-repo-check", "-C", workspace, "-s", "read-only", "-c", 'approval_policy="never"', "-m", "fixture-standard"],
    prompt: "Return the fixture marker without tools.",
    timeoutMs: 90000,
  });
  recordCase("cli_http_path", {
    cliCompleted: cli.code === 0,
    providerResponseObserved: gateway.outbound.some((event) => event.path.endsWith("/responses") && !event.official),
    cliLifecycleObserved: ["thread.started", "turn.started", "turn.completed"].every((type) => cli.rows.some((row) => row.type === type)),
  }, {
    rowTypes: [...new Set(cli.rows.map((row) => row.type).filter(Boolean))],
    durationMs: Date.now() - cliStartedAt,
  });

  const liteHome = join(root, "lite-home");
  await prepareHome(liteHome, gateway, "fixture-lite", { webSearch: "live" });
  app = startAppServer({ corePath: core.path, home: liteHome, cwd: workspace });
  await app.initialize("codex_local_router_g2_lite");
  const liteThread = await app.rpc("thread/start", {
    model: "fixture-lite",
    modelProvider: "openai",
    cwd: workspace,
    ephemeral: true,
    sandbox: "read-only",
    approvalPolicy: "never",
  });
  const liteStartedAt = Date.now();
  const liteTurn = await app.request(
    liteThread.thread.id,
    "fixture-lite",
    "Use the synthetic standalone search and return its source.",
    { timeoutMs: 120000 },
  );
  await app.close();
  app = null;
  const litePayloads = gateway.payloads.filter((item) => item.model === "fixture-lite");
  const searchOutbound = gateway.outbound.filter((event) => event.path.endsWith("/alpha/search"));
  recordCase("lite_search_closure", {
    appServerCompleted: liteTurn.status === "completed",
    reducedCarrierAdvertised: litePayloads.some((item) => item.additionalToolSurface.hasWebRun),
    officialSearchRequested: searchOutbound.some((event) => event.official && event.status === 200),
    searchResultReachedThirdParty: litePayloads.some((item) => item.markerMatches.includes("searchUrl")),
    searchItemCompleted: liteTurn.items.some((item) => item.type === "webSearch" && item.status !== "failed"),
    finalAnswerUsesSearchResult: liteTurn.text.includes(MARKERS.searchFinal) && liteTurn.text.includes(MARKERS.searchUrl),
    credentialsSeparated: gateway.outbound.every((event) => (!event.subscriptionBearer && !event.accountHeader) || event.official) && gateway.outbound.every((event) => !event.providerCredential || !event.official),
  }, {
    profile: "lite-search",
    clientItems: liteTurn.items,
    searchEvidence: gateway.searchEvidence.map((item) => ({ status: item.status, complete: item.complete, bytes: item.bytes, resultCount: item.resultFingerprints.length })),
    durationMs: Date.now() - liteStartedAt,
  });

  const websocketStartedAt = Date.now();
  const socket = await openGatewaySocket(gateway);
  const customEvents = await websocketTurn(socket, {
    model: "fixture-standard",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "G2 custom WS" }] }],
  });
  const officialEvents = await websocketTurn(socket, {
    model: "gpt-official-g2-unmapped",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "G2 official WS" }] }],
  });
  const prewarmProviderCount = provider.observations.length;
  const prewarmEvents = await websocketTurn(socket, {
    model: "fixture-standard",
    generate: false,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "G2 prewarm" }] }],
  });
  const prewarmProviderAfter = provider.observations.length;
  await closeSocket(socket);
  const disconnected = await openGatewaySocket(gateway);
  disconnected.send(JSON.stringify({
    type: "response.create",
    model: "fixture-standard",
    stream: true,
    max_output_tokens: 64,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "G2_SLOW_DISCONNECT" }] }],
  }));
  await new Promise((done) => setTimeout(done, 75));
  disconnected.terminate();
  const drained = await waitForGatewayIdle(gateway.url);
  const reconnected = await openGatewaySocket(gateway);
  const reconnectEvents = await websocketTurn(reconnected, {
    model: "gpt-official-g2-unmapped",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "G2 reconnect" }] }],
  });
  await closeSocket(reconnected);
  finalHealth = await waitForGatewayIdle(gateway.url, { websocketConnections: 0 });
  const terminal = (events) => events.at(-1)?.type === "response.completed";
  const contiguous = (events) => events.every((event, index) => event.sequence_number === index);
  recordCase("websocket_switch_lifecycle", {
    customTurnCompleted: terminal(customEvents),
    officialTurnCompleted: terminal(officialEvents),
    sameConnectionSequencesPreserved: contiguous(customEvents) && contiguous(officialEvents),
    customPrewarmHandledLocally: terminal(prewarmEvents) && prewarmProviderAfter === prewarmProviderCount,
    disconnectCancelledAndCleaned: drained.activeTurns === 0,
    reconnectCompleted: terminal(reconnectEvents),
    officialRelayObserved: gateway.outbound.some((event) => event.official && event.transport === "websocket" && event.status === 101),
    allWebSocketsClosed: finalHealth.websocketConnections === 0,
  }, {
    transports: { custom: "websocket-to-http", official: "websocket-opaque-relay" },
    eventCounts: {
      custom: customEvents.length,
      official: officialEvents.length,
      prewarm: prewarmEvents.length,
      reconnect: reconnectEvents.length,
    },
    eventTypes: {
      custom: customEvents.map((event) => event.type),
      official: officialEvents.map((event) => event.type),
      prewarm: prewarmEvents.map((event) => event.type),
      reconnect: reconnectEvents.map((event) => event.type),
    },
    durationMs: Date.now() - websocketStartedAt,
  });
} catch (error) {
  harnessError = { type: error?.type ?? error?.code ?? error?.name ?? "error", message: error?.message ?? "G2 qualification failed" };
} finally {
  healthSamples = healthSampler?.stop() ?? [];
  eventLoopDelayP99Ms = eventLoopMonitor?.stop() ?? null;
  await app?.close().catch(() => {});
  await gateway?.close().catch(() => {});
  await provider?.close().catch(() => {});
  delete process.env.G2_FIXTURE_API_KEY;
}

const routeSetupMs = (gateway?.logs ?? [])
  .filter((item) => item.event === "route")
  .map((item) => item.request_setup_ms)
  .filter(Number.isFinite);
const performance = {
  localRequestSetupP95Ms: percentile(routeSetupMs, 0.95),
  localRequestSetupSamples: routeSetupMs.length,
  healthSampleCount: healthSamples.length,
  healthP95Ms: percentile(healthSamples.map((item) => item.ms), 0.95),
  eventLoopDelayP99Ms,
  finalActiveTurns: finalHealth?.activeTurns ?? null,
  finalWebsocketConnections: finalHealth?.websocketConnections ?? null,
};
const performanceHealthy =
  (performance.localRequestSetupP95Ms == null || performance.localRequestSetupP95Ms <= 300) &&
  (performance.healthP95Ms == null || performance.healthP95Ms <= 1000) &&
  (performance.eventLoopDelayP99Ms == null || performance.eventLoopDelayP99Ms <= 200) &&
  performance.finalActiveTurns === 0 &&
  performance.finalWebsocketConnections === 0;
const summary = {
  runId: new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14),
  verdict: harnessError == null && cases.length === 4 && cases.every((item) => item.passed) && performanceHealthy ? "PASS" : "FAIL",
  scope: "G2-deterministic-current-codex-profile-qualification",
  implementation,
  harness: core ? { source: core.source, version: core.version, sha256: core.sha256 } : null,
  isolation: {
    codexAuth: value("auth") ? "explicit-fixture" : "synthetic",
    officialCatalog: value("catalog") ? "explicit-fixture" : "synthetic",
    providerCredentials: "synthetic-only",
    providerNetwork: "loopback-only",
    officialNetwork: "injected-fake",
    realMachineMutation: false,
  },
  durationMs: Date.now() - startedAt,
  performance: { ...performance, softHealthLinesMet: performanceHealthy },
  cases,
  harnessError,
  diagnostics: {
    providerSteps: (provider?.observations ?? []).map((item) => ({
      model: item.model,
      generate: item.generate,
      toolCount: item.toolNames.length,
      namespaceCount: item.namespaces.length,
      markerLabels: item.markerLabels,
      resultCallIds: item.resultCallIds,
    })),
    gatewayPayloads: (gateway?.payloads ?? []).map((item) => ({
      model: item.model,
      toolCount: item.tools.length,
      markerMatches: item.markerMatches,
      toolResultMarkers: item.toolResultMarkers,
      callIds: item.callIds,
    })),
    gatewayEvents: [...new Set((gateway?.logs ?? []).map((item) => item.event).filter(Boolean))],
    syntheticSearchRequestCount: syntheticSearchRequests.length,
  },
};
if (output) {
  await writeImmutableJson(output, summary);
}
await rm(root, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ event: "g2_summary", verdict: summary.verdict, cases: cases.length, harnessError })}\n`);
process.exitCode = summary.verdict === "PASS" ? 0 : 1;

#!/usr/bin/env node
// Live, isolated qualification for client-owned MCP search and the subscription
// standard-tool bridge. Evidence contains metadata only, never prompts or keys.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  classifyTurnRepeats,
  isolatedCodexHome,
  resolveCore,
  runCliExec,
  startAppServer,
  startIsolatedGateway,
  verifyAcceptanceRevision,
  writeCatalog,
} from "./lib/harness.mjs";
import { FocusedAcceptanceBudget } from "./lib/focused-budget.mjs";

const argv = process.argv.slice(2);
const exec = promisify(execFile);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? undefined : argv[index + 1];
};
if (!flag("run")) {
  console.error("Universal search acceptance makes real GLM, ai.feei, OpenAI and Tavily requests. Re-run with --run after reviewing docs/public/acceptance.md.");
  process.exit(2);
}
if (!process.env.TAVILY_API_KEY)
  throw Object.assign(Error("TAVILY_API_KEY is required"), { code: "tavily_credential_missing" });

const projectRoot = resolve(import.meta.dirname, "..", "..");
const authSource = value("auth") ?? join(homedir(), ".codex", "auth.json");
const sourceCatalog = value("catalog") ?? join(homedir(), ".codex", "models_cache.json");
const sourceConfig = value("config") ?? join(homedir(), "Library", "Application Support", "Codex Local Router", "config.json");
const output = value("out") ? resolve(value("out")) : null;
const maxGenerations = Number(value("max-generations") ?? 8);
if (!Number.isInteger(maxGenerations) || maxGenerations < 1 || maxGenerations > 8)
  throw Object.assign(Error("--max-generations must be an integer from 1 to 8"), {
    code: "generation_budget_invalid",
  });
const root = await mkdtemp(join(tmpdir(), "codex-router-universal-search-"));
const workspace = join(root, "workspace");
const registryHome = join(root, "registry-home");
const budget = new FocusedAcceptanceBudget({ maxTurns: 3, maxGenerations, maxSearchRequests: 3 });
const cases = [];
const mcpInventories = [];
let gateway;
let app;
let core;
let harnessError = null;
let implementation = { commit: "working-tree" };
let liveSource;
let tavilyCommand;

const finalCliText = (run) => run.rows
  .filter((row) => row.type === "item.completed" && row.item?.type === "agent_message")
  .map((row) => row.item.text ?? "")
  .join("\n");

function normalizeTarget(target, { bridge }) {
  const next = structuredClone(target);
  next.wireApi = "responses";
  next.capabilities = {
    ...next.capabilities,
    responses: true,
    streaming: true,
    toolCalling: true,
    nativeWebSearch: false,
    freeformTools: false,
  };
  next.app = {
    ...next.app,
    capabilityProfile: "standard-tools",
    useResponsesLite: false,
    instructionDelivery: "client",
    shellType: "shell_command",
    reasoningLevels: ["low", "high", "max"],
    defaultReasoningLevel: "max",
  };
  delete next.app.toolMode;
  delete next.app.multiAgent;
  delete next.app.thirdPartyTemplate;
  delete next.app.supportsSearchTool;
  next.standaloneSearch = { source: "disabled" };
  next.subscriptionSearch = { delivery: bridge ? "standard-tool" : "disabled" };
  return next;
}

function mutate(config) {
  const source = liveSource;
  config.providers = {
    "bigmodel-coding": structuredClone(source.providers["bigmodel-coding"]),
    feei: structuredClone(source.providers.feei),
  };
  config.targets = {
    "glm-flash": normalizeTarget(source.targets["glm-flash"], { bridge: true }),
    "feei-sol": normalizeTarget(source.targets["feei-sol"], { bridge: true }),
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

function appExtra({ tavily = false } = {}) {
  const lines = [
    "mcp_optional_startup_grace_ms = 0",
    "",
    "[features]",
    "responses_websockets = false",
    "responses_websockets_v2 = false",
    "",
  ];
  if (tavily) lines.push(
    "[mcp_servers.tavily]",
    `command = ${JSON.stringify(tavilyCommand)}`,
    "required = true",
    "startup_timeout_sec = 30.0",
    'default_tools_approval_mode = "approve"',
    "",
    "[mcp_servers.tavily.env]",
    `TAVILY_API_KEY = ${JSON.stringify(process.env.TAVILY_API_KEY)}`,
    ...(process.env.NODE_EXTRA_CA_CERTS
      ? [`NODE_EXTRA_CA_CERTS = ${JSON.stringify(process.env.NODE_EXTRA_CA_CERTS)}`]
      : []),
    "",
  );
  return lines.join("\n");
}

async function prepareHome(name, model, { webSearch = "disabled", tavily = false, reasoningEffort = "low" } = {}) {
  const home = join(root, name);
  const catalogPath = join(home, "models.json");
  await isolatedCodexHome({
    home,
    baseUrl: `${gateway.url}/subscription/v1`,
    catalogPath,
    authSource,
    model,
    reasoningEffort,
    webSearch,
    extra: appExtra({ tavily }),
  });
  await writeCatalog({ sourceCatalogPath: sourceCatalog, config: gateway.config, targetPath: catalogPath });
  if (tavily) {
    const probe = startAppServer({ corePath: core.path, home, cwd: workspace });
    try {
      await probe.initialize(`codex_local_router_${name}_mcp_preflight`);
      const inventory = await probe.rpc("mcpServerStatus/list", {
        cursor: null,
        detail: "toolsAndAuthOnly",
        limit: 100,
        threadId: null,
      });
      const server = inventory.data?.find((item) => item.name === "tavily");
      const toolNames = Object.keys(server?.tools ?? {});
      mcpInventories.push({ name, server: server?.name ?? null, toolNames, toolsError: server?.toolsError != null });
      if (!toolNames.includes("tavily_search"))
        throw Object.assign(Error("Codex did not register Tavily MCP tools"), {
          code: "tavily_mcp_catalog_missing",
        });
    } finally {
      await probe.close().catch(() => {});
    }
  }
  return home;
}

function snapshot() {
  return {
    outbound: gateway.outbound.length,
    payloads: gateway.payloads.length,
    logs: gateway.logs.length,
    search: gateway.searchEvidence.length,
  };
}

function evaluate({ name, kind, marker, text, completed, items, start, host, clientStreaming }) {
  const outbound = gateway.outbound.slice(start.outbound);
  const payloads = gateway.payloads.slice(start.payloads);
  const logs = gateway.logs.slice(start.logs);
  const searchEvidence = gateway.searchEvidence.slice(start.search);
  const generations = outbound.filter((event) =>
    event.host === host && event.path.endsWith("/responses") && event.generate !== false);
  const officialSearch = outbound.filter((event) =>
    event.official && event.path.endsWith("/alpha/search"));
  const repeats = classifyTurnRepeats(logs);
  const clientMcp = items.filter((item) =>
    String(item.type ?? "").replaceAll("_", "").toLowerCase() === "mcptoolcall");
  const providerPayloads = payloads.filter((item) => item.host === host && item.path.endsWith("/responses"));
  const bridgeResult = generations.some((event) => event.searchResultFingerprint);
  const assertions = kind === "bridge"
    ? {
        completed,
        officialSearchCompleted: officialSearch.length > 0 && officialSearch.every((event) => event.status >= 200 && event.status < 300),
        providerGenerationCompleted: generations.length > 1 && generations.every((event) => event.status >= 200 && event.status < 300),
        bridgeCallAndResultClosed:
          providerPayloads.some((item) => item.toolCallNames.includes("gateway_subscription_web_search")) &&
          providerPayloads.some((item) => item.callIds.some((id) => id.startsWith("function_call_output:"))),
        resultObservedAndForwarded:
          searchEvidence.some((item) => item.complete && item.resultFingerprints.length > 0) && bridgeResult,
        sourceAndMarkerPresent: text.includes(marker) && /https?:\/\//.test(text),
      }
    : {
        completed,
        officialSearchNotUsed: officialSearch.length === 0,
        mcpCallCompleted: clientMcp.length === 1 && clientMcp[0].status !== "failed",
        tavilyAvailableToModel:
          providerPayloads.some((item) =>
            [...item.tools, ...item.additionalToolSurface.names].some((tool) => /tavily/i.test(String(tool)))) ||
          (
            providerPayloads.some((item) => item.tools.includes("tool_search")) &&
            providerPayloads.some((item) => item.toolCallNames.includes("tavily_search"))
          ),
        toolResultReturned: providerPayloads.some((item) =>
          item.callIds.some((id) => id.startsWith("function_call_output:"))),
        providerGenerationCompleted: generations.length > 1 && generations.every((event) => event.status >= 200 && event.status < 300),
        sourceAndMarkerPresent: text.includes(marker) && /https?:\/\//.test(text),
      };
  Object.assign(assertions, {
    subscriptionCredentialOnlyOpenAI: outbound.every((event) =>
      (!event.subscriptionBearer && !event.accountHeader) || event.official),
    providerCredentialOnlyProvider: outbound.every((event) =>
      !event.providerCredential || !event.official),
    expectedCredentialsPresent:
      generations.length > 0 && generations.every((event) => event.providerCredential) &&
      (kind !== "bridge" || officialSearch.every((event) => event.subscriptionBearer)),
    noAutomaticRetry: repeats.reconnects.length === 0 && budget.implicitRetries === 0,
  });
  const delivered = logs.filter((event) => event.event === "downstream_stream_completed" && event.text_deltas > 0);
  if (kind === "bridge") {
    assertions.gatewayTextStreamingObserved = delivered.some((event) =>
      event.text_deltas > 1 && event.first_text_to_terminal_ms > 0);
    if (clientStreaming) assertions.clientTextStreamingObserved =
      clientStreaming.deltas > 1 && clientStreaming.firstTextToTerminalMs > 0;
  }
  cases.push({
    name,
    kind,
    passed: Object.values(assertions).every(Boolean),
    assertions,
    counts: {
      generations: generations.length,
      officialSearches: officialSearch.length,
      clientMcpCalls: clientMcp.length,
    },
    streaming: { client: clientStreaming ?? null, gateway: delivered.map((event) => ({
      textDeltas: event.text_deltas, textBytes: event.text_bytes,
      textSpanMs: event.text_span_ms, firstTextToTerminalMs: event.first_text_to_terminal_ms,
    })) },
    destinations: {
      generation: [...new Set(generations.map((event) => event.host))],
      officialSearch: [...new Set(officialSearch.map((event) => event.host))],
    },
    toolSurfaces: providerPayloads.map((item) => ({
      tools: item.tools,
      additionalTools: item.additionalToolSurface.names,
      calls: item.toolCallNames,
      resultKinds: item.callIds.map((id) => id.split(":", 1)[0]),
    })),
    clientItems: items.map((item) => ({
      type: item.type,
      status: item.status,
      errorCategory: item.errorCategory ?? null,
    })),
  });
}

function requirePassed() {
  if (cases.at(-1)?.passed) return;
  throw Object.assign(Error("universal search acceptance case failed"), {
    code: "acceptance_case_failed",
  });
}

async function runCliCase({ name, model, host, kind, tavily = false, webSearch, marker, reasoningEffort = "low" }) {
  budget.beginTurn();
  const home = await prepareHome(`${name}-home`, model, { tavily, webSearch, reasoningEffort });
  const started = snapshot();
  const controller = new AbortController();
  budget.activeAbort = () => controller.abort();
  try {
    const prompt = kind === "bridge"
      ? `Use the configured web search once for the official Codex web search documentation. Include a source URL and finish with ${marker}. Do not use other tools.`
      : `First call tool_search to load tavily_search. Then call that Tavily MCP tool exactly once for the official Codex web search documentation, with max_results 5, search_depth basic, and no date filters. Include a source URL and finish with ${marker}.`;
    const run = await runCliExec({
      corePath: core.path,
      home,
      cwd: workspace,
      args: ["--ephemeral", "--skip-git-repo-check", "-C", workspace, "-s", "read-only", "-c", 'approval_policy="never"', "-m", model],
      prompt,
      timeoutMs: 360000,
      signal: controller.signal,
    });
    const items = run.rows
      .filter((row) => row.type?.startsWith("item."))
      .map((row) => ({ type: row.item?.type ?? null, status: row.item?.status ?? null, errorCategory: null }));
    evaluate({ name, kind, marker, text: finalCliText(run), completed: run.code === 0, items, start: started, host });
  } finally {
    budget.activeAbort = null;
  }
}

async function runAppCase({ name, model, host, kind, tavily = false, webSearch, marker, reasoningEffort = "low" }) {
  budget.beginTurn();
  const home = await prepareHome(`${name}-home`, model, { tavily, webSearch, reasoningEffort });
  app = startAppServer({ corePath: core.path, home, cwd: workspace });
  await app.initialize(`codex_local_router_${name}`);
  const thread = await app.rpc("thread/start", {
    model,
    modelProvider: "openai",
    cwd: workspace,
    ephemeral: true,
    sandbox: "read-only",
    approvalPolicy: "never",
  });
  const started = snapshot();
  budget.activeAbort = () => app.close();
  try {
    const prompt = kind === "bridge"
      ? `Use the configured web search once for the official Codex web search documentation. Include a source URL and finish with ${marker}. Do not use other tools.`
      : `First call tool_search to load tavily_search. Then call that Tavily MCP tool exactly once for the official Codex web search documentation, with max_results 5, search_depth basic, and no date filters. Include a source URL and finish with ${marker}.`;
    const turn = await app.request(thread.thread.id, model, prompt, { timeoutMs: 360000 });
    evaluate({ name, kind, marker, text: turn.text, completed: turn.status === "completed", items: turn.items, start: started, host,
      clientStreaming: { deltas: turn.textDeltas.length,
        textSpanMs: turn.textDeltas.length ? turn.textDeltas.at(-1).at - turn.textDeltas[0].at : null,
        firstTextToTerminalMs: turn.firstTextAt == null ? null : turn.endedAt - turn.firstTextAt } });
  } finally {
    budget.activeAbort = null;
    await app.close().catch(() => {});
    app = null;
  }
}

try {
  implementation = await verifyAcceptanceRevision(projectRoot, process.env.ACCEPTANCE_COMMIT);
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await mkdir(registryHome, { recursive: true, mode: 0o700 });
  const tavilyPrefix = join(root, "tavily-mcp");
  await exec("npm", [
    "install", "--prefix", tavilyPrefix, "--ignore-scripts", "--no-audit", "--no-fund",
    "tavily-mcp@0.2.21",
  ], { timeout: 120000, maxBuffer: 1024 * 1024 });
  tavilyCommand = join(tavilyPrefix, "node_modules", ".bin", "tavily-mcp");
  const tavilyTools = await exec(tavilyCommand, ["--list-tools"], {
    env: { ...process.env, TAVILY_API_KEY: process.env.TAVILY_API_KEY },
    timeout: 20000,
  });
  if (!tavilyTools.stdout.includes("tavily_search"))
    throw Object.assign(Error("Tavily MCP preflight did not expose tavily_search"), {
      code: "tavily_mcp_preflight_failed",
    });
  await writeFile(join(registryHome, "config.toml"), [
    "[mcp_servers.tavily]",
    `command = ${JSON.stringify(tavilyCommand)}`,
    "",
  ].join("\n"), { mode: 0o600 });
  liveSource = JSON.parse(await readFile(sourceConfig, "utf8"));
  if (!liveSource.providers?.["bigmodel-coding"] || !liveSource.providers?.feei ||
      !liveSource.targets?.["glm-flash"] || !liveSource.targets?.["feei-sol"])
    throw Object.assign(Error("required source providers or targets are missing"), { code: "source_configuration_incomplete" });
  const configPath = join(root, "gateway.json");
  const base = JSON.parse(await readFile(join(projectRoot, "config", "gateway.example.json"), "utf8"));
  base.subscription.enabled = true;
  base.subscription.catalogPath = sourceCatalog;
  await writeFile(configPath, JSON.stringify(base), { mode: 0o600 });
  core = await resolveCore();
  gateway = await startIsolatedGateway({
    configPath,
    authSource,
    tokenFile: join(root, "access-token"),
    archivePath: join(root, "history.sqlite"),
    archiveKey: createHash("sha256").update("universal-search-acceptance").digest(),
    toolCodexHome: registryHome,
    mutate,
    beforeOutbound: (event) => budget.beforeOutbound(event),
  });

  await runAppCase({
    name: "glm-flash-app-subscription-bridge",
    model: gateway.config.targets["glm-flash"].app.modelId,
    host: new URL(gateway.config.providers["bigmodel-coding"].baseUrl).host,
    kind: "bridge",
    webSearch: "live",
    marker: "GLM_SUBSCRIPTION_SEARCH_OK",
    reasoningEffort: "max",
  });
  requirePassed();
  await runCliCase({
    name: "feei-sol-cli-subscription-bridge",
    model: gateway.config.targets["feei-sol"].app.modelId,
    host: new URL(gateway.config.providers.feei.baseUrl).host,
    kind: "bridge",
    webSearch: null,
    marker: "FEEI_SUBSCRIPTION_SEARCH_OK",
  });
  requirePassed();
  await runAppCase({
    name: "feei-sol-app-tavily",
    model: gateway.config.targets["feei-sol"].app.modelId,
    host: new URL(gateway.config.providers.feei.baseUrl).host,
    kind: "mcp",
    tavily: true,
    webSearch: "disabled",
    marker: "FEEI_TAVILY_OK",
  });
  requirePassed();
} catch (error) {
  harnessError = {
    type: error?.type ?? error?.code ?? error?.name ?? "acceptance_error",
    message: error?.type ?? error?.code ?? "universal search acceptance failed",
  };
} finally {
  await app?.close().catch(() => {});
  await gateway?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}

const observedBudget = budget.snapshot();
const externalMcpSearches = cases.reduce((count, item) => count + item.counts.clientMcpCalls, 0);
const summary = {
  verdict: !harnessError && cases.length === 3 && cases.every((item) => item.passed)
    ? "PASS"
    : "FAIL",
  implementation,
  driver: core ? { source: core.source, version: core.version, sha256: core.sha256 } : null,
  budget: {
    ...observedBudget,
    officialSearchRequests: observedBudget.searchRequests,
    externalMcpSearches,
    searchRequests: observedBudget.searchRequests + externalMcpSearches,
  },
  cases,
  mcpInventories,
  harnessError,
  appUi: "not-tested",
};
if (output) {
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
console.log(JSON.stringify(summary, null, 2));
if (summary.verdict !== "PASS") process.exitCode = 1;

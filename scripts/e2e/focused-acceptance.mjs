#!/usr/bin/env node
// Five-turn release-candidate acceptance for the official relay and ai.feei.
// This is opt-in and records metadata/assertions only; it never stores prompts,
// responses, credentials, image bytes, or tool schemas.
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  isolatedCodexHome,
  resolveCore,
  runCliExec,
  startAppServer,
  startIsolatedGateway,
  writeCatalog,
} from "./lib/harness.mjs";
import { solidPng } from "./lib/png.mjs";
import { FocusedAcceptanceBudget } from "./lib/focused-budget.mjs";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? undefined : argv[index + 1];
};
const projectRoot = resolve(import.meta.dirname, "..", "..");
const productionConfig = value("config") ??
  join(homedir(), "Library", "Application Support", "Codex Local Router", "config.json");
const authSource = value("auth") ?? join(homedir(), ".codex", "auth.json");
const sourceCatalog = value("catalog") ?? join(homedir(), ".codex", "models_cache.json");
const fixtureServer = join(import.meta.dirname, "fixtures", "read-only-mcp.mjs");

const toolShapeOnly = flag("tool-shape-only");
if (!flag("run") && !toolShapeOnly) {
  console.error("Focused acceptance makes real provider calls. Re-run with --run after reviewing docs/public/acceptance.md, or use --tool-shape-only for the zero-network-provider preflight.");
  process.exit(2);
}
if (!toolShapeOnly && !process.env.FEEI_API_KEY)
  throw Error("FEEI_API_KEY is required in the environment");

const budget = new FocusedAcceptanceBudget();

const root = await mkdtemp(join(tmpdir(), "codex-router-focused-"));
const codexHome = join(root, "codex-home");
const work = join(root, "workspace");
const runId = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
const output = resolve(value("out") ?? join(projectRoot, "artifacts", "focused", runId, "summary.json"));
const marker = `MCP_${createHash("sha256").update(randomUUID()).digest("hex").slice(0, 12)}`;
const cases = [];
let app;
let gateway;
let core;
let toolShape;
let harnessError;

function result(name, passed, detail = {}) {
  cases.push({ name, passed: Boolean(passed), ...detail });
  console.log(JSON.stringify({ event: "focused_case", name, passed: Boolean(passed) }));
}

function cliText(run) {
  return run.rows
    .filter((row) => row.type === "item.completed" && row.item?.type === "agent_message")
    .map((row) => row.item.text ?? "")
    .join("\n");
}

function appExtra() {
  return [
    "[features]",
    "responses_websockets = false",
    "responses_websockets_v2 = false",
    "",
    '[plugins."github@openai-curated-remote"]',
    "enabled = true",
    "",
    '[plugins."plugin-management@openai-curated-remote"]',
    "enabled = true",
    "",
    "[mcp_servers.router_acceptance]",
    `command = ${JSON.stringify(process.execPath)}`,
    `args = [${JSON.stringify(fixtureServer)}]`,
    "",
    "[mcp_servers.router_acceptance.env]",
    `ROUTER_ACCEPTANCE_MCP_MARKER = ${JSON.stringify(marker)}`,
    "",
  ].join("\n");
}

function feeiMutation(config) {
  config.providers.feei = {
    baseUrl: "https://ai.feei.cn/v1",
    adapter: "openai-compatible",
    apiKeyEnv: "FEEI_API_KEY",
    concurrency: 2,
  };
  config.targets["feei-sol"] = { provider: "feei", preset: "feei/gpt-5.6-sol" };
  config.targets["feei-astra"] = { provider: "feei", preset: "feei/gpt-6-astra" };
}

async function preparePlugin() {
  for (const name of ["github", "plugin-management"]) {
    const source = join(homedir(), ".codex", "plugins", "cache", "openai-curated-remote", name);
    const target = join(codexHome, "plugins", "cache", "openai-curated-remote", name);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await cp(source, target, { recursive: true, preserveTimestamps: true });
  }
}

async function captureCurrentToolShape() {
  const fake = createServer(async (req, res) => {
    for await (const _chunk of req) {}
    const response = Buffer.from(JSON.stringify({
      id: "resp_tool_shape",
      status: "completed",
      model: "gpt-5.6-sol",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "TOOL_SHAPE_OK" }],
      }],
    }));
    res.writeHead(200, { "content-type": "application/json", "content-length": response.length });
    res.end(response);
  });
  await new Promise((resolvePromise) => fake.listen(0, "127.0.0.1", resolvePromise));
  const fakeUrl = `http://127.0.0.1:${fake.address().port}/v1`;
  const shapeRoot = join(root, "tool-shape");
  await mkdir(shapeRoot, { recursive: true, mode: 0o700 });
  process.env.ROUTER_SHAPE_KEY = "synthetic-local-key";
  const shapeGateway = await startIsolatedGateway({
    configPath: productionConfig,
    authSource,
    tokenFile: join(shapeRoot, "access-token"),
    archivePath: join(shapeRoot, "history.sqlite"),
    archiveKey: createHash("sha256").update(`shape-${runId}`).digest(),
    toolCodexHome: codexHome,
    mutate(config) {
      config.providers.shape = {
        baseUrl: fakeUrl,
        adapter: "openai-compatible",
        apiKeyEnv: "ROUTER_SHAPE_KEY",
      };
      config.targets.shape = {
        provider: "shape",
        model: "gpt-5.6-sol",
        modelFamily: "openai-gpt",
        wireApi: "responses",
        contextWindow: 272000,
        maxContextWindow: 272000,
        inputModalities: ["text", "image"],
        compression: { mode: "summary" },
        capabilities: {
          responses: true,
          toolCalling: true,
          freeformTools: true,
          streaming: true,
          nativeWebSearch: false,
        },
        app: {
          enabled: true,
          modelId: "shape-gpt",
          displayName: "Shape Fixture",
          supportsSearchTool: false,
          useResponsesLite: false,
        },
      };
    },
  });
  let shapeApp;
  try {
    const catalogPath = join(shapeRoot, "models.json");
    await writeCatalog({ sourceCatalogPath: sourceCatalog, config: shapeGateway.config, targetPath: catalogPath });
    await isolatedCodexHome({
      home: codexHome,
      baseUrl: `${shapeGateway.url}/subscription/v1`,
      catalogPath,
      authSource,
      model: "shape-gpt",
      reasoningEffort: "low",
      extra: appExtra(),
    });
    shapeApp = startAppServer({ corePath: core.path, home: codexHome, cwd: work });
    await shapeApp.initialize("codex_local_router_tool_shape");
    const thread = await shapeApp.rpc("thread/start", {
      model: "shape-gpt",
      modelProvider: "openai",
      cwd: work,
      ephemeral: true,
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    const turn = await shapeApp.request(
      thread.thread.id,
      "shape-gpt",
      "Reply exactly TOOL_SHAPE_OK without using tools.",
      { timeoutMs: 120000 },
    );
    const tools = new Set(shapeGateway.payloads.flatMap((payload) => payload.tools ?? []));
    const filtered = shapeGateway.logs.filter((event) => event.event === "plugin_tools_filtered");
    const allowedPlugin = [...tools].some((tool) => tool.includes("codex_apps__github"));
    const userMcp = [...tools].some((tool) => tool.includes("router_acceptance"));
    const forbiddenRemoved = filtered.some((event) =>
      event.removed_count > 0 && event.removed_plugins?.includes("plugin_management"),
    );
    const passed = turn.status === "completed" && allowedPlugin && userMcp && forbiddenRemoved;
    return {
      passed,
      client: core.version,
      carrierPayloads: shapeGateway.payloads.length,
      forwardedToolCount: tools.size,
      allowedPlugin,
      userMcp,
      forbiddenPluginObservedAndRemoved: forbiddenRemoved,
    };
  } finally {
    await shapeApp?.close().catch(() => {});
    await shapeGateway.close().catch(() => {});
    await new Promise((resolvePromise) => fake.close(resolvePromise));
    delete process.env.ROUTER_SHAPE_KEY;
  }
}

async function cliCase(name, model, prompt, image) {
  budget.beginTurn();
  const controller = new AbortController();
  budget.activeAbort = () => controller.abort();
  try {
    const run = await runCliExec({
      corePath: core.path,
      home: codexHome,
      cwd: work,
      prompt,
      args: [
        "--ephemeral", "--skip-git-repo-check", "-C", work, "-s", "read-only",
        "-c", 'approval_policy="never"', "-m", model,
        ...(image ? ["-i", image] : []),
      ],
      timeoutMs: 300000,
      signal: controller.signal,
    });
    return { run, text: cliText(run) };
  } finally {
    budget.activeAbort = null;
  }
}

async function appCase(name, model) {
  budget.beginTurn();
  const thread = await app.rpc("thread/start", {
    model,
    modelProvider: "openai",
    cwd: work,
    ephemeral: true,
    sandbox: "read-only",
    approvalPolicy: "never",
  });
  budget.activeAbort = () => app.close();
  try {
    return await app.request(
      thread.thread.id,
      model,
      [
        "This is a controlled read-only acceptance turn using synthetic/public data only.",
        "You must call the router_acceptance read_marker MCP tool and include its returned marker verbatim.",
        "You must use the GitHub Plugin read-only on the public nyankosama/codex-local-router repository.",
        "You must use standalone web search for the public OpenAI Codex web-search documentation and mention a source host.",
        "Do not use shell, files, private repositories, messages, or write actions.",
      ].join(" "),
      { timeoutMs: 360000 },
    );
  } finally {
    budget.activeAbort = null;
  }
}

try {
  await mkdir(work, { recursive: true, mode: 0o700 });
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await preparePlugin();
  await writeFile(join(codexHome, "config.toml"), appExtra(), { mode: 0o600 });
  core = await resolveCore();
  toolShape = await captureCurrentToolShape();
  if (!toolShape.passed) throw Error("current Codex tool-shape preflight failed");
  console.log(JSON.stringify({ event: "tool_shape_preflight", passed: true }));
  if (toolShapeOnly) {
    await rm(root, { recursive: true, force: true });
    console.log(JSON.stringify({ event: "tool_shape_summary", ...toolShape }));
    process.exit(0);
  }
  gateway = await startIsolatedGateway({
    configPath: productionConfig,
    authSource,
    tokenFile: join(root, "access-token"),
    archivePath: join(root, "history.sqlite"),
    archiveKey: createHash("sha256").update(`focused-${runId}`).digest(),
    mutate: feeiMutation,
    toolCodexHome: codexHome,
    beforeOutbound: (event) => budget.beforeOutbound(event),
  });
  const catalogPath = join(codexHome, "models.json");
  await writeCatalog({ sourceCatalogPath: sourceCatalog, config: gateway.config, targetPath: catalogPath });
  await isolatedCodexHome({
    home: codexHome,
    baseUrl: `${gateway.url}/subscription/v1`,
    catalogPath,
    authSource,
    model: "gpt-5.6-sol",
    reasoningEffort: "low",
    webSearch: "live",
    extra: appExtra(),
  });

  const official = await cliCase(
    "official-cli-search",
    "gpt-5.6-sol",
    "Use standalone web search on the public OpenAI Codex web-search documentation, mention one source host, then end with OFFICIAL_SEARCH_OK. Do not use any other tool.",
  );
  const officialSearches = gateway.outbound.filter((event) => event.path.endsWith("/alpha/search"));
  const officialSearchCompleted = officialSearches.some(
    (event) => event.official && event.status >= 200 && event.status < 300,
  );
  result("official-cli-search", official.run.code === 0 && official.text.includes("OFFICIAL_SEARCH_OK") && officialSearchCompleted, {
    cliExit: official.run.code,
    searchCompleted: officialSearchCompleted,
  });
  if (budget.generations >= budget.maxGenerations)
    throw Object.assign(Error("generation_budget_exhausted"), { code: "generation_budget_exhausted" });

  const imagePath = join(work, "synthetic-red.png");
  await writeFile(imagePath, solidPng(64, [220, 20, 20]), { mode: 0o600 });
  for (const [name, model, markerText] of [
    ["feei-sol-cli", "feei-gpt-5.6-sol", "FEEI_SOL_OK"],
    ["feei-astra-cli", "feei-gpt-6-astra", "FEEI_ASTRA_OK"],
  ]) {
    const checked = await cliCase(
      name,
      model,
      `Identify the synthetic image's dominant color, answer briefly, and end with ${markerText}. Do not use tools.`,
      imagePath,
    );
    result(name, checked.run.code === 0 && /red/i.test(checked.text) && checked.text.includes(markerText), {
      cliExit: checked.run.code,
      imageRecognized: /red/i.test(checked.text),
    });
    if (budget.generations >= budget.maxGenerations)
      throw Object.assign(Error("generation_budget_exhausted"), { code: "generation_budget_exhausted" });
  }

  app = startAppServer({ corePath: core.path, home: codexHome, cwd: work });
  await app.initialize("codex_local_router_focused_acceptance");
  for (const [name, model] of [
    ["feei-sol-app", "feei-gpt-5.6-sol"],
    ["feei-astra-app", "feei-gpt-6-astra"],
  ]) {
    const beforePayloads = gateway.payloads.length;
    const beforeLogs = gateway.logs.length;
    const beforeOutbound = gateway.outbound.length;
    const turn = await appCase(name, model);
    const payloads = gateway.payloads.slice(beforePayloads);
    const logs = gateway.logs.slice(beforeLogs);
    const toolNames = new Set(payloads.flatMap((payload) => payload.tools ?? []));
    const filtered = logs.filter((event) => event.event === "plugin_tools_filtered");
    const calls = turn.items.filter((item) => ["mcpToolCall", "dynamicToolCall"].includes(item.type));
    const searches = gateway.outbound
      .slice(beforeOutbound)
      .filter((event) => event.path.endsWith("/alpha/search"));
    const allowedPluginPresent = [...toolNames].some((tool) => tool.includes("codex_apps__github"));
    const userMcpPresent = [...toolNames].some((tool) => tool.includes("router_acceptance"));
    const forbiddenAbsent = [...toolNames].every((tool) =>
      !["gmail", "safety_settings", "plugin_management", "alpaca"].some((name) => tool.includes(name)),
    );
    result(name, [
      turn.status === "completed",
      turn.text.includes(marker),
      calls.length >= 2,
      allowedPluginPresent,
      userMcpPresent,
      forbiddenAbsent,
      filtered.some((event) => event.removed_count > 0),
      searches.length > 0 && searches.every(
        (event) => event.official && event.status >= 200 && event.status < 300,
      ),
    ].every(Boolean), {
      status: turn.status,
      mcpMarkerReturned: turn.text.includes(marker),
      completedToolCalls: calls.length,
      allowedPluginPresent,
      userMcpPresent,
      forbiddenPluginObservedBeforeAndRemoved: filtered.some((event) => event.removed_count > 0) && forbiddenAbsent,
      standaloneSearchCompleted: searches.some(
        (event) => event.official && event.status >= 200 && event.status < 300,
      ),
    });
    if (budget.generations >= budget.maxGenerations && name !== "feei-astra-app")
      throw Object.assign(Error("generation_budget_exhausted"), { code: "generation_budget_exhausted" });
  }
} catch (error) {
  harnessError = error?.type ?? error?.code ?? error?.name ?? "error";
} finally {
  await app?.close().catch(() => {});
  await gateway?.close().catch(() => {});
  const summary = {
    runId,
    verdict: cases.length === 5 && cases.every((entry) => entry.passed) ? "PASS" : "FAIL",
    harness: typeof core === "object" ? {
      source: core.source,
      version: core.version,
      sha256: core.sha256,
    } : null,
    budget: budget.snapshot(),
    toolShape: toolShape ?? null,
    identityBoundary: gateway ? {
      officialHosts: [...new Set(gateway.outbound.filter((event) => event.official).map((event) => event.host))],
      thirdPartyHosts: [...new Set(gateway.outbound.filter((event) => !event.official).map((event) => event.host))],
      subscriptionCredentialReachedThirdParty: gateway.outbound.some(
        (event) => !event.official && (event.subscriptionBearer || event.accountHeader),
      ),
    } : null,
    cases,
    harnessError: harnessError ?? null,
    appUi: "not-tested",
  };
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify({ event: "focused_summary", verdict: summary.verdict, turns: budget.turns, generations: budget.generations }));
  process.exitCode = summary.verdict === "PASS" ? 0 : 1;
}

#!/usr/bin/env node
// Two-turn acceptance for third-party GPT generation plus first-party standalone
// search. The artifact contains only hashes, counts, destinations and booleans.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? undefined : argv[index + 1];
};
if (!flag("run")) {
  console.error("Third-party search acceptance makes two real ai.feei turns. Re-run with --run after reviewing docs/public/acceptance.md.");
  process.exit(2);
}

const projectRoot = resolve(import.meta.dirname, "..", "..");
const authSource = value("auth") ?? join(homedir(), ".codex", "auth.json");
const sourceCatalog = value("catalog") ?? join(homedir(), ".codex", "models_cache.json");
const output = value("out") ? resolve(value("out")) : null;
const root = await mkdtemp(join(tmpdir(), "codex-router-third-party-search-"));
const codexHome = join(root, "codex-home");
const work = join(root, "workspace");
const budget = new FocusedAcceptanceBudget({
  maxTurns: 2,
  // A normal Responses Lite search may need search, open, and read phases.
  // Keep the canary bounded while allowing both planned turns to finish.
  maxGenerations: 12,
  maxSearchRequests: 8,
});
const cases = [];
let gateway;
let app;
let core;
let harnessError = null;
let implementation = { commit: "working-tree" };

const finalCliText = (run) => run.rows
  .filter((row) => row.type === "item.completed" && row.item?.type === "agent_message")
  .map((row) => row.item.text ?? "")
  .join("\n");

function feeiMutation(config) {
  const existing = config.providers?.feei ?? {};
  const credentialRef = process.env.FEEI_API_KEY
    ? { apiKeyEnv: "FEEI_API_KEY" }
    : existing.keychain
      ? { keychain: existing.keychain }
      : { apiKeyEnv: "FEEI_API_KEY" };
  config.providers.feei = {
    adapter: "openai-compatible",
    baseUrl: "https://ai.feei.cn/v1",
    ...credentialRef,
    concurrency: 2,
  };
  config.targets["feei-sol"] = {
    provider: "feei",
    preset: "feei/gpt-5.6-sol",
    app: { capabilityProfile: "lite-search", useResponsesLite: true },
    standaloneSearch: { source: "subscription" },
  };
  config.targets["feei-astra"] = {
    provider: "feei",
    preset: "feei/gpt-6-astra",
    app: { capabilityProfile: "lite-search", useResponsesLite: true },
    standaloneSearch: { source: "subscription" },
  };
}

function appExtra() {
  return [
    "[features]",
    "responses_websockets = false",
    "responses_websockets_v2 = false",
    "",
  ].join("\n");
}

function evaluateCase({
  name,
  marker,
  text,
  clientCompleted,
  searchItemCompleted,
  outboundStart,
  payloadStart,
  clientItems,
  logStart,
  searchEvidenceStart,
  startedAt,
}) {
  const outbound = gateway.outbound.slice(outboundStart);
  const logs = gateway.logs.slice(logStart);
  const searchEvidence = gateway.searchEvidence.slice(searchEvidenceStart);
  const payloads = gateway.payloads.slice(payloadStart);
  const searchRequests = outbound.filter((event) => event.path.endsWith("/alpha/search"));
  const generationRequests = outbound.filter((event) =>
    event.path.endsWith("/responses") && event.generate !== false);
  const repeats = classifyTurnRepeats(logs);
  const matched = generationRequests
    .map((event) => event.searchResultFingerprint)
    .filter(Boolean);
  const assertions = {
    clientCompleted,
    searchItemCompleted,
    officialSearchCompleted: searchRequests.length > 0 && searchRequests.every((event) =>
      event.official && event.status >= 200 && event.status < 300),
    thirdPartyGenerationCompleted: generationRequests.length > 0 && generationRequests.every((event) =>
      event.host === "ai.feei.cn" && event.status >= 200 && event.status < 300),
    searchResultObserved: searchEvidence.some((event) =>
      event.host === "chatgpt.com" && event.complete && event.resultFingerprints.length > 0),
    searchResultReachedThirdParty: matched.length > 0,
    sourceMentioned: /(?:learn\.chatgpt\.com|developers\.openai\.com|openai\.com)/i.test(text),
    markerPresent: text.includes(marker),
    subscriptionCredentialOnlyOpenAI: outbound.every((event) =>
      (!event.subscriptionBearer && !event.accountHeader) || event.official),
    providerCredentialOnlyThirdParty: outbound.every((event) =>
      !event.providerCredential || !event.official),
    expectedCredentialsPresent: searchRequests.every((event) => event.subscriptionBearer) &&
      generationRequests.every((event) => event.providerCredential),
    noAutomaticRetry: repeats.reconnects.length === 0 && budget.implicitRetries === 0,
  };
  cases.push({
    name,
    passed: Object.values(assertions).every(Boolean),
    durationMs: Date.now() - startedAt,
    assertions,
    counts: {
      searches: searchRequests.length,
      generations: generationRequests.length,
      searchEvidence: searchEvidence.length,
      fingerprintMatches: matched.length,
      continuations: repeats.continuations.length,
      reconnects: repeats.reconnects.length,
    },
    destinations: {
      search: [...new Set(searchRequests.map((event) => event.host))],
      generation: [...new Set(generationRequests.map((event) => event.host))],
    },
    fingerprints: {
      searchResponses: searchEvidence.flatMap((event) => event.resultFingerprints),
      matched: [...new Set(matched)],
    },
    outboundDiagnostics: outbound.map((event) => ({
      host: event.host,
      path: event.path,
      status: event.status ?? null,
      error: event.error ?? null,
      subscriptionBearer: event.subscriptionBearer,
      providerCredential: event.providerCredential,
    })),
    generationToolSurface: payloads
      .filter((payload) =>
        payload.host === "ai.feei.cn" && payload.path.endsWith("/responses"))
      .map((payload) => ({
        host: payload.host,
        model: payload.model,
        toolCount: payload.tools.length,
        hasToolSearch: payload.tools.includes("tool_search"),
        hasWebSearch: payload.tools.includes("web_search"),
        additionalToolSurface: payload.additionalToolSurface,
        inputTypes: payload.items,
      })),
    clientItems,
  });
}

async function runCliCase() {
  budget.beginTurn();
  const marker = "FEEI_SOL_SUBSCRIPTION_SEARCH_OK";
  const outboundStart = gateway.outbound.length;
  const payloadStart = gateway.payloads.length;
  const logStart = gateway.logs.length;
  const searchEvidenceStart = gateway.searchEvidence.length;
  const controller = new AbortController();
  budget.activeAbort = () => controller.abort();
  const startedAt = Date.now();
  try {
    const run = await runCliExec({
      corePath: core.path,
      home: codexHome,
      cwd: work,
      args: [
        "--ephemeral", "--skip-git-repo-check", "-C", work, "-s", "read-only",
        "-c", 'approval_policy="never"', "-m", "feei-gpt-5.6-sol",
      ],
      timeoutMs: 360000,
      signal: controller.signal,
      prompt: [
        "Use standalone web search to find the public OpenAI Codex documentation about web search.",
        "Answer briefly. The final answer must contain the literal source URL https://learn.chatgpt.com/docs/web-search and finish with the exact marker",
        `${marker}.`,
        "Do not use shell, files, MCP, plugins, or write actions.",
      ].join(" "),
    });
    const text = finalCliText(run);
    const searchItems = run.rows.filter((row) =>
      row.type === "item.completed" && ["web_search", "webSearch"].includes(row.item?.type));
    const clientItems = run.rows
      .filter((row) => row.type?.startsWith("item.") && row.item?.type !== "agent_message")
      .map((row) => ({
        event: row.type,
        type: row.item?.type ?? null,
        status: row.item?.status ?? null,
      }));
    evaluateCase({
      name: "feei-sol-cli-cached-default",
      marker,
      text,
      clientCompleted: run.code === 0,
      searchItemCompleted: searchItems.some((row) => row.item?.status !== "failed"),
      outboundStart,
      payloadStart,
      clientItems,
      logStart,
      searchEvidenceStart,
      startedAt,
    });
  } finally {
    budget.activeAbort = null;
  }
}

function requirePassedCase() {
  if (cases.at(-1)?.passed) return;
  throw Object.assign(Error("third-party search acceptance case failed"), {
    code: budget.implicitRetries > 0
      ? "implicit_model_retry_detected"
      : "acceptance_case_failed",
  });
}

async function runAppCase() {
  await isolatedCodexHome({
    home: codexHome,
    baseUrl: `${gateway.url}/subscription/v1`,
    catalogPath: join(codexHome, "models.json"),
    authSource,
    model: "feei-gpt-6-astra",
    reasoningEffort: "low",
    webSearch: "live",
    extra: appExtra(),
  });
  app = startAppServer({ corePath: core.path, home: codexHome, cwd: work });
  await app.initialize("codex_local_router_third_party_search_acceptance");
  const thread = await app.rpc("thread/start", {
    model: "feei-gpt-6-astra",
    modelProvider: "openai",
    cwd: work,
    ephemeral: true,
    sandbox: "read-only",
    approvalPolicy: "never",
  });
  budget.beginTurn();
  const marker = "FEEI_ASTRA_SUBSCRIPTION_SEARCH_OK";
  const outboundStart = gateway.outbound.length;
  const payloadStart = gateway.payloads.length;
  const logStart = gateway.logs.length;
  const searchEvidenceStart = gateway.searchEvidence.length;
  const startedAt = Date.now();
  budget.activeAbort = () => app.close();
  try {
    const turn = await app.request(
      thread.thread.id,
      "feei-gpt-6-astra",
      [
        "Use standalone web search to find the public OpenAI Codex documentation about web search.",
        "Answer briefly. The final answer must contain the literal source URL https://learn.chatgpt.com/docs/web-search and finish with the exact marker",
        `${marker}.`,
        "Do not use shell, files, MCP, plugins, or write actions.",
      ].join(" "),
      { timeoutMs: 360000 },
    );
    const searchItems = turn.items.filter((item) => item.type === "webSearch");
    const clientItems = turn.items.map((item) => ({
      event: "item.completed",
      type: item.type,
      status: item.status ?? null,
    }));
    evaluateCase({
      name: "feei-astra-app-live",
      marker,
      text: turn.text,
      clientCompleted: turn.status === "completed",
      searchItemCompleted: searchItems.some((item) => item.status !== "failed"),
      outboundStart,
      payloadStart,
      clientItems,
      logStart,
      searchEvidenceStart,
      startedAt,
    });
  } finally {
    budget.activeAbort = null;
  }
}

try {
  implementation = await verifyAcceptanceRevision(
    projectRoot,
    process.env.ACCEPTANCE_COMMIT,
  );
  await mkdir(work, { recursive: true, mode: 0o700 });
  const baseConfig = JSON.parse(
    await readFile(join(projectRoot, "config", "gateway.example.json"), "utf8"),
  );
  baseConfig.subscription.enabled = true;
  baseConfig.subscription.catalogPath = sourceCatalog;
  const configPath = join(root, "gateway.json");
  await writeFile(configPath, JSON.stringify(baseConfig), { mode: 0o600 });

  core = await resolveCore();
  gateway = await startIsolatedGateway({
    configPath,
    authSource,
    tokenFile: join(root, "access-token"),
    archivePath: join(root, "history.sqlite"),
    archiveKey: createHash("sha256").update("third-party-search-acceptance").digest(),
    seed: 4,
    mutate: feeiMutation,
    beforeOutbound: (event) => budget.beforeOutbound(event),
  });
  const catalogPath = join(codexHome, "models.json");
  await isolatedCodexHome({
    home: codexHome,
    baseUrl: `${gateway.url}/subscription/v1`,
    catalogPath,
    authSource,
    model: "feei-gpt-5.6-sol",
    reasoningEffort: "low",
    webSearch: null,
    extra: appExtra(),
  });
  await writeCatalog({
    sourceCatalogPath: sourceCatalog,
    config: gateway.config,
    targetPath: catalogPath,
  });
  await runCliCase();
  requirePassedCase();
  await runAppCase();
} catch (error) {
  harnessError = {
    type: error?.type ?? error?.code ?? error?.name ?? "acceptance_error",
    message: error?.type ?? error?.code ?? "third-party search acceptance failed",
  };
} finally {
  await app?.close().catch(() => {});
  await gateway?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}

const summary = {
  verdict: !harnessError && cases.length === 2 && cases.every((entry) => entry.passed)
    ? "PASS"
    : "FAIL",
  implementation,
  driver: core ? {
    source: core.source,
    version: core.version,
    sha256: core.sha256,
  } : null,
  budget: budget.snapshot(),
  cases,
  harnessError,
  appUi: "not-tested",
};
if (output) {
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, JSON.stringify(summary, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
}
console.log(JSON.stringify(summary, null, 2));
if (summary.verdict !== "PASS") process.exitCode = 1;

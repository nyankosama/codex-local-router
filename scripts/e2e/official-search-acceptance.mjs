#!/usr/bin/env node
// Two-turn, official-only search acceptance. Records metadata and assertions only.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  isolatedCodexHome,
  resolveCore,
  runCliExec,
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
  console.error("Official search acceptance makes two real subscription turns. Re-run with --run after reviewing docs/public/acceptance.md.");
  process.exit(2);
}

const projectRoot = resolve(import.meta.dirname, "..", "..");
const authSource = value("auth") ?? join(homedir(), ".codex", "auth.json");
const sourceCatalog = value("catalog") ?? join(homedir(), ".codex", "models_cache.json");
const output = value("out") ? resolve(value("out")) : null;
const root = await mkdtemp(join(tmpdir(), "codex-router-official-search-"));
const codexHome = join(root, "codex-home");
const work = join(root, "workspace");
const budget = new FocusedAcceptanceBudget({ maxTurns: 2, maxGenerations: 8, maxSearchRequests: 6 });
const cases = [];
let gateway;
const finalText = (run) => run.rows
  .filter((row) => row.type === "item.completed" && row.item?.type === "agent_message")
  .map((row) => row.item.text ?? "")
  .join("\n");

async function runCase({ name, marker, live }) {
  budget.beginTurn();
  const beforeOutbound = gateway.outbound.length;
  const controller = new AbortController();
  budget.activeAbort = () => controller.abort();
  const startedAt = Date.now();
  try {
    const run = await runCliExec({
      corePath: core.path,
      home: codexHome,
      cwd: work,
      globalArgs: live ? ["--search"] : [],
      args: [
        "--ephemeral", "--skip-git-repo-check", "-C", work, "-s", "read-only",
        "-c", 'approval_policy="never"', "-m", "gpt-5.6-sol",
      ],
      timeoutMs: 240000,
      signal: controller.signal,
      prompt: [
        "Use the first-party web search tool on the public OpenAI Codex web-search documentation.",
        "Mention the source hostname and finish with the exact marker",
        `${marker}.`,
        "Do not use shell, files, MCP, plugins, or any other tool.",
      ].join(" "),
    });
    const text = finalText(run);
    const searchItems = run.rows.filter((row) =>
      row.type === "item.completed" && ["web_search", "webSearch"].includes(row.item?.type),
    );
    const clientItems = run.rows
      .filter((row) => row.type?.startsWith("item.") && row.item?.type !== "agent_message")
      .map((row) => ({
        event: row.type,
        type: row.item?.type ?? null,
        status: row.item?.status ?? null,
      }));
    const outbound = gateway.outbound.slice(beforeOutbound);
    const searchRequests = outbound.filter((event) => event.path.endsWith("/alpha/search"));
    const responseRequests = outbound.filter((event) => event.path.endsWith("/responses"));
    const assertions = {
      cliCompleted: run.code === 0,
      searchItemCompleted: searchItems.some((row) => row.item?.status !== "failed"),
      officialSearchCompleted: searchRequests.some((event) =>
        event.official && event.status >= 200 && event.status < 300),
      officialResponseCompleted: responseRequests.some((event) =>
        event.official && (
          (event.transport === "websocket" && event.status === 101) ||
          (event.transport === "http" && event.status >= 200 && event.status < 300)
        )),
      officialWebSocketCompleted: responseRequests.some((event) =>
        event.official && event.transport === "websocket" && event.status === 101),
      markerPresent: text.includes(marker),
      sourceHostMentioned: /(?:learn\.chatgpt\.com|developers\.openai\.com|openai\.com)/i.test(text),
      officialDestinationOnly: outbound.length > 0 && outbound.every((event) => event.official),
      subscriptionCredentialIsolated: outbound.every((event) =>
        event.official || (!event.subscriptionBearer && !event.accountHeader)),
    };
    cases.push({
      name,
      mode: live ? "live" : "cached-default",
      passed: Object.values(assertions).every(Boolean),
      durationMs: Date.now() - startedAt,
      assertions,
      cliExit: run.code,
      searchItems: searchItems.length,
      outbound: outbound.map((event) => ({
        host: event.host,
        path: event.path,
        status: event.status ?? null,
        transport: event.transport,
        official: event.official,
        subscriptionBearer: event.subscriptionBearer,
        accountHeader: event.accountHeader,
        bodyShape: event.bodyShape,
        error: event.error ?? null,
      })),
      clientItems,
    });
  } finally {
    budget.activeAbort = null;
  }
}

let core;
let harnessError = null;
let implementation = { commit: "working-tree" };
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
    archiveKey: createHash("sha256").update("official-search-acceptance").digest(),
    seed: 3,
    beforeOutbound: (event) => budget.beforeOutbound(event),
  });
  const catalogPath = join(codexHome, "models.json");
  await isolatedCodexHome({
    home: codexHome,
    baseUrl: `${gateway.url}/subscription/v1`,
    catalogPath,
    authSource,
    model: "gpt-5.6-sol",
    reasoningEffort: "low",
    webSearch: null,
  });
  await writeCatalog({
    sourceCatalogPath: sourceCatalog,
    config: gateway.config,
    targetPath: catalogPath,
  });

  await runCase({
    name: "official-cached-natural",
    marker: "OFFICIAL_CACHED_SEARCH_OK",
    live: false,
  });
  if (cases[0]?.passed) {
    await runCase({
      name: "official-live-explicit",
      marker: "OFFICIAL_LIVE_SEARCH_OK",
      live: true,
    });
  }
} catch (error) {
  harnessError = {
    type: error?.type ?? error?.code ?? "acceptance_error",
    message: error?.type ?? error?.code ?? "official search acceptance failed",
  };
} finally {
  await gateway?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}

const websocketProbe = {
  passed: cases.length === 2 && cases.every((entry) => entry.assertions.officialWebSocketCompleted),
  source: "official-search-cases",
};

const summary = {
  verdict: !harnessError && websocketProbe?.passed &&
    cases.length === 2 && cases.every((entry) => entry.passed)
    ? "PASS"
    : "FAIL",
  implementation,
  driver: core ? {
    source: core.source,
    version: core.version,
    sha256: core.sha256,
  } : null,
  websocketProbe,
  budget: budget.snapshot(),
  cases,
  harnessError,
  appUi: "not-tested",
};
if (output) {
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, JSON.stringify(summary, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
console.log(JSON.stringify(summary, null, 2));
if (summary.verdict !== "PASS") process.exitCode = 1;

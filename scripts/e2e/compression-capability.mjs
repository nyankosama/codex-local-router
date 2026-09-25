#!/usr/bin/env node
// Bounded live probe for same-target native compaction. It records only
// structural metadata and never changes the active configuration.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { credential, providerEndpoint } from "../../src/providers.mjs";
import {
  resolveCore,
  startIsolatedGateway,
  verifyAcceptanceRevision,
} from "./lib/harness.mjs";
import { FocusedAcceptanceBudget } from "./lib/focused-budget.mjs";
import { identity } from "../../src/state.mjs";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? undefined : argv[index + 1];
};
if (!flag("run")) {
  console.error("Compression capability probing makes bounded real Provider requests. Re-run with --run after reviewing docs/public/acceptance.md.");
  process.exit(2);
}
if (!process.env.ACCEPTANCE_COMMIT) throw Error("ACCEPTANCE_COMMIT is required");

const projectRoot = resolve(import.meta.dirname, "..", "..");
const sourceConfig = value("config") ??
  join(homedir(), "Library", "Application Support", "Codex Local Router", "config.json");
const sourceCatalog = value("catalog") ?? join(homedir(), ".codex", "models_cache.json");
const authSource = value("auth") ?? join(homedir(), ".codex", "auth.json");
const output = value("out") ? resolve(value("out")) : null;
const targetIds = (value("targets") ?? "deepseek,glm-main").split(",").filter(Boolean);
const maxGenerations = Number(value("max-generations") ?? 12);
if (!targetIds.length || new Set(targetIds).size !== targetIds.length)
  throw Error("--targets must contain unique target ids");
if (!Number.isSafeInteger(maxGenerations) || maxGenerations < 1)
  throw Error("--max-generations must be a positive safe integer");

const root = await mkdtemp(join(tmpdir(), "codex-router-compression-capability-"));
const configPath = join(root, "gateway.json");
const budget = new FocusedAcceptanceBudget({ maxTurns: 10, maxGenerations });
const cases = [];
const gateways = [];
let source;
let core;
let implementation = { commit: "working-tree" };
let harnessError = null;

function mutateFor(targetId, capability) {
  return (config) => {
    const sourceTarget = source.targets[targetId];
    const providerId = sourceTarget.provider;
    const target = structuredClone(sourceTarget);
    target.wireApi = "responses";
    if (capability === "supported")
      target.compression = {
        mode: "native",
        compatibility: { accountScope: "same", targets: [targetId] },
        nativeMigrationSummary: target.compression?.nativeMigrationSummary === true,
      };
    config.providers = { [providerId]: structuredClone(source.providers[providerId]) };
    config.targets = { [targetId]: target };
    config.defaultTarget = targetId;
    config.rules = [];
    config.subscription.enabled = true;
    config.subscription.catalogPath = sourceCatalog;
    config.subscription.customModels = { [target.app.modelId]: targetId };
  };
}

async function startGateway(targetId, capability, archivePath, seed) {
  const instance = await startIsolatedGateway({
    configPath,
    authSource,
    tokenFile: join(root, `${targetId}-${seed}.token`),
    archivePath,
    archiveKey: createHash("sha256").update(`capability-${targetId}`).digest(),
    seed,
    mutate: mutateFor(targetId, capability),
    toolCodexHome: join(root, "tool-registry"),
    beforeOutbound: (event) => budget.beforeOutbound(event),
  });
  gateways.push(instance);
  return instance;
}

const userMessage = (text) => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});
const responseText = (body) => (body?.output ?? [])
  .flatMap((item) =>
    Array.isArray(item?.content)
      ? item.content
      : typeof item?.content === "string"
        ? [item.content]
        : [])
  .map((item) => typeof item === "string" ? item : item?.text ?? "")
  .join("");

async function probeProviderCompact(targetId) {
  budget.beginTurn();
  const target = source.targets[targetId];
  const provider = source.providers[target.provider];
  const responsesUrl = providerEndpoint(provider, "responses");
  const url = `${responsesUrl.replace(/\/$/, "")}/compact`;
  const body = {
    model: target.model,
    input: [userMessage(`Remember ${targetId.toUpperCase()}_COMPACT_PROBE.`)],
  };
  const requestFingerprint = createHash("sha256")
    .update("POST")
    .update(new URL(url).pathname)
    .update(JSON.stringify(body))
    .digest("hex");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  budget.activeAbort = () => controller.abort();
  try {
    budget.beforeOutbound({
      path: new URL(url).pathname,
      official: false,
      requestFingerprint,
    });
    const key = await credential(provider);
    const subscriptionToken =
      JSON.parse(await readFile(authSource, "utf8")).tokens.access_token;
    const headers = {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json",
    };
    if (provider.adapter === "opencode-go")
      headers["x-opencode-session"] = randomUUID();
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") ?? "";
    let result = null;
    if (contentType.includes("application/json"))
      result = await response.json();
    else
      await response.arrayBuffer();
    const outputTypes = Array.isArray(result?.output)
      ? result.output.map((item) => item?.type ?? null)
      : [];
    const capability = response.ok && outputTypes.includes("compaction")
      ? "supported"
      : [400, 404, 405, 422, 501].includes(response.status)
        ? "provider-unsupported"
        : "inconclusive";
    return {
      result: capability,
      reached: true,
      httpStatus: response.status,
      contentType: contentType.split(";")[0] || null,
      object: result?.object ?? null,
      outputTypes,
      errorType: result?.error?.type ?? null,
      errorCode: result?.error?.code ?? null,
      credentialsIsolated: Boolean(key) && key !== subscriptionToken,
      transportError: null,
    };
  } catch (error) {
    return {
      result: "inconclusive",
      reached: false,
      httpStatus: null,
      contentType: null,
      object: null,
      outputTypes: [],
      errorType: null,
      errorCode: null,
      credentialsIsolated: false,
      transportError: error?.name ?? error?.code ?? "provider_compact_error",
    };
  } finally {
    clearTimeout(timer);
    budget.activeAbort = null;
  }
}

async function request(gateway, model, threadId, turnId, body) {
  budget.beginTurn();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 360000);
  budget.activeAbort = () => controller.abort();
  try {
    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${gateway.accessToken}`,
        "content-type": "application/json",
        "thread-id": threadId,
        "turn-id": turnId,
      },
      body: JSON.stringify({
        model,
        stream: false,
        ...body,
        client_metadata: {
          thread_id: threadId,
          turn_id: turnId,
          request_kind: body.input?.some((item) =>
            item?.type === "compaction_trigger")
            ? "compaction"
            : "turn",
        },
      }),
      signal: controller.signal,
    });
    const result = await response.json();
    return {
      status: response.ok && result?.status === "completed"
        ? "completed"
        : "failed",
      httpStatus: response.status,
      body: result,
      text: responseText(result),
      compactions: (result?.output ?? []).filter((item) =>
        item?.type === "compaction"),
    };
  } finally {
    clearTimeout(timer);
    budget.activeAbort = null;
  }
}

function classifyFailure({
  providerProbe,
  normalTurn,
  compactionPayloads,
  compacted,
  errors,
  recoveryConfirmed,
  implicitRetries,
}) {
  if (normalTurn?.status !== "completed") return "inconclusive";
  if (providerProbe.result !== "provider-unsupported")
    return "inconclusive";
  const localRejection =
    compacted?.httpStatus === 400 &&
    compacted?.body?.error?.type === "compaction_unsupported" &&
    compactionPayloads.length === 0;
  if (!localRejection) return "gateway-defect";
  const no502 =
    providerProbe.httpStatus !== 502 &&
    errors.every((entry) => entry.status !== 502);
  return recoveryConfirmed && no502 && implicitRetries === 0
    ? "provider-unsupported"
    : "inconclusive";
}

async function runTarget(targetId, seed) {
  const firstInstance = gateways.length;
  const implicitRetriesBefore = budget.implicitRetries;
  const archivePath = join(root, `${targetId}.sqlite`);
  const fact = `${targetId.toUpperCase().replaceAll("-", "_")}_CAPABILITY_FACT`;
  const providerProbe = await probeProviderCompact(targetId);
  let gateway = await startGateway(
    targetId,
    providerProbe.result,
    archivePath,
    seed,
  );
  const target = gateway.config.targets[targetId];
  const model = target.model;
  const providerHost = new URL(gateway.config.providers[target.provider].baseUrl).host;
  const threadId = `capability-${targetId}`;
  let normalTurn;
  let compacted = null;
  let verifyTurn = null;
  let continuationTurn = null;
  let restartTurn = null;
  let restartHistoryFactPreserved = false;
  let responseLineageContinued = false;
  let probeError = null;
  let stage = "initialize";
  try {
    stage = "normal-turn";
    normalTurn = await request(gateway, model, threadId, "seed", {
      input: [userMessage(
        `Remember the exact synthetic fact ${fact}. Reply only ACK.`,
      )],
    });
    stage = "compaction";
    compacted = await request(gateway, model, threadId, "compact", {
      previous_response_id: normalTurn.body?.id,
      input: [
        { type: "compaction_trigger" },
      ],
    });
    if (compacted.status === "completed" && compacted.compactions.length === 1) {
      stage = "post-compaction-continuation";
      verifyTurn = await request(gateway, model, threadId, "verify", {
        input: [
          ...compacted.compactions,
          userMessage(
            "State the exact synthetic fact from the compacted history and end with VERIFY_OK.",
          ),
        ],
      });
    } else {
      stage = "post-rejection-continuation";
      continuationTurn = await request(gateway, model, threadId, "continue", {
        previous_response_id: normalTurn.body?.id,
        input: [userMessage(
          "State the exact synthetic fact from the previous response and end with CONTINUE_OK.",
        )],
      });
    }
    stage = "restart";
    await gateway.close();
    gateway = await startGateway(
      targetId,
      providerProbe.result,
      archivePath,
      seed,
    );
    stage = "post-restart-continuation";
    const previous = (verifyTurn ?? continuationTurn)?.body?.id;
    if (!previous)
      throw Object.assign(Error("continuation response id missing"), {
        code: "continuation_response_id_missing",
      });
    restartTurn = await request(gateway, model, threadId, "restart", {
      previous_response_id: previous,
      input: [userMessage(
        "State the exact synthetic fact from the previous response and end with RESTART_OK.",
      )],
    });
    const context = identity(
      "api",
      { authorization: `Bearer ${gateway.accessToken}` },
      {
        client_metadata: {
          thread_id: threadId,
          turn_id: "restart",
        },
      },
    );
    const history = gateway.archive.history({
      owner: context.account,
      thread: context.thread,
      branch: context.branch,
    });
    restartHistoryFactPreserved =
      history?.responseId === restartTurn.body?.id &&
      JSON.stringify(history.original).includes(fact);
    responseLineageContinued =
      history?.version >= 3 &&
      history.parentVersion === history.version - 1;
  } catch (error) {
    probeError = {
      type: error?.type ?? error?.code ?? error?.name ?? "capability_probe_error",
      message: String(error?.message ?? error?.type ?? error?.code ??
        "capability probe failed").slice(0, 200),
      transportCode: error?.cause?.code ?? null,
    };
  } finally {
    await gateway?.close().catch(() => {});
  }

  const instances = gateways.slice(firstInstance);
  const logs = instances.flatMap((entry) => entry.logs);
  const payloads = instances.flatMap((entry) => entry.payloads)
    .filter((entry) => entry.host === providerHost && entry.path.endsWith("/responses"));
  const outbound = instances.flatMap((entry) => entry.outbound)
    .filter((entry) => entry.host === providerHost && entry.path.endsWith("/responses"));
  const compactionPayloads = payloads.filter((entry) =>
    entry.items.includes("compaction_trigger"));
  const errors = logs.filter((entry) =>
    ["request_error", "ws_error", "provider_error", "upstream_transport_error"].includes(entry.event));
  const nativeCompletions = logs.filter((entry) =>
    entry.event === "compaction_completed" && entry.mode === "native");
  const implicitRetries = budget.implicitRetries - implicitRetriesBefore;
  const recoveryTurn = verifyTurn ?? continuationTurn;
  const continuationCompleted =
    recoveryTurn?.status === "completed" &&
    restartTurn?.status === "completed";
  const recoveryConfirmed =
    continuationCompleted &&
    restartHistoryFactPreserved &&
    responseLineageContinued;
  const supported = compacted?.status === "completed" &&
    providerProbe.result === "supported" &&
    compacted.compactions.length === 1 &&
    verifyTurn?.status === "completed" &&
    verifyTurn.text.includes(fact) &&
    restartTurn?.status === "completed" &&
    restartTurn.text.includes(fact) &&
    compactionPayloads.length === 1 &&
    nativeCompletions.length === 1 &&
    nativeCompletions[0].summary_calls === 0 &&
    logs.every((entry) => entry.event !== "summary_started") &&
    implicitRetries === 0 &&
    outbound.every((entry) =>
      entry.providerCredential && !entry.subscriptionBearer && !entry.accountHeader);
  const result = supported
    ? "supported"
    : classifyFailure({
        providerProbe,
        normalTurn,
        compactionPayloads,
        compacted,
        errors,
        recoveryConfirmed,
        implicitRetries,
      });
  const semanticFactEcho =
    recoveryTurn?.text.includes(fact) === true &&
    restartTurn?.text.includes(fact) === true;
  const localUnsupportedRejection =
    compacted?.httpStatus === 400 &&
    compacted?.body?.error?.type === "compaction_unsupported" &&
    compactionPayloads.length === 0;
  const credentialsIsolated = providerProbe.credentialsIsolated &&
    outbound.every((entry) =>
      entry.providerCredential && !entry.subscriptionBearer && !entry.accountHeader);
  const no502 = providerProbe.httpStatus !== 502 &&
    errors.every((entry) => entry.status !== 502);
  cases.push({
    name: targetId,
    target: targetId,
    result,
    passed: ["supported", "provider-unsupported"].includes(result),
    assertions: {
      normalGenerationCompleted: normalTurn?.status === "completed",
      compactEndpointReachedProvider: providerProbe.reached,
      nativeTriggerReachedProvider:
        providerProbe.result !== "supported" || compactionPayloads.length === 1,
      unsupportedRejectedLocally:
        providerProbe.result !== "provider-unsupported" || localUnsupportedRejection,
      noImplicitRetry: compactionPayloads.length <= 1 && implicitRetries === 0,
      no502,
      noGatewaySummary: logs.every((entry) => entry.event !== "summary_started"),
      continuationCompleted,
      factPreserved: restartHistoryFactPreserved,
      responseLineageContinued,
      credentialsIsolated,
    },
    counts: {
      providerGenerations: outbound.length + (providerProbe.reached ? 1 : 0),
      compactEndpointRequests: providerProbe.reached ? 1 : 0,
      compactionPayloads: compactionPayloads.length,
      nativeCompletions: nativeCompletions.length,
      gatewaySummaries: logs.filter((entry) => entry.event === "summary_started").length,
      gatewayInstances: instances.length,
      implicitRetries,
    },
    providerProbe,
    diagnostics: errors.slice(-8).map((entry) => ({
      event: entry.event,
      type: entry.type ?? null,
      status: entry.status ?? null,
      transportCode: entry.transport_code ?? null,
      category: entry.category ?? entry.transport_category ?? null,
    })),
    semanticFactEcho,
    probeError: probeError ? { ...probeError, stage } : null,
  });
}

try {
  implementation = await verifyAcceptanceRevision(projectRoot, process.env.ACCEPTANCE_COMMIT);
  source = JSON.parse(await readFile(sourceConfig, "utf8"));
  for (const targetId of targetIds) {
    const target = source.targets?.[targetId];
    if (!target?.app?.modelId || target.wireApi !== "responses" ||
        !source.providers?.[target.provider])
      throw Object.assign(Error(`target is not a configured App Responses target: ${targetId}`), {
        code: "source_configuration_incomplete",
      });
  }
  const base = JSON.parse(await readFile(
    join(projectRoot, "config", "gateway.example.json"),
    "utf8",
  ));
  base.subscription.enabled = true;
  base.subscription.catalogPath = sourceCatalog;
  await mkdir(join(root, "tool-registry"), { recursive: true, mode: 0o700 });
  await writeFile(configPath, `${JSON.stringify(base)}\n`, { mode: 0o600 });
  core = await resolveCore();
  for (const [index, targetId] of targetIds.entries())
    await runTarget(targetId, index + 1);
} catch (error) {
  harnessError = {
    type: error?.type ?? error?.code ?? error?.name ?? "capability_probe_error",
    message: String(error?.type ?? error?.code ?? "compression capability probe failed"),
  };
} finally {
  await Promise.allSettled(gateways.map((entry) => entry.close()));
  await rm(root, { recursive: true, force: true });
}

const conclusive = cases.length === targetIds.length &&
  cases.every((entry) => ["supported", "provider-unsupported"].includes(entry.result));
const summary = {
  verdict: !harnessError && conclusive ? "PASS" : "INCONCLUSIVE",
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

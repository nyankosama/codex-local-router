#!/usr/bin/env node
// Bounded real-channel gate. Retains only hashes, counts and route metadata.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { captureInstructions } from "../../src/instruction-source.mjs";
import {
  DeterministicOfficialWebSocket,
  deterministicOfficialRequest,
  deterministicProviderRequest,
} from "./lib/deterministic-upstream.mjs";
import {
  isolatedCodexHome,
  resolveCore,
  startAppServer,
  startIsolatedGateway,
  writeCatalog,
} from "./lib/harness.mjs";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? fallback : argv[index + 1];
};
const deterministic = flag("deterministic");
const phase = value("phase", "all");
if (!["all", "comparison", "tools"].includes(phase))
  throw Error("--phase must be all, comparison or tools");
if (!flag("run") && !deterministic) {
  console.error("This gate makes at most 12 real model generations; add --run after reviewing the budget.");
  process.exit(2);
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const root = await mkdtemp(join(tmpdir(), "clr-instruction-live-"));
const codexHome = join(root, "codex-home");
const work = join(root, "workspace");
const configPath = value("config", join(homedir(), "Library", "Application Support", "Codex Local Router", "config.json"));
const authSource = value("auth", join(homedir(), ".codex", "auth.json"));
const sourceCatalogPath = value("catalog", join(homedir(), ".codex", "models_cache.json"));
const sourceCatalog = JSON.parse(await readFile(sourceCatalogPath, "utf8"));
const core = await resolveCore();
const specs = [
  { name: "sol", target: "feei-sol", official: "gpt-5.6-sol" },
  { name: "astra", target: "feei-astra", official: "gpt-6-astra" },
];
const instructionText = Object.fromEntries(specs.map((spec) => {
  const model = sourceCatalog.models?.find((entry) => entry.slug === spec.official);
  const variables = model?.model_messages?.instructions_variables;
  if (!model || (variables != null && Object.keys(variables).length))
    throw Error(`official instruction source is unavailable or variable-dependent: ${spec.official}`);
  const text = model.model_messages?.instructions_template || model.base_instructions;
  if (typeof text !== "string" || !text.trim())
    throw Error(`official instruction source is empty: ${spec.official}`);
  return [spec.name, text];
}));
const projectMarker = `INSTRUCTION_PROJECT_${sha256(randomUUID()).slice(0, 12)}`;
const toolMarker = `FILE_${sha256(randomUUID()).slice(0, 8)}`;
const toolPath = join(work, "marker-1.txt");
const markerLabel = (name) => `instruction-${name}`;
const generationBudget = phase === "all" ? 12 : 6;
let generations = 0, blockedGenerationAttempts = 0, gateway, app;
const comparison = [], tools = [];
let stoppedAt = null;

function appTarget(base, modelId) {
  const target = structuredClone(base);
  target.app = {
    ...(target.app ?? {}),
    enabled: true,
    modelId,
    capabilityProfile: "lite-search",
    useResponsesLite: true,
  };
  target.standaloneSearch = { source: "subscription" };
  delete target.app.baseInstructions;
  delete target.app.modelMessages;
  delete target.app.instructionSource;
  delete target.app.instructionDelivery;
  return target;
}

const modelIds = Object.fromEntries(specs.map((spec) => [spec.name, {
  official: spec.official,
  current: `instruction-current-${spec.name}`,
  candidate: `instruction-candidate-${spec.name}`,
}]));

const generated = (events) => events.filter((event) =>
  event.path.endsWith("/responses") && event.generate !== false);
const payloadsFor = (start) => gateway.payloads.slice(start).filter((item) =>
  item.path.endsWith("/responses") && item.generate !== false);
const credentialsSafe = (events) => events.every((event) =>
  event.official
    ? !event.providerCredential
    : !event.subscriptionBearer && !event.accountHeader);

try {
  await mkdir(work, { recursive: true, mode: 0o700 });
  await writeFile(join(work, "AGENTS.md"), `Synthetic project instruction: ${projectMarker}.\n`, { mode: 0o600 });
  await writeFile(toolPath, `${toolMarker}\n`, { mode: 0o600 });
  gateway = await startIsolatedGateway({
    configPath,
    authSource,
    tokenFile: join(root, "access-token"),
    archivePath: join(root, "history.sqlite"),
    archiveKey: createHash("sha256").update(randomUUID()).digest(),
    toolCodexHome: codexHome,
    markerObservations: [
      ...specs.map((spec) => ({ label: markerLabel(spec.name), value: instructionText[spec.name] })),
      { label: "project", value: projectMarker },
      { label: "tool", value: toolMarker },
    ],
    beforeOutbound(event) {
      if (!event.path.endsWith("/responses") || event.generate === false) return;
      if (generations >= generationBudget) {
        blockedGenerationAttempts++;
        throw Error("instruction acceptance generation budget exceeded");
      }
      generations++;
    },
    ...(deterministic ? {
      sendRequest: deterministicProviderRequest,
      officialRequest: deterministicOfficialRequest,
      providerSearchRequest: deterministicOfficialRequest,
      createOfficialWebSocket: () => new DeterministicOfficialWebSocket(),
    } : {}),
    mutate(config) {
      for (const spec of specs) {
        const base = config.targets?.[spec.target];
        if (!base) throw Error(`target is unavailable: ${spec.target}`);
        const current = appTarget(base, modelIds[spec.name].current);
        const candidate = captureInstructions(
          appTarget(base, modelIds[spec.name].candidate),
          sourceCatalog,
          { sourceModel: spec.official, clientVersion: core.version },
        );
        candidate.app.instructionDelivery = "gateway-lite";
        config.targets[`instruction-current-${spec.name}`] = current;
        config.targets[`instruction-candidate-${spec.name}`] = candidate;
      }
    },
  });
  const catalogPath = join(codexHome, "models.json");
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await writeCatalog({ sourceCatalogPath, config: gateway.config, targetPath: catalogPath });
  await isolatedCodexHome({
    home: codexHome,
    baseUrl: `${gateway.url}/subscription/v1`,
    catalogPath,
    authSource,
    model: modelIds.sol.candidate,
    reasoningEffort: "low",
    webSearch: "disabled",
    extra: 'personality = "pragmatic"\n[features]\nresponses_websockets = true\nresponses_websockets_v2 = true\n',
  });
  app = startAppServer({ corePath: core.path, home: codexHome, cwd: work });
  await app.initialize("codex_local_router_instruction_live");

  const prompt = [
    "Do not call tools. Use only these synthetic facts:",
    "Orchid status is amber; owner is River; next review is Friday.",
    "Reply in two concise sentences: state the status and next action.",
  ].join(" ");
  comparisonGate: for (const spec of phase === "tools" ? [] : specs)
    for (const mode of ["official", "current", "candidate"]) {
    const model = modelIds[spec.name][mode];
    const outboundStart = gateway.outbound.length;
    const payloadStart = gateway.payloads.length;
    const thread = await app.rpc("thread/start", {
      model, modelProvider: "openai", cwd: work, ephemeral: true,
      sandbox: "read-only", approvalPolicy: "never",
    });
    const turn = await app.request(thread.thread.id, model, prompt, { timeoutMs: 360000 });
    const outbound = generated(gateway.outbound.slice(outboundStart));
    const payloads = payloadsFor(payloadStart);
    const expectedMarker = markerLabel(spec.name);
    const markerCount = payloads.reduce(
      (total, item) => total + (item.markerCounts[expectedMarker] ?? 0),
      0,
    );
    const routed = mode === "official"
      ? outbound.every((item) => item.official && item.host === "chatgpt.com")
      : outbound.every((item) => !item.official && item.host === "ai.feei.cn");
    const passed = turn.status === "completed" && outbound.length === 1 && routed &&
      credentialsSafe(outbound) && (mode === "candidate" ? markerCount === 1 : markerCount === 0);
    comparison.push({
      model: spec.name,
      mode,
      generations: outbound.length,
      completed: turn.status === "completed",
      routed,
      instructionSnapshotCount: markerCount,
      outputHash: sha256(turn.text),
      outputBytes: Buffer.byteLength(turn.text),
      passed,
    });
    if (!passed) {
      stoppedAt = `comparison:${spec.name}:${mode}`;
      break comparisonGate;
    }
  }

  toolGate: for (const spec of stoppedAt || phase === "comparison" ? [] : specs) {
    const model = modelIds[spec.name].candidate;
    const outboundStart = gateway.outbound.length;
    const payloadStart = gateway.payloads.length;
    const logStart = gateway.logs.length;
    const thread = await app.rpc("thread/start", {
      model, modelProvider: "openai", cwd: work, ephemeral: true,
      sandbox: "read-only", approvalPolicy: "never",
    });
    const first = await app.request(
      thread.thread.id,
      model,
      `Use exec_command exactly once with cmd cat ${toolPath}. Then reply with the exact returned marker and TOOL_OK. Do not use another tool.`,
      { timeoutMs: 360000 },
    );
    const second = first.status === "completed"
      ? await app.request(
          thread.thread.id,
          model,
          "Without calling a tool, repeat the prior marker and finish with CONTINUATION_OK.",
          { timeoutMs: 360000 },
        )
      : { status: "not_run", text: "", items: [] };
    const outbound = generated(gateway.outbound.slice(outboundStart));
    const payloads = payloadsFor(payloadStart);
    const instructionEvents = gateway.logs.slice(logStart).filter((event) =>
      event.event === "instruction_snapshot_delivered");
    const completedCommands = first.items.filter((item) =>
      item.type === "commandExecution" && item.status === "completed");
    const passed = first.status === "completed" && second.status === "completed" &&
      first.text.includes(toolMarker) && second.text.includes(toolMarker) &&
      completedCommands.length === 1 && outbound.length === 3 &&
      credentialsSafe(outbound) &&
      payloads.every((item) => item.markerCounts[markerLabel(spec.name)] === 1) &&
      payloads.some((item) => item.toolResultMarkers.includes("tool")) &&
      instructionEvents.length <= outbound.length;
    tools.push({
      model: spec.name,
      generations: outbound.length,
      firstCompleted: first.status === "completed",
      continuationCompleted: second.status === "completed",
      completedCommands: completedCommands.length,
      toolResultForwarded: payloads.some((item) => item.toolResultMarkers.includes("tool")),
      snapshotExactlyOnceOnEveryGeneration: payloads.length === 3 && payloads.every((item) =>
        item.markerCounts[markerLabel(spec.name)] === 1),
      gatewayInjections: instructionEvents.length,
      passed,
    });
    if (!passed) {
      stoppedAt = `tools:${spec.name}`;
      break toolGate;
    }
  }

  const result = {
    mode: deterministic
      ? "deterministic-instruction-inheritance"
      : "live-instruction-inheritance",
    client: { version: core.version, sha256: core.sha256 },
    instructionHashes: Object.fromEntries(specs.map((spec) => [spec.name, sha256(instructionText[spec.name])])),
    phase,
    plannedMaximumGenerations: generationBudget,
    executedGenerations: generations,
    blockedGenerationAttempts,
    automaticRetries: 0,
    stoppedAt,
    comparison,
    tools,
    passed: !stoppedAt && generations === generationBudget && blockedGenerationAttempts === 0 &&
      (phase === "tools" || (comparison.length === 6 && comparison.every((item) => item.passed))) &&
      (phase === "comparison" || (tools.length === 2 && tools.every((item) => item.passed))),
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
} finally {
  await app?.close().catch(() => {});
  await gateway?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}

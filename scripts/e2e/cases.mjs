// 6 条 E2E 用例。每条返回 observation，由 run.mjs 套用 H1-H10 判据。
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { sseEvents } from "../../src/sse.mjs";
import { estimateRequestTokens } from "../../src/context.mjs";
import { PACKAGE_VERSION } from "../../src/product.mjs";
import { identityHash } from "./lib/criteria.mjs";
import {
  resolveCore,
  isolatedCodexHome,
  writeCatalog,
  startIsolatedGateway,
  startHealthSampling,
  monitorEventLoop,
  runCliExec,
  startAppServer,
  wsProbe,
  captureProxy,
  readGatewayLogWindow,
  derivePhases,
  groupStreams,
  truncatedStreams,
  classifyTurnRepeats,
  attributeReconnects,
  startExternalHealthSampling,
  toolCallOrderViolations,
  phasesFromGatewayLogs,
  toolObservations,
  toolObservationsFromPayloads,
  unknownEventTypes,
} from "./lib/harness.mjs";
import { solidPng, dataUrl } from "./lib/png.mjs";

export const GPT = "gpt-5.6-sol";
export const DS = "deepseek-v4.1-flash";
export const CHAT = "glm-5.3";

const CSV = "https://chatgpt.com/backend-api/codex/responses";
export const KNOWN_EVENT_TYPES = [
  "response.created", "response.in_progress", "response.queued",
  "response.output_item.added", "response.output_item.done",
  "response.content_part.added", "response.content_part.done",
  "response.output_text.delta", "response.output_text.done",
  "response.output_text.annotation.added",
  "response.reasoning_text.delta", "response.reasoning_text.done",
  "response.reasoning_summary_part.added", "response.reasoning_summary_part.done",
  "response.reasoning_summary_text.delta", "response.reasoning_summary_text.done",
  "response.function_call_arguments.delta", "response.function_call_arguments.done",
  "response.completed", "response.incomplete", "response.failed", "error", "ping",
];

const TERMINAL = ["response.completed", "response.incomplete", "response.failed", "error"];

async function httpProbe({ url, path, token, accountId, threadId, body, timeoutMs = 600000 }) {
  const startedAt = Date.now();
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(accountId ? { "chatgpt-account-id": accountId } : {}),
      ...(threadId ? { "thread-id": threadId } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text();
    return { events: [], status: res.status, errorBody: text.slice(0, 300), startedAt, endedAt: Date.now() };
  }
  const events = [];
  for await (const event of sseEvents(res.body)) events.push({ at: Date.now(), ...event });
  return { events, status: res.status, startedAt, endedAt: Date.now() };
}

// 隔离工作区放在系统临时目录：避免 Codex core 的插件缓存/工作树落进仓库，
// 也避免被 `node --test` 递归发现为测试文件。
function workRoot(ctx, name) {
  return join(tmpdir(), "codex-router-e2e", ctx.runId, name);
}

async function setup(ctx, name, mutate) {
  const root = workRoot(ctx, name);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const gateway = await startIsolatedGateway({
    configPath: ctx.prodConfigPath,
    authSource: ctx.authSource,
    tokenFile: join(root, "access-token"),
    archivePath: join(root, "history.sqlite"),
    archiveKey: createHash("sha256").update(`e2e-archive-${name}`).digest(),
    mutate,
  });
  return { root, ...gateway };
}

function buildObservation({ id, ctx, gateway, probe, extra = {} }) {
  const events = probe?.events ?? [];
  const streams = groupStreams(events);
  const phases = events.length
    ? derivePhases({ events, startedAt: probe?.startedAt ?? Date.now() })
    : (extra.gatewayLogs ?? []).length
      ? phasesFromGatewayLogs(extra.gatewayLogs)
      : derivePhases({ events: [], startedAt: Date.now() });
  const streamPhases = streams.map((stream) =>
    Object.fromEntries(
      Object.entries(derivePhases({ events: stream, startedAt: probe?.startedAt ?? Date.now() }).phasesByItem).map(
        ([key, value]) => [key, { added: value.added, done: value.done }],
      ),
    ),
  );
  const logs = gateway.logs ?? extra.gatewayLogs ?? [];
  const payloadsSeen = gateway.payloads ?? extra.payloads ?? [];
  const writes = gateway.historyWrites ?? extra.historyWrites ?? [];
  const repeats = classifyTurnRepeats(logs);
  const fromFrames = toolObservations(events);
  const fromPayloads = toolObservationsFromPayloads(payloadsSeen);
  const calls = fromFrames.calls.length ? fromFrames.calls : fromPayloads.calls;
  const results = fromFrames.results.length ? fromFrames.results : fromPayloads.results;
  const errors = logs
    .filter((x) => ["ws_error", "request_error", "provider_error", "upstream_transport_error"].includes(x.event))
    .map((x) => ({ event: x.event, category: x.transport_category ?? x.category ?? x.type }));
  return {
    case: id,
    runId: ctx.runId,
    startedAt: probe?.startedAt ?? Date.now(),
    entry: { kind: ctx.entryKind, binary: ctx.core.source, sha256: ctx.core.sha256, version: ctx.core.version },
    gateway: { url: gateway.url, version: PACKAGE_VERSION, instance: null },
    result: "PASS",
    terminal: events.filter((x) => TERMINAL.includes(x.type)),
    clientEvents: events,
    streams,
    truncated: truncatedStreams(streams, TERMINAL),
    repeatUpstreamCalls: repeats.reconnects.length,
    continuationRequests: repeats.continuations.length,
    reconnectDetail: repeats.reconnects,
    continuationDetail: repeats.continuations,
    phasesByItemArray: streamPhases,
    phases: {
      firstSubstantiveMs: phases.firstSubstantiveMs,
      firstTextMs: phases.firstTextMs,
      maxEventGapMs: phases.maxEventGapMs,
      progressObserved: phases.progressObserved,
      source: phases.source ?? "client_frames",
    },
    phasesByItem: Object.fromEntries(
      Object.entries(phases.phasesByItem ?? {}).map(([key, value]) => [key, { added: value.added, done: value.done }]),
    ),
    historyWrites: writes,
    historyWritesAvailable: Array.isArray(gateway.historyWrites),
    completedResponses: logs.filter((x) => x.event === "completed").length,
    extraTerminals: extra.extraTerminals ?? [],
    unknownEventTypes: unknownEventTypes(events, KNOWN_EVENT_TYPES),
    toolCalls: calls,
    toolResults: results,
    gatewayLogs: logs,
    outbound: gateway.outbound ?? extra.outbound ?? [],
    payloads: payloadsSeen,
    requestBytes: Math.max(0, ...payloadsSeen.map((x) => x.bytes ?? 0)),
    errors,
    health: extra.health ?? [],
    healthInProcess: extra.healthInProcess ?? [],
    eventLoopDelayP99Ms: extra.eventLoopDelayP99Ms ?? null,
    activeTurnsIdle: extra.activeTurnsIdle ?? true,
    historyVersionsDelta: extra.historyVersionsDelta ?? null,
    expectedOfficialHosts: ["chatgpt.com"],
    expectedFailure: extra.expectedFailure ?? false,
    toolsExecutedLocally: extra.toolsExecutedLocally ?? false,
    sequenceEvidence: extra.sequenceEvidence,
    attribution: extra.attribution,
    attributionByCriterion: extra.attributionByCriterion,
    assertions: extra.assertions ?? [],
    detail: extra.detail ?? {},
  };
}

const assertion = (assertions, name, ok, detail = "") => assertions.push({ name, ok: Boolean(ok), detail });

async function awaitIdle(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5000) });
      const body = await res.json();
      if (body.activeTurns === 0) return true;
    } catch {}
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

// E2E-1 官方订阅透传基线（A harness + WS 协议探针）
export async function e2e1(ctx) {
  const gw = await setup(ctx, "e2e1");
  const assertions = [];
  try {
    const home = join(gw.root, "home");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await symlink(ctx.authSource, join(home, "auth.json"));
    const catalogPath = join(home, "models.json");
    await writeCatalog({ sourceCatalogPath: ctx.catalogSource, config: gw.config, targetPath: catalogPath });
    const health = startHealthSampling(gw.url, ctx.thresholds.healthSampleIntervalMs);
    const loop = monitorEventLoop();
    const versions0 = gw.archive.stats().versions;

    // 真实 CLI 客户端经由协议捕获代理访问 Gateway，H5 使用客户端实际收到的帧。
    const proxy = await captureProxy({ target: gw.url });
    const cli = await runCliExec({
      corePath: ctx.core.path,
      home,
      cwd: gw.root,
      prompt: "Reply exactly E2E_SUB_BASELINE_OK. Do not use any tools.",
      args: [
        "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "-C", gw.root, "-s", "read-only",
        "-c", 'approval_policy="never"', "-c", 'model_provider="openai"',
        "-c", `openai_base_url="${proxy.url}/subscription/v1"`, "-c", `model_catalog_json="${catalogPath}"`,
        "-m", GPT, "-c", 'model_reasoning_effort="low"',
      ],
      timeoutMs: 300000,
    });
    await proxy.close();
    const cliText = cli.rows
      .filter((x) => x.type === "item.completed" && x.item?.type === "agent_message")
      .map((x) => x.item.text)
      .join("\n");
    assertion(assertions, "cli_exit_0", cli.code === 0, `exit=${cli.code}`);
    assertion(assertions, "cli_answer", cliText.includes("E2E_SUB_BASELINE_OK"), cliText.slice(0, 120));
    assertion(assertions, "captured_sequenced_frames", proxy.frames.length > 0, `${proxy.frames.length} frames`);

    const official = gw.outbound.filter((x) => x.official);
    assertion(assertions, "official_channel_only", official.length > 0 && official.every((x) => x.subscriptionBearer), JSON.stringify(official.map((x) => x.host)));
    assertion(assertions, "no_third_party_outbound", gw.outbound.every((x) => x.official), JSON.stringify([...new Set(gw.outbound.map((x) => x.host))]));

    const healthSamples = health.stop().map((x) => ({ at: x.at, ms: x.ms, ok: x.ok, activeTurns: x.activeTurns }));
    return buildObservation({
      id: "E2E-1", ctx, gateway: gw,
      probe: { events: proxy.frames, startedAt: proxy.frames[0]?.at ?? Date.now() },
      extra: {
        assertions,
        health: healthSamples,
        eventLoopDelayP99Ms: loop.stop(),
        historyVersionsDelta: gw.archive.stats().versions - versions0,
        detail: { cliExit: cli.code, frames: proxy.frames.length, outboundHosts: [...new Set(gw.outbound.map((x) => x.host))] },
      },
    });
  } finally {
    await gw.close();
  }
}

// E2E-2 第三方 Responses 路径 + 图片两分支
export async function e2e2(ctx) {
  const gw = await setup(ctx, "e2e2", (config) => {
    config.rules = [{ name: "e2e-text-only", match: { modelID: "gpt-5.6-luna" }, target: "strong" }];
  });
  const assertions = [];
  try {
    const home = join(gw.root, "home");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await symlink(ctx.authSource, join(home, "auth.json"));
    const catalogPath = join(home, "models.json");
    await writeCatalog({ sourceCatalogPath: ctx.catalogSource, config: gw.config, targetPath: catalogPath });
    await isolatedCodexHome({
      home,
      baseUrl: `${gw.url}/subscription/v1`,
      catalogPath,
      authSource: ctx.authSource,
      model: DS,
    });
    const health = startHealthSampling(gw.url, ctx.thresholds.healthSampleIntervalMs);
    const loop = monitorEventLoop();
    const versions0 = gw.archive.stats().versions;

    const app = startAppServer({ corePath: ctx.core.path, home, cwd: gw.root });
    await app.initialize("e2e_third_party");
    const account = await app.rpc("account/read", { refreshToken: false });
    const thread = await app.rpc("thread/start", {
      model: DS, modelProvider: "openai", cwd: gw.root, ephemeral: true,
      sandbox: "read-only", approvalPolicy: "never",
    });
    const turn = await app.request(thread.thread.id, DS, "Reply exactly E2E_THIRD_PARTY_OK. Do not use any tools.");
    assertion(assertions, "app_account_chatgpt", account.account?.type === "chatgpt", String(account.account?.type));
    assertion(assertions, "app_turn_completed", turn.status === "completed", String(turn.status));
    assertion(assertions, "app_turn_answer", turn.text.includes("E2E_THIRD_PARTY_OK"), turn.text.slice(0, 120));
    await app.close();

    const image = dataUrl(solidPng(64, [220, 20, 20]));
    const proxy = await captureProxy({ target: gw.url });
    const first = await httpProbe({
      url: proxy.url, path: "/v1/responses", token: gw.accessToken, threadId: "e2e2-image",
      body: {
        model: DS,
        input: [{ type: "message", role: "user", content: [
          { type: "input_text", text: "What is the dominant color of this image? Answer with one English word." },
          { type: "input_image", image_url: image },
        ] }],
        stream: true, max_output_tokens: 64,
      },
    });
    const firstText = first.events.filter((x) => x.type === "response.output_text.delta").map((x) => x.delta).join("");
    const firstId = first.events.find((x) => x.type === "response.completed")?.response?.id;
    assertion(assertions, "image_native_completed", Boolean(firstId), JSON.stringify(first.errorBody ?? first.status));
    assertion(assertions, "image_native_color", /red/i.test(firstText), firstText.slice(0, 120));

    const second = await httpProbe({
      url: proxy.url, path: "/v1/responses", token: gw.accessToken, threadId: "e2e2-image",
      body: {
        model: "gpt-5.6-luna",
        previous_response_id: firstId,
        input: [{ type: "message", role: "user", content: [
          { type: "input_text", text: "Was an image present in this conversation? Answer briefly." },
        ] }],
        stream: true, max_output_tokens: 128,
      },
    });
    const secondId = second.events.find((x) => x.type === "response.completed")?.response?.id;
    const describeLog = gw.logs.find((x) => x.event === "image_description_started");
    const toTextOnly = gw.payloads.filter((x) => x.model === "gpt-5.6-luna");
    assertion(assertions, "image_migration_completed", Boolean(secondId), JSON.stringify(second.errorBody ?? second.status));
    assertion(assertions, "image_description_ran", Boolean(describeLog), "no image_description_started log");
    assertion(
      assertions,
      "text_only_received_text",
      toTextOnly.length > 0 &&
        toTextOnly.every((x) => (x.contentTypes ?? []).every((types) => types.every((t) => t !== "input_image"))),
      JSON.stringify(toTextOnly.map((x) => x.contentTypes)),
    );

    const thirdParty = gw.outbound.filter((x) => !x.official);
    await proxy.close();
    assertion(
      assertions,
      "no_subscription_credential_to_third_party",
      thirdParty.length > 0 && thirdParty.every((x) => !x.subscriptionBearer && !x.accountHeader),
      JSON.stringify(thirdParty.map((x) => ({ host: x.host, bearer: x.subscriptionBearer, account: x.accountHeader }))),
    );

    const healthSamples = health.stop().map((x) => ({ at: x.at, ms: x.ms, ok: x.ok, activeTurns: x.activeTurns }));
    return buildObservation({
      id: "E2E-2", ctx, gateway: gw,
      probe: { events: proxy.frames, startedAt: proxy.frames[0]?.at ?? Date.now() },
      extra: {
        assertions,
        extraTerminals: [`app:${turn.status}`],
        health: healthSamples,
        eventLoopDelayP99Ms: loop.stop(),
        historyVersionsDelta: gw.archive.stats().versions - versions0,
        toolsExecutedLocally: false,
        detail: {
          appAnswerObserved: turn.text.length > 0,
          imageAnswerObserved: firstText.length > 0,
          imageDescription: Boolean(describeLog),
        },
      },
    });
  } finally {
    await gw.close();
  }
}

// E2E-3 跨模型切换 + 历史与工具（B harness）
export async function e2e3(ctx) {
  const gw = await setup(ctx, "e2e3");
  const assertions = [];
  try {
    const home = join(gw.root, "home");
    const fixture = join(gw.root, "fixture");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(fixture, { recursive: true, mode: 0o700 });
    await symlink(ctx.authSource, join(home, "auth.json"));
    const catalogPath = join(home, "models.json");
    await writeCatalog({ sourceCatalogPath: ctx.catalogSource, config: gw.config, targetPath: catalogPath });
    await isolatedCodexHome({ home, baseUrl: `${gw.url}/subscription/v1`, catalogPath, authSource: ctx.authSource, model: GPT });
    const health = startHealthSampling(gw.url, ctx.thresholds.healthSampleIntervalMs);
    const loop = monitorEventLoop();
    const versions0 = gw.archive.stats().versions;

    const app = startAppServer({ corePath: ctx.core.path, home, cwd: fixture });
    await app.initialize("e2e_switch");
    const threads = [];
    for (const model of [GPT, DS])
      threads.push(
        (
          await app.rpc("thread/start", {
            model, modelProvider: "openai", cwd: fixture, ephemeral: true,
            sandbox: "read-only", approvalPolicy: "never",
          })
        ).thread.id,
      );
    const tokens = [0, 1].map(() => ({
      memory: `MEM_${createHash("sha256").update(`m${Math.random()}`).digest("hex").slice(0, 8)}`,
      tool: `FILE_${createHash("sha256").update(`t${Math.random()}`).digest("hex").slice(0, 8)}`,
    }));
    for (let i = 0; i < 2; i++) await writeFile(join(fixture, `marker-${i}.txt`), `${tokens[i].tool}\n`);

    const turns = [];
    turns.push(
      ...(await Promise.all(
        threads.map((id, i) =>
          app.request(
            id,
            i ? DS : GPT,
            `Remember the conversation code ${tokens[i].memory}. Use the shell tool to read only ${join(fixture, `marker-${i}.txt`)}. Report the conversation code and the file code; remember both.`,
          ),
        ),
      )),
    );
    for (let i = 0; i < 2; i++) await rm(join(fixture, `marker-${i}.txt`));
    for (let round = 0; round < 3; round++)
      turns.push(
        ...(await Promise.all(
          threads.map((id, i) =>
            app.request(
              id,
              (round + i) % 2 === 0 ? DS : GPT,
              "Without using any tools, recall the conversation code I gave you and the code you read from the file earlier. Output both exact codes.",
            ),
          ),
        )),
      );
    const recalls = turns.slice(2);
    const recallOk = recalls.every((turn, index) => {
      const i = index % 2;
      return turn.text.includes(tokens[i].memory) && turn.text.includes(tokens[i].tool);
    });
    assertion(assertions, "all_turns_completed", turns.every((x) => x.status === "completed"), turns.map((x) => x.status).join(","));
    assertion(assertions, "cross_model_recall_after_file_removal", recallOk, recalls.map((x) => x.text.slice(0, 60)).join(" | "));
    assertion(assertions, "tool_executed_in_first_turn", turns.slice(0, 2).every((x) => x.items.length > 0), JSON.stringify(turns.slice(0, 2).map((x) => x.items.length)));
    const toolIds = turns.flatMap((x) => x.items.map((i) => i.id));
    assertion(assertions, "no_duplicate_tool_execution", new Set(toolIds).size === toolIds.length, `${toolIds.length} executions`);
    assertion(assertions, "no_summary_or_compaction", !gw.logs.some((x) => ["summary_started", "migration_summary_installed", "compaction_completed"].includes(x.event)), JSON.stringify(gw.logs.filter((x) => ["summary_started", "migration_summary_installed"].includes(x.event)).map((x) => x.event)));
    assertion(assertions, "history_migrations_recorded", gw.logs.filter((x) => x.event === "full_history_migrated").length >= 4, `${gw.logs.filter((x) => x.event === "full_history_migrated").length} migrations`);
    await app.close();

    const before = gw.logs.length;
    const prewarm = await wsProbe({
      url: gw.url, token: gw.subscriptionToken, accountId: gw.subscriptionAccountId,
      model: DS, input: "prewarm", generate: false,
    });
    const afterLogs = gw.logs.slice(before);
    assertion(assertions, "prewarm_no_upstream", !afterLogs.some((x) => x.event === "upstream_headers"), JSON.stringify(afterLogs.map((x) => x.event)));

    const probe = await wsProbe({
      url: gw.url, token: gw.subscriptionToken, accountId: gw.subscriptionAccountId,
      model: DS, input: "Reply exactly E2E_SWITCH_PROBE_OK. Do not use any tools.",
    });
    assertion(assertions, "probe_completed", probe.terminal?.type === "response.completed", String(probe.terminal?.type));
    assertion(assertions, "prewarm_terminal", prewarm.terminal?.type === "response.completed", String(prewarm.terminal?.type));

    const healthSamples = health.stop().map((x) => ({ at: x.at, ms: x.ms, ok: x.ok, activeTurns: x.activeTurns }));
    return buildObservation({
      id: "E2E-3", ctx, gateway: gw, probe,
      extra: {
        assertions,
        health: healthSamples,
        eventLoopDelayP99Ms: loop.stop(),
        historyVersionsDelta: gw.archive.stats().versions - versions0,
        toolsExecutedLocally: true,
        detail: {
          turns: turns.map((x) => ({ model: x.model, status: x.status, tools: x.items.length })),
          migrations: gw.logs.filter((x) => x.event === "full_history_migrated").length,
        },
      },
    });
  } finally {
    await gw.close();
  }
}

// E2E-5 第二入口与非 Responses 协议（/v1 + 本地令牌 + Chat 目标 + 搜索回退）
export async function e2e5(ctx) {
  const gw = await setup(ctx, "e2e5", (config) => {
    config.rules = [{ name: "e2e-chat", match: { modelID: CHAT }, target: "balanced" }];
  });
  const assertions = [];
  try {
    const health = startHealthSampling(gw.url, ctx.thresholds.healthSampleIntervalMs);
    const loop = monitorEventLoop();
    const versions0 = gw.archive.stats().versions;

    const denied = await httpProbe({
      url: gw.url, path: "/v1/responses", token: "wrong-token", threadId: "e2e5",
      body: { model: CHAT, input: "hi", stream: false },
    });
    assertion(assertions, "local_token_enforced", denied.status === 401, `status=${denied.status}`);

    const proxy = await captureProxy({ target: gw.url });
    const probed = await httpProbe({
      url: proxy.url, path: "/v1/responses", token: gw.accessToken, threadId: "e2e5",
      body: {
        model: CHAT,
        input: "Use the web search tool once, then answer in one sentence about the newest result.",
        tools: [{ type: "web_search" }],
        stream: true,
        // 搜索 + 工具回填会消耗输出预算；512 会稳定触发上游 incomplete（已实测）。
        max_output_tokens: 2048,
      },
    });
    const text = probed.events.filter((x) => x.type === "response.output_text.delta").map((x) => x.delta).join("");
    const searchLog = gw.logs.find((x) => x.event === "search");
    const chatPayloads = gw.payloads.filter((x) => x.model === CHAT);
    const upstreamTools = [...new Set(chatPayloads.flatMap((x) => x.tools ?? []))];
    const clientVisible = JSON.stringify(probed.events) + text;
    const violations = toolCallOrderViolations(gw.payloads);
    assertion(assertions, "chat_target_completed", probed.events.some((x) => x.type === "response.completed"), JSON.stringify(probed.errorBody ?? probed.status));
    assertion(assertions, "answer_present", text.trim().length > 0, text.slice(0, 120));
    assertion(assertions, "search_executed", Boolean(searchLog) && (searchLog?.result_count ?? 0) > 0, `backend=${searchLog?.backend ?? "none"} results=${searchLog?.result_count ?? 0}`);
    assertion(assertions, "internal_tools_invisible", !clientVisible.includes("gateway_web_search"), "internal tool name leaked to client");
    assertion(assertions, "gateway_tools_sent_upstream", upstreamTools.includes("gateway_web_search"), JSON.stringify(upstreamTools));
    assertion(assertions, "continuation_order", violations.length === 0 && gw.payloads.some((x) => (x.callIds ?? []).length > 0), JSON.stringify(violations).slice(0, 160));
    await proxy.close();

    const healthSamples = health.stop().map((x) => ({ at: x.at, ms: x.ms, ok: x.ok, activeTurns: x.activeTurns }));
    return buildObservation({
      id: "E2E-5", ctx, gateway: gw,
      probe: { events: proxy.frames, startedAt: proxy.frames[0]?.at ?? probed.startedAt },
      extra: {
        assertions,
        health: healthSamples,
        eventLoopDelayP99Ms: loop.stop(),
        historyVersionsDelta: gw.archive.stats().versions - versions0,
        detail: { searchResults: searchLog?.result_count ?? 0, chatCalls: chatPayloads.length },
      },
    });
  } finally {
    await gw.close();
  }
}

// E2E-4 容量边界（发布前运行）
export async function e2e4(ctx) {
  const gw = await setup(ctx, "e2e4");
  const assertions = [];
  try {
    const health = startHealthSampling(gw.url, ctx.thresholds.healthSampleIntervalMs);
    const loop = monitorEventLoop();
    const versions0 = gw.archive.stats().versions;
    const filler = "The quick brown fox jumps over the lazy dog while the auditor records every clause of the specification. ";
    const build = (targetTokens, salt) => {
      const input = [];
      let tokens = 0;
      let index = 0;
      while (tokens < targetTokens) {
        const text = `[${salt}-${index}] ${filler}`;
        input.push({ type: "message", role: "user", content: [{ type: "input_text", text }] });
        tokens = estimateRequestTokens({ input });
        index++;
      }
      input.push({ type: "message", role: "user", content: [{ type: "input_text", text: `Reply exactly E2E_CAPACITY_${salt}_OK and nothing else.` }] });
      return { input, tokens: estimateRequestTokens({ input }) };
    };
    const within = build(360000, "WITHIN");
    const over = build(430000, "OVER");
    const proxy = await captureProxy({ target: gw.url });

    const probe = await httpProbe({
      url: proxy.url, path: "/subscription/v1/responses",
      token: gw.subscriptionToken, accountId: gw.subscriptionAccountId, threadId: "e2e4-within",
      body: { model: DS, input: within.input, stream: true, max_output_tokens: 512 },
      timeoutMs: 900000,
    });
    const text = probe.events.filter((x) => x.type === "response.output_text.delta").map((x) => x.delta).join("");
    const lossy = gw.logs.filter((x) => ["summary_started", "migration_summary_installed", "compaction_completed"].includes(x.event));
    assertion(assertions, "within_budget_completed", probe.events.some((x) => x.type === "response.completed"), JSON.stringify(probe.errorBody ?? probe.status));
    assertion(assertions, "within_budget_answer", text.includes("E2E_CAPACITY_WITHIN_OK"), text.slice(0, 120));
    assertion(assertions, "no_lossy_compression", lossy.length === 0, JSON.stringify(lossy.map((x) => x.event)));
    assertion(
      assertions,
      "estimated_tokens_in_range",
      within.tokens >= 350000 && within.tokens <= 380000,
      `estimate=${within.tokens}`,
    );
    const sentItems = gw.payloads.find((x) => x.model === DS && x.items.length === within.input.length);
    assertion(assertions, "original_items_preserved", Boolean(sentItems), "payload item count mismatch");
    const versionsAfterWithin = gw.archive.stats().versions;

    const overflow = await httpProbe({
      url: proxy.url, path: "/subscription/v1/responses",
      token: gw.subscriptionToken, accountId: gw.subscriptionAccountId, threadId: "e2e4-over",
      body: { model: DS, input: over.input, stream: true, max_output_tokens: 512 },
      timeoutMs: 900000,
    });
    await proxy.close();
    const overflowLossy = gw.logs.filter((x) => ["summary_started", "migration_summary_installed"].includes(x.event));
    const overflowCompleted = overflow.events.some((x) => x.type === "response.completed");
    const classified = gw.logs.some((x) => x.event === "provider_error" && ["context_limit", "other"].includes(x.category)) ||
      overflow.events.some((x) => x.type === "error");
    assertion(assertions, "overflow_no_lossy_compression", overflowLossy.length === 0, JSON.stringify(overflowLossy.map((x) => x.event)));
    assertion(assertions, "overflow_well_defined", overflowCompleted || classified, JSON.stringify(overflow.errorBody ?? overflow.status));

    const healthSamples = health.stop().map((x) => ({ at: x.at, ms: x.ms, ok: x.ok, activeTurns: x.activeTurns }));
    return buildObservation({
      id: "E2E-4", ctx, gateway: gw,
      probe: { events: proxy.frames, startedAt: proxy.frames[0]?.at ?? probe.startedAt },
      extra: {
        assertions,
        health: healthSamples,
        eventLoopDelayP99Ms: loop.stop(),
        historyVersionsDelta: versionsAfterWithin - versions0,
        expectedFailure: false,
        detail: {
          withinTokens: within.tokens,
          overTokens: over.tokens,
          overflowCompleted,
          overflowStatus: overflow.status,
        },
      },
    });
  } finally {
    await gw.close();
  }
}

// E2E-6 并发稳定性（线上 8788，4 会话 × 短轮）
export async function e2e6(ctx) {
  const { url, logPath, catalogPath } = ctx.live;
  const assertions = [];
  const root = workRoot(ctx, "e2e6");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const home = join(root, "home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await symlink(ctx.authSource, join(home, "auth.json"));
  await isolatedCodexHome({ home, baseUrl: `${url}/subscription/v1`, catalogPath, authSource: ctx.authSource, model: GPT });

  const idle = await awaitIdle(url, 20000);
  assertion(assertions, "started_idle", idle, "activeTurns was not 0 before start");
  // 独立进程采样：驱动进程自身繁忙不得污染健康延迟结论。
  const health = startExternalHealthSampling(url, {
    intervalMs: ctx.thresholds.healthSampleIntervalMs,
    timeoutMs: 5000,
  });
  const inProcessHealth = startHealthSampling(url, ctx.thresholds.healthSampleIntervalMs);
  const startedAt = Date.now();
  const app = startAppServer({ corePath: ctx.core.path, home, cwd: root });
  await app.initialize("e2e_live_concurrency");
  const models = [DS, GPT, DS, GPT];
  const threads = [];
  for (const model of models)
    threads.push(
      (
        await app.rpc("thread/start", {
          model, modelProvider: "openai", cwd: root, ephemeral: true,
          sandbox: "read-only", approvalPolicy: "never",
        })
      ).thread.id,
    );
  const turns = await Promise.all(
    threads.map((id, index) =>
      app.request(id, models[index], `Reply exactly E2E_LIVE_${index}_OK. Do not use any tools.`, { timeoutMs: 420000 }),
    ),
  );
  const endedAt = Date.now();
  const userInterference = health.samples.some((x) => (x.activeTurns ?? 0) > ctx.thresholds.liveUserInterferenceGuard);
  assertion(assertions, "no_user_interference", !userInterference, "conflicting activity detected on the live service");
  assertion(assertions, "four_sessions_completed", turns.every((x) => x.status === "completed"), turns.map((x) => x.status).join(","));
  assertion(assertions, "no_cross_session_text", turns.every((x, index) => x.text.includes(`E2E_LIVE_${index}_OK`)), turns.map((x) => x.text.slice(0, 40)).join(" | "));
  await app.close();

  const idleAfter = await awaitIdle(url, ctx.thresholds.activeTurnsIdleMs);
  const windowLogs = await readGatewayLogWindow(logPath, startedAt - 5000, endedAt + 5000);
  const ourTurns = new Set(
    turns
      .map((x) => x.turnId ?? x.turn)
      .filter(Boolean)
      .map((x) => identityHash(x)),
  );
  const scoped = windowLogs.filter((x) => x.turn && ourTurns.has(x.turn));
  const errors = scoped
    .filter((x) => ["ws_error", "request_error", "provider_error", "upstream_transport_error"].includes(x.event))
    .map((x) => ({ event: x.event, category: x.transport_category ?? x.category ?? x.type }));
  const phases = scoped
    .filter((x) => x.event === "upstream_first_substantive_event")
    .map((x) => x.duration_ms)
    .sort((a, b) => a - b);

  const healthSamples = health.stop().map((x) => ({ at: x.at, ms: x.ms, ok: x.ok, activeTurns: x.activeTurns }));
  const inProcessSamples = inProcessHealth.stop().map((x) => ({ at: x.at, ms: x.ms, ok: x.ok }));
  const reconnects = classifyTurnRepeats(scoped).reconnects;
  const attribution = attributeReconnects({ reconnects, logs: scoped });
  return buildObservation({
    id: "E2E-6", ctx, gateway: { url, version: PACKAGE_VERSION }, probe: null,
    extra: {
      assertions,
      health: healthSamples,
      healthInProcess: inProcessSamples,
      attributionByCriterion: attribution ? { H3: attribution } : {},
      attribution,
      eventLoopDelayP99Ms: null,
      activeTurnsIdle: idleAfter,
      historyVersionsDelta: null,
      errors,
      gatewayLogs: scoped,
      extraTerminals: turns.map((x) => (x.status === "completed" ? "completed" : String(x.status))),
      outbound: [],
      payloads: [],
      requestBytes: 0,
      sequenceEvidence: "live App-protocol turns; sequence contract evaluated on the same build in E2E-1/2/3",
      detail: {
        sessions: turns.length,
        matchedRequests: scoped.filter((x) => x.event === "route").length,
        firstSubstantiveMs: phases[0] ?? null,
        eventLoopMeasurement: "n/a (external process)",
      },
    },
  });
}

export const CASES = {
  "E2E-1": { group: "l1", title: "官方订阅透传基线", run: e2e1 },
  "E2E-2": { group: "l1", title: "第三方 Responses 路径与图片两分支", run: e2e2 },
  "E2E-3": { group: "l1", title: "跨模型切换与历史工具", run: e2e3 },
  "E2E-4": { group: "l2", title: "容量边界（发布前）", run: e2e4, preRelease: true },
  "E2E-5": { group: "l1", title: "第二入口与非 Responses 协议", run: e2e5 },
  "E2E-6": { group: "live", title: "并发稳定性（线上）", run: e2e6 },
};

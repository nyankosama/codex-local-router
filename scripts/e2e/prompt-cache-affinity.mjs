#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { PromptCacheAffinity } from "../../src/prompt-cache-affinity.mjs";
import {
  callProvider,
  credential,
  prepareThirdPartyProviderBody,
} from "../../src/providers.mjs";
import { loadConfig } from "../../src/config.mjs";
import { request } from "../../src/transport.mjs";
import { sseEvents } from "../../src/sse.mjs";
import {
  isolatedCodexHome,
  resolveCore,
  startAppServer,
  startIsolatedGateway,
  writeCatalog,
  writeDeterministicCodexInputs,
} from "./lib/harness.mjs";
import { deterministicProviderRequest } from "./lib/deterministic-upstream.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const percentile = (samples, p) => {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};
const usageOf = (body) => ({
  inputTokens: body?.usage?.input_tokens ?? null,
  cachedTokens:
    body?.usage?.input_tokens_details?.cached_tokens ??
    body?.usage?.input_tokens_details?.cache_read_tokens ??
    null,
  outputTokens: body?.usage?.output_tokens ?? null,
});
const assessment = (rows, { postWarm, minimumHits, minimumRate }) => {
  const measured = rows.slice(-postWarm);
  const hits = measured.filter((row) => (row.cachedTokens ?? 0) > 0).length;
  const input = measured.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0);
  const cached = measured.reduce((sum, row) => sum + (row.cachedTokens ?? 0), 0);
  const weightedHitRate = input > 0 ? cached / input : null;
  return {
    measured: measured.length,
    hits,
    weightedHitRate:
      weightedHitRate == null ? null : Number(weightedHitRate.toFixed(4)),
    passed:
      measured.length === postWarm &&
      hits >= minimumHits &&
      weightedHitRate >= minimumRate,
  };
};
const commaValues = (name, fallback) =>
  value(name, fallback).split(",").map((item) => item.trim()).filter(Boolean);

class MemoryState {
  constructor() { this.values = new Map(); }
  get(key) { return structuredClone(this.values.get(key)); }
  set(key, item) { this.values.set(key, structuredClone(item)); }
}

async function deterministic() {
  const resolver = new PromptCacheAffinity(new MemoryState(), {
    secret: Buffer.alloc(32, 23),
  });
  const config = {
    providers: { relay: { promptCaching: { affinity: "gateway-opaque" } } },
  };
  const target = {
    id: "gpt",
    provider: "relay",
    model: "gpt-test",
    modelFamily: "openai-gpt",
    wireApi: "responses",
  };
  const derivation = [];
  for (let index = 0; index < 5000; index++) {
    const started = performance.now();
    await resolver.resolve(config, target, {
      prompt_cache_key: "synthetic-client-key",
    }, {
      auth: "synthetic-account-hash",
      thread: "synthetic-thread",
      turn: `synthetic-turn-${index}`,
      requestKind: "turn",
    });
    derivation.push(performance.now() - started);
  }
  const base = {
    model: "gpt-test",
    input: [{ role: "user", content: "synthetic" }],
    stream: true,
  };
  const key = "clr-pc-v1-" + "a".repeat(43);
  const plain = prepareThirdPartyProviderBody(target, base, { applied: false });
  const enabled = prepareThirdPartyProviderBody(target, base, {
    applied: true,
    providerKey: key,
  });
  const adaptation = [];
  for (let index = 0; index < 10000; index++) {
    const started = performance.now();
    prepareThirdPartyProviderBody(target, enabled, {
      applied: true,
      providerKey: key,
    });
    adaptation.push(performance.now() - started);
  }
  const result = {
    mode: "deterministic",
    networkCalls: 0,
    derivationP95Ms: Number(percentile(derivation, 0.95).toFixed(4)),
    adaptationP95Ms: Number(percentile(adaptation, 0.95).toFixed(4)),
    wireDeltaBytes:
      Buffer.byteLength(JSON.stringify(enabled)) -
      Buffer.byteLength(JSON.stringify(plain)),
  };
  result.passed =
    result.derivationP95Ms < 5 &&
    result.adaptationP95Ms < 25 &&
    result.wireDeltaBytes < 128;
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}

function requireRun(mode) {
  if (!flag("run"))
    throw Error(`${mode} is live; add --run after reviewing its bounded budget`);
}

function syntheticInput(label) {
  const prefix = (
    "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu " +
    "xi omicron pi rho sigma tau upsilon phi chi psi omega. "
  ).repeat(1085);
  return [
    { role: "developer", content: [{ type: "input_text", text: prefix }] },
    {
      role: "user",
      content: [{
        type: "input_text",
        text: `Synthetic prompt-cache acceptance ${label}. Reply only OK.`,
      }],
    },
  ];
}

async function postJson(url, token, body) {
  const started = performance.now();
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(120000),
    });
  } catch (error) {
    return {
      ok: false,
      error: error?.name === "TimeoutError" ? "timeout" : "transport_error",
      durationMs: Math.round(performance.now() - started),
    };
  }
  let json;
  try { json = await response.json(); } catch {}
  return {
    ok: response.ok,
    status: response.status,
    durationMs: Math.round(performance.now() - started),
    ...usageOf(json),
  };
}

async function postProvider(url, token, body, headers) {
  const started = performance.now();
  const controller = new AbortController();
  try {
    const response = await request(url, {
      headers: {
        ...headers,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: body.stream ? "text/event-stream" : "application/json",
      },
      body,
      signal: controller.signal,
      timeoutMs: 120000,
    });
    let terminal;
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      for await (const event of sseEvents(response.body))
        if (event.response?.usage ||
            ["response.completed", "response.incomplete", "response.failed"]
              .includes(event.type)) terminal = event.response;
    } else {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) throw Error("provider body too large");
        chunks.push(chunk);
      }
      try { terminal = JSON.parse(Buffer.concat(chunks)); } catch {}
    }
    return {
      ok: response.ok && ["completed", "incomplete"].includes(terminal?.status),
      status: response.status,
      durationMs: Math.round(performance.now() - started),
      ...usageOf(terminal),
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.type ?? "transport_error",
      durationMs: Math.round(performance.now() - started),
    };
  } finally {
    controller.abort();
  }
}

async function captureCodexProviderShape(model) {
  const root = await mkdtemp(join(tmpdir(), "clr-cache-shape-"));
  const home = join(root, "codex-home");
  const work = join(root, "workspace");
  const fixture = await writeDeterministicCodexInputs(join(root, "fixtures"));
  await mkdir(work, { recursive: true, mode: 0o700 });
  let captured;
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      if (JSON.stringify(body).includes("SYNTHETIC_SHAPE_OK"))
        captured ??= { body, headers: { ...incoming.headers } };
      const result = await deterministicProviderRequest(
        "http://fixture.invalid/v1/responses",
        { body },
      );
      outgoing.writeHead(result.status, Object.fromEntries(result.headers));
      for await (const chunk of result.body) outgoing.write(chunk);
      outgoing.end();
    } catch {
      outgoing.writeHead(500);
      outgoing.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let app;
  try {
    const catalog = JSON.parse(await readFile(fixture.catalogPath, "utf8"));
    catalog.models[0].slug = model;
    catalog.models[0].use_responses_lite = true;
    catalog.models[0].supports_search_tool = false;
    const catalogPath = join(home, "models.json");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(catalogPath, JSON.stringify(catalog), { mode: 0o600 });
    await writeFile(join(home, "config.toml"), [
      `model = ${JSON.stringify(model)}`,
      'model_provider = "fixture"',
      'model_reasoning_effort = "low"',
      'web_search = "disabled"',
      `model_catalog_json = ${JSON.stringify(catalogPath)}`,
      "[model_providers.fixture]",
      'name = "Isolated synthetic provider"',
      `base_url = "http://127.0.0.1:${server.address().port}/v1"`,
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "request_max_retries = 0",
      "stream_max_retries = 0",
      "[analytics]",
      "enabled = false",
      "",
    ].join("\n"), { mode: 0o600 });
    const core = await resolveCore();
    app = startAppServer({ corePath: core.path, home, cwd: work });
    await app.initialize("codex_local_router_cache_shape");
    const thread = await app.rpc("thread/start", {
      model,
      modelProvider: "fixture",
      cwd: work,
      ephemeral: true,
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    const turn = await app.request(
      thread.thread.id,
      model,
      "Reply exactly SYNTHETIC_SHAPE_OK without using tools.",
      { timeoutMs: 120000 },
    );
    if (turn.status !== "completed" || !captured?.body?.prompt_cache_key)
      throw Error("current Codex Provider shape capture failed");
    return captured;
  } finally {
    await app?.close().catch(() => {});
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

async function candidateProviderShape(target, body, affinity, headers = {}) {
  let captured;
  const response = await callProvider(
    {
      providers: {
        [target.provider]: {
          baseUrl: "http://fixture.invalid/v1",
          adapter: "openai-compatible",
          concurrency: 1,
        },
      },
    },
    target,
    structuredClone(body),
    {
      entry: "subscription",
      headers,
      promptCacheAffinity: affinity,
      thread: "synthetic-thread",
      turn: "synthetic-turn",
    },
    new AbortController().signal,
    async (_url, options) => {
      captured = {
        body: structuredClone(options.body),
        headers: { ...options.headers },
      };
      return deterministicProviderRequest(_url, options);
    },
  );
  for await (const _chunk of response.body) {}
  if (!captured) throw Error("candidate Provider shape capture failed");
  return captured;
}

async function shapePreflight() {
  const target = {
    id: "synthetic-gpt",
    provider: "synthetic-provider",
    model: "gpt-5.6-sol",
    modelFamily: "openai-gpt",
    wireApi: "responses",
  };
  let direct;
  try {
    direct = await captureCodexProviderShape(target.model);
  } catch (error) {
    if (error?.message !== "no usable codex core binary found") throw error;
    console.log(JSON.stringify({
      mode: "shape-preflight",
      externalNetworkCalls: 0,
      skipped: true,
      reason: "codex_core_unavailable",
      passed: null,
    }, null, 2));
    return;
  }
  const liteFrame = {
    ...direct.body,
    client_metadata: {
      ...(direct.body.client_metadata ?? {}),
      ws_request_header_x_openai_internal_codex_responses_lite: "true",
    },
  };
  const providerKey = `clr-pc-v1-${"a".repeat(43)}`;
  const candidate = await candidateProviderShape(
    target,
    liteFrame,
    { applied: true, providerKey },
    direct.headers,
  );
  const compatibilityHeaders = [
    "user-agent",
    "originator",
    "x-codex-beta-features",
  ].filter((name) => direct.headers[name] != null);
  const result = {
    mode: "shape-preflight",
    externalNetworkCalls: 0,
    clientProviderShapeCaptured: typeof direct.body.prompt_cache_key === "string",
    liteFrameMetadata:
      liteFrame.client_metadata
        ?.ws_request_header_x_openai_internal_codex_responses_lite === "true",
    candidateLiteHeader:
      candidate.headers["x-openai-internal-codex-responses-lite"] === "true",
    compatibilityHeadersObserved: compatibilityHeaders.length > 0,
    compatibilityHeadersPreserved: compatibilityHeaders.every((name) =>
      candidate.headers[name] === direct.headers[name]),
    clientMetadataRemoved: candidate.body.client_metadata === undefined,
    anonymousKeyApplied: candidate.body.prompt_cache_key === providerKey,
    inputPreserved:
      JSON.stringify(candidate.body.input) === JSON.stringify(liteFrame.input),
    toolsPreserved:
      JSON.stringify(candidate.body.tools) === JSON.stringify(liteFrame.tools),
  };
  result.passed = Object.entries(result).every(([name, item]) =>
    ["mode", "externalNetworkCalls", "passed"].includes(name) || item === true);
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}

async function feasibility() {
  requireRun("live feasibility");
  const keyEnv = value("api-key-env", "FEEI_API_KEY");
  const token = process.env[keyEnv];
  if (!token) throw Error(`${keyEnv} is unavailable`);
  const baseUrl = new URL(value("base-url", "https://ai.feei.cn/v1/"));
  if (baseUrl.protocol !== "https:") throw Error("live Provider URL must use HTTPS");
  const url = new URL("responses", baseUrl).toString();
  const model = value("model", "gpt-5.6-sol");
  const fixedKey = `clr-feasibility-v1-${randomUUID()}`;
  const plan = [
    ...Array.from({ length: 4 }, (_, index) => ({
      group: "control",
      index: index + 1,
      promptCacheKey: null,
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      group: "fixed-key",
      index: index + 1,
      promptCacheKey: fixedKey,
    })),
  ];
  const rows = [];
  for (const item of plan) {
    const body = {
      model,
      input: syntheticInput(`${item.group}-${item.index}`),
      max_output_tokens: 16,
      store: false,
      stream: false,
      ...(item.promptCacheKey
        ? { prompt_cache_key: item.promptCacheKey }
        : {}),
    };
    const result = await postJson(url, token, body);
    rows.push({ group: item.group, index: item.index, ...result });
    if (!result.ok) break;
  }
  const fixed = rows.filter((row) => row.group === "fixed-key" && row.ok);
  const gate = assessment(fixed.slice(1), {
    postWarm: 3,
    minimumHits: 2,
    minimumRate: 0.6,
  });
  const result = {
    mode: "live-feasibility",
    plannedGenerations: 8,
    executedGenerations: rows.length,
    automaticRetries: 0,
    rows,
    assessment: gate,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!gate.passed) process.exitCode = 1;
}

async function providerAccess() {
  const keyEnv = value("api-key-env", "FEEI_API_KEY");
  if (process.env[keyEnv]) return process.env[keyEnv];
  const configPath = value(
    "config",
    join(
      homedir(),
      "Library",
      "Application Support",
      "Codex Local Router",
      "config.json",
    ),
  );
  const config = await loadConfig(configPath);
  const providerId = value("provider", "feei");
  const provider = config.providers?.[providerId];
  if (!provider) throw Error(`Provider ${providerId} is unavailable`);
  return credential(provider);
}

async function comparison() {
  requireRun("live cache comparison");
  const token = await providerAccess();
  if (!token) throw Error("Provider credential is unavailable");
  const baseUrl = new URL(value("base-url", "https://ai.feei.cn/v1/"));
  if (baseUrl.protocol !== "https:")
    throw Error("live Provider URL must use HTTPS");
  const url = new URL("responses", baseUrl).toString();
  const models = commaValues("models", "gpt-5.6-sol,gpt-6-astra");
  if (models.length !== 2) throw Error("--models must contain exactly two models");
  const captured = await captureCodexProviderShape(models[0]);
  const clientHeaders = Object.fromEntries(
    Object.entries(captured.headers).filter(([name]) => ![
      "host",
      "content-length",
      "authorization",
      "cookie",
      "chatgpt-account-id",
    ].includes(name)),
  );
  const resolver = new PromptCacheAffinity(new MemoryState(), {
    secret: Buffer.alloc(32, 29),
  });
  const results = [];
  let stopped = false;
  for (const model of models) {
    const target = {
      id: model,
      provider: value("provider", "feei"),
      model,
      modelFamily: "openai-gpt",
      wireApi: "responses",
    };
    const affinity = await resolver.resolve(
      {
        providers: {
          [target.provider]: {
            promptCaching: { affinity: "gateway-opaque" },
          },
        },
      },
      target,
      { prompt_cache_key: `synthetic-${model}-lineage` },
      {
        auth: "synthetic-cache-account",
        thread: `synthetic-${model}-thread`,
        turn: `synthetic-${model}-turn`,
        requestKind: "turn",
      },
    );
    if (!affinity.applied) throw Error(`affinity unavailable for ${model}`);
    const body = {
      ...structuredClone(captured.body),
      model,
      input: syntheticInput(`strict-comparison-${model}`),
      tools: [],
      max_output_tokens: 16,
      store: false,
      stream: true,
    };
    const direct = { body, headers: clientHeaders };
    const candidate = await candidateProviderShape(
      target,
      body,
      affinity,
      clientHeaders,
    );
    const rows = [];
    for (let index = 1; index <= 6; index++) {
      for (const group of ["direct", "candidate"]) {
        const variant = group === "direct" ? direct : candidate;
        const result = await postProvider(
          url,
          token,
          variant.body,
          variant.headers,
        );
        rows.push({ group, index, ...result });
        if ([401, 403, 429].includes(result.status)) {
          stopped = true;
          break;
        }
      }
      if (stopped) break;
    }
    const directRows = rows.filter((row) => row.group === "direct");
    const candidateRows = rows.filter((row) => row.group === "candidate");
    const directGate = assessment(directRows.slice(1), {
      postWarm: 5,
      minimumHits: 0,
      minimumRate: 0,
    });
    const candidateGate = assessment(candidateRows.slice(1), {
      postWarm: 5,
      minimumHits: 4,
      minimumRate: 0.7,
    });
    const comparable =
      directGate.measured === 5 &&
      candidateGate.measured === 5 &&
      directRows.slice(1).every((row) => row.ok && row.inputTokens != null) &&
      candidateRows.slice(1).every((row) => row.ok && row.inputTokens != null);
    const delta = comparable
      ? candidateGate.weightedHitRate - directGate.weightedHitRate
      : null;
    results.push({
      model,
      rows,
      direct: directGate,
      candidate: candidateGate,
      comparable,
      differencePercentagePoints:
        delta == null ? null : Number((delta * 100).toFixed(2)),
      passed:
        comparable && candidateGate.passed && delta >= -0.15,
    });
    if (stopped) break;
  }
  const executedGenerations = results.reduce(
    (sum, result) => sum + result.rows.length,
    0,
  );
  const result = {
    mode: "live-cache-comparison",
    plannedGenerations: 24,
    executedGenerations,
    automaticRetries: 0,
    stoppedOnAuthenticationOrRateLimit: stopped,
    results,
    passed:
      !stopped &&
      executedGenerations === 24 &&
      results.length === 2 &&
      results.every((item) => item.passed),
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}

async function gatewayEffect() {
  requireRun("live Gateway effect");
  const tokenEnv = value("subscription-token-env", "CODEX_SUBSCRIPTION_TOKEN");
  const token = process.env[tokenEnv];
  if (!token) throw Error(`${tokenEnv} is unavailable`);
  const url = new URL(
    value("gateway-url", "http://127.0.0.1:8788/subscription/v1/responses"),
  );
  if (!(["http:", "https:"].includes(url.protocol) &&
    ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)))
    throw Error("live Gateway effect requires a loopback Gateway URL");
  const model = value("model");
  if (!model) throw Error("--model is required");
  const rows = [];
  for (let index = 0; index < 6; index++) {
    const result = await postJson(url, token, {
      model,
      input: syntheticInput(`gateway-${index + 1}`),
      max_output_tokens: 16,
      store: false,
      stream: false,
      prompt_cache_key: "synthetic-gateway-effect",
      client_metadata: {
        thread_id: "synthetic-gateway-thread",
        turn_id: `synthetic-gateway-turn-${index + 1}`,
      },
    });
    rows.push({ index: index + 1, ...result });
    if (!result.ok) break;
  }
  const gate = assessment(rows.slice(1), {
    postWarm: 5,
    minimumHits: 4,
    minimumRate: 0.7,
  });
  const result = {
    mode: "live-gateway-effect",
    plannedGenerations: 6,
    executedGenerations: rows.length,
    automaticRetries: 0,
    rows,
    assessment: gate,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!gate.passed) process.exitCode = 1;
}

function wsTurn(ws, body) {
  return new Promise((resolve, reject) => {
    const onMessage = (data) => {
      const event = JSON.parse(data);
      if (!["response.completed", "response.incomplete", "error"].includes(event.type))
        return;
      cleanup();
      if (event.type === "error") reject(Error("App protocol turn failed"));
      else resolve(usageOf(event.response));
    };
    const onError = () => { cleanup(); reject(Error("App protocol transport failed")); };
    const cleanup = () => {
      ws.off("message", onMessage);
      ws.off("error", onError);
    };
    ws.on("message", onMessage);
    ws.on("error", onError);
    ws.send(JSON.stringify({ type: "response.create", ...body }));
  });
}

async function appProtocol() {
  requireRun("live App protocol");
  const tokenEnv = value("subscription-token-env", "CODEX_SUBSCRIPTION_TOKEN");
  const token = process.env[tokenEnv];
  if (!token) throw Error(`${tokenEnv} is unavailable`);
  const url = new URL(
    value("gateway-url", "ws://127.0.0.1:8788/subscription/v1/responses"),
  );
  if (!(["ws:", "wss:"].includes(url.protocol) &&
    ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)))
    throw Error("live App protocol requires a loopback Gateway URL");
  const model = value("model");
  if (!model) throw Error("--model is required");
  const ws = new WebSocket(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const plan = [
    { thread: "synthetic-parent", turn: "parent-1" },
    { thread: "synthetic-parent", turn: "parent-2" },
    { thread: "synthetic-fork", turn: "fork-1", parent: "synthetic-parent" },
    { thread: "synthetic-fork", turn: "fork-2", parent: "synthetic-parent" },
  ];
  const rows = [];
  try {
    for (const item of plan) {
      const started = performance.now();
      let usage;
      try {
        usage = await wsTurn(ws, {
          model,
          input: syntheticInput(item.turn),
          max_output_tokens: 16,
          prompt_cache_key: "synthetic-app-lineage",
          client_metadata: {
            thread_id: item.thread,
            turn_id: item.turn,
            ...(item.parent ? { parent_thread_id: item.parent } : {}),
          },
        });
      } catch {
        rows.push({ turn: item.turn, ok: false, error: "protocol_error" });
        break;
      }
      rows.push({
        turn: item.turn,
        ok: true,
        durationMs: Math.round(performance.now() - started),
        ...usage,
      });
    }
  } finally {
    ws.close();
  }
  const result = {
    mode: "live-app-protocol",
    plannedGenerations: 4,
    executedGenerations: rows.length,
    automaticRetries: 0,
    rows,
    passed:
      rows.length === 4 &&
      rows.every((row) => row.ok) &&
      (rows[1].cachedTokens ?? 0) > 0 &&
      (rows[3].cachedTokens ?? 0) > 0,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}

async function appCandidate() {
  requireRun("live App candidate protocol");
  const configPath = value(
    "config",
    join(
      homedir(),
      "Library",
      "Application Support",
      "Codex Local Router",
      "config.json",
    ),
  );
  const authSource = value("auth", join(homedir(), ".codex", "auth.json"));
  const sourceCatalog = value(
    "catalog",
    join(homedir(), ".codex", "models_cache.json"),
  );
  const models = commaValues(
    "models",
    "feei-gpt-5.6-sol,feei-gpt-6-astra",
  );
  if (models.length !== 2) throw Error("--models must contain exactly two models");
  const root = await mkdtemp(join(tmpdir(), "clr-cache-app-"));
  const codexHome = join(root, "codex-home");
  const work = join(root, "workspace");
  const marker = `CACHE_CORE_${createHash("sha256")
    .update(randomUUID()).digest("hex").slice(0, 12)}`;
  const markerPath = join(work, "cache-marker.txt");
  const extra = [
    "[features]",
    "responses_websockets = true",
    "responses_websockets_v2 = true",
    "",
  ].join("\n");
  let app;
  let gateway;
  let generations = 0;
  let blockedGenerationAttempts = 0;
  const generationsByModel = new Map();
  try {
    await mkdir(work, { recursive: true, mode: 0o700 });
    await writeFile(markerPath, `${marker}\n`, { mode: 0o600 });
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    await writeFile(join(codexHome, "config.toml"), extra, { mode: 0o600 });
    gateway = await startIsolatedGateway({
      configPath,
      authSource,
      tokenFile: join(root, "access-token"),
      archivePath: join(root, "history.sqlite"),
      archiveKey: createHash("sha256").update(marker).digest(),
      promptCacheSecret: Buffer.alloc(32, 31),
      toolCodexHome: codexHome,
      markerObservations: [{ label: "core", value: marker }],
      beforeOutbound(event) {
        if (!event.official && event.path.endsWith("/responses")) {
          const modelCount = generationsByModel.get(event.model) ?? 0;
          if (generations >= 6 || modelCount >= 3) {
            blockedGenerationAttempts++;
            throw Error("App generation budget exceeded");
          }
          generations++;
          generationsByModel.set(event.model, modelCount + 1);
        }
      },
      mutate(config) {
        if (!config.providers?.feei)
          throw Error("feei Provider is unavailable");
        config.providers.feei.promptCaching = {
          affinity: "gateway-opaque",
        };
        for (const id of ["feei-sol", "feei-astra"]) {
          if (!config.targets?.[id]) throw Error(`${id} target is unavailable`);
          config.targets[id].app = {
            ...(config.targets[id].app ?? {}),
            enabled: true,
            capabilityProfile: "lite-search",
            useResponsesLite: true,
          };
          config.targets[id].standaloneSearch = { source: "subscription" };
        }
      },
    });
    const catalogPath = join(codexHome, "models.json");
    await writeCatalog({
      sourceCatalogPath: sourceCatalog,
      config: gateway.config,
      targetPath: catalogPath,
    });
    await isolatedCodexHome({
      home: codexHome,
      baseUrl: `${gateway.url}/subscription/v1`,
      catalogPath,
      authSource,
      model: models[0],
      reasoningEffort: "low",
      webSearch: "disabled",
      extra,
    });
    const core = await resolveCore();
    app = startAppServer({ corePath: core.path, home: codexHome, cwd: work });
    await app.initialize("codex_local_router_cache_affinity");
    const results = [];
    for (const model of models) {
      const outboundStart = gateway.outbound.length;
      const payloadStart = gateway.payloads.length;
      const logStart = gateway.logs.length;
      const thread = await app.rpc("thread/start", {
        model,
        modelProvider: "openai",
        cwd: work,
        ephemeral: true,
        sandbox: "read-only",
        approvalPolicy: "never",
      });
      const first = await app.request(
        thread.thread.id,
        model,
        `Use exec_command exactly once with cmd cat ${JSON.stringify(markerPath)}. Then reply with the exact returned marker and APP_TOOL_OK. Do not use any other tool.`,
        { timeoutMs: 360000 },
      );
      const firstOutbound = gateway.outbound.slice(outboundStart).filter(
        (event) => !event.official && event.path.endsWith("/responses"),
      );
      const firstPayloads = gateway.payloads.slice(payloadStart);
      const completedToolCalls = first.items.filter((item) =>
        item.type === "commandExecution" && item.status === "completed");
      const toolResultForwarded = firstPayloads.some((payload) =>
        payload.toolResultMarkers.includes("core"));
      const coreToolCalled = firstPayloads.some((payload) =>
        payload.toolCallNames.includes("exec_command"));
      const firstPassed =
        first.status === "completed" &&
        first.text.includes(marker) &&
        first.text.includes("APP_TOOL_OK") &&
        completedToolCalls.length === 1 &&
        coreToolCalled &&
        toolResultForwarded &&
        firstOutbound.length === 2;
      const second = firstPassed
        ? await app.request(
            thread.thread.id,
            model,
            "Without calling a tool, repeat the prior marker and end with APP_CONTINUATION_OK.",
            { timeoutMs: 360000 },
          )
        : { status: "not_run", text: "" };
      const outbound = gateway.outbound.slice(outboundStart).filter(
        (event) => !event.official && event.path.endsWith("/responses"),
      );
      const payloads = gateway.payloads.slice(payloadStart);
      const usage = gateway.logs.slice(logStart).filter(
        (event) => event.event === "prompt_cache_usage",
      );
      const keyFingerprints = outbound
        .map((event) => event.promptCacheKeyFingerprint)
        .filter(Boolean);
      const passed =
        firstPassed &&
        second.status === "completed" &&
        second.text.includes(marker) &&
        second.text.includes("APP_CONTINUATION_OK") &&
        outbound.length === 3 &&
        outbound.every((event) =>
          event.headerNames.includes(
            "x-openai-internal-codex-responses-lite",
          )) &&
        keyFingerprints.length === outbound.length &&
        new Set(keyFingerprints).size === 1 &&
        new Set(outbound.map((event) => event.requestFingerprint)).size ===
          outbound.length &&
        outbound.every((event) => !event.accountHeader) &&
        usage.length === outbound.length &&
        usage.every((event) =>
          event.policy === "gateway-opaque" &&
          event.transport === "websocket");
      results.push({
        model,
        generations: outbound.length,
        firstStatus: first.status,
        secondStatus: second.status,
        completedToolCalls: completedToolCalls.length,
        coreToolCalled,
        toolResultForwarded,
        continuationObserved:
          second.text.includes(marker) &&
          second.text.includes("APP_CONTINUATION_OK"),
        liteHeaderOnEveryGeneration: outbound.every((event) =>
          event.headerNames.includes(
            "x-openai-internal-codex-responses-lite",
          )),
        stableAnonymousKey:
          keyFingerprints.length === outbound.length &&
          new Set(keyFingerprints).size === 1,
        cacheUsageEvents: usage.length,
        passed,
      });
    }
    const result = {
      mode: "live-app-candidate",
      client: core,
      plannedMaximumGenerations: 6,
      executedGenerations: generations,
      blockedGenerationAttempts,
      automaticRetries: 0,
      results,
      passed:
        generations === 6 &&
        blockedGenerationAttempts === 0 &&
        results.length === 2 &&
        results.every((item) => item.passed),
    };
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } finally {
    await app?.close().catch(() => {});
    await gateway?.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

const modes = [
  flag("shape-preflight"),
  flag("live-feasibility"),
  flag("live-gateway"),
  flag("live-app-protocol"),
  flag("live-comparison"),
  flag("live-app-candidate"),
].filter(Boolean).length;
if (modes > 1) throw Error("select only one harness mode");
if (flag("shape-preflight")) await shapePreflight();
else if (flag("live-feasibility")) await feasibility();
else if (flag("live-gateway")) await gatewayEffect();
else if (flag("live-app-protocol")) await appProtocol();
else if (flag("live-comparison")) await comparison();
else if (flag("live-app-candidate")) await appCandidate();
else await deterministic();

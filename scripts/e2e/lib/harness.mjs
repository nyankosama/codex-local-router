// E2E harness：隔离 Gateway、真实渠道驱动（A=exec / B=app-server）、健康与事件循环采样。
// 只记录结构化元数据（host、头名称、事件类型、耗时），从不记录正文或凭证值。
import { spawn, execFile } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { readFile, writeFile, symlink, mkdir, rm } from "node:fs/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { WebSocket } from "ws";
import { loadConfig, validate } from "../../../src/config.mjs";
import { createGateway } from "../../../src/server.mjs";
import { request, requestRaw } from "../../../src/transport.mjs";
import { Archive } from "../../../src/archive.mjs";
import { identityHash } from "./criteria.mjs";
import { createLocalIdentityResolver } from "../../../src/local-identity.mjs";
import { buildModelCatalog } from "../../../src/model-catalog.mjs";
import { discoverToolSources } from "../../../src/tool-sources.mjs";

const exec = promisify(execFile);
export const APP_CORE = "/Applications/ChatGPT.app/Contents/Resources/codex";

export async function resolveCore() {
  const candidates = [
    { path: APP_CORE, source: "app-bundle" },
    { path: "codex", source: "path" },
  ];
  for (const candidate of candidates) {
    try {
      const { stdout } = await exec(candidate.path, ["--version"], { timeout: 20000 });
      const version = stdout.trim();
      let sha256 = null;
      if (candidate.source === "app-bundle") {
        sha256 = createHash("sha256").update(await readFile(candidate.path)).digest("hex");
      }
      return { path: candidate.path, source: candidate.source, version, sha256 };
    } catch {
      continue;
    }
  }
  throw Error("no usable codex core binary found");
}

export async function isolatedCodexHome({
  home,
  baseUrl,
  catalogPath,
  authSource,
  model,
  reasoningEffort = "low",
  webSearch = "disabled",
  extra = "",
}) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  await rm(`${home}/auth.json`, { force: true });
  await symlink(authSource, `${home}/auth.json`);
  const toml =
    `model_provider = "openai"\nmodel = "${model}"\nmodel_reasoning_effort = "${reasoningEffort}"\n` +
    `web_search = "${webSearch}"\nopenai_base_url = "${baseUrl}"\nmodel_catalog_json = "${catalogPath}"\n${extra}`;
  await writeFile(`${home}/config.toml`, toml, { mode: 0o600 });
  return home;
}

export async function writeCatalog({ sourceCatalogPath, config, targetPath }) {
  const source = JSON.parse(await readFile(sourceCatalogPath, "utf8"));
  const catalog = buildModelCatalog(source, config);
  await writeFile(targetPath, JSON.stringify(catalog), { mode: 0o600 });
  return catalog;
}

// 隔离 Gateway：随机端口、独立历史库、独立访问令牌；记录出站契约与阶段耗时。
export async function startIsolatedGateway({
  configPath,
  authSource,
  tokenFile,
  archivePath,
  archiveKey,
  seed = 0,
  mutate,
  toolCodexHome,
  beforeOutbound,
}) {
  const base = structuredClone(await loadConfig(configPath));
  base.listen = { host: "127.0.0.1", port: 0 };
  base.history = { ...(base.history ?? {}), persistent: { enabled: false } };
  base.access = { required: true, tokenFile };
  mutate?.(base);
  const config = validate(base);
  const accessToken = createHash("sha256").update(`e2e-token-${seed}`).digest("hex");
  await writeFile(tokenFile, accessToken, { mode: 0o600 });
  const subscriptionToken = JSON.parse(await readFile(authSource, "utf8")).tokens.access_token;
  const toolRegistry = await discoverToolSources(
    toolCodexHome ? { codexHome: toolCodexHome } : undefined,
  );

  const logs = [];
  const outbound = [];
  const payloads = [];
  const archive = new Archive(archivePath, archiveKey);
  // 历史写入观测：只记录结构化元数据（是否新插、版本号、responseId 哈希）。
  const historyWrites = [];
  const saveResponse = archive.saveResponse.bind(archive);
  archive.saveResponse = (key, value, history) => {
    const saved = saveResponse(key, value, history);
    historyWrites.push({
      at: Date.now(),
      inserted: saved?.inserted === true,
      version: saved?.version ?? null,
      responseIdHash: history?.responseId ? identityHash(history.responseId) : null,
    });
    return saved;
  };
  const recordOutbound = (url, options) => {
    const host = new URL(url).host;
    const headers = options.headers ?? {};
    const authorization = headers.authorization ?? "";
    let body = options.body;
    if (Buffer.isBuffer(body) && !headers["content-encoding"])
      try { body = JSON.parse(body.toString("utf8")); } catch { body = null; }
    const input = Array.isArray(body?.input) ? body.input : [];
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const metadata = {
      host,
      official: host === "chatgpt.com",
      headerNames: Object.keys(headers).sort(),
      subscriptionBearer: Boolean(subscriptionToken) && authorization === `Bearer ${subscriptionToken}`,
      accountHeader: Boolean(headers["chatgpt-account-id"]),
      opencodeSession: Boolean(headers["x-opencode-session"]),
      path: new URL(url).pathname,
    };
    beforeOutbound?.({
      ...metadata,
      model: body?.model,
      generate: body?.generate,
    });
    outbound.push(metadata);
    payloads.push({
      host,
      model: body?.model,
      bytes: Buffer.isBuffer(options.body)
        ? options.body.length
        : Buffer.byteLength(JSON.stringify(options.body ?? "")),
      items: [
        ...input.map((x) => x.type ?? x.role),
        ...messages.map((x) => `${x.role}${x.tool_calls ? "+tool_calls" : ""}`),
      ],
      contentTypes: [
        ...input
          .filter((x) => Array.isArray(x.content))
          .map((x) => (x.content ?? []).map((part) => part?.type)),
        ...messages
          .filter((x) => Array.isArray(x.content))
          .map((x) => (x.content ?? []).map((part) => part?.type)),
      ],
      tools: (body?.tools ?? []).map((x) => x.name ?? x.function?.name ?? x.type),
      toolSizes: (body?.tools ?? []).map((x) => ({
        name: x.name ?? x.function?.name ?? x.type,
        type: x.type ?? null,
        bytes: Buffer.byteLength(JSON.stringify(x)),
      })),
      callIds: [
        ...input
          .filter((x) => ["function_call", "function_call_output"].includes(x.type))
          .map((x) => `${x.type}:${x.call_id ?? ""}`),
        ...messages.flatMap((x) => [
          ...(x.role === "tool" ? [`function_call_output:${x.tool_call_id ?? ""}`] : []),
          ...((x.tool_calls ?? []).map((call) => `function_call:${call.id ?? ""}`)),
        ]),
      ],
    });
    return metadata;
  };
  const gateway = createGateway(config, {
    archive,
    closeArchive: true,
    resolveIdentity: createLocalIdentityResolver(authSource),
    toolRegistry,
    send: async (url, options) => {
      const metadata = recordOutbound(url, options);
      try {
        const response = await request(url, options);
        metadata.status = response.status;
        return response;
      } catch (error) {
        metadata.error = error?.type ?? "transport_error";
        throw error;
      }
    },
    officialRequest: async (url, options) => {
      const metadata = recordOutbound(url, options);
      try {
        const response = await requestRaw(url, options);
        metadata.status = response.status;
        return response;
      } catch (error) {
        metadata.error = error?.type ?? "transport_error";
        throw error;
      }
    },
    log: (event) => logs.push(event),
  });
  await new Promise((r) => gateway.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${gateway.server.address().port}`;
  return {
    gateway,
    archive,
    config,
    url,
    accessToken,
    subscriptionAccountId: JSON.parse(await readFile(authSource, "utf8")).tokens.account_id,
    logs,
    outbound,
    payloads,
    historyWrites,
    subscriptionToken,
    async close() {
      await gateway.close();
    },
  };
}

// 独立进程健康采样：用 curl 子进程观测，避免被测/驱动进程自身繁忙污染延迟测量。
export function startExternalHealthSampling(url, { intervalMs = 250, timeoutMs = 5000 } = {}) {
  const script = [
    `while :; do`,
    `  curl -s --noproxy '*' --max-time ${Math.max(1, Math.round(timeoutMs / 1000))} -w ' %{time_total} %{http_code}' '${url}/healthz'`,
    `  echo`,
    `  sleep ${(intervalMs / 1000).toFixed(3)}`,
    `done`,
  ].join("\n");
  const child = spawn("/bin/bash", ["-c", script], { stdio: ["ignore", "pipe", "ignore"] });
  const samples = [];
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const match = line.match(/ \s*([0-9.]+) (\d{3})$/);
    if (!match) return;
    let activeTurns = null;
    try {
      activeTurns = JSON.parse(line.slice(0, match.index)).activeTurns ?? null;
    } catch {}
    samples.push({
      at: Date.now(),
      ms: Math.round(Number(match[1]) * 1000),
      ok: match[2] === "200",
      activeTurns,
    });
  });
  return {
    samples,
    stop() {
      child.kill("SIGTERM");
      return samples;
    },
  };
}

// 同进程健康采样（保留作为对照：客户端繁忙时可能虚高）。
export function startHealthSampling(url, intervalMs) {
  const samples = [];
  let stopped = false;
  let timer;
  const tick = async () => {
    const at = Date.now();
    try {
      const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5000) });
      const body = await res.json();
      samples.push({ at, ms: Date.now() - at, ok: body.ok === true, activeTurns: body.activeTurns ?? null });
    } catch (error) {
      samples.push({ at, ms: Date.now() - at, ok: false, error: error?.name ?? "error" });
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);
  return {
    samples,
    stop() {
      stopped = true;
      clearTimeout(timer);
      return samples;
    },
  };
}

export function monitorEventLoop() {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  return {
    stop() {
      histogram.disable();
      const p99 = histogram.percentile(99) / 1e6;
      return Number.isFinite(p99) ? Math.round(p99) : null;
    },
  };
}

// A harness：App 包内 core 的 exec（或 PATH 回退）。返回 JSONL 事件与退出码。
export async function runCliExec({
  corePath,
  home,
  cwd,
  args,
  env = {},
  timeoutMs = 600000,
  prompt,
  signal,
}) {
  const child = spawn(corePath, ["exec", "--json", ...args, prompt], {
    cwd,
    env: { ...process.env, CODEX_HOME: home, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (x) => (stdout += x));
  child.stderr.on("data", (x) => (stderr += x));
  const abort = () => child.kill();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  const code = await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  signal?.removeEventListener("abort", abort);
  const rows = stdout
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  return { code, rows, stdout, stderr };
}

// B harness：同一二进制的 app-server --stdio（App 真实客户端协议）。
export function startAppServer({ corePath, home, cwd }) {
  const child = spawn(corePath, ["app-server", "--stdio"], {
    env: { ...process.env, CODEX_HOME: home },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const notifications = [];
  const threads = new Map();
  const pending = new Map();
  let serial = 0;
  let exited = false;
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    notifications.push({ at: Date.now(), method: message.method, id: message.id });
    if (message.id != null && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      message.error ? entry.reject(Error(`rpc ${JSON.stringify(message.error)}`)) : entry.resolve(message.result);
      return;
    }
    const record = threads.get(message.params?.threadId);
    if (!record) return;
    if (message.method === "item/agentMessage/delta") {
      record.text += message.params.delta;
      record.firstTextAt ??= Date.now();
    }
    if (message.method === "item/completed") {
      const item = message.params.item ?? {};
      if (["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch"].includes(item.type)) {
        record.items.push({
          type: item.type,
          id: item.id,
          status: item.status ?? "completed",
          tool: item.tool ?? item.name ?? item.server ?? item.serverLabel ?? null,
          resultCount: Array.isArray(item.results) ? item.results.length : null,
          at: Date.now(),
        });
      }
      if (item.type === "contextCompaction") record.compactions++;
    }
    if (message.method === "turn/completed") record.finish(message.params.turn);
  });
  child.on("exit", () => {
    exited = true;
    for (const entry of pending.values()) entry.reject(Error("app-server exited"));
    for (const record of threads.values()) record.finish({ status: "backend_exited" });
  });
  const rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (exited) return reject(Error("app-server not running"));
      const id = ++serial;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  const request = (threadId, model, text, { timeoutMs = 600000 } = {}) => {
    const record = { threadId, model, text: "", items: [], compactions: 0, startedAt: Date.now(), firstTextAt: null };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`turn timeout for ${threadId}`)), timeoutMs);
      record.finish = (turn) => {
        clearTimeout(timer);
        threads.delete(threadId);
        resolve({ ...record, turn: turn.id, status: turn.status, endedAt: Date.now() });
      };
      threads.set(threadId, record);
      rpc("turn/start", { threadId, model, input: [{ type: "text", text, text_elements: [] }] }).then(
        (started) => {
          record.turnId = started?.turn?.id;
        },
        (error) => {
          clearTimeout(timer);
          threads.delete(threadId);
          reject(error);
        },
      );
    });
  };
  return {
    rpc,
    request,
    notifications,
    async initialize(name) {
      await rpc("initialize", { clientInfo: { name, version: "1.0" }, capabilities: { experimentalApi: true } });
      child.stdin.write('{"method":"initialized"}\n');
    },
    async close() {
      child.kill();
    },
  };
}

// 原始 WebSocket 探针：直接观察 Gateway 发出的 sequence_number / phase / 终态。
export function wsProbe({ url, token, accountId = "", model, input, generate = true, timeoutMs = 300000 }) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${url.replace("http", "ws")}/subscription/v1/responses`, {
      headers: { authorization: `Bearer ${token}`, ...(accountId ? { "chatgpt-account-id": accountId } : {}) },
    });
    const events = [];
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      socket.terminate();
      reject(Error("ws probe timeout"));
    }, timeoutMs);
    const done = (terminal) => {
      clearTimeout(timer);
      socket.close();
      resolve({ events, terminal, startedAt, endedAt: Date.now() });
    };
    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          type: "response.create",
          model,
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }],
          stream: true,
          max_output_tokens: 512,
          ...(generate === false ? { generate: false } : {}),
        }),
      );
    });
    socket.on("message", (data) => {
      let event;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }
      events.push({ at: Date.now(), ...event });
      if (["response.completed", "response.failed", "response.incomplete", "error"].includes(event.type))
        done(event);
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

// 协议捕获代理：在真实客户端与 Gateway 之间透明转发，只记录 SSE 帧的
// type / sequence_number / phase 元数据（不记录正文），用于 H5 协议契约判定。
export function captureProxy({ target }) {
  const upstream = new URL(target);
  const frames = [];
  let streamIndex = -1;
  const server = createServer((req, res) => {
    const stream = ++streamIndex; // 每个客户端请求一个独立事件流（sequence_number 从 0 重新开始）
    const proxyReq = httpRequest(
      {
        hostname: upstream.hostname,
        port: upstream.port,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: upstream.host },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        const streaming = (proxyRes.headers["content-type"] ?? "").includes("text/event-stream");
        let buffer = "";
        proxyRes.on("data", (chunk) => {
          if (streaming) {
            buffer += chunk.toString("utf8");
            for (;;) {
              const end = buffer.indexOf("\n\n");
              if (end < 0) break;
              const block = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              const line = block.split("\n").find((x) => x.startsWith("data: "));
              if (!line) continue;
              try {
                const event = JSON.parse(line.slice(6));
                frames.push({
                  at: Date.now(),
                  stream,
                  type: event.type,
                  sequence_number: event.sequence_number,
                  itemType: event.item?.type,
                  // 用量元数据（数字，不含正文）
                  inputTokens: event.response?.usage?.input_tokens ?? event.usage?.input_tokens,
                  outputTokens: event.response?.usage?.output_tokens ?? event.usage?.output_tokens,
                  phase: event.item?.phase,
                  itemId: event.item?.id,
                });
              } catch {}
            }
          }
          res.write(chunk);
        });
        proxyRes.on("end", () => res.end());
      },
    );
    proxyReq.on("error", () => res.destroy());
    req.pipe(proxyReq);
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () =>
      resolvePromise({
        url: `http://127.0.0.1:${server.address().port}`,
        frames,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(done);
          }),
      }),
    );
  });
}

// 只读观测：按时间窗切片线上 Gateway 日志（供 E2E-6 使用）。
export async function readGatewayLogWindow(path, since, until) {
  const body = await readFile(path, "utf8").catch(() => "");
  return body
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line);
        if (!event.at) return [];
        const at = Date.parse(event.at);
        return at >= since && at <= until ? [{ ...event, atMs: at }] : [];
      } catch {
        return [];
      }
    });
}

// 无客户端帧时的前进性回退：从 Gateway 日志的时长字段提取（外部进程用法）。
export function phasesFromGatewayLogs(events) {
  const durations = (name) =>
    (events ?? []).filter((x) => x.event === name && typeof x.duration_ms === "number").map((x) => x.duration_ms);
  const substantive = durations("upstream_first_substantive_event");
  const text = [...durations("downstream_first_output_text"), ...durations("upstream_first_output_text")];
  const completed = durations("completed");
  return {
    firstSubstantiveMs: substantive.length ? Math.max(...substantive) : undefined,
    firstTextMs: text.length ? Math.max(...text) : undefined,
    maxEventGapMs: completed.length ? Math.max(...completed) : undefined,
    progressObserved: (events ?? []).some((x) => x.event === "completed" && x.status === "completed"),
    source: "gateway_logs",
  };
}

// 事件流分组：连接/请求为单位（captureProxy 按请求编号，探针默认单流）。
export function groupStreams(events) {
  const map = new Map();
  for (const event of events) {
    const key = event.stream ?? 0;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(event);
  }
  return [...map.values()];
}

// 截断检测：含有 Responses 事件但未以终态结尾的流。
export function truncatedStreams(streams, terminals) {
  return streams
    .map((events, index) => [index, events])
    .filter(([, events]) => events.length && events.some((x) => String(x.type ?? "").startsWith("response.")))
    .filter(([, events]) => !terminals.includes(events[events.length - 1].type))
    .map(([index]) => index);
}

// 重连观测：同一 turn 在 Gateway 侧被重复请求的次数（不依赖客户端日志）。
// 区分两种同 turn 多请求：
// - continuation：输入项严格增多（工具结果回填后的续跑），属正常协议行为；
// - reconnect：输入项未增长（同内容重发），属客户端重试/重连信号。
export function classifyTurnRepeats(logs) {
  const groups = new Map();
  for (const event of logs ?? []) {
    if (event.event !== "route" || !event.turn) continue;
    const key = `${event.thread ?? ""}:${event.turn}:${event.request_kind ?? "turn"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  const reconnects = [];
  const continuations = [];
  for (const [key, rows] of groups) {
    for (let i = 1; i < rows.length; i++) {
      const previous = rows[i - 1];
      const current = rows[i];
      const previousSize = previous.input_items ?? previous.payload_bytes ?? 0;
      const currentSize = current.input_items ?? current.payload_bytes ?? 0;
      if (currentSize > previousSize) continuations.push({ key, from: previousSize, to: currentSize });
      else reconnects.push({ key, size: currentSize });
    }
  }
  return { reconnects, continuations };
}

export function derivePhases({ events, startedAt }) {
  const itemType = (event) => event.item?.type ?? event.itemType;
  const itemKey = (event) => event.item?.id ?? event.itemId ?? (event.output_index != null ? String(event.output_index) : undefined);
  const substantive = events.filter(
    (x) =>
      x.type &&
      ![
        "response.created",
        "response.in_progress",
        "response.queued",
        "response.completed",
        "response.incomplete",
        "response.failed",
        "error",
        "ping",
      ].includes(x.type),
  );
  const firstText = events.find((x) => x.type === "response.output_text.delta");
  const stamps = events.map((x) => x.at ?? startedAt).sort((a, b) => a - b);
  let maxGap = 0;
  for (let i = 1; i < stamps.length; i++) maxGap = Math.max(maxGap, stamps[i] - stamps[i - 1]);
  const phasesByItem = {};
  for (const event of events) {
    if (itemType(event) !== "message" || !itemKey(event)) continue;
    const key = itemKey(event);
    phasesByItem[key] ??= {};
    if (event.type === "response.output_item.added")
      phasesByItem[key].added = event.item?.phase ?? event.phase;
    if (event.type === "response.output_item.done")
      phasesByItem[key].done = event.item?.phase ?? event.phase;
  }
  return {
    firstSubstantiveMs: substantive.length ? substantive[0].at - startedAt : undefined,
    firstTextMs: firstText ? firstText.at - startedAt : undefined,
    maxEventGapMs: maxGap,
    progressObserved: substantive.length > 0,
    phasesByItem,
  };
}

export function toolObservations(events) {
  const calls = [];
  const results = [];
  for (const event of events) {
    if (event.item?.type === "function_call" && event.type === "response.output_item.done")
      calls.push({ call_id: event.item.call_id, name: event.item.name, status: "completed" });
    if (event.type === "response.output_item.done" && event.item?.type === "function_call_output")
      results.push({ call_id: event.item.call_id });
  }
  return { calls, results };
}

// 工具调用/结果顺序：每个 result 必须引用此前已出现的 call（跨请求累积），无孤儿结果。
export function toolCallOrderViolations(payloads) {
  const seen = new Set();
  const violations = [];
  for (const [index, payload] of (payloads ?? []).entries()) {
    for (const entry of payload.callIds ?? []) {
      const [kind, callId] = entry.split(":");
      if (kind === "function_call") seen.add(callId);
      else if (!seen.has(callId)) violations.push({ payload: index, callId });
    }
  }
  return violations;
}

// 重连归因：同一 turn 的重发之前是否有该 turn 的传输/上游错误（客户端重试放大）。
// 全部重连都有前序错误才算已归因，否则返回 undefined（保持未归因）。
export function attributeReconnects({ reconnects, logs }) {
  if (!reconnects?.length) return undefined;
  const categories = new Set();
  for (const reconnect of reconnects) {
    const [thread, turn] = String(reconnect.key).split(":");
    const prior = (logs ?? []).filter(
      (x) =>
        x.thread === thread &&
        x.turn === turn &&
        ["ws_error", "upstream_transport_error", "provider_error"].includes(x.event),
    );
    if (!prior.length) return undefined;
    for (const row of prior)
      categories.add(row.transport_category ?? row.category ?? row.type ?? "unknown");
  }
  return `upstream_${[...categories].join("+")}_then_client_retry`;
}

// 从上游 payload 元数据推导工具调用/结果配对（只读 call_id，不读内容）。
export function toolObservationsFromPayloads(payloads) {
  const calls = [];
  const results = [];
  for (const payload of payloads ?? [])
    for (const entry of payload.callIds ?? []) {
      const [kind, callId] = entry.split(":");
      if (kind === "function_call") calls.push({ call_id: callId, status: "completed" });
      else results.push({ call_id: callId });
    }
  const unique = new Map();
  for (const call of calls) if (!unique.has(call.call_id)) unique.set(call.call_id, call);
  const uniqueResults = new Map();
  for (const result of results) if (!uniqueResults.has(result.call_id)) uniqueResults.set(result.call_id, result);
  return { calls: [...unique.values()], results: [...uniqueResults.values()] };
}

export function unknownEventTypes(events, known) {
  return [...new Set(events.map((x) => x.type).filter((x) => x && !known.includes(x)))];
}

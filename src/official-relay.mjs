import * as zlib from "node:zlib";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { fail } from "./errors.mjs";
import { buildModelCatalog } from "./model-catalog.mjs";
import { sseEvents } from "./sse.mjs";
import { requestRaw } from "./transport.mjs";

export const OFFICIAL_CODEX_ORIGIN = "https://chatgpt.com/backend-api/codex/";
const subscriptionPrefix = "/subscription/v1/";
const fixedOrigin = new URL(OFFICIAL_CODEX_ORIGIN);
const hopByHop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function connectionTokens(headers) {
  return new Set(
    String(headers.connection ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function validateOfficialRelayPath(rawUrl, method) {
  if (["CONNECT", "TRACE"].includes(String(method).toUpperCase()))
    throw fail("relay_method_rejected", 405);
  if (
    typeof rawUrl !== "string" ||
    !rawUrl.startsWith(subscriptionPrefix) ||
    rawUrl.startsWith("//") ||
    /(?:^|\/)(?:\.|\.\.)(?:\/|\?|$)/.test(rawUrl) ||
    /%(?:2e|2f|5c)/i.test(rawUrl) ||
    rawUrl.includes("\\")
  )
    throw fail("relay_path_rejected", 400);
  const parsed = new URL(rawUrl, "http://router.invalid");
  if (!parsed.pathname.startsWith(subscriptionPrefix))
    throw fail("relay_path_rejected", 400);
  return parsed;
}

export function officialRelayUrl(rawUrl, method = "GET") {
  const parsed = validateOfficialRelayPath(rawUrl, method);
  const relative = parsed.pathname.slice(subscriptionPrefix.length);
  const destination = new URL(relative + parsed.search, fixedOrigin);
  if (destination.origin !== fixedOrigin.origin || !destination.pathname.startsWith(fixedOrigin.pathname))
    throw fail("relay_path_rejected", 400);
  return destination.toString();
}

export function relayRequestHeaders(headers, { models = false, websocket = false } = {}) {
  const dynamic = connectionTokens(headers);
  const output = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (
      value == null ||
      lower === "host" ||
      hopByHop.has(lower) ||
      dynamic.has(lower) ||
      lower.startsWith("proxy-") ||
      lower.startsWith("sec-websocket-")
    ) continue;
    output[lower] = value;
  }
  if (models) output["accept-encoding"] = "identity";
  return output;
}

export function relayResponseHeaders(upstream, overrides = {}) {
  const dynamic = connectionTokens(Object.fromEntries(upstream.rawHeaders ?? []));
  const grouped = new Map();
  for (const [key, value] of upstream.rawHeaders ?? []) {
    const lower = key.toLowerCase();
    if (hopByHop.has(lower) || dynamic.has(lower) || lower.startsWith("proxy-")) continue;
    const values = grouped.get(lower) ?? [];
    values.push(value);
    grouped.set(lower, values);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value == null) grouped.delete(key.toLowerCase());
    else grouped.set(key.toLowerCase(), [String(value)]);
  }
  return Object.fromEntries(
    [...grouped].map(([key, values]) => [key, values.length === 1 ? values[0] : values]),
  );
}

async function collect(stream, limit, { truncate = false } = {}) {
  const chunks = [];
  let bytes = 0, complete = true;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes <= limit) chunks.push(Buffer.from(chunk));
    else if (!truncate) throw fail("upstream_body_too_large", 502);
    else complete = false;
  }
  return { body: Buffer.concat(chunks), complete, bytes };
}

async function write(res, chunk, signal) {
  if (signal?.aborted) throw fail("cancelled", 499);
  if (res.write(chunk)) return;
  await new Promise((resolve, reject) => {
    const done = () => { clean(); resolve(); };
    const closed = () => { clean(); reject(fail("cancelled", 499)); };
    const clean = () => {
      res.off("drain", done);
      res.off("close", closed);
    };
    res.once("drain", done);
    res.once("close", closed);
  });
}

function injectedModels(value, config) {
  if (Array.isArray(value?.models) && value.models.length)
    return buildModelCatalog(value, config);
  if (Array.isArray(value?.data)) {
    const officialIds = new Set(value.data.map((model) => model.id));
    const custom = Object.values(config.targets)
      .filter((target) => target.app?.enabled && !officialIds.has(target.app.modelId))
      .map((target) => ({
        id: target.app.modelId,
        object: "model",
        owned_by: target.app.providerLabel ?? target.provider,
      }));
    return { ...value, data: [...value.data, ...custom] };
  }
  return null;
}

export async function relayOfficialHttp({
  req,
  res,
  wire,
  config,
  signal,
  send = requestRaw,
  observe,
  log = () => {},
}) {
  const destination = officialRelayUrl(req.url, req.method);
  const models = new URL(req.url, "http://router.invalid").pathname === "/subscription/v1/models";
  const headers = relayRequestHeaders(req.headers, { models });
  const upstream = await send(destination, {
    method: req.method,
    headers,
    body: wire,
    signal,
    timeoutMs: config.timeoutMs ?? 180000,
  });
  if (models) {
    const collected = await collect(upstream.body, config.maxBodyBytes ?? 20 * 1024 * 1024);
    let injected;
    try {
      injected = injectedModels(JSON.parse(collected.body.toString("utf8")), config);
    } catch {}
    if (injected) {
      const body = Buffer.from(JSON.stringify(injected));
      res.writeHead(upstream.status, relayResponseHeaders(upstream, {
        "content-type": "application/json",
        "content-encoding": null,
        "content-length": body.length,
        etag: null,
      }));
      res.end(body);
      return { status: upstream.status, bytes: body.length, injected: true };
    }
    res.writeHead(upstream.status, relayResponseHeaders(upstream));
    res.end(collected.body);
    return { status: upstream.status, bytes: collected.bytes, injected: false };
  }

  res.writeHead(upstream.status, relayResponseHeaders(upstream));
  const observed = [], observationLimit = config.maxBodyBytes ?? 20 * 1024 * 1024;
  let observedBytes = 0, observationComplete = true, bytes = 0;
  for await (const chunk of upstream.body) {
    bytes += chunk.length;
    observedBytes += chunk.length;
    if (observedBytes <= observationLimit) observed.push(Buffer.from(chunk));
    else observationComplete = false;
    await write(res, chunk, signal);
  }
  let observationTask;
  if (observe) {
    try {
      observationTask = observe({
        status: upstream.status,
        headers: upstream.headers,
        body: Buffer.concat(observed),
        complete: observationComplete,
      });
    } catch (error) {
      log({ event: "official_history_observation_failed", type: error.type ?? "observation_error" });
    }
  }
  res.end();
  Promise.resolve(observationTask).catch((error) => {
    log({ event: "official_history_observation_failed", type: error.type ?? "observation_error" });
  });
  return { status: upstream.status, bytes, injected: false };
}

const decompressors = {
  gzip: promisify(zlib.gunzip),
  deflate: promisify(zlib.inflate),
  zstd: zlib.zstdDecompress ? promisify(zlib.zstdDecompress) : null,
};

export async function observedOfficialResponse(observation, limit = 20 * 1024 * 1024) {
  if (!observation.complete) throw fail("history_observation_incomplete", 409);
  let body = observation.body;
  const encoding = observation.headers.get("content-encoding")?.toLowerCase() ?? "identity";
  if (encoding !== "identity") {
    const decode = decompressors[encoding];
    if (!decode) throw fail("history_observation_incomplete", 409);
    try { body = await decode(body, { maxOutputLength: limit }); }
    catch { throw fail("history_observation_incomplete", 409); }
  }
  const type = observation.headers.get("content-type") ?? "";
  if (type.includes("application/json")) return JSON.parse(body.toString("utf8"));
  if (type.includes("text/event-stream")) {
    let terminal;
    for await (const event of sseEvents(Readable.from([body])))
      if (["response.completed", "response.incomplete"].includes(event.type)) terminal = event.response;
    if (terminal) return terminal;
  }
  throw fail("history_observation_incomplete", 409);
}

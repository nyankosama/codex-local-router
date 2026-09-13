import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { createGateway } from "../src/server.mjs";
import {
  OFFICIAL_CODEX_ORIGIN,
  officialRelayUrl,
  relayRequestHeaders,
  validateOfficialRelayPath,
} from "../src/official-relay.mjs";
import { OfficialWebSocketSession } from "../src/official-websocket.mjs";

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

const upstream = (status, headers, body) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: new Headers(headers),
  rawHeaders: Object.entries(headers),
  body: Readable.from([body]),
});

const config = () => ({
  mode: "rules",
  defaultTarget: "vendor",
  providers: {
    feei: {
      adapter: "openai-compatible",
      baseUrl: "https://ai.feei.cn/v1",
      concurrency: 4,
      responsesMessagePhasePolicy: "passthrough",
    },
  },
  targets: {
    vendor: {
      id: "vendor",
      provider: "feei",
      model: "gpt-5.6-sol",
      wireApi: "responses",
      modelFamily: "openai-gpt",
      contextWindow: 272000,
      maxContextWindow: 272000,
      effectiveContextWindowPercent: 95,
      outputReserveTokens: 16384,
      inputModalities: ["text", "image"],
      compression: { mode: "summary" },
      capabilities: { responses: true, toolCalling: true, streaming: true },
      app: { enabled: true, modelId: "feei-gpt-5.6-sol", displayName: "GPT 5.6 Sol via ai.feei" },
    },
  },
  rules: [],
  history: { maxBytes: 1024 * 1024, ttlMs: 60000, persistent: { enabled: false } },
  access: { required: false },
  maxBodyBytes: 1024 * 1024,
  maxConnections: 8,
  timeoutMs: 5000,
  pluginTools: { thirdPartyGpt: { additionalAllowedPlugins: [], excludedDefaultPlugins: [] } },
  subscription: {
    enabled: true,
    models: ["gpt-official"],
    customModels: { "feei-gpt-5.6-sol": "vendor" },
  },
});

test("A5/A7 official URL is fixed, query-preserving and rejects path/method attacks", () => {
  assert.equal(
    officialRelayUrl("/subscription/v1/alpha/search?q=a%20b&limit=4", "GET"),
    `${OFFICIAL_CODEX_ORIGIN}alpha/search?q=a%20b&limit=4`,
  );
  assert.throws(() => validateOfficialRelayPath("https://evil.test/subscription/v1/models", "GET"));
  assert.throws(() => validateOfficialRelayPath("/subscription/v1/../secret", "GET"));
  assert.throws(() => validateOfficialRelayPath("/subscription/v1/%2e%2e/secret", "GET"));
  assert.throws(() => validateOfficialRelayPath("/subscription/v1/models", "CONNECT"));
  const headers = relayRequestHeaders({
    host: "127.0.0.1",
    connection: "keep-alive, x-remove",
    "x-remove": "secret",
    "proxy-authorization": "proxy-secret",
    authorization: "Bearer subscription",
    "chatgpt-account-id": "acct",
    "x-end-to-end": "keep",
  });
  assert.deepEqual(headers, {
    authorization: "Bearer subscription",
    "chatgpt-account-id": "acct",
    "x-end-to-end": "keep",
  });
});

test("A5/A7 subscription auxiliary endpoints relay bytes and query; local API search stays closed", async (t) => {
  const calls = [];
  const compressed = zlib.gzipSync(Buffer.from("fixture-search-result"));
  const gateway = createGateway(config(), {
    resolveIdentity: async (_entry, headers) => {
      if (headers.authorization !== "Bearer subscription") {
        const error = Error("identity mismatch");
        error.type = "subscription_identity_mismatch";
        error.status = 401;
        throw error;
      }
      return "chatgpt:fixture";
    },
    officialRequest: async (url, request) => {
      calls.push({ url, request });
      if (url.includes("future/binary"))
        return upstream(218, {
          "content-type": "application/octet-stream",
          "x-upstream": "future",
        }, request.body);
      return upstream(207, {
        "content-type": "application/octet-stream",
        "content-encoding": "gzip",
        "x-upstream": "preserved",
      }, compressed);
    },
  });
  const port = await listen(gateway.server);
  t.after(() => gateway.close());
  const response = await fetch(`http://127.0.0.1:${port}/subscription/v1/alpha/search?q=a%20b`, {
    headers: { authorization: "Bearer subscription", "chatgpt-account-id": "acct" },
  });
  assert.equal(response.status, 207);
  assert.equal(response.headers.get("content-encoding"), "gzip");
  assert.equal(response.headers.get("x-upstream"), "preserved");
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "fixture-search-result");
  assert.equal(calls[0].url, `${OFFICIAL_CODEX_ORIGIN}alpha/search?q=a%20b`);
  assert.equal(calls[0].request.headers.authorization, "Bearer subscription");

  const binary = Buffer.from([0, 1, 2, 127, 128, 255]);
  const future = await fetch(
    `http://127.0.0.1:${port}/subscription/v1/future/binary?revision=2`,
    {
      method: "PATCH",
      headers: {
        authorization: "Bearer subscription",
        "content-type": "application/octet-stream",
      },
      body: binary,
    },
  );
  assert.equal(future.status, 218);
  assert.equal(future.headers.get("x-upstream"), "future");
  assert.equal(Buffer.compare(Buffer.from(await future.arrayBuffer()), binary), 0);
  assert.equal(calls[1].url, `${OFFICIAL_CODEX_ORIGIN}future/binary?revision=2`);
  assert.equal(calls[1].request.method, "PATCH");
  assert.equal(Buffer.compare(calls[1].request.body, binary), 0);

  const local = await fetch(`http://127.0.0.1:${port}/v1/alpha/search`);
  assert.equal(local.status, 404);
  assert.equal(calls.length, 2);

  const denied = await fetch(`http://127.0.0.1:${port}/subscription/v1/alpha/search`, {
    headers: { authorization: "Bearer wrong" },
  });
  assert.equal(denied.status, 401);
  assert.equal(calls.length, 2);
});

test("A5 models preserves query and official fields while injecting custom catalog entries", async (t) => {
  let called;
  const gateway = createGateway(config(), {
    resolveIdentity: async () => "chatgpt:fixture",
    officialRequest: async (url, request) => {
      called = { url, request };
      return upstream(200, { "content-type": "application/json", etag: "official" }, Buffer.from(JSON.stringify({
        server_field: "unchanged",
        models: [{ slug: "gpt-official", display_name: "Official", priority: 10 }],
      })));
    },
  });
  const port = await listen(gateway.server);
  t.after(() => gateway.close());
  const response = await fetch(`http://127.0.0.1:${port}/subscription/v1/models?client_version=fixture`, {
    headers: { authorization: "Bearer subscription" },
  });
  const body = await response.json();
  assert.equal(called.url, `${OFFICIAL_CODEX_ORIGIN}models?client_version=fixture`);
  assert.equal(called.request.headers["accept-encoding"], "identity");
  assert.equal(body.server_field, "unchanged");
  assert.deepEqual(body.models.map((model) => model.slug), ["gpt-official", "feei-gpt-5.6-sol"]);
  assert.equal(response.headers.get("etag"), null);
});

test("A5/A8 ordinary official Responses stays byte-transparent and observed history can migrate", async (t) => {
  const relayCalls = [], providerCalls = [];
  const rawSse = Buffer.from([
    'event: response.created\ndata: {"type":"response.created","sequence_number":41,"response":{"id":"resp_official_1","status":"in_progress","output":[]}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","sequence_number":42,"response":{"id":"resp_official_1","status":"completed","model":"gpt-unlisted-future","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"official"}]}]}}\n\n',
  ].join(""));
  const gateway = createGateway(config(), {
    resolveIdentity: async () => "chatgpt:fixture",
    officialRequest: async (url, request) => {
      relayCalls.push({ url, request });
      return upstream(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }, rawSse);
    },
    send: async (_url, request) => {
      providerCalls.push(request.body);
      return upstream(200, { "content-type": "application/json" }, Buffer.from(JSON.stringify({
        id: "resp_vendor_1",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "vendor" }] }],
      })));
    },
  });
  const port = await listen(gateway.server);
  t.after(() => gateway.close());
  const officialRequest = {
    model: "gpt-unlisted-future",
    input: [{ role: "user", content: "fixture" }],
    stream: true,
    store: true,
  };
  const official = await fetch(`http://127.0.0.1:${port}/subscription/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer subscription", "content-type": "application/json" },
    body: JSON.stringify(officialRequest),
  });
  assert.equal(Buffer.compare(Buffer.from(await official.arrayBuffer()), rawSse), 0);
  assert.deepEqual(JSON.parse(relayCalls[0].request.body.toString()), officialRequest);

  const migrated = await fetch(`http://127.0.0.1:${port}/subscription/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer subscription", "content-type": "application/json" },
    body: JSON.stringify({
      model: "feei-gpt-5.6-sol",
      previous_response_id: "resp_official_1",
      input: [{ role: "user", content: "continue" }],
      stream: false,
    }),
  });
  assert.equal(migrated.status, 200);
  assert.equal((await migrated.json()).id, "resp_vendor_1");
  assert.equal(providerCalls.length, 1);
  assert.match(JSON.stringify(providerCalls[0].input), /fixture/);
  assert.match(JSON.stringify(providerCalls[0].input), /continue/);
});

test("A5 official Responses classifies a compressed copy but forwards the original request bytes", async (t) => {
  let captured;
  const terminal = Buffer.from('data: {"type":"response.completed","response":{"id":"resp_gzip","status":"completed","output":[]}}\n\n');
  const gateway = createGateway(config(), {
    resolveIdentity: async () => "chatgpt:fixture",
    officialRequest: async (_url, request) => {
      captured = request;
      return upstream(200, { "content-type": "text/event-stream" }, terminal);
    },
  });
  const port = await listen(gateway.server);
  t.after(() => gateway.close());
  const body = Buffer.from(JSON.stringify({
    model: "gpt-future-compressed",
    input: "fixture",
    stream: true,
  }));
  const wire = zlib.gzipSync(body);
  const response = await fetch(`http://127.0.0.1:${port}/subscription/v1/responses?transport=fixture`, {
    method: "POST",
    headers: {
      authorization: "Bearer subscription",
      "content-type": "application/json",
      "content-encoding": "gzip",
    },
    body: wire,
  });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  assert.equal(Buffer.compare(captured.body, wire), 0);
  assert.equal(captured.headers["content-encoding"], "gzip");
});

test("A8 missing observed history fails cross-provider migration explicitly", async (t) => {
  const gateway = createGateway(config(), { resolveIdentity: async () => "chatgpt:fixture" });
  const port = await listen(gateway.server);
  t.after(() => gateway.close());
  const response = await fetch(`http://127.0.0.1:${port}/subscription/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer subscription", "content-type": "application/json" },
    body: JSON.stringify({
      model: "feei-gpt-5.6-sol",
      previous_response_id: "resp_not_observed",
      input: "continue",
    }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.type, "history_observation_incomplete");
});

test("A8 an observation write failure does not fail an ordinary official response", async (t) => {
  const logs = [];
  const terminal = Buffer.from('data: {"type":"response.completed","response":{"id":"resp_archive_failure","status":"completed","output":[]}}\n\n');
  const gateway = createGateway(config(), {
    resolveIdentity: async () => "chatgpt:fixture",
    officialRequest: async () =>
      upstream(200, { "content-type": "text/event-stream" }, terminal),
    log: (event) => logs.push(event),
  });
  gateway.engine.observeOfficial = async () => {
    const error = Error("fixture write failure");
    error.type = "archive_write_failed";
    throw error;
  };
  const port = await listen(gateway.server);
  t.after(() => gateway.close());
  const response = await fetch(`http://127.0.0.1:${port}/subscription/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer subscription", "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-future", input: "fixture", stream: true }),
  });
  assert.equal(response.status, 200);
  assert.equal(Buffer.compare(Buffer.from(await response.arrayBuffer()), terminal), 0);
  assert.equal(
    logs.some((event) =>
      event.event === "official_history_observation_failed" &&
      event.type === "archive_write_failed"),
    true,
  );
});

test("A8 an ordinary official response does not wait for observation I/O", async (t) => {
  let releaseObservation;
  const observation = new Promise((resolve) => { releaseObservation = resolve; });
  const terminal = Buffer.from('data: {"type":"response.completed","response":{"id":"resp_slow_observation","status":"completed","output":[]}}\n\n');
  const gateway = createGateway(config(), {
    resolveIdentity: async () => "chatgpt:fixture",
    officialRequest: async () =>
      upstream(200, { "content-type": "text/event-stream" }, terminal),
  });
  gateway.engine.observeOfficial = async () => observation;
  const port = await listen(gateway.server);
  t.after(() => gateway.close());
  const response = await fetch(`http://127.0.0.1:${port}/subscription/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer subscription", "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-future", input: "fixture", stream: true }),
  });
  assert.equal(response.status, 200);
  assert.equal(Buffer.compare(Buffer.from(await response.arrayBuffer()), terminal), 0);
  assert.equal(gateway.engine.officialObservations.size, 1);
  releaseObservation();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gateway.engine.officialObservations.size, 0);
});

test("A6 official WebSocket relays message payloads and sequence without Engine rewriting", async (t) => {
  const upstreamSockets = [];
  const received = [];
  class FakeUpstream extends EventEmitter {
    constructor(url, options) {
      super();
      this.url = url;
      this.options = options;
      this.readyState = 0;
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open");
      });
    }
    send(data, options, callback) {
      received.push({ data: Buffer.from(data), options });
      callback();
      const first = Buffer.from(JSON.stringify({
        type: "response.created",
        sequence_number: 91,
        response: { id: "resp_ws_1", status: "in_progress", output: [] },
      }));
      const terminal = Buffer.from(JSON.stringify({
        type: "response.completed",
        sequence_number: 92,
        response: { id: "resp_ws_1", status: "completed", output: [] },
      }));
      queueMicrotask(() => {
        this.emit("message", first, false);
        this.emit("message", terminal, false);
      });
    }
    close() { this.readyState = 3; this.emit("close"); }
    terminate() { this.close(); }
  }
  const gateway = createGateway(config(), {
    resolveIdentity: async () => "chatgpt:fixture",
    createOfficialWebSocket: (url, options) => {
      const socket = new FakeUpstream(url, options);
      upstreamSockets.push(socket);
      return socket;
    },
  });
  const port = await listen(gateway.server);
  t.after(() => gateway.close());
  const socket = new WebSocket(`ws://127.0.0.1:${port}/subscription/v1/responses`, {
    headers: { authorization: "Bearer subscription" },
    perMessageDeflate: false,
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const request = Buffer.from(JSON.stringify({
    type: "response.create",
    model: "gpt-future-ws",
    input: "fixture",
    stream: true,
  }));
  const messages = [];
  const done = new Promise((resolve, reject) => {
    socket.on("message", (data) => {
      messages.push(Buffer.from(data));
      if (JSON.parse(data.toString()).type === "response.completed") resolve();
    });
    socket.once("error", reject);
  });
  socket.send(request);
  await done;
  assert.equal(upstreamSockets[0].url, "wss://chatgpt.com/backend-api/codex/responses");
  assert.equal(upstreamSockets[0].options.headers.authorization, "Bearer subscription");
  assert.equal(Buffer.compare(received[0].data, request), 0);
  assert.deepEqual(messages.map((message) => JSON.parse(message).sequence_number), [91, 92]);
  socket.close();
});

test("A6 cancelling an official WebSocket turn terminates and releases the upstream", async () => {
  let terminated = 0;
  class HangingUpstream extends EventEmitter {
    constructor() {
      super();
      this.readyState = 0;
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open");
      });
    }
    send(_data, _options, callback) { callback(); }
    terminate() {
      terminated++;
      this.readyState = 3;
      this.emit("close");
    }
    close() { this.terminate(); }
  }
  const session = new OfficialWebSocketSession(
    { authorization: "Bearer subscription" },
    { createSocket: () => new HangingUpstream() },
  );
  const controller = new AbortController();
  const turn = session.run(Buffer.from('{"type":"response.create"}'), false, {
    signal: controller.signal,
    forward: async () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(turn, (error) => error.type === "cancelled");
  assert.equal(terminated, 1);
  assert.equal(session.active, null);
});

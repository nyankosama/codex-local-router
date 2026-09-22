import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { createGateway } from "../src/server.mjs";
import { Engine } from "../src/engine.mjs";
import {
  OFFICIAL_CODEX_ORIGIN,
  officialObservationFailureLog,
  officialRelayUrl,
  observedOfficialResponse,
  relayOfficialHttp,
  relayRequestHeaders,
  validateOfficialRelayPath,
} from "../src/official-relay.mjs";
import {
  createOfficialWebSocketAgent,
  OfficialWebSocketSession,
  officialWebSocketCaCertificates,
  officialWebSocketProxyForUrl,
} from "../src/official-websocket.mjs";
import { expandCheckpoints } from "../src/history.mjs";
import { request, requestRaw } from "../src/transport.mjs";

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
  assert.throws(() => validateOfficialRelayPath("/subscription/v1/models", "TRACE"));
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
  assert.deepEqual(
    relayRequestHeaders(
      {
        authorization: "Bearer subscription",
        "chatgpt-account-id": "acct",
        "content-encoding": "zstd",
        "content-length": "223986",
        "content-type": "application/json",
        "x-end-to-end": "keep",
      },
      { websocket: true },
    ),
    {
      authorization: "Bearer subscription",
      "chatgpt-account-id": "acct",
      "x-end-to-end": "keep",
    },
  );
});

test("A6 official relay waits for downstream drain before forwarding the next chunk", async () => {
  const response = new EventEmitter();
  const chunks = [];
  let writes = 0;
  response.writeHead = () => {};
  response.write = (chunk) => {
    chunks.push(Buffer.from(chunk));
    writes++;
    if (writes === 1) setImmediate(() => response.emit("drain"));
    return writes !== 1;
  };
  response.end = () => {};
  const req = { url: "/subscription/v1/future/events", method: "POST", headers: {} };
  async function* body() {
    yield Buffer.from("first");
    yield Buffer.from("second");
  }
  const result = await relayOfficialHttp({
    req,
    res: response,
    wire: Buffer.from("request"),
    config: { timeoutMs: 1000 },
    send: async () => ({
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      rawHeaders: [["content-type", "text/event-stream"]],
      body: body(),
    }),
  });
  assert.equal(result.status, 200);
  assert.deepEqual(Buffer.concat(chunks).toString(), "firstsecond");
  assert.equal(writes, 2);
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
  const observed = await gateway.engine.officialRelayContext(
    { authorization: "Bearer subscription" },
    { previous_response_id: "resp_official_1", input: [] },
  );
  assert.equal(observed.previous.continuationProvenance, "official-relay");
  assert.equal(
    (await gateway.engine.officialRequestNeedsEngine(
      { authorization: "Bearer subscription" },
      {
        model: "gpt-unlisted-future",
        previous_response_id: "resp_official_1",
        input: [{ role: "user", content: "native continuation" }],
      },
    )).needsEngine,
    false,
  );
});

test("A8 Engine-managed and legacy official response IDs stay on Engine replay", async () => {
  const gateway = createGateway(config(), {
    resolveIdentity: async () => "chatgpt:fixture",
  });
  const headers = {
    authorization: "Bearer subscription",
    "thread-id": "thread-engine-history",
  };
  const prepared = await gateway.engine.officialRelayContext(headers, {
    model: "gpt-5.6-sol",
    input: [{ role: "user", content: "fixture" }],
  });
  gateway.engine.state.save(
    prepared.ctx,
    {
      id: "resp_engine_official",
      status: "completed",
      output: [{
        type: "function_call",
        call_id: "call_engine_official",
        name: "read_fixture",
        arguments: "{}",
      }],
    },
    prepared.body.input,
    gateway.engine.officialTarget("gpt-5.6-sol"),
  );
  assert.equal(
    gateway.engine.state.get(
      `response:${prepared.ctx.owner}:resp_engine_official`,
    ).continuationProvenance,
    "gateway-replay",
  );
  assert.equal(
    (await gateway.engine.officialRequestNeedsEngine(headers, {
      model: "gpt-5.6-sol",
      previous_response_id: "resp_engine_official",
      input: [{
        type: "function_call_output",
        call_id: "call_engine_official",
        output: "fixture result",
      }],
    })).needsEngine,
    true,
  );

  gateway.engine.state.set(
    `response:${prepared.ctx.owner}:resp_legacy_official`,
    {
      input: prepared.body.input,
      original: prepared.body.input,
      target: gateway.engine.officialTarget("gpt-5.6-sol"),
      provider: "chatgpt-subscription",
    },
    prepared.ctx,
  );
  assert.equal(
    (await gateway.engine.officialRequestNeedsEngine(headers, {
      model: "gpt-5.6-sol",
      previous_response_id: "resp_legacy_official",
      input: [{ role: "user", content: "legacy continuation" }],
    })).needsEngine,
    true,
  );
  await gateway.close();
});

test("A8 native official compaction stays transparent and records a portable checkpoint", async () => {
  const gateway = createGateway(config(), {
    resolveIdentity: async () => "chatgpt:fixture",
  });
  const headers = {
    authorization: "Bearer subscription",
    "thread-id": "thread-native-compaction",
  };
  const request = {
    model: "gpt-5.6-sol",
    input: [
      { role: "user", content: "portable fixture" },
      { type: "compaction_trigger" },
    ],
  };
  assert.equal(
    (await gateway.engine.officialRequestNeedsEngine(headers, request)).needsEngine,
    false,
  );

  const item = {
    type: "compaction",
    encrypted_content: "official-native-fixture",
  };
  assert.equal(
    (await gateway.engine.officialRequestNeedsEngine(headers, {
      model: request.model,
      input: [item, { role: "user", content: "continue" }],
    })).needsEngine,
    false,
  );
  assert.equal(
    (await gateway.engine.officialRequestNeedsEngine(headers, {
      model: request.model,
      input: [{
        type: "compaction",
        encrypted_content: "gateway-checkpoint-v1:fixture",
      }],
    })).needsEngine,
    true,
  );
  for (const encrypted_content of [null, "", 123]) {
    assert.equal((await gateway.engine.officialRequestNeedsEngine(headers, {
      model: request.model, input: [{ type: "compaction", encrypted_content }],
    })).needsEngine, true, "malformed checkpoints still require validation");
  }

  const committed = await gateway.engine.commitOfficialObservation(headers, request, {
    id: "resp_native_compaction",
    status: "completed",
    output: [item],
  });
  assert.equal(committed.checkpoint_count, 1);
  const prepared = await gateway.engine.officialRelayContext(headers, request);
  const portable = expandCheckpoints(
    gateway.engine.state,
    prepared.ctx,
    [item],
    config().targets.vendor,
    { portable: true },
  );
  assert.match(JSON.stringify(portable.input), /portable fixture/);
  const repeated = { type: "compaction", encrypted_content: "official-recompaction-fixture" };
  await gateway.engine.commitOfficialObservation(headers, {
    ...request,
    input: [item, { role: "user", content: "second fixture" }, { type: "compaction_trigger" }],
  }, { id: "resp_recompaction", status: "completed", output: [repeated] });
  const expanded = expandCheckpoints(gateway.engine.state, prepared.ctx, [repeated],
    config().targets.vendor, { portable: true }).input;
  assert.deepEqual(expanded, [
    { role: "user", content: "portable fixture" },
    { role: "user", content: "second fixture" },
  ]);
  gateway.engine.state.set(`last-target:${prepared.ctx.owner}`, config().targets.vendor, prepared.ctx);
  assert.equal((await gateway.engine.officialRequestNeedsEngine(headers, {
    model: request.model, input: [item, { role: "user", content: "switch back" }],
  })).needsEngine, true, "native compaction must not bypass cross-provider migration");
  await gateway.close();
});

test("A8 compaction emitted by an ordinary official turn replaces the active window", async () => {
  const gateway = createGateway(config(), {
    resolveIdentity: async () => "chatgpt:fixture",
  });
  const headers = {
    authorization: "Bearer subscription",
    "thread-id": "thread-inline-compaction",
  };
  await gateway.engine.commitOfficialObservation(
    headers,
    { model: "gpt-5.6-sol", input: [{ role: "user", content: "old" }] },
    {
      id: "resp_before_inline_compaction",
      status: "completed",
      output: [{ role: "assistant", content: "old answer" }],
    },
  );
  const item = {
    type: "compaction",
    encrypted_content: "official-inline-compaction-fixture",
  };
  await gateway.engine.commitOfficialObservation(
    headers,
    {
      model: "gpt-5.6-sol",
      previous_response_id: "resp_before_inline_compaction",
      input: [{ role: "user", content: "latest" }],
    },
    {
      id: "resp_inline_compaction",
      status: "completed",
      output: [{ role: "user", content: "latest" }, item],
    },
  );
  const prepared = await gateway.engine.officialRelayContext(headers, {
    previous_response_id: "resp_inline_compaction",
    input: [],
  });
  assert.deepEqual(prepared.previous.input, [
    { role: "user", content: "latest" },
    item,
  ]);
  const portable = expandCheckpoints(
    gateway.engine.state,
    prepared.ctx,
    prepared.previous.input,
    config().targets.vendor,
    { portable: true },
  ).input;
  assert.match(JSON.stringify(portable), /old/);
  assert.match(JSON.stringify(portable), /old answer/);
  assert.match(JSON.stringify(portable), /latest/);
  await gateway.engine.requireObservedHistory(headers, { input: [item] });
  await gateway.close();
});

test("official HTTP relay and Engine HTTP/WS replay survive active streams beyond their deadline", async (t) => {
  for (const mode of ["relay-http", "engine-http", "engine-ws"]) {
    await t.test(mode, async (t) => {
      let sends = 0;
      const upstreamServer = http.createServer((_req, res) => {
        sends++;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"type":"response.created","response":{"id":"resp_long","output":[]}}\n\n');
        let count = 0;
        const timer = setInterval(() => {
          res.write(": heartbeat\n\n");
          if (++count === 20) res.end('data: {"type":"response.completed","response":{"id":"resp_long","status":"completed","output":[]}}\n\n');
        }, 100);
        res.on("close", () => clearInterval(timer));
      });
      const upstreamPort = await listen(upstreamServer);
      t.after(() => { upstreamServer.closeAllConnections(); upstreamServer.close(); });
      const cfg = config();
      cfg.timeoutMs = 1000;
      const gateway = createGateway(cfg, {
        resolveIdentity: async () => "chatgpt:fixture",
        officialRequest: async (_url, options) => {
          assert.equal(mode, "relay-http");
          assert.equal(JSON.parse(options.body).input[0].encrypted_content, "native-fixture");
          return requestRaw(`http://127.0.0.1:${upstreamPort}`, options);
        },
        send: async (_url, options) => {
          assert.notEqual(mode, "relay-http");
          assert.equal(options.body.previous_response_id, undefined);
          return request(`http://127.0.0.1:${upstreamPort}`, options);
        },
      });
      const port = await listen(gateway.server);
      t.after(() => gateway.close());
      const headers = { authorization: "Bearer subscription", "thread-id": mode };
      const body = { model: "gpt-official", stream: true,
        input: [{ type: "compaction", encrypted_content: "native-fixture" }, { role: "user", content: "continue" }] };
      if (mode !== "relay-http") {
        const prepared = await gateway.engine.officialRelayContext(headers, body);
        gateway.engine.state.save(prepared.ctx, { id: "resp_engine", output: [] }, [], gateway.engine.officialTarget(body.model));
        body.previous_response_id = "resp_engine";
      }
      const started = Date.now();
      if (mode === "engine-ws") {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/subscription/v1/responses`, { headers });
        t.after(() => ws.terminate());
        await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
        const completed = new Promise((resolve, reject) => {
          ws.on("message", (data) => {
            const event = JSON.parse(data);
            if (event.type === "error") reject(Error(event.error?.type));
            if (event.type === "response.completed") resolve(event);
          });
          ws.once("close", () => reject(Error("closed before completion")));
          ws.once("error", reject);
        });
        ws.send(JSON.stringify({ type: "response.create", ...body }));
        assert.equal((await completed).response.id, "resp_long");
      } else {
        const response = await fetch(`http://127.0.0.1:${port}/subscription/v1/responses`, {
          method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body),
        });
        assert.equal(response.status, 200);
        assert.match(await response.text(), /response.completed/);
      }
      assert.equal(sends, 1);
      assert.ok(Date.now() - started > cfg.timeoutMs);
    });
  }
});

test("A6/A8 WebSocket continuations after Engine-managed official responses replay every turn", async (t) => {
  const upstreamSockets = [];
  const providerCalls = [];
  const gateway = createGateway(config(), {
    resolveIdentity: async () => "chatgpt:fixture",
    createOfficialWebSocket: (...args) => {
      upstreamSockets.push(args);
      throw Error("opaque official relay must not open");
    },
    send: async (_url, request) => {
      providerCalls.push(request.body);
      const first = providerCalls.length === 1;
      return upstream(
        200,
        { "content-type": "application/json" },
        Buffer.from(JSON.stringify({
          id: first ? "resp_engine_continued_1" : "resp_engine_continued_2",
          status: "completed",
          output: first
            ? [{
                type: "custom_tool_call",
                call_id: "call_engine_ws_2",
                name: "custom_fixture",
                input: "fixture",
              }]
            : [{
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "continued" }],
              }],
        })),
      );
    },
  });
  const port = await listen(gateway.server);
  t.after(() => gateway.close());
  const headers = {
    authorization: "Bearer subscription",
    "thread-id": "thread-engine-ws",
  };
  const prepared = await gateway.engine.officialRelayContext(headers, {
    model: "gpt-5.6-sol",
    input: [{ role: "user", content: "call a tool" }],
  });
  gateway.engine.state.save(
    prepared.ctx,
    {
      id: "resp_engine_ws",
      status: "completed",
      output: [{
        type: "function_call",
        call_id: "call_engine_ws",
        name: "read_fixture",
        arguments: "{}",
      }],
    },
    prepared.body.input,
    gateway.engine.officialTarget("gpt-5.6-sol"),
  );

  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/subscription/v1/responses`,
    { headers, perMessageDeflate: false },
  );
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const messages = [];
  const nextCompleted = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(Error("timed out waiting for response.completed"));
    }, 2000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onMessage = (data) => {
      const event = JSON.parse(data.toString());
      messages.push(event);
      if (event.type === "error") {
        cleanup();
        reject(Error(event.error?.type ?? "gateway WebSocket error"));
      } else if (event.type === "response.completed") {
        cleanup();
        resolve(event);
      }
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
  const firstDone = nextCompleted();
  socket.send(JSON.stringify({
    type: "response.create",
    model: "gpt-5.6-sol",
    previous_response_id: "resp_engine_ws",
    input: [{
      type: "function_call_output",
      call_id: "call_engine_ws",
      output: "fixture result",
    }],
  }));
  const first = await firstDone;
  assert.equal(first.response.id, "resp_engine_continued_1");

  const secondDone = nextCompleted();
  socket.send(JSON.stringify({
    type: "response.create",
    model: "gpt-5.6-sol",
    previous_response_id: "resp_engine_continued_1",
    input: [{
      type: "custom_tool_call_output",
      call_id: "call_engine_ws_2",
      output: "custom fixture result",
    }],
  }));
  const second = await secondDone;
  assert.equal(upstreamSockets.length, 0);
  assert.equal(providerCalls.length, 2);
  assert.equal(providerCalls[0].previous_response_id, undefined);
  assert.equal(providerCalls[1].previous_response_id, undefined);
  assert.equal(providerCalls[0].store, false);
  assert.equal(providerCalls[1].store, false);
  assert.deepEqual(
    providerCalls[0].input.map((item) => item.type ?? item.role),
    ["user", "function_call", "function_call_output"],
  );
  assert.deepEqual(
    providerCalls[1].input.map((item) => item.type ?? item.role),
    [
      "user",
      "function_call",
      "function_call_output",
      "custom_tool_call",
      "custom_tool_call_output",
    ],
  );
  assert.equal(second.response.id, "resp_engine_continued_2");
  assert.equal(messages.filter((event) => event.type === "response.completed").length, 2);
  socket.close();
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

test("A8 HTTP observation rebuilds ordered output from compressed done-item events", async () => {
  const items = [
    { type: "message", id: "item_first", role: "assistant", content: [] },
    { type: "compaction", id: "item_second", encrypted_content: "opaque-http" },
  ];
  const events = [
    { type: "response.output_item.done", output_index: 1, item: items[1] },
    { type: "response.output_item.added", output_index: 0, item: { ...items[0], content: [] } },
    { type: "response.output_item.done", output_index: 0, item: items[0] },
    { type: "response.completed", response: { id: "resp_done_items", status: "completed" } },
  ];
  const wire = Buffer.from(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
  const diagnostics = {};
  const response = await observedOfficialResponse({
    complete: true,
    headers: new Headers({
      "content-type": "text/event-stream",
      "content-encoding": "gzip",
    }),
    body: zlib.gzipSync(wire),
  }, undefined, diagnostics);
  assert.deepEqual(response.output, items);
  assert.equal(diagnostics.output_source, "done-items");

  for (const invalid of [
    [
      { type: "response.output_item.added", output_index: 0, item: items[0] },
      events.at(-1),
    ],
    [
      { type: "response.output_item.done", output_index: 0, item: items[0] },
      { type: "response.output_item.done", output_index: 0, item: items[1] },
      events.at(-1),
    ],
  ]) {
    const body = Buffer.from(invalid.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
    await assert.rejects(
      observedOfficialResponse({
        complete: true,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body,
      }),
      (error) => error.type === "history_observation_incomplete",
    );
  }
});

test("A8 HTTP observation failure stays transparent and logs bounded diagnostics", async (t) => {
  const logs = [];
  const item = { type: "compaction", encrypted_content: "opaque-unfinished" };
  const wire = Buffer.from([
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_unfinished", status: "completed" } },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
  const gateway = createGateway(config(), {
    resolveIdentity: async () => "chatgpt:fixture",
    officialRequest: async () =>
      upstream(200, { "content-type": "text/event-stream" }, wire),
    log: (event) => logs.push(event),
  });
  const port = await listen(gateway.server);
  t.after(() => gateway.close());
  const response = await fetch(`http://127.0.0.1:${port}/subscription/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer subscription", "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-future", input: "fixture", stream: true }),
  });
  assert.equal(response.status, 200);
  assert.equal(Buffer.compare(Buffer.from(await response.arrayBuffer()), wire), 0);
  await new Promise((resolve) => setImmediate(resolve));
  const started = logs.find((event) => event.event === "official_relay_started");
  const failed = logs.find((event) => event.event === "official_history_observation_failed");
  assert.deepEqual({
    request_id: failed.request_id,
    transport: failed.transport,
    encoding: failed.encoding,
    response_bytes: failed.response_bytes,
    terminal_type: failed.terminal_type,
    item_count: failed.item_count,
    observation_stage: failed.observation_stage,
  }, {
    request_id: started.request_id,
    transport: "http",
    encoding: "identity",
    response_bytes: wire.byteLength,
    terminal_type: "response.completed",
    item_count: 1,
    observation_stage: "unfinished_output_item",
  });
});

test("A8 unsupported official content types log only a normalized media type", async () => {
  await assert.rejects(
    observedOfficialResponse({
      complete: true,
      headers: new Headers({ "content-type": "Application/Octet-Stream; private=value" }),
      body: Buffer.from("opaque"),
    }),
    (error) => {
      assert.equal(error.observation.stage, "unsupported_content_type");
      assert.equal(error.observation.content_type, "application/octet-stream");
      const event = officialObservationFailureLog(error, "http");
      assert.equal(event.content_type, "application/octet-stream");
      assert.equal(JSON.stringify(event).includes("private=value"), false);
      return true;
    },
  );
});

test("A8 missing official content type is inferred only for JSON and SSE", async () => {
  const item = { type: "compaction", encrypted_content: "opaque-sniffed" };
  const events = [
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_sniffed", status: "completed" } },
  ];
  const sseDiagnostics = {};
  const sse = await observedOfficialResponse({
    complete: true,
    headers: new Headers(),
    body: Buffer.from(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")),
  }, undefined, sseDiagnostics);
  assert.deepEqual(sse.output, [item]);
  assert.equal(sseDiagnostics.content_type, "text/event-stream");
  assert.equal(sseDiagnostics.content_type_source, "sniffed");

  const jsonDiagnostics = {};
  const json = await observedOfficialResponse({
    complete: true,
    headers: new Headers(),
    body: Buffer.from(JSON.stringify({ id: "resp_json", status: "completed", output: [] })),
  }, undefined, jsonDiagnostics);
  assert.equal(json.id, "resp_json");
  assert.equal(jsonDiagnostics.content_type, "application/json");
  assert.equal(jsonDiagnostics.content_type_source, "sniffed");

  await assert.rejects(
    observedOfficialResponse({
      complete: true,
      headers: new Headers(),
      body: Buffer.from("opaque"),
    }),
    (error) => error.observation.stage === "unsupported_content_type" &&
      error.observation.content_type === "missing",
  );
});

test("A8 WebSocket observation uses the same done-item result", async () => {
  class FixtureSocket extends EventEmitter {
    constructor() {
      super();
      this.readyState = 0;
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open");
      });
    }
    send(_data, _options, callback) { callback(); }
    close() { this.readyState = 3; this.emit("close"); }
    terminate() { this.close(); }
  }
  let socket, observed;
  const item = { type: "compaction", encrypted_content: "opaque-ws" };
  const session = new OfficialWebSocketSession(
    { authorization: "Bearer subscription" },
    { createSocket: () => (socket = new FixtureSocket()) },
  );
  const turn = session.run(Buffer.from('{"type":"response.create"}'), false, {
    forward: async () => {},
    observe: (event) => { observed = event; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  socket.emit("message", Buffer.from(JSON.stringify({
    type: "response.output_item.done", output_index: 0, item,
  })), false);
  socket.emit("message", Buffer.from(JSON.stringify({
    type: "response.completed",
    response: { id: "resp_ws_done_item", status: "completed" },
  })), false);
  await turn;
  assert.deepEqual(observed.response.output, [item]);
  session.close();

  const logs = [], forwarded = [];
  const broken = new OfficialWebSocketSession(
    { authorization: "Bearer subscription" },
    { createSocket: () => (socket = new FixtureSocket()), log: (event) => logs.push(event) },
  );
  const brokenTurn = broken.run(Buffer.from('{"type":"response.create"}'), false, {
    forward: async (data) => forwarded.push(Buffer.from(data)),
    observe: (event) => {
      if (event.observationError) throw event.observationError;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  for (const event of [
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item: { ...item, encrypted_content: "conflict" } },
    { type: "response.completed", response: { id: "resp_ws_conflict", status: "completed" } },
  ])
    socket.emit("message", Buffer.from(JSON.stringify(event)), false);
  await brokenTurn;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(forwarded.length, 3);
  assert.equal(logs.at(-1).observation_stage, "conflicting_output_item");
  broken.close();
});

test("A8 incomplete official responses cannot install compaction checkpoints", async () => {
  const gateway = createGateway(config(), {
    resolveIdentity: async () => "chatgpt:fixture",
  });
  const headers = {
    authorization: "Bearer subscription",
    "thread-id": "thread-incomplete-compaction",
  };
  const item = { type: "compaction", encrypted_content: "opaque-incomplete" };
  const request = {
    model: "gpt-5.6-sol",
    input: [{ role: "user", content: "fixture" }, { type: "compaction_trigger" }],
  };
  await assert.rejects(
    gateway.engine.commitOfficialObservation(headers, request, {
      id: "resp_incomplete_compaction",
      status: "incomplete",
      output: [item],
    }),
    (error) => error.type === "history_observation_incomplete",
  );
  await assert.rejects(
    gateway.engine.requireObservedHistory(headers, { input: [item] }),
    (error) =>
      error.type === "history_observation_incomplete" &&
      /checkpoint is unavailable/.test(error.message),
  );
  await gateway.close();
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

test("A8 WebSocket model switches enter Engine when the App omits previous_response_id", async () => {
  const gateway = createGateway(config(), {
    resolveIdentity: async () => "chatgpt:fixture",
  });
  const headers = {
    authorization: "Bearer subscription",
    "thread-id": "thread-fixture",
    "turn-id": "turn-fixture",
  };
  const first = await gateway.engine.officialRelayContext(headers, {
    model: "gpt-5.6-sol",
    input: [{ role: "user", content: "first" }],
  });
  gateway.engine.state.set(
    `last-target:${first.ctx.owner}`,
    { provider: "opencode-go", model: "deepseek-v4.1-flash" },
    first.ctx,
  );
  const classification = await gateway.engine.officialRequestNeedsEngine(headers, {
    model: "gpt-5.6-sol",
    input: [{ type: "custom_tool_call_output", call_id: "call_fixture", output: "ok" }],
  });
  assert.equal(classification.needsEngine, true);
  await gateway.close();
});

test("A8 projected third-party history stays portable on repeated official turns and forks", async (t) => {
  const providerCalls = [];
  const gateway = createGateway(config(), {
    resolveIdentity: async () => "chatgpt:fixture",
    officialRequest: async () => assert.fail("projected history entered opaque relay"),
    send: async (_url, request) => {
      providerCalls.push(request.body);
      return upstream(200, { "content-type": "application/json" }, Buffer.from(JSON.stringify({
        id: `resp_portable_${providerCalls.length}`,
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "portable" }],
        }],
      })));
    },
  });
  const port = await listen(gateway.server);
  t.after(() => gateway.close());
  const headers = {
    authorization: "Bearer subscription",
    "content-type": "application/json",
    "thread-id": "thread-projected-history",
  };
  const projected = {
    type: "reasoning",
    id: "item_gateway_projected_reasoning",
    summary: [{ type: "summary_text", text: "portable reasoning summary" }],
    encrypted_content: null,
  };
  const prepared = await gateway.engine.officialRelayContext(headers, {
    model: "gpt-unlisted-future",
    input: [projected],
  });
  gateway.engine.state.set(
    `last-target:${prepared.ctx.owner}`,
    gateway.engine.officialTarget("gpt-unlisted-future"),
    prepared.ctx,
  );
  for (const [thread, prompt] of [
    ["thread-projected-history", "second official turn"],
    ["thread-projected-history", "third official turn"],
    ["fork-projected-history", "forked official turn"],
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}/subscription/v1/responses`, {
      method: "POST",
      headers: { ...headers, "thread-id": thread },
      body: JSON.stringify({
        model: "gpt-unlisted-future",
        input: [projected, { role: "user", content: prompt }],
        stream: false,
      }),
    });
    assert.equal(response.status, 200);
  }
  assert.equal(providerCalls.length, 3);
  for (const call of providerCalls) {
    assert.doesNotMatch(JSON.stringify(call.input), /item_gateway_/);
    assert.equal(call.input.some((item) => item.type === "reasoning"), false);
  }
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

test("A8 official observations commit in account order across changing thread metadata", async () => {
  const engine = new Engine(config());
  const firstContext = { ctx: { auth: "account", owner: "owner-1", branch: "branch-1" } };
  const secondContext = { ctx: { auth: "account", owner: "owner-2", branch: "branch-2" } };
  const order = [];
  let release;
  const first = engine.queueOfficialObservation(firstContext, async () => {
    order.push("first-start");
    await new Promise((resolve) => { release = resolve; });
    order.push("first-end");
  });
  const second = engine.queueOfficialObservation(secondContext, async () => {
    order.push("second");
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first-start"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second"]);
  assert.equal(engine.officialObservations.size, 0);
});

test("A6 official WebSocket proxy resolution honors native variables, compatible fallbacks and bypass", () => {
  const nativeCalls = [];
  assert.equal(
    officialWebSocketProxyForUrl(
      "wss://chatgpt.com/backend-api/codex/responses",
      (url) => {
        nativeCalls.push(url);
        return url.startsWith("wss:") ? "socks5://127.0.0.1:7897" : "";
      },
      { WSS_PROXY: "socks5://127.0.0.1:7897", ALL_PROXY: "http://127.0.0.1:7898" },
    ),
    "socks5://127.0.0.1:7897",
  );
  assert.equal(nativeCalls.length, 1);

  const fallbackCalls = [];
  assert.equal(
    officialWebSocketProxyForUrl(
      "wss://chatgpt.com/backend-api/codex/responses",
      (url) => {
        fallbackCalls.push(url);
        return url.startsWith("https:") ? "http://127.0.0.1:7897" : "";
      },
      { HTTPS_PROXY: "http://127.0.0.1:7897", ALL_PROXY: "http://127.0.0.1:7898" },
    ),
    "http://127.0.0.1:7897",
  );
  assert.deepEqual(fallbackCalls, ["https://chatgpt.com/backend-api/codex/responses"]);

  assert.equal(
    officialWebSocketProxyForUrl(
      "wss://chatgpt.com/backend-api/codex/responses",
      () => "",
      { HTTPS_PROXY: "http://127.0.0.1:7897", NO_PROXY: "chatgpt.com" },
    ),
    "",
  );
});

test("A6 ProxyAgent callback adapts its request argument without changing proxy resolution", async (t) => {
  const agent = createOfficialWebSocketAgent({
    env: { HTTPS_PROXY: "http://127.0.0.1:7897", ALL_PROXY: "socks5://127.0.0.1:7898" },
    resolveProxy: (url) => url.startsWith("https:") ? "http://127.0.0.1:7897" : "",
  });
  t.after(() => agent.destroy());
  assert.equal(
    await agent.getProxyForUrl(
      "wss://chatgpt.com/backend-api/codex/responses",
      { requestArgument: true },
    ),
    "http://127.0.0.1:7897",
  );
});

test("A6 official WebSocket trust preserves default CAs and adds system CAs once", () => {
  const calls = [];
  assert.deepEqual(
    officialWebSocketCaCertificates({
      rootCertificates: ["fallback-only"],
      getCACertificates: (type) => {
        calls.push(type);
        return type === "default"
          ? ["bundled-a", "shared", "extra-a"]
          : ["system-a", "shared"];
      },
    }),
    ["bundled-a", "shared", "extra-a", "system-a"],
  );
  assert.deepEqual(calls, ["default", "system"]);
  assert.deepEqual(
    officialWebSocketCaCertificates({ rootCertificates: ["legacy-a", "legacy-a"] }),
    null,
  );
});

test("A6 official WebSocket passes local trust without disabling verification", async (t) => {
  let socketOptions;
  class OpenSocket extends EventEmitter {
    constructor() {
      super();
      this.readyState = 0;
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open");
      });
    }
    close() { this.readyState = 3; }
  }
  const agent = { destroy() {} };
  const session = new OfficialWebSocketSession(
    { authorization: "Bearer subscription" },
    {
      agent,
      caCertificates: ["fixture-default", "fixture-system"],
      createSocket: (_url, options) => {
        socketOptions = options;
        return new OpenSocket();
      },
    },
  );
  t.after(() => session.close());
  await session.connect();
  assert.deepEqual(socketOptions.ca, ["fixture-default", "fixture-system"]);
  assert.equal(socketOptions.rejectUnauthorized, true);
});

test("A6 official WebSocket connection failures stay redacted and attributable", async () => {
  const logs = [];
  class FailingSocket extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => {
        const error = Error("connect ETIMEDOUT via private proxy detail");
        error.code = "ETIMEDOUT";
        this.emit("error", error);
      });
    }
    terminate() {}
  }
  const session = new OfficialWebSocketSession(
    { authorization: "Bearer subscription" },
    {
      agent: {},
      createSocket: () => new FailingSocket(),
      log: (event) => logs.push(event),
    },
  );
  await assert.rejects(session.connect(), (error) =>
    error.type === "upstream_connection_error" &&
    error.transportCategory === "timeout" &&
    !error.message.includes("private proxy"),
  );
  assert.deepEqual(logs, [{
    event: "official_ws_connect_failed",
    transport: "websocket",
    transport_category: "timeout",
  }]);
});

test("A6 official WebSocket exposes only allowlisted TLS error codes", async () => {
  const logs = [];
  class FailingSocket extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => {
        const error = Error("private certificate and proxy detail");
        error.code = "UNABLE_TO_VERIFY_LEAF_SIGNATURE";
        this.emit("error", error);
      });
    }
    terminate() {}
  }
  const session = new OfficialWebSocketSession(
    { authorization: "Bearer subscription" },
    {
      agent: {},
      caCertificates: [],
      createSocket: () => new FailingSocket(),
      log: (event) => logs.push(event),
    },
  );
  await assert.rejects(session.connect(), (error) =>
    error.type === "upstream_connection_error" &&
    error.transportCategory === "tls" &&
    error.transportCode === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" &&
    !error.message.includes("private certificate"),
  );
  assert.deepEqual(logs, [{
    event: "official_ws_connect_failed",
    transport: "websocket",
    transport_code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    transport_category: "tls",
  }]);
});

test("A6 official WebSocket replays a stale continuation once from observed history", async (t) => {
  const upstreamSockets = [];
  const received = [];
  const logs = [];
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
      const requestBody = JSON.parse(Buffer.from(data).toString());
      if (received.length === 2 || requestBody.previous_response_id === "resp_missing") {
        const error = Buffer.from(JSON.stringify({
          type: "error",
          status: 400,
          error: {
            type: "invalid_request_error",
            message: "Invalid `previous_response_id`.",
          },
        }));
        queueMicrotask(() => this.emit("message", error, false));
        return;
      }
      const responseId = `resp_ws_${received.length}`;
      const first = Buffer.from(JSON.stringify({
        type: "response.created",
        sequence_number: 91,
        response: { id: responseId, status: "in_progress", output: [] },
      }));
      const terminal = Buffer.from(JSON.stringify({
        type: "response.completed",
        sequence_number: 92,
        response: {
          id: responseId,
          status: "completed",
          output: received.length === 1
            ? [{ type: "message", role: "assistant", content: [] }]
            : [],
        },
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
    log: (event) => logs.push(event),
    createOfficialWebSocket: (url, options) => {
      const socket = new FakeUpstream(url, options);
      upstreamSockets.push(socket);
      return socket;
    },
  });
  const port = await listen(gateway.server);
  t.after(() => gateway.close());
  const headers = {
    authorization: "Bearer subscription",
    "session-id": "session-official-relay",
  };
  const socket = new WebSocket(`ws://127.0.0.1:${port}/subscription/v1/responses`, {
    headers,
    perMessageDeflate: false,
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const request = Buffer.from(JSON.stringify({
    type: "response.create",
    model: "gpt-future-ws",
    generate: false,
    input: "fixture",
    access_programs: { cyber: "current_turn" },
    stream: true,
  }));
  const messages = [];
  socket.on("message", (data) => messages.push(Buffer.from(data)));
  const nextEvent = (type) => new Promise((resolve, reject) => {
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onMessage = (data) => {
      const event = JSON.parse(data.toString());
      if (event.type !== type) return;
      cleanup();
      resolve(event);
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
  const done = nextEvent("response.completed");
  socket.send(request);
  await done;
  await gateway.engine.requireObservedHistory(
    headers,
    { previous_response_id: "resp_ws_1", input: [] },
  );
  const context = await gateway.engine.officialRelayContext(
    headers,
    { previous_response_id: "resp_ws_1", input: [] },
  );
  assert.equal(context.previous.continuationProvenance, "official-relay");
  const continuation = Buffer.from(JSON.stringify({
    type: "response.create",
    model: "gpt-future-ws",
    previous_response_id: "resp_ws_1",
    input: [{ role: "user", content: "continue" }],
    stream: true,
  }));
  const continued = nextEvent("response.completed");
  socket.send(continuation);
  await continued;
  assert.equal(upstreamSockets[0].url, "wss://chatgpt.com/backend-api/codex/responses");
  assert.ok(upstreamSockets[0].options.agent);
  assert.equal(upstreamSockets[0].options.headers.authorization, "Bearer subscription");
  assert.equal(Buffer.compare(received[0].data, request), 0);
  assert.equal(Buffer.compare(received[1].data, continuation), 0);
  const replay = JSON.parse(received[2].data.toString());
  assert.equal(replay.previous_response_id, undefined);
  assert.deepEqual(replay.input, [
    { role: "user", content: "fixture" },
    { type: "message", role: "assistant", content: [] },
    { role: "user", content: "continue" },
  ]);
  assert.deepEqual(
    messages.map((message) => JSON.parse(message).sequence_number),
    [91, 92, 91, 92],
  );
  assert.equal(
    logs.filter((event) => event.event === "official_previous_response_replayed").length,
    1,
  );
  const missingError = nextEvent("error");
  socket.send(JSON.stringify({
    type: "response.create",
    model: "gpt-future-ws",
    previous_response_id: "resp_missing",
    input: [{ role: "user", content: "unknown history" }],
    stream: true,
  }));
  assert.equal((await missingError).error.message, "Invalid `previous_response_id`.");
  assert.equal(received.length, 4);
  socket.close();
});

test("A6 official WebSocket queues upstream messages while downstream forward is backpressured", async () => {
  class FixtureSocket extends EventEmitter {
    constructor() {
      super();
      this.readyState = 0;
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open");
      });
    }
    send(_data, _options, callback) { callback(); }
    close() { this.readyState = 3; this.emit("close"); }
    terminate() { this.close(); }
  }
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const forwarded = [];
  let socket;
  const session = new OfficialWebSocketSession(
    { authorization: "Bearer subscription" },
    { createSocket: () => (socket = new FixtureSocket()) },
  );
  const turn = session.run(Buffer.from('{"type":"response.create"}'), false, {
    forward: async (data) => {
      const event = JSON.parse(Buffer.from(data).toString("utf8"));
      forwarded.push(event.type);
      if (event.type === "response.created") await gate;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  socket.emit("message", Buffer.from(JSON.stringify({ type: "response.created", sequence_number: 1 })), false);
  socket.emit("message", Buffer.from(JSON.stringify({
    type: "response.completed", sequence_number: 2,
    response: { id: "resp_backpressure", status: "completed", output: [] },
  })), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(forwarded, ["response.created"]);
  release();
  const terminal = await turn;
  assert.equal(terminal.type, "response.completed");
  assert.deepEqual(forwarded, ["response.created", "response.completed"]);
  session.close();
});

test("A6 cancelling an official WebSocket turn terminates and releases the upstream", async () => {
  let terminated = 0;
  let observation;
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
    observe: (event) => { observation = event; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(turn, (error) => error.type === "cancelled");
  assert.equal(terminated, 1);
  assert.equal(session.active, null);
  assert.equal(observation.observationError.observation.stage, "cancelled");
});

test("A8 a malformed WebSocket stream ending without a terminal fails observation", async () => {
  class BrokenUpstream extends EventEmitter {
    constructor() {
      super();
      this.readyState = 0;
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open");
      });
    }
    send(_data, _options, callback) { callback(); }
    close() { this.readyState = 3; this.emit("close"); }
    terminate() { this.close(); }
  }
  let socket, observation;
  const forwarded = [];
  const session = new OfficialWebSocketSession(
    { authorization: "Bearer subscription" },
    { createSocket: () => (socket = new BrokenUpstream()) },
  );
  const turn = session.run(Buffer.from('{"type":"response.create"}'), false, {
    forward: async (data) => forwarded.push(Buffer.from(data)),
    observe: (event) => { observation = event; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  socket.emit("message", Buffer.from("not-json"), false);
  await new Promise((resolve) => setImmediate(resolve));
  socket.close();
  await assert.rejects(turn, (error) => error.type === "upstream_connection_error");
  assert.equal(forwarded[0].toString(), "not-json");
  assert.equal(observation.observationError.observation.stage, "parse_failed");
  session.close();
});

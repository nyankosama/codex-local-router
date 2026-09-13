import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { WebSocket } from "ws";
import { validate } from "../src/config.mjs";
import { fail } from "../src/errors.mjs";
import { createGateway } from "../src/server.mjs";
import { StateStore } from "../src/state.mjs";
import { StandaloneSearchRoutes } from "../src/search-routes.mjs";

process.env.ROUTER_SEARCH_TEST_KEY = "provider-secret";

const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
  );

const upstream = (status, headers, body) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: new Headers(headers),
  rawHeaders: Object.entries(headers),
  body: Readable.from([body]),
});

const completed = (id = "resp_vendor") => Buffer.from(JSON.stringify({
  id,
  object: "response",
  status: "completed",
  output: [{
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "ok" }],
  }],
}));

const completedStream = (id = "resp_vendor_ws") => Buffer.from([
  `data: ${JSON.stringify({
    type: "response.created",
    response: { id, object: "response", status: "in_progress", output: [] },
  })}\n\n`,
  `data: ${JSON.stringify({
    type: "response.completed",
    response: JSON.parse(completed(id).toString("utf8")),
  })}\n\n`,
].join(""));

function config(source = "subscription") {
  return validate({
    schemaVersion: 3,
    mode: "rules",
    defaultTarget: "vendor",
    providers: {
      feei: {
        adapter: "openai-compatible",
        baseUrl: "https://provider.example/v1",
        apiKeyEnv: "ROUTER_SEARCH_TEST_KEY",
        standaloneSearch: { endpoint: "alpha/search" },
      },
    },
    targets: {
      vendor: {
        provider: "feei",
        model: "gpt-upstream",
        modelFamily: "openai-gpt",
        standaloneSearch: { source },
        wireApi: "responses",
        contextWindow: 100000,
        capabilities: {
          responses: true,
          toolCalling: true,
          streaming: true,
          nativeWebSearch: false,
        },
        app: { enabled: true, modelId: "vendor-gpt" },
      },
    },
    pluginTools: {
      thirdPartyGpt: {
        additionalAllowedPlugins: [],
        excludedDefaultPlugins: [],
      },
    },
    history: {
      maxBytes: 1024 * 1024,
      ttlMs: 60000,
      persistent: { enabled: false },
    },
    access: { required: false },
    maxBodyBytes: 1024 * 1024,
    maxConnections: 8,
    timeoutMs: 5000,
    subscription: { enabled: true, models: ["gpt-official"] },
  });
}

async function modelTurn(port, {
  model = "vendor-gpt",
  thread = "thread-one",
  turn = "turn-one",
} = {}) {
  return fetch(`http://127.0.0.1:${port}/subscription/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer subscription-secret",
      "chatgpt-account-id": "account",
      "content-type": "application/json",
      "thread-id": thread,
      "turn-id": turn,
    },
    body: JSON.stringify({ model, input: "fixture", stream: false }),
  });
}

function rawRequest(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.once("error", reject);
    req.end(body);
  });
}

function gatewayOptions({ officialCalls, providerSearchCalls, modelCalls, logs }) {
  return {
    resolveIdentity: async (_entry, headers) => {
      if (headers.authorization !== "Bearer subscription-secret")
        throw fail("subscription_identity_mismatch", 401);
      return "chatgpt:fixture";
    },
    send: async (url, request) => {
      modelCalls.push({ url, request });
      return upstream(200, { "content-type": "application/json" }, completed());
    },
    officialRequest: async (url, request) => {
      officialCalls.push({ url, request });
      return upstream(200, { "content-type": "application/json" }, completed("resp_official"));
    },
    providerSearchRequest: async (url, request) => {
      providerSearchCalls.push({ url, request });
      return upstream(200, { "content-type": "application/json" }, Buffer.from('{"results":[]}'));
    },
    log: (event) => logs.push(event),
  };
}

test("HTTP model selection routes subscription search only to OpenAI", async (t) => {
  const officialCalls = [], providerSearchCalls = [], modelCalls = [], logs = [];
  const gateway = createGateway(
    config("subscription"),
    gatewayOptions({ officialCalls, providerSearchCalls, modelCalls, logs }),
  );
  const port = await listen(gateway.server);
  t.after(() => gateway.close());
  assert.equal((await modelTurn(port)).status, 200);
  const search = await fetch(
    `http://127.0.0.1:${port}/subscription/v1/alpha/search?q=public`,
    {
      headers: {
        authorization: "Bearer subscription-secret",
        "chatgpt-account-id": "account",
        "thread-id": "thread-one",
        "turn-id": "turn-one",
      },
    },
  );
  assert.equal(search.status, 200);
  assert.equal(modelCalls.length, 1);
  assert.equal(providerSearchCalls.length, 0);
  assert.equal(officialCalls.length, 1);
  assert.equal(officialCalls[0].request.headers.authorization, "Bearer subscription-secret");
  assert.notEqual(officialCalls[0].request.headers.authorization, "Bearer provider-secret");
  assert.equal(officialCalls[0].url, "https://chatgpt.com/backend-api/codex/alpha/search?q=public");
  assert.equal(logs.some((event) => event.query || event.url), false);
});

test("official models always replace a prior provider route with subscription search", async (t) => {
  const prior = process.env.ROUTER_SEARCH_TEST_KEY;
  process.env.ROUTER_SEARCH_TEST_KEY = "provider-secret";
  t.after(() => {
    if (prior == null) delete process.env.ROUTER_SEARCH_TEST_KEY;
    else process.env.ROUTER_SEARCH_TEST_KEY = prior;
  });
  const officialCalls = [], providerSearchCalls = [], modelCalls = [], logs = [];
  const gateway = createGateway(
    config("provider"),
    gatewayOptions({ officialCalls, providerSearchCalls, modelCalls, logs }),
  );
  const port = await listen(gateway.server);
  t.after(() => gateway.close());
  assert.equal((await modelTurn(port)).status, 200);
  assert.equal((await modelTurn(port, {
    model: "gpt-official",
    thread: "official-thread",
    turn: "official-turn",
  })).status, 200);
  const response = await fetch(
    `http://127.0.0.1:${port}/subscription/v1/alpha/search?q=official`,
    { headers: {
      authorization: "Bearer subscription-secret",
      "chatgpt-account-id": "account",
      "thread-id": "official-thread",
      "turn-id": "official-turn",
    } },
  );
  assert.equal(response.status, 200);
  assert.equal(providerSearchCalls.length, 0);
  const search = officialCalls.find((call) => new URL(call.url).pathname.endsWith("/alpha/search"));
  assert.equal(search.request.headers.authorization, "Bearer subscription-secret");
  assert.notEqual(search.request.headers.authorization, "Bearer provider-secret");
});

test("provider search relay preserves bytes, query, status, compression and SSE", async (t) => {
  const prior = process.env.ROUTER_SEARCH_TEST_KEY;
  process.env.ROUTER_SEARCH_TEST_KEY = "provider-secret";
  t.after(() => {
    if (prior == null) delete process.env.ROUTER_SEARCH_TEST_KEY;
    else process.env.ROUTER_SEARCH_TEST_KEY = prior;
  });
  const officialCalls = [], providerSearchCalls = [], modelCalls = [], logs = [];
  const responseBodies = {
    gzip: zlib.gzipSync(Buffer.from("gzip-result")),
    zstd: zlib.zstdCompressSync
      ? zlib.zstdCompressSync(Buffer.from("zstd-result"))
      : Buffer.from("zstd-unavailable"),
    sse: Buffer.from('event: search.completed\ndata: {"status":"completed"}\n\n'),
    error: Buffer.from('{"error":"provider fixture"}'),
  };
  const options = gatewayOptions({ officialCalls, providerSearchCalls, modelCalls, logs });
  options.providerSearchRequest = async (url, request) => {
    providerSearchCalls.push({ url, request });
    const kind = new URL(url).searchParams.get("kind");
    if (kind === "gzip")
      return upstream(207, {
        "content-type": "application/octet-stream",
        "content-encoding": "gzip",
        "x-upstream": "gzip",
      }, responseBodies.gzip);
    if (kind === "zstd")
      return upstream(208, {
        "content-type": "application/octet-stream",
        "content-encoding": zlib.zstdCompressSync ? "zstd" : "identity",
        "x-upstream": "zstd",
      }, responseBodies.zstd);
    if (kind === "sse")
      return upstream(200, { "content-type": "text/event-stream" }, responseBodies.sse);
    return upstream(422, { "content-type": "application/json" }, responseBodies.error);
  };
  const gateway = createGateway(config("provider"), options);
  const port = await listen(gateway.server);
  t.after(() => gateway.close());
  assert.equal((await modelTurn(port)).status, 200);

  const requestBody = Buffer.from([0, 1, 2, 127, 128, 255]);
  const common = {
    method: "POST",
    headers: {
      authorization: "Bearer subscription-secret",
      "chatgpt-account-id": "account",
      "content-type": "application/octet-stream",
      "content-length": requestBody.length,
      "thread-id": "thread-one",
      "turn-id": "turn-one",
      "x-codex-private": "remove",
      cookie: "remove=true",
      "x-end-to-end": "keep",
    },
    body: requestBody,
  };
  for (const [kind, expectedStatus, expectedBody] of [
    ["gzip", 207, responseBodies.gzip],
    ["zstd", 208, responseBodies.zstd],
    ["sse", 200, responseBodies.sse],
    ["error", 422, responseBodies.error],
  ]) {
    const response = await rawRequest(
      `http://127.0.0.1:${port}/subscription/v1/alpha/search?kind=${kind}&q=a%20b`,
      common,
    );
    assert.equal(response.status, expectedStatus);
    assert.equal(Buffer.compare(response.body, expectedBody), 0);
  }
  assert.equal(officialCalls.length, 0);
  assert.equal(providerSearchCalls.length, 4);
  for (const call of providerSearchCalls) {
    assert.match(call.url, /^https:\/\/provider\.example\/v1\/alpha\/search\?/);
    assert.match(call.url, /q=a%20b/);
    assert.equal(Buffer.compare(call.request.body, requestBody), 0);
    assert.equal(call.request.headers.authorization, "Bearer provider-secret");
    assert.equal(call.request.headers["chatgpt-account-id"], undefined);
    assert.equal(call.request.headers["thread-id"], undefined);
    assert.equal(call.request.headers["turn-id"], undefined);
    assert.equal(call.request.headers["x-codex-private"], undefined);
    assert.equal(call.request.headers.cookie, undefined);
    assert.equal(call.request.headers["x-end-to-end"], "keep");
  }
  assert.equal(logs.some((event) => event.query || event.url), false);
});

test("disabled and unresolved routes fail without fallback or retry", async (t) => {
  const disabledCalls = { official: [], search: [], model: [], logs: [] };
  const disabled = createGateway(
    config("disabled"),
    gatewayOptions({
      officialCalls: disabledCalls.official,
      providerSearchCalls: disabledCalls.search,
      modelCalls: disabledCalls.model,
      logs: disabledCalls.logs,
    }),
  );
  const disabledPort = await listen(disabled.server);
  t.after(() => disabled.close());
  assert.equal((await modelTurn(disabledPort)).status, 200);
  let response = await fetch(
    `http://127.0.0.1:${disabledPort}/subscription/v1/alpha/search`,
    { headers: {
      authorization: "Bearer subscription-secret",
      "thread-id": "thread-one",
      "turn-id": "turn-one",
    } },
  );
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.type, "standalone_search_disabled");
  assert.equal(disabledCalls.search.length + disabledCalls.official.length, 0);

  const unresolvedCalls = { official: [], search: [], model: [], logs: [] };
  const unresolved = createGateway(
    config("provider"),
    gatewayOptions({
      officialCalls: unresolvedCalls.official,
      providerSearchCalls: unresolvedCalls.search,
      modelCalls: unresolvedCalls.model,
      logs: unresolvedCalls.logs,
    }),
  );
  const unresolvedPort = await listen(unresolved.server);
  t.after(() => unresolved.close());
  response = await fetch(
    `http://127.0.0.1:${unresolvedPort}/subscription/v1/alpha/search`,
    { headers: { authorization: "Bearer subscription-secret", "thread-id": "unknown" } },
  );
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.type, "standalone_search_route_unresolved");
  assert.equal(unresolvedCalls.search.length + unresolvedCalls.official.length, 0);

  const prior = process.env.ROUTER_SEARCH_TEST_KEY;
  process.env.ROUTER_SEARCH_TEST_KEY = "provider-secret";
  t.after(() => {
    if (prior == null) delete process.env.ROUTER_SEARCH_TEST_KEY;
    else process.env.ROUTER_SEARCH_TEST_KEY = prior;
  });
  let attempts = 0;
  const failing = createGateway(config("provider"), {
    ...gatewayOptions({ officialCalls: [], providerSearchCalls: [], modelCalls: [], logs: [] }),
    providerSearchRequest: async () => {
      attempts++;
      throw fail("upstream_connection_error", 502);
    },
  });
  const failingPort = await listen(failing.server);
  t.after(() => failing.close());
  assert.equal((await modelTurn(failingPort)).status, 200);
  response = await fetch(
    `http://127.0.0.1:${failingPort}/subscription/v1/alpha/search`,
    { headers: {
      authorization: "Bearer subscription-secret",
      "thread-id": "thread-one",
      "turn-id": "turn-one",
    } },
  );
  assert.equal(response.status, 502);
  assert.equal(attempts, 1);
});

test("leases isolate concurrent threads and freeze provider routing across reload", async (t) => {
  const prior = process.env.ROUTER_SEARCH_TEST_KEY;
  process.env.ROUTER_SEARCH_TEST_KEY = "provider-secret";
  t.after(() => {
    if (prior == null) delete process.env.ROUTER_SEARCH_TEST_KEY;
    else process.env.ROUTER_SEARCH_TEST_KEY = prior;
  });
  const officialCalls = [], providerSearchCalls = [], modelCalls = [], logs = [];
  const gateway = createGateway(
    config("provider"),
    gatewayOptions({ officialCalls, providerSearchCalls, modelCalls, logs }),
  );
  const port = await listen(gateway.server);
  t.after(() => gateway.close());
  assert.equal((await modelTurn(port, { thread: "provider-thread", turn: "provider-turn" })).status, 200);
  gateway.engine.update(config("subscription"));
  assert.equal((await modelTurn(port, { thread: "subscription-thread", turn: "subscription-turn" })).status, 200);

  let response = await fetch(
    `http://127.0.0.1:${port}/subscription/v1/alpha/search?q=one`,
    { headers: {
      authorization: "Bearer subscription-secret",
      "thread-id": "provider-thread",
      "turn-id": "provider-turn",
    } },
  );
  assert.equal(response.status, 200);
  response = await fetch(
    `http://127.0.0.1:${port}/subscription/v1/alpha/search?q=two`,
    { headers: {
      authorization: "Bearer subscription-secret",
      "thread-id": "subscription-thread",
      "turn-id": "subscription-turn",
    } },
  );
  assert.equal(response.status, 200);
  assert.equal(providerSearchCalls.length, 1);
  assert.equal(officialCalls.length, 1);
});

test("WebSocket model generation creates a session-scoped provider lease", async (t) => {
  const prior = process.env.ROUTER_SEARCH_TEST_KEY;
  process.env.ROUTER_SEARCH_TEST_KEY = "provider-secret";
  t.after(() => {
    if (prior == null) delete process.env.ROUTER_SEARCH_TEST_KEY;
    else process.env.ROUTER_SEARCH_TEST_KEY = prior;
  });
  const officialCalls = [], providerSearchCalls = [], modelCalls = [], logs = [];
  const options = gatewayOptions({ officialCalls, providerSearchCalls, modelCalls, logs });
  options.send = async (url, request) => {
    modelCalls.push({ url, request });
    return upstream(200, { "content-type": "text/event-stream" }, completedStream());
  };
  const gateway = createGateway(config("provider"), options);
  const port = await listen(gateway.server);
  t.after(() => gateway.close());
  const ws = new WebSocket(`ws://127.0.0.1:${port}/subscription/v1/responses`, {
    headers: {
      authorization: "Bearer subscription-secret",
      "session-id": "ws-session",
    },
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const done = new Promise((resolve, reject) => {
    ws.on("message", (data) => {
      const event = JSON.parse(data.toString());
      if (event.type === "response.completed") resolve();
      if (event.type === "error") reject(Error(event.error?.type ?? "ws error"));
    });
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({
    type: "response.create",
    model: "vendor-gpt",
    input: "fixture",
  }));
  await done;
  ws.close();
  const response = await fetch(
    `http://127.0.0.1:${port}/subscription/v1/alpha/search`,
    { headers: {
      authorization: "Bearer subscription-secret",
      "session-id": "ws-session",
    } },
  );
  assert.equal(response.status, 200);
  assert.equal(providerSearchCalls.length, 1);
  assert.equal(modelCalls.length, 1);
  assert.equal(modelCalls[0].request.body.model, "gpt-upstream");
});

test("encrypted-state route records survive restart, expire and keep correlation scoped", () => {
  const records = new Map();
  const archive = {
    setState(key, value) { records.set(key, structuredClone(value)); },
    getState(key) { return structuredClone(records.get(key)); },
  };
  let now = 1000;
  const first = new StandaloneSearchRoutes(
    new StateStore({ maxBytes: 1024 * 1024, ttlMs: 30000 }, archive),
    { now: () => now, ttlMs: 100 },
  );
  first.save("account", { "thread-id": "a", "turn-id": "one" }, {}, {
    target: "provider-target",
    provider: "provider",
    source: "provider",
    endpoint: "alpha/search",
    providerBaseUrl: "https://provider.example/v1",
    configDigest: "one",
  }, { account: "chatgpt:fixture", thread: "a", branch: "a" });
  first.save("account", { "thread-id": "b", "turn-id": "two" }, {}, {
    target: "subscription-target",
    provider: "provider",
    source: "subscription",
    configDigest: "two",
  }, { account: "chatgpt:fixture", thread: "b", branch: "b" });

  const restarted = new StandaloneSearchRoutes(
    new StateStore({ maxBytes: 1024 * 1024, ttlMs: 30000 }, archive),
    { now: () => now, ttlMs: 100 },
  );
  assert.equal(restarted.resolve("account", { "turn-id": "one" }).source, "provider");
  assert.equal(restarted.resolve("account", { "thread-id": "b" }).source, "subscription");
  assert.equal(restarted.resolve("account", { "thread-id": "missing" }), null);
  now = 1200;
  assert.equal(restarted.resolve("account", { "turn-id": "one" }), null);
});

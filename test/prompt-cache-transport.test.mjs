import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { WebSocket } from "ws";
import { Engine } from "../src/engine.mjs";
import { validate } from "../src/config.mjs";
import { createGateway } from "../src/server.mjs";

const secret = Buffer.alloc(32, 11);
let serial = 0;
const response = (usage = {}) => ({
  id: `cache_response_${++serial}`,
  object: "response",
  status: "completed",
  output: [],
  usage,
});
const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers({ "content-type": "application/json" }),
  body: Readable.from([JSON.stringify(body)]),
});
const stream = (body) => ({
  ok: true,
  status: 200,
  headers: new Headers({ "content-type": "text/event-stream" }),
  body: Readable.from([
    Buffer.from(
      `data: ${JSON.stringify({ type: "response.completed", response: body })}\n\n`,
    ),
  ]),
});
const baseConfig = (affinity = "gateway-opaque") => validate({
  mode: "rules",
  defaultTarget: "gpt",
  providers: {
    relay: {
      adapter: "openai-compatible",
      baseUrl: "https://relay.example/v1",
      apiKeyEnv: "PROMPT_CACHE_TEST_KEY",
      ...(affinity == null ? {} : { promptCaching: { affinity } }),
    },
    go: {
      adapter: "opencode-go",
      baseUrl: "https://opencode.example/go",
    },
  },
  targets: {
    gpt: {
      provider: "relay",
      model: "gpt-test",
      modelFamily: "openai-gpt",
      wireApi: "responses",
      capabilities: { toolCalling: true },
      app: { enabled: true, modelId: "custom-gpt" },
    },
    go: {
      provider: "go",
      model: "deepseek-test",
      modelFamily: "other",
      wireApi: "responses",
      capabilities: { toolCalling: true },
    },
  },
  rules: [],
  subscription: {
    enabled: true,
    models: ["gpt-official"],
    customModels: { "custom-gpt": "gpt" },
  },
});
const collect = async (
  engine,
  body,
  entry = "subscription",
  headers = {
    authorization: "Bearer official-secret",
    "chatgpt-account-id": "raw-account",
    "thread-id": "raw-thread",
    "turn-id": "raw-turn",
  },
) => {
  const events = [];
  for await (const event of engine.generate(
    entry,
    headers,
    body,
    new AbortController().signal,
  )) events.push(event);
  return events;
};

test("third-party GPT wire receives only a derived key and safe cache options", async (t) => {
  process.env.PROMPT_CACHE_TEST_KEY = "provider-secret";
  t.after(() => delete process.env.PROMPT_CACHE_TEST_KEY);
  const seen = [], logs = [];
  const engine = new Engine(baseConfig(), {
    promptCacheSecret: secret,
    log: (event) => logs.push(event),
    send: async (url, options) => {
      seen.push({ url, options });
      return json(response({
        input_tokens: 1000,
        input_tokens_details: { cached_tokens: 700 },
        output_tokens: 4,
      }));
    },
  });
  await collect(engine, {
    model: "custom-gpt",
    input: "synthetic",
    prompt_cache_key: "raw-private-cache-key",
    prompt_cache_options: {
      mode: "explicit",
      ttl: "30m",
      comparison_response_id: "raw-response-id",
      extra: "unsafe",
    },
    client_metadata: {
      session_id: "raw-session",
      "x-codex-installation-id": "raw-installation",
    },
    metadata: { session_id: "raw-session" },
    session_id: "raw-session",
  });
  assert.equal(seen.length, 1);
  assert.match(seen[0].options.body.prompt_cache_key, /^clr-pc-v1-/);
  assert.notEqual(
    seen[0].options.body.prompt_cache_key,
    "raw-private-cache-key",
  );
  assert.deepEqual(seen[0].options.body.prompt_cache_options, {
    mode: "explicit",
    ttl: "30m",
  });
  for (const field of ["client_metadata", "metadata", "session_id"])
    assert.equal(seen[0].options.body[field], undefined);
  for (const header of [
    "chatgpt-account-id",
    "thread-id",
    "turn-id",
    "x-codex-turn-metadata",
  ]) assert.equal(seen[0].options.headers[header], undefined);
  assert.equal(seen[0].options.headers.authorization, "Bearer provider-secret");

  const applied = logs.find((event) =>
    event.event === "prompt_cache_affinity_applied");
  assert.equal(applied.lineage_source, "client_prompt_cache_key");
  const usage = logs.find((event) => event.event === "prompt_cache_usage");
  assert.equal(usage.input_tokens, 1000);
  assert.equal(usage.cached_tokens, 700);
  assert.equal(usage.cache_ratio, 0.7);
  const logText = JSON.stringify(logs);
  for (const raw of [
    "raw-private-cache-key",
    "raw-response-id",
    "raw-account",
    "raw-thread",
    "raw-turn",
    "raw-session",
    "raw-installation",
    "provider-secret",
  ]) assert.equal(logText.includes(raw), false);
});

test("same turn reuses a frozen key and SSE reports cache usage", async (t) => {
  process.env.PROMPT_CACHE_TEST_KEY = "provider-secret";
  t.after(() => delete process.env.PROMPT_CACHE_TEST_KEY);
  const keys = [], logs = [];
  const engine = new Engine(baseConfig(), {
    promptCacheSecret: secret,
    log: (event) => logs.push(event),
    send: async (_, options) => {
      keys.push(options.body.prompt_cache_key);
      return stream(response({
        input_tokens: 2048,
        input_tokens_details: { cached_tokens: 1024 },
      }));
    },
  });
  await collect(engine, {
    model: "custom-gpt",
    input: "first",
    prompt_cache_key: "first-client-key",
  });
  await collect(engine, {
    model: "custom-gpt",
    input: "continuation",
    prompt_cache_key: "changed-client-key",
  });
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.equal(
    logs.filter((event) => event.event === "prompt_cache_usage").at(-1)
      .cache_ratio,
    0.5,
  );
});

test("legacy, non-GPT and Chat-compatible requests never gain an affinity key", async (t) => {
  process.env.PROMPT_CACHE_TEST_KEY = "provider-secret";
  t.after(() => delete process.env.PROMPT_CACHE_TEST_KEY);
  const apiConfig = structuredClone(baseConfig());
  apiConfig.defaultTarget = "go";
  for (const setup of [
    { config: baseConfig(null), target: "custom-gpt", entry: "subscription" },
    { config: validate(apiConfig), target: "deepseek-test", entry: "api" },
  ]) {
    let sent;
    const engine = new Engine(setup.config, {
      promptCacheSecret: secret,
      send: async (_, options) => {
        sent = options.body;
        return json(response());
      },
    });
    await collect(engine, {
      model: setup.target,
      input: "synthetic",
      prompt_cache_key: "raw-private-cache-key",
      prompt_cache_options: { comparison_response_id: "raw-response-id" },
    }, setup.entry, setup.entry === "api" ? {} : undefined);
    assert.equal(sent.prompt_cache_key, undefined);
    assert.equal(sent.prompt_cache_options, undefined);
  }

  const chatConfig = structuredClone(baseConfig());
  chatConfig.targets.gpt.wireApi = "chat_completions";
  let sent;
  const chat = new Engine(validate(chatConfig), {
    promptCacheSecret: secret,
    send: async (_, options) => {
      sent = options.body;
      return json({
        id: "chat-response",
        choices: [{ message: { role: "assistant", content: "ok" } }],
      });
    },
  });
  await collect(chat, {
    model: "custom-gpt",
    input: "synthetic",
    prompt_cache_key: "raw-private-cache-key",
  });
  assert.equal(sent.prompt_cache_key, undefined);
});

test("official subscription preserves client cache fields byte-structurally", async () => {
  let sent;
  const engine = new Engine(baseConfig(), {
    promptCacheSecret: secret,
    send: async (_, options) => {
      sent = options.body;
      return json(response());
    },
  });
  await collect(engine, {
    model: "gpt-official",
    input: "synthetic",
    prompt_cache_key: "official-client-key",
    prompt_cache_options: {
      mode: "explicit",
      ttl: "30m",
      comparison_response_id: "official-response",
    },
  });
  assert.equal(sent.prompt_cache_key, "official-client-key");
  assert.deepEqual(sent.prompt_cache_options, {
    mode: "explicit",
    ttl: "30m",
    comparison_response_id: "official-response",
  });
});

test("missing lineage degrades safely while missing secret fails before the wire", async (t) => {
  process.env.PROMPT_CACHE_TEST_KEY = "provider-secret";
  t.after(() => delete process.env.PROMPT_CACHE_TEST_KEY);
  const logs = [];
  let sent;
  const engine = new Engine(baseConfig(), {
    promptCacheSecret: secret,
    log: (event) => logs.push(event),
    send: async (_, options) => {
      sent = options.body;
      return json(response());
    },
  });
  await collect(engine, {
    model: "custom-gpt",
    input: "synthetic",
  }, "subscription", { authorization: "Bearer official-secret" });
  assert.equal(sent.prompt_cache_key, undefined);
  assert.ok(logs.some((event) =>
    event.event === "prompt_cache_affinity_unavailable" &&
    event.reason === "missing_lineage"));

  let calls = 0;
  const missing = new Engine(baseConfig(), {
    loadPromptCacheSecret: async () => { throw Error("not available"); },
    send: async () => { calls++; return json(response()); },
  });
  await assert.rejects(
    collect(missing, {
      model: "custom-gpt",
      input: "synthetic",
      prompt_cache_key: "client-key",
    }),
    (error) => error.type === "prompt_cache_affinity_key_unavailable" &&
      error.status === 503,
  );
  assert.equal(calls, 0);
});

test("an upstream rejection is returned once without stripping-and-retrying", async (t) => {
  process.env.PROMPT_CACHE_TEST_KEY = "provider-secret";
  t.after(() => delete process.env.PROMPT_CACHE_TEST_KEY);
  let calls = 0;
  const logs = [];
  const engine = new Engine(baseConfig(), {
    promptCacheSecret: secret,
    log: (event) => logs.push(event),
    send: async () => {
      calls++;
      return json({ error: { type: "invalid_request_error" } }, 400);
    },
  });
  await assert.rejects(
    collect(engine, {
      model: "custom-gpt",
      input: "synthetic",
      prompt_cache_key: "client-key",
    }),
    (error) => error.type === "provider_error" && error.status === 400,
  );
  assert.equal(calls, 1);
  assert.equal(
    logs.filter((event) => event.event === "prompt_cache_usage").length,
    0,
  );
});

test("none affinity records terminal usage once and keeps missing usage unknown", async (t) => {
  process.env.PROMPT_CACHE_TEST_KEY = "provider-secret";
  t.after(() => delete process.env.PROMPT_CACHE_TEST_KEY);
  const logs = [];
  let calls = 0;
  const engine = new Engine(baseConfig("none"), {
    log: (event) => logs.push(event),
    send: async () => {
      calls++;
      return calls === 1
        ? json(response({
            input_tokens: 1200,
            input_tokens_details: { cached_tokens: 300 },
          }))
        : stream(response());
    },
  });
  await collect(engine, {
    model: "custom-gpt",
    input: "non-stream terminal",
    prompt_cache_key: "raw-key-one",
  });
  await collect(engine, {
    model: "custom-gpt",
    input: "stream terminal",
    prompt_cache_key: "raw-key-two",
  }, "subscription", {
    authorization: "Bearer official-secret",
    "thread-id": "raw-thread",
    "turn-id": "second-turn",
  });
  const usage = logs.filter((event) => event.event === "prompt_cache_usage");
  assert.equal(usage.length, 2);
  assert.deepEqual(
    usage.map((event) => ({
      policy: event.policy,
      input: event.input_tokens,
      cached: event.cached_tokens,
      ratio: event.cache_ratio,
    })),
    [
      { policy: "none", input: 1200, cached: 300, ratio: 0.25 },
      { policy: "none", input: null, cached: null, ratio: null },
    ],
  );
});

test("cancelled none-affinity requests do not emit terminal cache usage", async (t) => {
  process.env.PROMPT_CACHE_TEST_KEY = "provider-secret";
  t.after(() => delete process.env.PROMPT_CACHE_TEST_KEY);
  const logs = [];
  const controller = new AbortController();
  controller.abort();
  const engine = new Engine(baseConfig("none"), {
    log: (event) => logs.push(event),
    send: async () => {
      throw Error("provider must not be called");
    },
  });
  await assert.rejects(async () => {
    for await (const _ of engine.generate(
      "subscription",
      {
        authorization: "Bearer official-secret",
        "thread-id": "raw-thread",
        "turn-id": "cancelled-turn",
      },
      { model: "custom-gpt", input: "cancelled" },
      controller.signal,
    )) {}
  }, (error) => error.type === "cancelled");
  assert.equal(
    logs.filter((event) => event.event === "prompt_cache_usage").length,
    0,
  );
});

test("a turn freezes enabled affinity across reload and a new turn sees the new policy", async (t) => {
  process.env.PROMPT_CACHE_TEST_KEY = "provider-secret";
  t.after(() => delete process.env.PROMPT_CACHE_TEST_KEY);
  const sent = [];
  const enabled = baseConfig();
  const engine = new Engine(enabled, {
    promptCacheSecret: secret,
    send: async (_, options) => {
      sent.push(options.body.prompt_cache_key);
      return json(response());
    },
  });
  await collect(engine, {
    model: "custom-gpt",
    input: "before reload",
    prompt_cache_key: "client-key",
  });
  engine.update(baseConfig("none"));
  await collect(engine, {
    model: "custom-gpt",
    input: "same turn after reload",
    prompt_cache_key: "changed-client-key",
  });
  await collect(engine, {
    model: "custom-gpt",
    input: "next turn",
    prompt_cache_key: "client-key",
  }, "subscription", {
    authorization: "Bearer official-secret",
    "thread-id": "raw-thread",
    "turn-id": "next-turn",
  });
  assert.match(sent[0], /^clr-pc-v1-/);
  assert.equal(sent[1], sent[0]);
  assert.equal(sent[2], undefined);
});

test("HTTP and WebSocket custom-model turns apply the same safe wire contract", async (t) => {
  process.env.PROMPT_CACHE_TEST_KEY = "provider-secret";
  t.after(() => delete process.env.PROMPT_CACHE_TEST_KEY);
  const seen = [];
  const gateway = createGateway(baseConfig(), {
    promptCacheSecret: secret,
    resolveIdentity: async () => "chatgpt:test-account",
    log: () => {},
    send: async (_, options) => {
      seen.push(options);
      return stream(response({
        input_tokens: 1024,
        input_tokens_details: { cached_tokens: 512 },
      }));
    },
  });
  await new Promise((resolve) =>
    gateway.server.listen(0, "127.0.0.1", resolve));
  t.after(() => gateway.close());
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const http = await fetch(`${base}/subscription/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer official-secret",
      "content-type": "application/json",
      "thread-id": "http-thread",
      "turn-id": "http-turn",
    },
    body: JSON.stringify({
      model: "custom-gpt",
      input: "synthetic http",
      prompt_cache_key: "raw-http-key",
      stream: false,
    }),
  });
  assert.equal(http.status, 200);

  const ws = new WebSocket(
    base.replace("http", "ws") + "/subscription/v1/responses",
    { headers: { authorization: "Bearer official-secret" } },
  );
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const completed = new Promise((resolve) => {
    ws.on("message", (data) => {
      const event = JSON.parse(data);
      if (event.type === "response.completed") resolve(event);
    });
  });
  ws.send(JSON.stringify({
    type: "response.create",
    model: "custom-gpt",
    input: "synthetic ws",
    prompt_cache_key: "raw-ws-key",
    client_metadata: {
      thread_id: "ws-thread",
      turn_id: "ws-turn",
    },
  }));
  await completed;
  ws.close();
  assert.equal(seen.length, 2);
  for (const capture of seen) {
    assert.match(capture.body.prompt_cache_key, /^clr-pc-v1-/);
    assert.equal(capture.body.client_metadata, undefined);
    assert.equal(capture.headers["chatgpt-account-id"], undefined);
    assert.equal(capture.headers["thread-id"], undefined);
    assert.equal(capture.headers["turn-id"], undefined);
  }
  assert.notEqual(seen[0].body.prompt_cache_key, seen[1].body.prompt_cache_key);
  const serialized = JSON.stringify(seen);
  assert.equal(serialized.includes("raw-http-key"), false);
  assert.equal(serialized.includes("raw-ws-key"), false);
  assert.equal(serialized.includes("official-secret"), false);
});

test("HTTP and each WebSocket frame negotiate Responses Lite independently", async (t) => {
  process.env.PROMPT_CACHE_TEST_KEY = "provider-secret";
  t.after(() => delete process.env.PROMPT_CACHE_TEST_KEY);
  const seen = [];
  const gateway = createGateway(baseConfig("none"), {
    resolveIdentity: async () => "chatgpt:test-account",
    log: () => {},
    send: async (_, options) => {
      seen.push(options);
      return stream(response());
    },
  });
  await new Promise((resolve) =>
    gateway.server.listen(0, "127.0.0.1", resolve));
  t.after(() => gateway.close());
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const http = await fetch(`${base}/subscription/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer official-secret",
      "content-type": "application/json",
      "x-openai-internal-codex-responses-lite": "true",
    },
    body: JSON.stringify({
      model: "custom-gpt",
      input: "synthetic http lite",
      stream: false,
    }),
  });
  assert.equal(http.status, 200);

  const ws = new WebSocket(
    base.replace("http", "ws") + "/subscription/v1/responses",
    {
      headers: {
        authorization: "Bearer official-secret",
        "x-openai-internal-codex-responses-lite": "true",
      },
    },
  );
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const request = (turn, lite) => new Promise((resolve, reject) => {
    const onMessage = (data) => {
      const event = JSON.parse(data);
      if (event.type === "error") {
        cleanup();
        reject(Error(event.error?.message ?? "WebSocket request failed"));
      } else if (event.type === "response.completed") {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      ws.off("message", onMessage);
      ws.off("error", onError);
    };
    const onError = (error) => { cleanup(); reject(error); };
    ws.on("message", onMessage);
    ws.on("error", onError);
    ws.send(JSON.stringify({
      type: "response.create",
      model: "custom-gpt",
      input: `synthetic ${turn}`,
      client_metadata: {
        thread_id: "lite-thread",
        turn_id: turn,
        ...(lite == null
          ? {}
          : {
              ws_request_header_x_openai_internal_codex_responses_lite:
                String(lite),
            }),
      },
    }));
  });
  await request("lite-one", true);
  await request("metadata-missing", null);
  await request("explicit-false", false);
  await request("lite-two", true);
  ws.close();

  assert.deepEqual(
    seen.map((capture) =>
      capture.headers["x-openai-internal-codex-responses-lite"]),
    ["true", "true", undefined, undefined, "true"],
  );
  assert.ok(seen.every((capture) => capture.body.client_metadata === undefined));
});

test("explicit internal non-Lite context overrides client metadata", async (t) => {
  process.env.PROMPT_CACHE_TEST_KEY = "provider-secret";
  t.after(() => delete process.env.PROMPT_CACHE_TEST_KEY);
  let sent;
  const engine = new Engine(baseConfig("none"), {
    send: async (_, options) => {
      sent = options;
      return json(response());
    },
  });
  for await (const _ of engine.generate(
    "subscription",
    { authorization: "Bearer official-secret" },
    {
      model: "custom-gpt",
      input: "synthetic internal request",
      client_metadata: {
        thread_id: "internal-thread",
        turn_id: "internal-turn",
        ws_request_header_x_openai_internal_codex_responses_lite: "true",
      },
    },
    new AbortController().signal,
    { responsesLite: false },
  )) {}
  assert.equal(
    sent.headers["x-openai-internal-codex-responses-lite"],
    undefined,
  );
});

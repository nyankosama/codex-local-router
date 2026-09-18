import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { WebSocket } from "ws";
import { Engine } from "../src/engine.mjs";
import { validate } from "../src/config.mjs";
import { StateStore, identity } from "../src/state.mjs";
import { ChatEncoder } from "../src/events.mjs";
import { createGateway } from "../src/server.mjs";
import { sseEvents, readSSE } from "../src/sse.mjs";
import { fail } from "../src/errors.mjs";
const cfg = () => ({
  mode: "rules",
  defaultTarget: "go",
  providers: { go: { baseUrl: "http://127.0.0.1:9000" } },
  targets: {
    go: {
      provider: "go",
      model: "deepseek-v4.1-flash",
      wireApi: "responses",
      capabilities: { toolCalling: true, nativeWebSearch: false },
    },
    backup: {
      provider: "go",
      model: "backup",
      wireApi: "responses",
      capabilities: { toolCalling: true },
    },
  },
  subscription: {
    enabled: true,
    models: ["gpt-5.5"],
    customModels: { "deepseek-v4.1-flash": "go" },
  },
  webSearch: { backend: "fake" },
  rules: [],
});
const message = (text) => ({
  type: "message",
  id: "m1",
  role: "assistant",
  content: [{ type: "output_text", text, annotations: [] }],
});
let serial = 0;
const result = (output = [message("ok")]) => ({
  id: `r${++serial}`,
  object: "response",
  status: "completed",
  output,
});
const json = (value) => ({
  ok: true,
  status: 200,
  headers: new Headers({ "content-type": "application/json" }),
  body: Readable.from([JSON.stringify(value)]),
});
const stream = (events) => ({
  ok: true,
  status: 200,
  headers: new Headers({ "content-type": "text/event-stream" }),
  body: Readable.from(
    events
      .map((x) => `data: ${JSON.stringify(x)}\n\n`)
      .flatMap((x) => [x.slice(0, 7), x.slice(7)])
      .map((x) => Buffer.from(x)),
  ),
});
const collect = async (
  engine,
  body,
  entry = "subscription",
  headers = { authorization: "Bearer official-test", "thread-id": "thread" },
  signal = new AbortController().signal,
) => {
  const events = [];
  for await (const e of engine.generate(entry, headers, body, signal))
    events.push(e);
  return events;
};
test("subscription identities stay official; Go headers and metadata are isolated", async () => {
  const seen = [];
  const engine = new Engine(validate(cfg()), {
    send: async (url, options) => {
      seen.push({ url, ...options });
      return json(result());
    },
  });
  await collect(engine, { model: "gpt-5.5", input: "hi" });
  await collect(engine, {
    model: "deepseek-v4.1-flash",
    input: "hi",
    client_metadata: { secret: "account" },
    prompt_cache_key: "private",
  });
  assert.equal(seen[0].url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(seen[0].headers.authorization, "Bearer official-test");
  assert.equal(seen[1].headers.authorization, undefined);
  assert.equal(seen[1].body.client_metadata, undefined);
  assert.equal(seen[1].body.prompt_cache_key, undefined);
  assert.notEqual(seen[1].headers["x-opencode-session"], "thread");
  await collect(engine, { model: "deepseek-v4.1-flash", input: "again" });
  assert.equal(
    seen[1].headers["x-opencode-session"],
    seen[2].headers["x-opencode-session"],
  );
  await collect(engine, { model: "unknown" });
  assert.equal(seen[3].body.model, "unknown");
  await assert.rejects(
    collect(engine, { model: "gpt-5.5" }, "subscription", {}),
    /subscription_auth_required/,
  );
});
test("OpenCode session header is adapter-scoped", async () => {
  const c = cfg();
  c.providers.generic = {
    adapter: "openai-compatible",
    baseUrl: "http://127.0.0.1:9001",
  };
  c.targets.generic = {
    provider: "generic",
    model: "generic-model",
    wireApi: "responses",
    capabilities: { toolCalling: true },
    app: { enabled: true, modelId: "generic-model" },
  };
  c.subscription.customModels["generic-model"] = "generic";
  let seen;
  const engine = new Engine(validate(c), {
    send: async (_, options) => {
      seen = options;
      return json(result());
    },
  });
  await collect(engine, { model: "generic-model", input: "hi" });
  assert.equal(seen.headers["x-opencode-session"], undefined);
  assert.equal(seen.headers.authorization, undefined);
});
test("third-party GPT forwards only non-identity Codex compatibility headers", async (t) => {
  const c = cfg();
  c.providers.feei = {
    adapter: "openai-compatible",
    baseUrl: "https://ai.feei.cn/v1",
    apiKeyEnv: "ROUTER_TEST_FEEI_KEY",
  };
  c.targets.feei = {
    provider: "feei",
    model: "gpt-5.6-sol",
    modelFamily: "openai-gpt",
    wireApi: "responses",
    capabilities: { toolCalling: true },
    app: { enabled: true, modelId: "feei-gpt" },
  };
  c.subscription.customModels["feei-gpt"] = "feei";
  process.env.ROUTER_TEST_FEEI_KEY = "provider-only";
  t.after(() => delete process.env.ROUTER_TEST_FEEI_KEY);
  let seen;
  const engine = new Engine(validate(c), {
    send: async (_, options) => {
      seen = options;
      return json(result());
    },
  });
  await collect(
    engine,
    {
      model: "feei-gpt",
      input: "hi",
      client_metadata: {
        session_id: "body-session",
        "x-codex-installation-id": "installation-secret",
      },
      prompt_cache_key: "private-cache-key",
    },
    "subscription",
    {
      authorization: "Bearer official-test",
      "chatgpt-account-id": "account-secret",
      cookie: "cookie-secret",
      "user-agent": "Codex Desktop/test",
      originator: "Codex Desktop",
      "x-codex-beta-features": "feature-a",
      "x-openai-internal-codex-responses-lite": "false",
      "x-client-request-id": "client-request-secret",
      "x-codex-window-id": "window-secret",
      "thread-id": "thread-secret",
      "turn-id": "turn-secret",
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: "thread-secret",
        turn_id: "turn-secret",
      }),
    },
  );
  assert.equal(seen.headers.authorization, "Bearer provider-only");
  assert.equal(seen.headers["user-agent"], "Codex Desktop/test");
  assert.equal(seen.headers.originator, "Codex Desktop");
  assert.equal(seen.headers["x-codex-beta-features"], "feature-a");
  assert.equal(
    seen.headers["x-openai-internal-codex-responses-lite"],
    undefined,
  );
  for (const name of [
    "chatgpt-account-id",
    "cookie",
    "x-client-request-id",
    "x-codex-window-id",
    "thread-id",
    "turn-id",
    "x-codex-turn-metadata",
  ]) assert.equal(seen.headers[name], undefined);
  assert.equal(seen.body.client_metadata, undefined);
  assert.equal(seen.body.prompt_cache_key, undefined);
});
test("Chat targets flatten Codex namespace definitions without dropping functions", async () => {
  const c = cfg();
  c.defaultTarget = "chat";
  c.targets.chat = {
    provider: "go",
    model: "chat-model",
    wireApi: "chat_completions",
    capabilities: { toolCalling: true, freeformTools: false },
  };
  const logs = [];
  let sent;
  const engine = new Engine(validate(c), {
    log: (event) => logs.push(event),
    send: async (_, options) => {
      sent = options.body;
      return json({
        id: "chat-result",
        choices: [{ message: { role: "assistant", content: "ok" } }],
      });
    },
  });
  await collect(engine, {
    model: "chat-model",
    input: "use the function",
    tools: [
      {
        type: "namespace",
        name: "mcp_search",
        tools: [{
          name: "query",
          description: "Search",
          parameters: { type: "object", properties: {} },
        }],
      },
      {
        type: "function",
        name: "read_file",
        description: "Read one file",
        parameters: { type: "object", properties: {} },
      },
    ],
  }, "api", {});
  assert.equal(sent.tools.length, 2);
  assert.match(sent.tools[0].function.name, /^clr_mcp_search__query_/);
  assert.equal(sent.tools[1].function.name, "read_file");
  assert.equal(logs.some((event) =>
    event.event === "unsupported_tool_definitions_omitted"), false);
});
test("API passthrough and fixed routing execute real targets; no configured fallback means one attempt", async () => {
  for (const mode of ["passthrough", "fixed", "rules"]) {
    const c = cfg();
    c.mode = mode;
    c.fixedTarget = "go";
    let seen;
    const engine = new Engine(validate(c), {
      send: async (u, o) => {
        seen = o.body;
        return json(result());
      },
    });
    await collect(engine, { model: "requested", input: "hello" }, "api", {});
    assert.equal(
      seen.model,
      mode === "passthrough" ? "requested" : "deepseek-v4.1-flash",
    );
  }
  let calls = 0;
  const logs = [];
  const e = new Engine(validate(cfg()), {
    log: (event) => logs.push(event),
    send: async () => {
      calls++;
      const error = fail("upstream_connection_error", 502);
      error.transportCode = 56;
      error.transportCategory = "receive";
      throw error;
    },
  });
  await assert.rejects(collect(e, { model: "x" }, "api", {}));
  assert.equal(calls, 1);
  assert.ok(logs.some((event) =>
    event.event === "upstream_transport_error" &&
    event.transport_code === 56 &&
    event.transport_category === "receive"));
});
test("fallback only before output, within API provider, not on auth or capability errors", async () => {
  for (const status of [401, 400, 429, 500, 503]) {
    const c = cfg();
    c.fallbackTarget = "backup";
    let calls = 0;
    const e = new Engine(validate(c), {
      send: async () =>
        ++calls === 1
          ? { ok: false, status, body: Readable.from([]) }
          : json(result()),
    });
    if (status < 429)
      await assert.rejects(collect(e, { model: "x" }, "api", {}));
    else await collect(e, { model: "x" }, "api", {});
    assert.equal(calls, status < 429 ? 1 : 2);
  }
  const c = cfg();
  c.fallbackTarget = "backup";
  let calls = 0;
  const e = new Engine(validate(c), {
    send: async () => {
      calls++;
      return stream([{ type: "response.output_text.delta", delta: "partial" }]);
    },
  });
  await assert.rejects(
    collect(e, { model: "x" }, "api", {}),
    /upstream_stream_incomplete/,
  );
  assert.equal(calls, 1);
  calls = 0;
  const subscription = new Engine(validate(c), {
    send: async () => {
      calls++;
      return { ok: false, status: 503, body: Readable.from([]) };
    },
  });
  await assert.rejects(collect(subscription, { model: "gpt-5.5" }));
  assert.equal(calls, 1);
});
test("search loops accumulate multiple results and stream only final answer", async () => {
  let round = 0;
  const bodies = [];
  const e = new Engine(validate(cfg()), {
    send: async (u, o) => {
      bodies.push(o.body);
      round++;
      return json(
        result(
          round < 3
            ? [
                {
                  type: "function_call",
                  name: "gateway_web_search",
                  call_id: "s" + round,
                  arguments: '{"query":"test"}',
                },
              ]
            : [message("searched")],
        ),
      );
    },
  });
  const events = await collect(e, {
    model: "deepseek-v4.1-flash",
    input: "search",
    tools: [{ type: "web_search" }],
  });
  assert.equal(round, 3);
  assert.equal(
    bodies[2].input.filter((x) => x.type === "function_call_output").length,
    2,
  );
  assert.equal(events.at(-1).response.output[0].content[0].text, "searched");
  assert.ok(!events.some((e) => e.item?.name === "gateway_web_search"));
});
test("search fallback extracts bounded page content without exposing internal tools", async () => {
  const c = cfg();
  c.webSearch.pages = {
    "https://example.com/report": "report".repeat(1000),
  };
  c.webSearch.maxExtractCharacters = 1200;
  let round = 0;
  const bodies = [];
  const logs = [];
  const e = new Engine(validate(c), {
    log: (event) => logs.push(event),
    send: async (_url, options) => {
      bodies.push(options.body);
      round++;
      return json(
        result(
          round === 1
            ? [
                {
                  type: "function_call",
                  name: "gateway_web_search",
                  call_id: "search",
                  arguments: '{"query":"report"}',
                },
              ]
            : round === 2
              ? [
                  {
                    type: "function_call",
                    name: "gateway_web_fetch",
                    call_id: "fetch",
                    arguments:
                      '{"url":"https://example.com/report","query":"finding"}',
                  },
                ]
              : [message("done")],
        ),
      );
    },
  });
  const events = await collect(e, {
    model: "deepseek-v4.1-flash",
    input: "search and read the report",
    tools: [{ type: "web_search" }],
  });
  assert.deepEqual(
    bodies[0].tools.slice(-2).map((tool) => tool.name),
    ["gateway_web_search", "gateway_web_fetch"],
  );
  const extracted = JSON.parse(
    bodies[2].input.find(
      (item) =>
        item.type === "function_call_output" && item.call_id === "fetch",
    ).output,
  );
  assert.equal(extracted.characters, 1200);
  assert.equal(extracted.truncated, true);
  assert.ok(logs.some((event) => event.event === "web_fetch"));
  assert.ok(
    !events.some((event) =>
      ["gateway_web_search", "gateway_web_fetch"].includes(event.item?.name),
    ),
  );
});
test("subscription bridge executes fixed-origin search and hides its internal call", async () => {
  const c = cfg();
  c.targets.go.app = {
    enabled: true,
    modelId: "glm-flash",
    capabilityProfile: "standard-tools",
    useResponsesLite: false,
  };
  c.targets.go.standaloneSearch = { source: "disabled" };
  c.targets.go.subscriptionSearch = { delivery: "standard-tool" };
  c.subscription.customModels = { "glm-flash": "go" };
  const modelBodies = [];
  const official = [];
  let round = 0;
  const engine = new Engine(validate(c), {
    send: async (_url, options) => {
      modelBodies.push(options.body);
      round++;
      return json(result(round === 1
        ? [{
            type: "function_call",
            name: "gateway_subscription_web_search",
            call_id: "subscription-search",
            arguments: '{"query":"router docs","numResults":2}',
          }]
        : [message("https://docs.example.com/router")]),
      );
    },
    officialRequest: async (url, options) => {
      official.push({ url, options });
      return json({
        results: [{
          title: "Router docs",
          url: "https://docs.example.com/router",
          snippet: "fixture",
          ref_id: "r1",
        }],
      });
    },
  });
  const events = await collect(engine, {
    model: "glm-flash",
    input: "search",
    tools: [{
      type: "web_search",
      mode: "live",
      filters: { allowed_domains: ["docs.example.com"] },
    }],
  });
  assert.equal(round, 2);
  assert.equal(official.length, 1);
  assert.equal(official[0].url, "https://chatgpt.com/backend-api/codex/alpha/search");
  assert.equal(official[0].options.headers.authorization, "Bearer official-test");
  assert.ok(JSON.stringify(modelBodies[1]).includes("https://docs.example.com/router"));
  assert.equal(events.some((event) =>
    event.item?.name === "gateway_subscription_web_search"), false);
});
test("subscription bridge cannot lend subscription identity to /v1", async () => {
  const c = cfg();
  c.targets.go.app = {
    enabled: true,
    modelId: "glm-flash",
    capabilityProfile: "standard-tools",
    useResponsesLite: false,
  };
  c.targets.go.standaloneSearch = { source: "disabled" };
  c.targets.go.subscriptionSearch = { delivery: "standard-tool" };
  c.subscription.customModels = { "glm-flash": "go" };
  let officialCalls = 0;
  const engine = new Engine(validate(c), {
    officialRequest: async () => {
      officialCalls++;
      throw Error("must not run");
    },
  });
  await assert.rejects(
    collect(
      engine,
      {
        model: "glm-flash",
        input: "search",
        tools: [{ type: "web_search", mode: "cached" }],
      },
      "api",
      { authorization: "Bearer local-api-key" },
    ),
    /subscription_search_identity_required/,
  );
  assert.equal(officialCalls, 0);
});
test("native search passthrough and unavailable fallback errors", async () => {
  let tools;
  const e = new Engine(validate(cfg()), {
    send: async (u, o) => {
      tools = o.body.tools;
      return json(result());
    },
  });
  await collect(e, { model: "gpt-5.5", tools: [{ type: "web_search" }] });
  assert.equal(tools[0].type, "web_search");
  const c = cfg();
  delete c.webSearch;
  await assert.rejects(
    collect(new Engine(validate(c)), {
      model: "deepseek-v4.1-flash",
      tools: [{ type: "web_search" }],
    }),
    /web_search_unavailable/,
  );
});
test("third-party GPT standalone search rejects the hosted-search carrier", async () => {
  const c = cfg();
  c.targets.go.modelFamily = "openai-gpt";
  c.standaloneSearch = { thirdPartyGpt: { defaultSource: "subscription" } };
  delete c.webSearch;
  c.targets.go.app = {
    enabled: true,
    modelId: "deepseek-v4.1-flash",
    useResponsesLite: true,
  };
  await assert.rejects(
    collect(new Engine(validate(c)), {
      model: "deepseek-v4.1-flash",
      tools: [{ type: "web_search" }],
    }),
    /standalone_search_protocol_mismatch/,
  );

  c.targets.go.standaloneSearch = { source: "disabled" };
  c.targets.go.app.capabilityProfile = "standard-tools";
  c.targets.go.app.useResponsesLite = false;
  await assert.rejects(
    collect(new Engine(validate(c)), {
      model: "deepseek-v4.1-flash",
      tools: [{ type: "web_search" }],
    }),
    /standalone_search_disabled/,
  );
});
test("turn leases survive reload and reject mid-turn changes; next turn changes route", async () => {
  const c = cfg();
  const models = [];
  const e = new Engine(validate(c), {
    send: async (u, o) => {
      models.push(o.body.model);
      return json(result());
    },
  });
  const headers = {
    authorization: "Bearer test",
    "thread-id": "a",
    "turn-id": "one",
  };
  await collect(e, { model: "input" }, "api", headers);
  const next = cfg();
  next.mode = "fixed";
  next.fixedTarget = "backup";
  e.update(validate(next));
  await collect(e, { model: "input" }, "api", headers);
  assert.deepEqual(models, ["deepseek-v4.1-flash", "deepseek-v4.1-flash"]);
  await assert.rejects(
    collect(e, { model: "different" }, "api", headers),
    /model_change_during_turn/,
  );
  await collect(e, { model: "input" }, "api", { ...headers, "turn-id": "two" });
  assert.equal(models.at(-1), "backup");
});
test("history is auth/thread scoped, bounded, expiring and replayable", async () => {
  const e = new Engine(validate(cfg()), { send: async () => json(result()) });
  const a = (await collect(e, { model: "gpt-5.5", input: "hi" })).at(
    -1,
  ).response;
  await collect(e, { model: "gpt-5.5", previous_response_id: a.id, input: [] });
  await assert.rejects(
    collect(
      e,
      { model: "gpt-5.5", previous_response_id: a.id },
      "subscription",
      { authorization: "Bearer other", "thread-id": "thread" },
    ),
    /Previous response/,
  );
  const store = new StateStore({ maxBytes: 20, ttlMs: 2 });
  store.set("a", "12345678");
  store.set("b", "1234567890");
  assert.equal(store.get("a"), undefined);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(store.get("b"), undefined);
  assert.throws(() => store.set("c", "x".repeat(30)), /history_capacity/);
});
test("Chat event encoder aggregates two tool arguments and reasoning before completion", () => {
  const e = new ChatEncoder("chat");
  const events = [
    e.start(),
    ...e.consume({
      choices: [
        {
          delta: {
            reasoning_content: "think",
            tool_calls: [
              { index: 0, id: "a", function: { name: "one", arguments: "{" } },
              { index: 1, id: "b", function: { name: "two", arguments: "{}" } },
            ],
          },
        },
      ],
    }),
    ...e.consume({
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] },
          finish_reason: "tool_calls",
        },
      ],
    }),
    ...e.end(),
  ];
  const response = events.at(-1).response;
  assert.deepEqual(
    response.output
      .filter((x) => x.type === "function_call")
      .map((x) => [x.call_id, x.arguments]),
    [
      ["a", "{}"],
      ["b", "{}"],
    ],
  );
  assert.equal(events.at(-1).type, "response.completed");
});
test("SSE split UTF8 and callback failures are not swallowed", async () => {
  const bytes = Buffer.from('data: {"text":"中文"}\r\n\r\n');
  const events = [];
  for await (const e of sseEvents(
    Readable.from([...bytes].map((x) => Buffer.from([x]))),
  ))
    events.push(e);
  assert.equal(events[0].text, "中文");
  await assert.rejects(
    readSSE(Readable.from([Buffer.from("data: {}\n\n")]), () => {
      throw Error("handler failed");
    }),
    /handler failed/,
  );
});
test("configuration rejects insecure URLs, unknown conditions and partial reload candidates", () => {
  for (const mutate of [
    (c) => (c.providers.go.baseUrl = "http://example.com"),
    (c) => (c.rules = [{ name: "x", target: "go", match: { query: "x" } }]),
    (c) => (c.targets.go.capabilities.nativeWebSearch = "yes"),
    (c) => (c.subscription.customModels.bad = "absent"),
    (c) => (c.webSearch.maxExtractCharacters = 100001),
    (c) => (c.webSearch.extractUrl = "http://metadata.example/extract"),
  ]) {
    const c = cfg();
    mutate(c);
    assert.throws(() => validate(c));
  }
});
test("production HTTP and WebSocket entrypoints, prewarm and origin rejection", async (t) => {
  let calls = 0;
  const gateway = createGateway(validate(cfg()), {
    send: async () => {
      calls++;
      return stream([
        { type: "response.created", response: { id: "r", output: [] } },
        { type: "response.completed", response: result() },
      ]);
    },
    officialRequest: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      rawHeaders: [["content-type", "application/json"]],
      body: Readable.from([JSON.stringify({
        models: [{ slug: "gpt-5.5", display_name: "GPT 5.5", priority: 10 }],
      })]),
    }),
    log: () => {},
  });
  await new Promise((r) => gateway.server.listen(0, "127.0.0.1", r));
  t.after(() => gateway.close());
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  assert.equal((await fetch(base + "/subscription/v1/models")).status, 401);
  assert.equal((await fetch(base + "/subscription/v1/models", {
    headers: { authorization: "Bearer test" },
  })).status, 200);
  assert.equal(
    (
      await fetch(base + "/v1/models", {
        headers: { origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  const ws = new WebSocket(
    base.replace("http", "ws") + "/subscription/v1/responses",
    { headers: { authorization: "Bearer test" } },
  );
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", j);
  });
  const receive = () =>
    new Promise((resolve) => {
      const fn = (data) => {
        const x = JSON.parse(data);
        if (x.type === "response.completed") {
          ws.off("message", fn);
          resolve(x);
        }
      };
      ws.on("message", fn);
    });
  let p = receive();
  ws.send(
    JSON.stringify({
      type: "response.create",
      model: "deepseek-v4.1-flash",
      generate: false,
    }),
  );
  const warm = await p;
  assert.equal(calls, 0);
  p = receive();
  ws.send(
    JSON.stringify({
      type: "response.create",
      model: "deepseek-v4.1-flash",
      previous_response_id: warm.response.id,
      input: [{ role: "user", content: "hi" }],
    }),
  );
  await p;
  assert.equal(calls, 1);
  ws.close();
});
test("HTTP and WebSocket preserve mixed search and external tool order", async (t) => {
  const captures = new Map();
  const initialOutput = () => [
    {
      type: "reasoning",
      content: [{ type: "reasoning_text", text: "search and inspect" }],
    },
    {
      type: "function_call",
      name: "gateway_web_search",
      call_id: "internal",
      arguments: '{"query":"report"}',
    },
    {
      type: "function_call",
      name: "inspect",
      call_id: "external",
      arguments: "{}",
    },
  ];
  const gateway = createGateway(validate(cfg()), {
    log: () => {},
    send: async (_url, options) => {
      const transport = options.body.input.find(
        (item) => item.role === "user",
      )?.content;
      if (
        options.body.input.some(
          (item) =>
            item.type === "function_call_output" &&
            item.call_id === "external",
        )
      ) {
        captures.set(transport, options.body.input);
        return json(result([message("complete")]));
      }
      return json(result(initialOutput()));
    },
  });
  await new Promise((done) => gateway.server.listen(0, "127.0.0.1", done));
  t.after(() => gateway.close());
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const request = (transport, previousResponseId, output) => ({
    model: "deepseek-v4.1-flash",
    session_id: `mixed-${transport}`,
    input: previousResponseId
      ? [{ type: "function_call_output", call_id: "external", output }]
      : [{ role: "user", content: transport }],
    ...(previousResponseId
      ? { previous_response_id: previousResponseId }
      : {}),
    tools: [
      { type: "web_search" },
      {
        type: "function",
        name: "inspect",
        parameters: { type: "object" },
      },
    ],
    reasoning: { effort: "max" },
  });
  const firstHttp = await fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request("http")),
  });
  const firstHttpBody = await firstHttp.json();
  assert.equal(firstHttp.status, 200);
  const secondHttp = await fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request("http", firstHttpBody.id, "http done")),
  });
  assert.equal(secondHttp.status, 200);

  const ws = new WebSocket(base.replace("http", "ws") + "/v1/responses");
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const complete = () =>
    new Promise((resolve) => {
      const receive = (data) => {
        const event = JSON.parse(data);
        if (event.type !== "response.completed") return;
        ws.off("message", receive);
        resolve(event.response);
      };
      ws.on("message", receive);
    });
  let pending = complete();
  ws.send(JSON.stringify({ type: "response.create", ...request("ws") }));
  const firstWs = await pending;
  pending = complete();
  ws.send(
    JSON.stringify({
      type: "response.create",
      ...request("ws", firstWs.id, "ws done"),
    }),
  );
  await pending;
  ws.close();

  for (const transport of ["http", "ws"])
    assert.deepEqual(
      captures
        .get(transport)
        .filter((item) =>
          ["reasoning", "function_call", "function_call_output"].includes(
            item.type,
          ),
        )
        .map((item) => `${item.type}:${item.call_id ?? "reasoning"}`),
      [
        "reasoning:reasoning",
        "function_call:internal",
        "function_call:external",
        "function_call_output:internal",
        "function_call_output:external",
      ],
    );
});
test("native completion reconstructs missing tool output before history replay", async () => {
  let count = 0,
    second;
  const call = {
    type: "function_call",
    id: "f",
    call_id: "call",
    name: "read",
    arguments: "{}",
  };
  const e = new Engine(validate(cfg()), {
    send: async (u, o) => {
      if (++count === 1)
        return stream([
          { type: "response.output_item.done", output_index: 0, item: call },
          {
            type: "response.completed",
            response: { id: "native", status: "completed", output: [] },
          },
        ]);
      second = o.body;
      return json(result());
    },
  });
  const first = await collect(e, { model: "gpt-5.5", input: "read" });
  assert.equal(first.at(-1).response.output[0].call_id, "call");
  await collect(e, {
    model: "gpt-5.5",
    previous_response_id: "native",
    input: [{ type: "function_call_output", call_id: "call", output: "ok" }],
  });
  assert.ok(
    second.input.some(
      (x) => x.type === "function_call" && x.call_id === "call",
    ),
  );
});
test("native SSE without Content-Type remains streaming", async () => {
  const e = new Engine(validate(cfg()), {
    send: async () => {
      const r = stream([{ type: "response.completed", response: result() }]);
      r.headers = new Headers();
      return r;
    },
  });
  assert.equal(
    (await collect(e, { model: "gpt-5.5" })).at(-1).type,
    "response.completed",
  );
});
test("multiple internal search calls and mixed external tool output are associated on replay", async () => {
  let n = 0,
    last;
  const searches = [1, 2].map((i) => ({
    type: "function_call",
    call_id: "s" + i,
    name: "gateway_web_search",
    arguments: '{"query":"test"}',
  }));
  const reasoning = {
    type: "reasoning",
    id: "reasoning",
    status: "completed",
    encrypted_content: "provider-reasoning",
    content: [{ type: "reasoning_text", text: "check sources" }],
  };
  const external = ["read", "write"].map((name) => ({
    type: "function_call",
    call_id: name,
    name,
    arguments: "{}",
  }));
  const e = new Engine(validate(cfg()), {
    send: async (u, o) => {
      n++;
      last = o.body;
      return json(
        result(
          n === 1
            ? [
                reasoning,
                ...searches,
                ...external,
              ]
            : [message("done")],
        ),
      );
    },
  });
  const first = await collect(e, {
    model: "deepseek-v4.1-flash",
    input: "search and read",
    tools: [
      { type: "web_search" },
      { type: "function", name: "read", parameters: { type: "object" } },
      { type: "function", name: "write", parameters: { type: "object" } },
    ],
  });
  assert.deepEqual(
    first
      .at(-1)
      .response.output.filter((item) => item.type === "function_call")
      .map((item) => item.name),
    ["read", "write"],
  );
  await collect(e, {
    model: "deepseek-v4.1-flash",
    previous_response_id: first.at(-1).response.id,
    input: [
      {
        type: "function_call_output",
        call_id: "read",
        output: "read done",
      },
      {
        type: "function_call_output",
        call_id: "write",
        output: "write done",
      },
    ],
  });
  assert.deepEqual(
    last.input
      .filter((item) =>
        ["reasoning", "function_call", "function_call_output"].includes(
          item.type,
        ),
      )
      .map((item) =>
        item.type === "reasoning"
          ? "reasoning"
          : `${item.type}:${item.call_id}`,
      ),
    [
      "reasoning",
      "function_call:s1",
      "function_call:s2",
      "function_call:read",
      "function_call:write",
      "function_call_output:s1",
      "function_call_output:s2",
      "function_call_output:read",
      "function_call_output:write",
    ],
  );
});
test("legacy mixed search history is repaired before thinking-mode replay", async () => {
  const config = validate(cfg());
  let sent;
  const e = new Engine(config, {
    send: async (_url, options) => {
      sent = options.body;
      return json(result([message("recovered")]));
    },
  });
  const headers = {
    authorization: "Bearer official-test",
    "thread-id": "legacy-thread",
  };
  const ctx = identity("subscription", headers, {});
  const reasoning = {
    type: "reasoning",
    content: [{ type: "reasoning_text", text: "search then read" }],
  };
  const external = ["read", "write"].map((name) => ({
    type: "function_call",
    name,
    call_id: name,
    arguments: "{}",
  }));
  const base = [
    { type: "message", role: "user", content: "find it" },
    reasoning,
    ...external,
  ];
  e.state.set(
    `response:${ctx.owner}:legacy-response`,
    { input: base, original: base, target: config.targets.go },
    ctx,
  );
  const hidden = [
      {
        type: "function_call",
        name: "gateway_web_search",
        call_id: "internal",
        arguments: '{"query":"report"}',
      },
      {
        type: "function_call_output",
        call_id: "internal",
        output: '{"results":[]}',
      },
    ];
  for (const call of external)
    e.state.set(`search:${ctx.owner}:${call.call_id}`, hidden, ctx);
  const events = await collect(
    e,
    {
      model: "deepseek-v4.1-flash",
      previous_response_id: "legacy-response",
      input: [
        {
          type: "function_call_output",
          call_id: "read",
          output: "read done",
        },
        {
          type: "function_call_output",
          call_id: "write",
          output: "write done",
        },
      ],
      tools: [
        { type: "web_search" },
        { type: "function", name: "read", parameters: { type: "object" } },
        { type: "function", name: "write", parameters: { type: "object" } },
      ],
    },
    "subscription",
    headers,
  );
  assert.deepEqual(
    sent.input
      .filter((item) => item.type !== "message")
      .map((item) => `${item.type}:${item.call_id ?? "reasoning"}`),
    [
      "reasoning:reasoning",
      "function_call:internal",
      "function_call:read",
      "function_call:write",
      "function_call_output:internal",
      "function_call_output:read",
      "function_call_output:write",
    ],
  );
  const saved = e.state.get(
    `response:${ctx.owner}:${events.at(-1).response.id}`,
  );
  assert.deepEqual(
    saved.original
      .filter((item) => item.type?.startsWith("function_call"))
      .map((item) => `${item.type}:${item.call_id}`),
    [
      "function_call:internal",
      "function_call:read",
      "function_call:write",
      "function_call_output:internal",
      "function_call_output:read",
      "function_call_output:write",
    ],
  );
});
test("thinking history rejection is classified without exposing provider text", async () => {
  const logs = [];
  const e = new Engine(validate(cfg()), {
    log: (event) => logs.push(event),
    send: async () => {
      const response = json({
        error: {
          type: "invalid_request_error",
          code: "invalid_request_error",
          message:
            "The `reasoning_text` in the thinking mode must be passed back to the API. private-data",
        },
      });
      response.ok = false;
      response.status = 400;
      return response;
    },
  });
  await assert.rejects(
    collect(e, { model: "deepseek-v4.1-flash", input: "continue" }),
    (error) =>
      error.type === "thinking_history_incompatible" &&
      !error.message.includes("private-data"),
  );
  assert.equal(logs.at(-1).category, "thinking_history");
  assert.ok(!JSON.stringify(logs).includes("private-data"));
});
test("no fallback after local tool results and no full provider error in logs", async () => {
  const c = cfg();
  c.fallbackTarget = "backup";
  let calls = 0;
  const logs = [];
  const e = new Engine(validate(c), {
    log: (x) => logs.push(x),
    send: async () => {
      calls++;
      const r = json({
        error: { message: "secret-private-prompt", param: "input" },
      });
      r.ok = false;
      r.status = 503;
      return r;
    },
  });
  await assert.rejects(
    collect(
      e,
      {
        model: "x",
        input: [
          {
            type: "function_call_output",
            call_id: "x",
            output: "changed file",
          },
        ],
      },
      "api",
      {},
    ),
  );
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(logs).includes("secret-private-prompt"));
});
test("client disconnect cancels upstream in production HTTP handler", async (t) => {
  let aborted = false;
  const gateway = createGateway(validate(cfg()), {
    log: () => {},
    send: async (u, { signal }) => {
      const body = new Readable({ read() {} });
      signal.addEventListener("abort", () => {
        aborted = true;
        body.destroy(fail("cancelled", 499));
      });
      body.push(
        'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
      );
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body,
      };
    },
  });
  await new Promise((r) => gateway.server.listen(0, "127.0.0.1", r));
  t.after(() => gateway.close());
  const c = new AbortController();
  const r = await fetch(
    `http://127.0.0.1:${gateway.server.address().port}/v1/responses`,
    {
      method: "POST",
      signal: c.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "x", stream: true }),
    },
  );
  await r.body.getReader().read();
  c.abort();
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(aborted);
});

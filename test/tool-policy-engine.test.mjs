import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Engine } from "../src/engine.mjs";
import { fail } from "../src/errors.mjs";
import { createGateway } from "../src/server.mjs";

const registry = {
  status: "fixture",
  pluginApps: new Set(["github", "gmail", "safety_settings"]),
  pluginMcpServers: new Set(),
  pluginMcpOwners: new Map(),
  userMcpServers: new Set(["test_mcp"]),
  coreNamespaces: new Set(["codex_app", "cua_repl"]),
};

const response = (output = []) => ({
  status: 200,
  ok: true,
  headers: new Headers({ "content-type": "application/json" }),
  body: Readable.from([JSON.stringify({ id: "resp_fixture", status: "completed", output })]),
});

const target = (model, modelFamily) => ({
  id: model,
  provider: "vendor",
  model,
  modelFamily,
  wireApi: "responses",
  contextWindow: 32000,
  maxContextWindow: 32000,
  effectiveContextWindowPercent: 95,
  outputReserveTokens: 1024,
  inputModalities: ["text"],
  compression: { mode: "unsupported" },
  capabilities: { responses: true, toolCalling: true, streaming: true },
});

const config = () => ({
  mode: "fixed",
  fixedTarget: "gpt",
  defaultTarget: "gpt",
  fallbackTarget: "other",
  providers: {
    vendor: {
      baseUrl: "https://vendor.example/v1",
      adapter: "openai-compatible",
      concurrency: 2,
      responsesMessagePhasePolicy: "passthrough",
    },
  },
  targets: {
    gpt: target("gpt", "openai-gpt"),
    other: target("other", "other"),
  },
  rules: [],
  history: {},
  pluginTools: { thirdPartyGpt: { additionalAllowedPlugins: [], excludedDefaultPlugins: [] } },
});

const request = () => ({
  model: "client-model",
  input: [{ role: "user", content: "fixture" }],
  tools: [
    { type: "namespace", name: "mcp__codex_apps__github", untouched: 1 },
    { type: "namespace", name: "mcp__codex_apps__gmail", untouched: 2 },
    { type: "function", name: "mcp__test_mcp__read", untouched: 3 },
    { type: "function", name: "mcp__unknown__read", untouched: 4 },
    { type: "function", name: "exec_command", untouched: 5 },
  ],
});

async function collect(engine, body = request()) {
  const events = [];
  for await (const event of engine.generate(
    "api",
    { "x-opencode-session": "fixture" },
    body,
    new AbortController().signal,
  )) events.push(event);
  return events;
}

test("A3/A4 Engine applies the selected target policy and preserves allowed definitions", async () => {
  let payload;
  const engine = new Engine(config(), {
    toolRegistry: registry,
    send: async (_url, options) => {
      payload = options.body;
      return response();
    },
  });
  await collect(engine);
  assert.deepEqual(payload.tools.map((tool) => tool.name), [
    "mcp__codex_apps__github",
    "mcp__test_mcp__read",
    "mcp__unknown__read",
    "exec_command",
  ]);
  assert.equal(payload.tools[0].untouched, 1);
});

test("A2 Engine logs source counts without tool names or schemas", async () => {
  const logs = [];
  const engine = new Engine(config(), {
    toolRegistry: registry,
    log: (event) => logs.push(event),
    send: async () => response(),
  });
  await collect(engine, {
    model: "client-model",
    input: [{
      type: "additional_tools",
      tools: [{
        type: "namespace",
        name: "mcp__codex_apps__github",
        tools: [{ type: "function", name: "private_fixture", schema: { secret: true } }],
      }],
    }],
  });
  const route = logs.find((event) => event.event === "route");
  assert.deepEqual(route.tool_source_counts, {
    core: 0,
    user_mcp: 0,
    allowed_plugin: 2,
    removed_plugin: 0,
    unknown: 0,
    collision: 0,
  });
  assert.equal(route.inherited_tool_source_count, 1);
  assert.doesNotMatch(JSON.stringify(route), /private_fixture|secret/);
});

test("A3 fallback derives a fresh target view from the unfiltered request", async () => {
  const payloads = [];
  const engine = new Engine(config(), {
    toolRegistry: registry,
    send: async (_url, options) => {
      payloads.push(options.body);
      if (payloads.length === 1) throw fail("upstream_timeout", 504);
      return response();
    },
  });
  await collect(engine);
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].tools.some((tool) => tool.name.includes("gmail")), false);
  assert.equal(payloads[1].tools.some((tool) => tool.name.includes("gmail")), true);
});

test("A4 disallowed Plugin calls become a terminal policy error and never retry", async () => {
  let calls = 0;
  const engine = new Engine(config(), {
    toolRegistry: registry,
    send: async () => {
      calls++;
      return response([{
        type: "function_call",
        name: "mcp__codex_apps__gmail",
        call_id: "call_disallowed",
        arguments: "{}",
      }]);
    },
  });
  await assert.rejects(
    collect(engine),
    (error) => error.type === "disallowed_plugin_tool_call",
  );
  assert.equal(calls, 1);
});

test("A4 streaming HTTP returns an explicit error without delivering a forbidden call", async (t) => {
  const logs = [];
  const events = [
    { type: "response.created", response: { id: "resp_stream", status: "in_progress", output: [] } },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "function_call",
        name: "mcp__codex_apps__gmail",
        call_id: "never_deliver_this_call",
        arguments: "{}",
      },
    },
  ];
  const gateway = createGateway(config(), {
    toolRegistry: registry,
    log: (event) => logs.push(event),
    send: async () => ({
      status: 200,
      ok: true,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: Readable.from(events.map((event) => Buffer.from(`data: ${JSON.stringify(event)}\n\n`))),
    }),
  });
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  t.after(() => gateway.close());
  const result = await fetch(
    `http://127.0.0.1:${gateway.server.address().port}/v1/responses`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request(), stream: true }),
    },
  );
  const body = await result.text();
  assert.equal(logs.at(-1)?.type, "disallowed_plugin_tool_call", JSON.stringify(logs));
  assert.match(body, /disallowed_plugin_tool_call/);
  assert.doesNotMatch(body, /never_deliver_this_call/);
});

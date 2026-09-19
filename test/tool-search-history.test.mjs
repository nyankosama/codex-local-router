import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Archive } from "../src/archive.mjs";
import { Engine } from "../src/engine.mjs";
import {
  TOOL_SEARCH_HISTORY_MARKER,
  canonicalizeToolSearchHistory,
  hasPendingTools,
  portableItems,
} from "../src/history.mjs";

const message = (role, text) => ({
  type: "message",
  role,
  content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
});

const pair = (callId, suffix = callId, tools = []) => [
  {
    type: "tool_search_call",
    id: `provider-call-${suffix}`,
    call_id: callId,
    arguments: `QUERY_SECRET_${suffix}`,
    execution: { opaque: `EXECUTION_SECRET_${suffix}` },
    status: "completed",
  },
  {
    type: "tool_search_output",
    id: `provider-output-${suffix}`,
    call_id: callId,
    execution: { opaque: `OUTPUT_EXECUTION_SECRET_${suffix}` },
    status: "completed",
    tools,
  },
];

const sha = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("tool search pairs become fixed portable markers without leaking provider metadata", () => {
  const [call, output] = pair("search-1", "ONE", [
    {
      type: "namespace",
      name: "mcp__codex_apps__private_plugin",
      description: "SCHEMA_SECRET_ONE",
      tools: [{ name: "private_read", input_schema: { secret: "NESTED_SCHEMA_SECRET" } }],
    },
  ]);
  const input = [
    message("user", "keep-user-message"),
    call,
    { type: "function_call", id: "provider-function-id", call_id: "fn-1", name: "exec_command", arguments: "{}" },
    output,
    { type: "function_call_output", call_id: "fn-1", output: "FUNCTION_RESULT" },
    { type: "custom_tool_call", id: "provider-custom-id", call_id: "custom-1", name: "custom", input: "CUSTOM_INPUT" },
    { type: "custom_tool_call_output", call_id: "custom-1", output: "CUSTOM_RESULT" },
  ];
  const diagnostics = {};
  const portable = portableItems(input, { diagnostics });
  const serialized = JSON.stringify(portable);

  assert.equal(diagnostics.toolSearchPairs, 1);
  assert.equal(portable[1].content[0].text, TOOL_SEARCH_HISTORY_MARKER);
  assert.deepEqual(portable.map((item) => item.type), [
    "message",
    "message",
    "function_call",
    "function_call_output",
    "custom_tool_call",
    "custom_tool_call_output",
  ]);
  assert.equal(portable[2].id, undefined);
  assert.equal(portable[4].id, undefined);
  for (const secret of [
    "QUERY_SECRET_ONE",
    "EXECUTION_SECRET_ONE",
    "OUTPUT_EXECUTION_SECRET_ONE",
    "SCHEMA_SECRET_ONE",
    "NESTED_SCHEMA_SECRET",
    "private_read",
    "provider-call-ONE",
    "provider-output-ONE",
  ]) assert.doesNotMatch(serialized, new RegExp(secret));
  assert.match(serialized, /FUNCTION_RESULT/);
  assert.match(serialized, /CUSTOM_RESULT/);
});

test("visible agent messages and completed search sources remain portable facts", () => {
  const portable = portableItems([
    {
      type: "agent_message",
      text: "delegated result",
      encrypted_content: "provider-private-agent-state",
    },
    {
      type: "web_search_call",
      status: "completed",
      sources: [{ title: "Public source", url: "https://example.test/source" }],
      encrypted_content: "provider-private-search-state",
    },
  ]);
  const serialized = JSON.stringify(portable);
  assert.match(serialized, /delegated result/);
  assert.match(serialized, /Provider-private agent state was not portable/);
  assert.match(serialized, /Public source/);
  assert.match(serialized, /https:\/\/example\.test\/source/);
  assert.doesNotMatch(serialized, /provider-private/);
  assert.throws(
    () => portableItems([{ type: "web_search_call", status: "in_progress" }]),
    (error) => error.type === "history_incompatible",
  );
});

test("multiple interleaved tool search pairs preserve order and allow empty results", () => {
  const [call1, output1] = pair("search-1", "ONE", []);
  const [call2, output2] = pair("search-2", "TWO", [{ type: "function", name: "hidden" }]);
  const input = [
    message("user", "before"),
    call1,
    message("assistant", "between-calls"),
    call2,
    output1,
    message("assistant", "between-outputs"),
    output2,
    message("user", "after"),
  ];
  const diagnostics = {};
  const canonical = canonicalizeToolSearchHistory(input, diagnostics);

  assert.equal(diagnostics.toolSearchPairs, 2);
  assert.deepEqual(
    canonical.map((item) => item.content?.[0]?.text),
    ["before", TOOL_SEARCH_HISTORY_MARKER, "between-calls", TOOL_SEARCH_HISTORY_MARKER, "between-outputs", "after"],
  );
  assert.equal(canonical.some((item) => item.type.startsWith?.("tool_search")), false);
});

test("incomplete, duplicated, reversed and malformed tool search history fails closed", () => {
  const [call, output] = pair("search-1");
  const cases = [
    [call],
    [output],
    [output, call],
    [call, call, output],
    [call, output, output],
    [{ ...call, call_id: "" }, output],
    [{ ...call, call_id: "   " }, { ...output, call_id: "   " }],
  ];
  for (const input of cases)
    assert.throws(
      () => portableItems(input),
      (error) =>
        error.type === "tool_search_history_incomplete" && error.status === 409,
    );
  assert.throws(
    () => hasPendingTools([call]),
    (error) => error.type === "tool_search_history_incomplete",
  );
});

test("tool search canonicalization remains linear for long synthetic histories", { timeout: 5000 }, () => {
  const input = [];
  for (let index = 0; index < 5000; index++) {
    const [call, output] = pair(`search-${index}`, `LONG_${index}`, []);
    input.push(call, output);
  }
  const startedAt = performance.now();
  const portable = portableItems(input);
  const durationMs = performance.now() - startedAt;
  assert.equal(portable.length, 5000);
  assert.ok(durationMs < 5000, `canonicalization took ${durationMs}ms`);
});

const gatewayConfig = () => ({
  mode: "fixed",
  defaultTarget: "feei",
  fixedTarget: "feei",
  fallbackTarget: "chat",
  providers: {
    feei: { baseUrl: "https://provider.invalid/v1", adapter: "openai-compatible" },
    chat: { baseUrl: "https://chat.invalid/v1", adapter: "openai-compatible" },
  },
  targets: {
    feei: {
      id: "feei",
      provider: "feei",
      model: "gpt-5.6-sol",
      modelFamily: "openai-gpt",
      wireApi: "responses",
      inputModalities: ["text"],
      compression: { mode: "summary" },
      capabilities: { responses: true, toolCalling: true, streaming: true },
    },
    chat: {
      id: "chat",
      provider: "chat",
      model: "chat-model-upstream",
      modelFamily: "other",
      wireApi: "chat_completions",
      inputModalities: ["text"],
      compression: { mode: "unsupported" },
      capabilities: { responses: false, toolCalling: true, streaming: true },
    },
  },
  subscription: {
    enabled: true,
    models: ["gpt-official"],
    customModels: { "feei-gpt": "feei", "chat-model": "chat" },
  },
  rules: [],
  history: {},
  pluginTools: {
    thirdPartyGpt: {
      additionalAllowedPlugins: [],
      excludedDefaultPlugins: [],
    },
  },
});

const response = (id, output) => ({
  id,
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

const metadata = (turn) => ({ thread_id: "thread-tool-search", turn_id: turn });

async function generate(engine, model, turn, input, previousResponseId) {
  const events = [];
  for await (const event of engine.generate(
    "subscription",
    { authorization: "Bearer synthetic-subscription" },
    {
      model,
      input,
      client_metadata: metadata(turn),
      ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
    },
    new AbortController().signal,
  )) events.push(event);
  return events.at(-1).response;
}

test("Engine safely migrates tool search history through official, third-party and Chat targets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "router-tool-search-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = new Archive(join(root, "history.sqlite"), Buffer.alloc(32, 7));
  t.after(() => archive.close());
  const payloads = [];
  const logs = [];
  let call = 0;
  const [searchCall, searchOutput] = pair("search-engine", "ENGINE", [
    {
      type: "namespace",
      name: "mcp__codex_apps__private_plugin",
      description: "ENGINE_SCHEMA_SECRET",
    },
    {
      type: "namespace",
      name: "mcp__user_fixture",
      description: "ENGINE_USER_MCP_SCHEMA_SECRET",
    },
  ]);
  const engine = new Engine(gatewayConfig(), {
    archive,
    resolveIdentity: async () => "synthetic-account",
    log: (event) => logs.push(event),
    send: async (url, options) => {
      payloads.push({ url, body: structuredClone(options.body) });
      call++;
      if (call === 1)
        return json(response("resp-feei-search", [
          searchCall,
          searchOutput,
          {
            type: "function_call",
            id: "provider-function-id",
            call_id: "function-engine",
            name: "exec_command",
            arguments: "{}",
          },
        ]));
      return json(response(`resp-${call}`, [message("assistant", `answer-${call}`)]));
    },
  });

  const first = await generate(
    engine,
    "feei-gpt",
    "turn-1",
    [message("user", "remember the synthetic context")],
  );
  const second = await generate(
    engine,
    "feei-gpt",
    "turn-2",
    [{ type: "function_call_output", call_id: "function-engine", output: "FUNCTION_ENGINE_RESULT" }],
    first.id,
  );
  const official = await generate(
    engine,
    "gpt-official",
    "turn-3",
    [message("user", "continue officially")],
    second.id,
  );
  const backToResponses = await generate(
    engine,
    "feei-gpt",
    "turn-4",
    [message("user", "continue on the third party")],
    official.id,
  );
  await generate(
    engine,
    "chat-model",
    "turn-5",
    [message("user", "continue on Chat Completions")],
    backToResponses.id,
  );

  const officialBody = payloads[2].body;
  const responsesBody = payloads[3].body;
  const chatBody = payloads[4].body;
  for (const body of [officialBody, responsesBody]) {
    const serialized = JSON.stringify(body);
    assert.equal(body.input.filter((item) =>
      item.type === "message" && item.content?.[0]?.text === TOOL_SEARCH_HISTORY_MARKER
    ).length, 1);
    assert.equal(body.input.some((item) => item.type.startsWith?.("tool_search")), false);
    assert.match(serialized, /FUNCTION_ENGINE_RESULT/);
    assert.doesNotMatch(serialized, /ENGINE_SCHEMA_SECRET|ENGINE_USER_MCP_SCHEMA_SECRET|QUERY_SECRET_ENGINE/);
  }
  const chatSerialized = JSON.stringify(chatBody);
  assert.match(chatSerialized, new RegExp(TOOL_SEARCH_HISTORY_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(chatSerialized, /FUNCTION_ENGINE_RESULT/);
  assert.doesNotMatch(chatSerialized, /tool_search_|ENGINE_SCHEMA_SECRET|ENGINE_USER_MCP_SCHEMA_SECRET|QUERY_SECRET_ENGINE/);

  const canonicalized = logs.filter((event) =>
    event.event === "tool_search_history_canonicalized"
  );
  assert.deepEqual(canonicalized.map((event) => event.pairs), [1, 1, 1]);
  assert.ok(canonicalized.every((event) => event.thread && event.turn));
  assert.doesNotMatch(JSON.stringify(logs), /QUERY_SECRET_ENGINE|ENGINE_SCHEMA_SECRET|private_plugin/);

  const latest = archive.history({
    owner: "synthetic-account",
    thread: "thread-tool-search",
    branch: "thread-tool-search",
  });
  const archivedCall = latest.original.find((item) => item.type === "tool_search_call");
  const archivedOutput = latest.original.find((item) => item.type === "tool_search_output");
  assert.equal(sha(archivedCall), sha(searchCall));
  assert.equal(sha(archivedOutput), sha(searchOutput));
  assert.equal(latest.view.some((item) => item.type.startsWith?.("tool_search")), false);
  assert.equal(latest.view.filter((item) =>
    item.type === "message" && item.content?.[0]?.text === TOOL_SEARCH_HISTORY_MARKER
  ).length, 1);
});

test("official routing recognizes a single cross-provider tool search item and malformed history never reaches upstream", async () => {
  let sends = 0;
  const engine = new Engine(gatewayConfig(), {
    resolveIdentity: async () => "synthetic-account",
    send: async () => {
      sends++;
      return json(response(`response-${sends}`, [message("assistant", "ok")]));
    },
  });
  await generate(engine, "feei-gpt", "turn-1", [message("user", "prime route")]);
  const decision = await engine.officialRequestNeedsEngine(
    { authorization: "Bearer synthetic-subscription" },
    {
      model: "gpt-official",
      input: [{ type: "tool_search_call", call_id: "single-item", arguments: "{}" }],
      client_metadata: metadata("turn-2"),
    },
  );
  assert.equal(decision.needsEngine, true);
  await assert.rejects(
    generate(
      engine,
      "gpt-official",
      "turn-2",
      [{ type: "tool_search_call", call_id: "missing-output", arguments: "{}" }],
    ),
    (error) =>
      error.type === "tool_search_history_incomplete" && error.status === 409,
  );
  assert.equal(sends, 1);
});

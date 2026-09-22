// Real Tavily extraction and OpenCode Go thinking/tool continuation acceptance.
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Engine } from "../src/engine.mjs";
import { loadConfig, validate } from "../src/config.mjs";
import { request } from "../src/transport.mjs";
import { TavilyWebSearchAdapter } from "../src/websearch.mjs";
import { identity } from "../src/state.mjs";
import { writeAcceptanceEvidence } from "./e2e/lib/evidence-path.mjs";

const report = {
  at: new Date().toISOString(),
  model: "deepseek-v4.1-flash",
  passed: false,
};
const logs = [];
const jsonResponse = (value) => ({
  ok: true,
  status: 200,
  headers: new Headers({ "content-type": "application/json" }),
  body: Readable.from([JSON.stringify(value)]),
});
const collect = async (engine, body) => {
  const events = [];
  for await (const event of engine.generate(
    "api",
    {},
    body,
    new AbortController().signal,
  ))
    events.push(event);
  return events;
};

try {
  const loaded = await loadConfig(
    process.env.GATEWAY_CONFIG ??
      "config/gateway.subscription.local.json",
  );
  const targetId = Object.keys(loaded.targets).find(
    (id) => loaded.targets[id].model === report.model,
  );
  assert.ok(targetId, "DeepSeek target is not configured");

  const tavilyKey =
    process.env[
      loaded.webSearch?.apiKeyEnv ?? "TAVILY_API_KEY"
    ];
  assert.ok(tavilyKey, "Tavily credential is unavailable");
  const extracted = await new TavilyWebSearchAdapter({
    apiKey: tavilyKey,
  }).fetchPage({
    url: "https://docs.tavily.com/documentation/api-reference/endpoint/extract",
    query: "Tavily Extract request and response fields",
    maxCharacters: 4000,
    signal: AbortSignal.timeout(60000),
  });
  assert.ok(extracted.characters >= 500);
  assert.ok(extracted.characters <= 4000);
  report.webFetch = {
    status: "completed",
    characters: extracted.characters,
    truncated: extracted.truncated,
  };

  const input = structuredClone(loaded);
  input.mode = "fixed";
  input.defaultTarget = targetId;
  input.fixedTarget = targetId;
  delete input.fallbackTarget;
  input.history = {
    ...(input.history ?? {}),
    persistent: { enabled: false },
  };
  input.webSearch = {
    backend: "fake",
    maxRounds: 3,
    maxExtractCharacters: 20000,
  };
  const config = validate(input);
  let upstreamCalls = 0;
  let continuationBody;
  const engine = new Engine(config, {
    log: (event) => logs.push(event),
    send: async (url, options) => {
      upstreamCalls++;
      if (upstreamCalls === 1)
        return jsonResponse({
          id: "mixed-search-probe",
          object: "response",
          status: "completed",
          output: [
            {
              type: "reasoning",
              status: "completed",
              content: [
                {
                  type: "reasoning_text",
                  text: "Search and continuation tools are required.",
                },
              ],
            },
            {
              type: "message",
              role: "assistant",
              phase: "commentary",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: "Checking the source and local probe.",
                },
              ],
            },
            {
              type: "function_call",
              name: "gateway_web_search",
              call_id: "internal-search",
              arguments: '{"query":"OpenAI Codex"}',
              status: "completed",
            },
            {
              type: "function_call",
              name: "continuation_probe",
              call_id: "external-probe",
              arguments: "{}",
              status: "completed",
            },
          ],
        });
      continuationBody ??= options.body;
      return request(url, options);
    },
  });
  const common = {
    model: report.model,
    reasoning: { effort: "max", summary: "auto" },
    max_output_tokens: 256,
    tools: [
      { type: "web_search" },
      {
        type: "function",
        name: "continuation_probe",
        description: "A completed no-op acceptance probe",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ],
    stream: true,
  };
  const first = await collect(engine, {
    ...common,
    session_id: "search-continuation-acceptance",
    input: "Search and run the continuation probe.",
  });
  const firstResponse = first.at(-1)?.response;
  assert.equal(firstResponse?.id, "mixed-search-probe");
  assert.deepEqual(
    firstResponse.output
      .filter((item) => item.type === "function_call")
      .map((item) => item.name),
    ["continuation_probe"],
  );
  const second = await collect(engine, {
    ...common,
    session_id: "search-continuation-acceptance",
    previous_response_id: firstResponse.id,
    input: [
      {
        type: "function_call_output",
        call_id: "external-probe",
        output: "probe completed",
      },
    ],
  });
  const secondResponse = second.at(-1)?.response;
  assert.ok(
    ["completed", "incomplete"].includes(secondResponse?.status),
    "OpenCode Go did not accept the corrected continuation",
  );
  const ordered = continuationBody.input.filter((item) =>
    ["reasoning", "function_call", "function_call_output"].includes(
      item.type,
    ),
  );
  const firstOutput = ordered.findIndex(
    (item) => item.type === "function_call_output",
  );
  const lastCall = ordered.findLastIndex(
    (item) => item.type === "function_call",
  );
  assert.ok(ordered.some((item) => item.type === "reasoning"));
  assert.ok(lastCall >= 0 && lastCall < firstOutput);
  assert.deepEqual(
    ordered.map((item) => `${item.type}:${item.call_id ?? "reasoning"}`),
    [
      "reasoning:reasoning",
      "function_call:internal-search",
      "function_call:external-probe",
      "function_call_output:internal-search",
      "function_call_output:external-probe",
    ],
  );
  report.continuation = {
    status: secondResponse.status,
    reasoningEffort: continuationBody.reasoning?.effort,
    order: ordered.map(
      (item) => `${item.type}:${item.call_id ?? "reasoning"}`,
    ),
    upstreamCalls,
  };

  let legacyBody;
  const legacyEngine = new Engine(config, {
    log: (event) => logs.push(event),
    send: async (url, options) => {
      legacyBody ??= options.body;
      return request(url, options);
    },
  });
  const legacySession = "legacy-search-continuation-acceptance";
  const legacyContext = identity("api", {}, { session_id: legacySession });
  const legacyReasoning = {
    type: "reasoning",
    status: "completed",
    content: [
      {
        type: "reasoning_text",
        text: "The search and external diagnostic are required.",
      },
    ],
  };
  const legacyExternal = {
    type: "function_call",
    name: "continuation_probe",
    call_id: "legacy-external",
    arguments: "{}",
    status: "completed",
  };
  const legacyBase = [
    {
      type: "message",
      role: "user",
      content: "Use the completed diagnostics and reply OK.",
    },
    legacyReasoning,
    legacyExternal,
  ];
  legacyEngine.state.set(
    `response:${legacyContext.owner}:legacy-response`,
    {
      input: legacyBase,
      original: legacyBase,
      target: config.targets[targetId],
    },
    legacyContext,
  );
  legacyEngine.state.set(
    `search:${legacyContext.owner}:legacy-external`,
    [
      {
        type: "function_call",
        name: "gateway_web_search",
        call_id: "legacy-internal",
        arguments: '{"query":"OpenAI Codex"}',
        status: "completed",
      },
      {
        type: "function_call_output",
        call_id: "legacy-internal",
        output: '{"query":"OpenAI Codex","results":[]}',
      },
    ],
    legacyContext,
  );
  const legacyEvents = await collect(legacyEngine, {
    ...common,
    session_id: legacySession,
    previous_response_id: "legacy-response",
    input: [
      {
        type: "function_call_output",
        call_id: "legacy-external",
        output: "probe completed",
      },
    ],
  });
  const legacyResponse = legacyEvents.at(-1)?.response;
  assert.ok(
    ["completed", "incomplete"].includes(legacyResponse?.status),
    "OpenCode Go did not accept the repaired legacy continuation",
  );
  const legacyOrder = legacyBody.input
    .filter((item) =>
      ["reasoning", "function_call", "function_call_output"].includes(
        item.type,
      ),
    )
    .map((item) => `${item.type}:${item.call_id ?? "reasoning"}`);
  assert.deepEqual(legacyOrder, [
    "reasoning:reasoning",
    "function_call:legacy-internal",
    "function_call:legacy-external",
    "function_call_output:legacy-internal",
    "function_call_output:legacy-external",
  ]);
  assert.ok(
    logs.some((event) => event.event === "legacy_search_history_restored"),
  );
  report.legacyContinuation = {
    status: legacyResponse.status,
    order: legacyOrder,
    restored: true,
  };
  report.passed = true;
  console.log(
    JSON.stringify({ event: "search_continuation_acceptance_passed", ...report }),
  );
} catch (error) {
  report.failure = error.message;
  report.diagnostics = logs
    .filter((event) =>
      ["provider_error", "request_error"].includes(event.event),
    )
    .map((event) => ({
      event: event.event,
      status: event.status,
      type: event.type,
      category: event.category,
      code: event.code,
      param: event.param,
    }));
  console.log(
    JSON.stringify({
      event: "search_continuation_acceptance_failed",
      reason: error.message,
    }),
  );
  process.exitCode = 1;
} finally {
  await writeAcceptanceEvidence("search-continuation.json", report, { projectRoot: resolve(".") });
}

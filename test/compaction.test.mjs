import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { Engine } from "../src/engine.mjs";
import { createGateway } from "../src/server.mjs";
import { identity, threadOwner } from "../src/state.mjs";
import { buildModelCatalog } from "../src/model-catalog.mjs";
import { Archive } from "../src/archive.mjs";
import { expandCheckpoints, portableItems } from "../src/history.mjs";

const GPT = "gpt-5.6-sol",
  DS = "deepseek-v4.1-flash";
const config = () => ({
  mode: "fixed",
  defaultTarget: "go",
  fixedTarget: "go",
  providers: { go: { baseUrl: "http://127.0.0.1:9000" } },
  targets: {
    go: {
      id: "go",
      provider: "go",
      model: DS,
      wireApi: "responses",
      contextWindow: 400000,
      effectiveContextWindowPercent: 95,
      outputReserveTokens: 16384,
      inputModalities: ["text"],
      compression: { mode: "summary" },
      capabilities: {},
    },
  },
  subscription: { enabled: true, models: [GPT], customModels: { [DS]: "go" } },
});
const headers = {
  authorization: "Bearer test",
  "thread-id": "thread",
  "turn-id": "stale",
};
const metadata = (turn, kind = "turn", thread = "thread", reason) => ({
  "x-codex-turn-metadata": JSON.stringify({
    thread_id: thread,
    turn_id: turn,
    request_kind: kind,
    compaction:
      kind === "compaction" ? { phase: "pre_turn", reason } : undefined,
  }),
});
const msg = (role, text) => ({
  type: "message",
  role,
  content: [
    { type: role === "assistant" ? "output_text" : "input_text", text },
  ],
});
const opaque = {
  type: "compaction",
  encrypted_content: "official-opaque-test-only",
};
const result = (output) => ({
  id: "r" + Math.random(),
  status: "completed",
  output,
});
const json = (r) => ({
  ok: true,
  status: 200,
  headers: new Headers({ "content-type": "application/json" }),
  body: Readable.from([JSON.stringify(r)]),
});
const upstreamError = (status, code, message) => ({
  ok: false,
  status,
  headers: new Headers({ "content-type": "application/json" }),
  body: Readable.from([
    JSON.stringify({ error: { code, message, type: code } }),
  ]),
});
const call = async (
  e,
  model,
  turn,
  input,
  kind = "turn",
  h = headers,
  previousResponseId,
  clientMetadata,
) => {
  const events = [];
  for await (const event of e.generate(
    "subscription",
    h,
    {
      model,
      input,
      client_metadata: clientMetadata ?? metadata(turn, kind),
      ...(previousResponseId
        ? { previous_response_id: previousResponseId }
        : {}),
    },
    new AbortController().signal,
  ))
    events.push(event);
  return events.at(-1).response;
};

test("frame metadata wins over stale WS headers and compaction trigger has deterministic classification", () => {
  const h = {
    ...headers,
    "x-codex-turn-metadata": JSON.stringify({
      turn_id: "old",
      thread_id: "old",
    }),
  };
  assert.equal(
    identity("subscription", h, { client_metadata: metadata("new") }).turn,
    "new",
  );
  assert.equal(
    identity("subscription", h, {
      client_metadata: { turn_id: "flat", thread_id: "flat" },
    }).turn,
    "flat",
  );
  assert.equal(
    identity("subscription", h, { input: [{ type: "compaction_trigger" }] })
      .requestKind,
    "compaction",
  );
  assert.throws(
    () =>
      identity("subscription", h, {
        client_metadata: { "x-codex-turn-metadata": "invalid" },
      }),
    /invalid_turn_metadata/,
  );
});

test("provider-private reasoning becomes an explicit migration marker", () => {
  const portable = portableItems([
    { type: "reasoning", encrypted_content: "opaque-provider-state" },
  ]);
  assert.match(JSON.stringify(portable), /Provider-private reasoning state/);
  assert.ok(!JSON.stringify(portable).includes("opaque-provider-state"));
});

test("same turn old-model compaction then new-model inference in both directions preserves history and tool results", async () => {
  const seen = [],
    logs = [];
  const e = new Engine(config(), {
    log: (x) => logs.push(x),
    send: async (url, o) => {
      seen.push(o.body);
      return json(
        result(
          o.body.input.some((x) => x.type === "compaction_trigger")
            ? [opaque]
            : [msg("assistant", "done")],
        ),
      );
    },
  });
  const history = [
    msg("user", "Remember BLUE_739"),
    msg("assistant", "BLUE_739"),
    {
      type: "function_call",
      id: "provider_specific_item_id",
      name: "read",
      call_id: "tool1",
      arguments: "{}",
    },
    { type: "function_call_output", call_id: "tool1", output: "READ_482" },
  ];
  await call(e, GPT, "one", history);
  const c1 = await call(
    e,
    GPT,
    "two",
    [...history, { type: "compaction_trigger" }],
    "compaction",
  );
  await call(e, DS, "two", [
    history[0],
    ...c1.output,
    msg("user", "Recall both"),
  ]);
  const migrated = seen.at(-1).input;
  assert.equal(
    migrated.filter(
      (x) => x.role === "user" && x.content[0].text === "Remember BLUE_739",
    ).length,
    1,
  );
  assert.ok(
    migrated.some((x) => x.call_id === "tool1" && x.output === "READ_482"),
  );
  assert.equal(migrated.find((x) => x.type === "function_call").id, undefined);
  assert.ok(!JSON.stringify(migrated).includes(opaque.encrypted_content));
  await assert.rejects(
    call(e, GPT, "two", migrated),
    /model_change_during_turn/,
  );
  const c2 = await call(
    e,
    DS,
    "three",
    [...migrated, { type: "compaction_trigger" }],
    "compaction",
  );
  assert.match(c2.output[0].encrypted_content, /^gateway-checkpoint-v1:/);
  await call(e, GPT, "three", [
    history[0],
    ...c2.output,
    msg("user", "Recall again"),
  ]);
  assert.ok(JSON.stringify(seen.at(-1).input).includes("READ_482"));
  assert.ok(!JSON.stringify(seen.at(-1).input).includes("gateway-checkpoint"));
  assert.equal(logs.filter((x) => x.event === "history_migrated").length, 2);
  assert.ok(!JSON.stringify(logs).includes("Remember BLUE_739"));
  assert.ok(!JSON.stringify(logs).includes("official-opaque-test-only"));
});

test("native compact content stays on its provider; checkpoint expiry and authentication mismatch fail closed", async () => {
  const seen = [];
  const e = new Engine(config(), {
    send: async (url, o) => {
      seen.push(o.body);
      return json(
        result(
          o.body.input.some((x) => x.type === "compaction_trigger")
            ? [opaque]
            : [msg("assistant", "ok")],
        ),
      );
    },
  });
  const c = await call(
    e,
    GPT,
    "one",
    [msg("user", "hi"), { type: "compaction_trigger" }],
    "compaction",
  );
  await call(e, GPT, "one", c.output);
  assert.ok(
    seen
      .at(-1)
      .input.some((x) => x.encrypted_content === opaque.encrypted_content),
  );
  await assert.rejects(
    call(e, DS, "two", c.output, "turn", {
      ...headers,
      authorization: "Bearer other",
    }),
    /Compacted history/,
  );
  e.state.items.clear();
  e.state.bytes = 0;
  await assert.rejects(call(e, DS, "two", c.output), /Compacted history/);
});

test("a trusted fork inherits the exact portable parent checkpoint and persists its own copy", async () => {
  const seen = [], logs = [];
  const e = new Engine(config(), {
    log: (event) => logs.push(event),
    send: async (_, options) => {
      seen.push(options.body);
      return json(result([msg("assistant", "fork continued")]));
    },
  });
  const parentHeaders = { ...headers, "thread-id": "parent-thread" };
  const parentCtx = identity("subscription", parentHeaders, {
    client_metadata: metadata("parent", "turn", "parent-thread"),
  });
  const item = {
    type: "compaction",
    encrypted_content: "fork-parent-opaque-test-only",
  };
  const checkpoint = {
    provider: "chatgpt-subscription",
    model: GPT,
    targetId: `official:${GPT}`,
    original: [msg("user", "PORTABLE_FORK_731")],
    virtual: false,
  };
  const digest = createHash("sha256")
    .update(item.encrypted_content)
    .digest("hex");
  e.state.set(`checkpoint:${parentCtx.owner}:${digest}`, checkpoint, parentCtx);

  const forkThread = "fork-thread";
  const forkMetadata = {
    "x-codex-turn-metadata": JSON.stringify({
      thread_id: forkThread,
      parent_thread_id: "parent-thread",
      turn_id: "fork-turn",
    }),
  };
  await call(
    e,
    DS,
    "fork-turn",
    [item, msg("user", "continue")],
    "turn",
    { ...headers, "thread-id": forkThread },
    undefined,
    forkMetadata,
  );
  assert.match(JSON.stringify(seen[0].input), /PORTABLE_FORK_731/);
  assert.doesNotMatch(JSON.stringify(seen[0].input), /fork-parent-opaque/);
  assert.equal(
    logs.filter((event) => event.event === "checkpoint_inherited_from_parent")
      .length,
    1,
  );
  const forkAuth = identity("subscription", headers, {}).auth;
  assert.deepEqual(
    e.state.get(`checkpoint:${threadOwner(forkAuth, forkThread)}:${digest}`),
    checkpoint,
  );
});

test("fork inheritance rejects a wrong parent or compaction hash and stays below the local lookup budget", () => {
  const e = new Engine(config(), { send: async () => json(result([])) });
  const parentCtx = identity("subscription", headers, {
    client_metadata: metadata("parent", "turn", "parent-thread"),
  });
  const item = { type: "compaction", encrypted_content: "exact-parent-hash" };
  const digest = createHash("sha256").update(item.encrypted_content).digest("hex");
  e.state.set(`checkpoint:${parentCtx.owner}:${digest}`, {
    provider: "chatgpt-subscription",
    model: GPT,
    targetId: `official:${GPT}`,
    original: [msg("user", "portable")],
    virtual: false,
  }, parentCtx);

  const target = config().targets.go;
  for (const [parentThread, encryptedContent] of [
    ["wrong-parent", item.encrypted_content],
    ["parent-thread", "different-compaction-hash"],
  ]) {
    const ctx = identity("subscription", headers, {
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: `fork-${parentThread}-${encryptedContent}`,
          parent_thread_id: parentThread,
        }),
      },
    });
    assert.throws(
      () => expandCheckpoints(e.state, ctx, [{ ...item, encrypted_content: encryptedContent }], target, { portable: true }),
      (error) => error.type === "compaction_history_unavailable",
    );
  }

  const samples = [];
  for (let index = 0; index < 200; index++) {
    const ctx = identity("subscription", headers, {
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: `benchmark-fork-${index}`,
          parent_thread_id: "parent-thread",
        }),
      },
    });
    const started = performance.now();
    expandCheckpoints(e.state, ctx, [item], target, { portable: true });
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  assert.ok(samples[Math.floor(samples.length * 0.95)] < 10);
});

test("fork inheritance fails closed without a portable parent and keeps official continuation native", async () => {
  const seen = [], logs = [];
  const e = new Engine(config(), {
    log: (event) => logs.push(event),
    send: async (_, options) => {
      seen.push(options.body);
      return json(result([msg("assistant", "ok")]));
    },
  });
  const item = {
    type: "compaction",
    encrypted_content: "fork-nonportable-test-only",
  };
  const parentCtx = identity("subscription", headers, {
    client_metadata: metadata("parent", "turn", "parent-thread"),
  });
  const digest = createHash("sha256")
    .update(item.encrypted_content)
    .digest("hex");
  e.state.set(
    `checkpoint:${threadOwner(parentCtx.auth, "parent-thread")}:${digest}`,
    {
      provider: "chatgpt-subscription",
      model: GPT,
      targetId: `official:${GPT}`,
      virtual: false,
    },
    parentCtx,
  );
  const forkMetadata = {
    "x-codex-turn-metadata": JSON.stringify({
      thread_id: "fork-thread",
      parent_thread_id: "parent-thread",
      turn_id: "fork-turn",
    }),
  };
  await assert.rejects(
    call(
      e,
      DS,
      "fork-turn",
      [item],
      "turn",
      headers,
      undefined,
      forkMetadata,
    ),
    /Compacted history/,
  );
  assert.equal(seen.length, 0);
  assert.ok(
    logs.some(
      (event) =>
        event.event === "checkpoint_parent_unavailable" &&
        event.reason === "portable_source_missing",
    ),
  );

  await call(
    e,
    GPT,
    "official-turn",
    [item],
    "turn",
    headers,
    undefined,
    {
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: "official-fork",
        parent_thread_id: "missing-parent",
        turn_id: "official-turn",
      }),
    },
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].input[0].encrypted_content, item.encrypted_content);

  await assert.rejects(
    call(
      e,
      DS,
      "wrong-account",
      [item],
      "turn",
      { ...headers, authorization: "Bearer other" },
      undefined,
      forkMetadata,
    ),
    /Compacted history/,
  );
  assert.equal(seen.length, 1);
});

test("summary-mode compaction makes exactly one source-model call with tools disabled", async () => {
  const seen = [];
  const e = new Engine(config(), {
    send: async (u, o) => {
      seen.push(o.body);
      return json(
        result([
          msg(
            "assistant",
            "Preserved code FACT_902; read completed, no repeat.",
          ),
        ]),
      );
    },
  });
  const c = await call(
    e,
    DS,
    "one",
    [
      msg("user", "FACT_902 " + "a".repeat(70000)),
      msg("assistant", "Earlier work completed."),
      msg("user", "CURRENT_903 must remain verbatim"),
      { type: "compaction_trigger" },
    ],
    "compaction",
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].model, DS);
  assert.deepEqual(seen[0].tools, []);
  assert.ok(!JSON.stringify(seen[0].input).includes("CURRENT_903"));
  await call(e, GPT, "one", c.output);
  assert.ok(JSON.stringify(seen.at(-1).input).includes("FACT_902"));
  assert.ok(JSON.stringify(seen.at(-1).input).includes("CURRENT_903"));
  const bad = new Engine(config(), {
    send: async () => json({ status: "incomplete", output: [] }),
  });
  await assert.rejects(
    call(
      bad,
      DS,
      "one",
      [
        msg("user", "x".repeat(70000)),
        msg("assistant", "old answer"),
        msg("user", "current"),
        { type: "compaction_trigger" },
      ],
      "compaction",
    ),
    /compaction_summary_failed/,
  );
});

test("same-model recompression summarizes the active view while retaining the full original", async () => {
  const seen = [];
  let summaries = 0;
  const e = new Engine(config(), {
    send: async (_, options) => {
      seen.push(options.body);
      summaries++;
      return json(result([msg("assistant", `ACTIVE_SUMMARY_${summaries}`)]));
    },
  });
  const first = await call(
    e,
    DS,
    "compact-one",
    [
      msg("user", "FULL_ORIGINAL_101"),
      msg("assistant", "old answer"),
      msg("user", "CURRENT_ONE_102"),
      { type: "compaction_trigger" },
    ],
    "compaction",
  );
  const second = await call(
    e,
    DS,
    "compact-two",
    [
      ...first.output,
      msg("user", "CURRENT_TWO_103"),
      { type: "compaction_trigger" },
    ],
    "compaction",
  );
  assert.equal(summaries, 2);
  assert.match(JSON.stringify(seen[1].input), /ACTIVE_SUMMARY_1/);
  assert.match(JSON.stringify(seen[1].input), /CURRENT_ONE_102/);
  assert.doesNotMatch(JSON.stringify(seen[1].input), /FULL_ORIGINAL_101/);
  const ctx = identity("subscription", headers, {
    client_metadata: metadata("inspect"),
  });
  const checkpoint = e.state.get(
    "checkpoint:" +
      ctx.owner +
      ":" +
      createHash("sha256")
        .update(second.output[0].encrypted_content)
        .digest("hex"),
  );
  assert.match(JSON.stringify(checkpoint.original), /FULL_ORIGINAL_101/);
  assert.match(JSON.stringify(checkpoint.view), /CURRENT_TWO_103/);
});

test("model-downshift compaction stores a lossless prepared checkpoint and does not call a summary model", async () => {
  const seen = [];
  const e = new Engine(config(), {
    send: async (_, options) => {
      seen.push(options.body);
      return json(result([msg("assistant", "fits") ]));
    },
  });
  let checkpoint;
  for await (const event of e.generate(
    "subscription",
    headers,
    {
      model: DS,
      input: [msg("user", "LOSSLESS_612"), { type: "compaction_trigger" }],
      client_metadata: metadata(
        "downshift",
        "compaction",
        "thread",
        "model_downshift",
      ),
    },
    new AbortController().signal,
  ))
    if (event.type === "response.completed") checkpoint = event.response;
  assert.equal(seen.length, 0);
  await call(e, GPT, "downshift", checkpoint.output);
  assert.equal(seen.length, 1);
  assert.match(JSON.stringify(seen[0].input), /LOSSLESS_612/);
});

test("explicit target overflow triggers one persisted source summary; estimates and other errors do not", async () => {
  const seen = [];
  let gptAttempts = 0;
  const e = new Engine(config(), {
    send: async (_, options) => {
      seen.push(options.body);
      if (options.body.model === DS && options.body.instructions)
        return json(result([msg("assistant", "Keep OVERFLOW_314 and completed tools.")]));
      if (options.body.model === GPT && ++gptAttempts === 1)
        return upstreamError(
          400,
          "context_length_exceeded",
          "maximum context length exceeded",
        );
      return json(result([msg("assistant", "done") ]));
    },
  });
  await call(e, DS, "source", [msg("user", "OVERFLOW_314")]);
  await call(e, GPT, "target", [
    msg("user", "OVERFLOW_314"),
    msg("user", "continue"),
  ]);
  const summaries = seen.filter(
    (body) => body.model === DS && body.instructions?.startsWith("Create one factual"),
  );
  assert.equal(summaries.length, 1);
  assert.deepEqual(summaries[0].tools, []);
  assert.equal(gptAttempts, 2);
  assert.match(JSON.stringify(seen.at(-1).input), /Keep OVERFLOW_314/);

  let calls = 0;
  const other = new Engine(config(), {
    send: async () => {
      calls++;
      return upstreamError(401, "invalid_api_key", "invalid credentials");
    },
  });
  await assert.rejects(call(other, GPT, "auth", [msg("user", "x")]), /provider_error/);
  assert.equal(calls, 1);
});

test("a migration summary is generated once and a second explicit overflow fails without recursive compression", async () => {
  let summaries = 0;
  const e = new Engine(config(), {
    send: async (_, options) => {
      if (options.body.model === DS && options.body.instructions) {
        summaries++;
        return json(result([msg("assistant", "single summary") ]));
      }
      if (options.body.model === GPT)
        return upstreamError(
          400,
          "context_length_exceeded",
          "context window limit exceeded",
        );
      return json(result([msg("assistant", "source") ]));
    },
  });
  await call(e, DS, "source", [msg("user", "too large")]);
  await assert.rejects(
    call(e, GPT, "target", [msg("user", "too large"), msg("user", "go")]),
    /one persisted migration summary/,
  );
  assert.equal(summaries, 1);
});

test("pending tools cannot be compacted away; config snapshot is shared and unlisted official models pass", async () => {
  const e = new Engine(config(), {
    send: async () => json(result([msg("assistant", "ok")])),
  });
  await assert.rejects(
    call(
      e,
      DS,
      "one",
      [
        {
          type: "function_call",
          call_id: "pending",
          name: "read",
          arguments: "{}",
        },
        { type: "compaction_trigger" },
      ],
      "compaction",
    ),
    /Finish outstanding tool calls/,
  );
  const c = await call(
    e,
    DS,
    "two",
    [
      msg("user", "old"),
      msg("assistant", "old answer"),
      msg("user", "hi"),
      { type: "compaction_trigger" },
    ],
    "compaction",
  );
  const next = config();
  next.subscription.models = [];
  e.update(next);
  await call(e, GPT, "two", c.output);
  await call(e, GPT, "three", c.output);
});

test("production reused WebSocket accepts same-turn compaction and model switch, with per-frame turn IDs", async (t) => {
  const seen = [], officialSeen = [];
  class FakeOfficialSocket extends EventEmitter {
    constructor() {
      super();
      this.readyState = 0;
      queueMicrotask(() => { this.readyState = 1; this.emit("open"); });
    }
    send(data, _options, callback) {
      const request = JSON.parse(Buffer.from(data).toString());
      officialSeen.push(request.model);
      callback();
      const response = result([msg("assistant", "WS_MEMORY_503")]);
      queueMicrotask(() => {
        this.emit("message", Buffer.from(JSON.stringify({
          type: "response.created",
          response: { ...response, status: "in_progress", output: [] },
        })), false);
        this.emit("message", Buffer.from(JSON.stringify({
          type: "response.completed",
          response,
        })), false);
      });
    }
    close() { this.readyState = 3; this.emit("close"); }
    terminate() { this.close(); }
  }
  const gw = createGateway(config(), {
    log: () => {},
    send: async (u, o) => {
      seen.push(o.body);
      return json(
        result(
          o.body.input.some((x) => x.type === "compaction_trigger")
            ? [opaque]
            : [msg("assistant", "WS_MEMORY_503")],
        ),
      );
    },
    createOfficialWebSocket: () => new FakeOfficialSocket(),
  });
  await new Promise((r) => gw.server.listen(0, "127.0.0.1", r));
  t.after(() => gw.close());
  const ws = new WebSocket(
    `ws://127.0.0.1:${gw.server.address().port}/subscription/v1/responses`,
    { headers },
  );
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", j);
  });
  const request = (model, turn, input, kind = "turn") =>
    new Promise((resolve, reject) => {
      const fn = (raw) => {
        const event = JSON.parse(raw);
        if (event.type === "error" || event.type === "response.completed") {
          ws.off("message", fn);
          event.type === "error"
            ? reject(Error(event.error.message))
            : resolve(event.response);
        }
      };
      ws.on("message", fn);
      ws.send(
        JSON.stringify({
          type: "response.create",
          model,
          input,
          client_metadata: metadata(turn, kind),
        }),
      );
    });
  await request(GPT, "a", [msg("user", "WS_MEMORY_503")]);
  const c = await request(
    GPT,
    "b",
    [msg("user", "WS_MEMORY_503"), { type: "compaction_trigger" }],
    "compaction",
  );
  await request(DS, "b", c.output);
  await request(GPT, "c", [msg("user", "WS_MEMORY_503")]);
  assert.deepEqual(
    seen.map((x) => x.model),
    [GPT, DS],
  );
  assert.deepEqual(officialSeen, [GPT, GPT]);
  ws.close();
});

test("Responses Lite per-frame protocol header is isolated and tool declarations are excluded from checkpoints", async () => {
  const seen = [];
  const e = new Engine(config(), {
    send: async (u, o) => {
      seen.push(o);
      return json(
        result(
          o.body.input.some((x) => x.type === "compaction_trigger")
            ? [opaque]
            : [msg("assistant", "ok")],
        ),
      );
    },
  });
  const body = {
    model: GPT,
    client_metadata: {
      ...metadata("one", "compaction"),
      ws_request_header_x_openai_internal_codex_responses_lite: "true",
    },
    input: [
      { type: "additional_tools", tools: [] },
      msg("user", "PORTABLE_LITE"),
      { type: "compaction_trigger" },
    ],
  };
  let response;
  for await (const event of e.generate(
    "subscription",
    headers,
    body,
    new AbortController().signal,
  ))
    if (event.type === "response.completed") response = event.response;
  assert.equal(
    seen[0].headers["x-openai-internal-codex-responses-lite"],
    "true",
  );
  await call(e, DS, "one", response.output);
  assert.equal(
    seen.at(-1).headers["x-openai-internal-codex-responses-lite"],
    undefined,
  );
  assert.ok(!seen.at(-1).body.input.some((x) => x.type === "additional_tools"));
  assert.ok(JSON.stringify(seen.at(-1).body.input).includes("PORTABLE_LITE"));
});

test("cross-provider Responses Lite keeps only current tools and closes a core tool call", async () => {
  const c = config();
  c.targets.go.modelFamily = "openai-gpt";
  c.targets.go.app = { enabled: true, useResponsesLite: true };
  const seen = [], logs = [];
  const e = new Engine(c, {
    log: (event) => logs.push(event),
    toolRegistry: {
      pluginApps: new Set(),
      pluginMcpServers: new Set(["acceptance_github", "acceptance_gmail"]),
      pluginMcpOwners: new Map([
        ["acceptance_github", "github"],
        ["acceptance_gmail", "gmail"],
      ]),
      userMcpServers: new Set(["router_acceptance"]),
      coreNamespaces: new Set(["functions"]),
    },
    send: async (_, options) => {
      seen.push(options.body);
      if (options.body.model !== DS)
        return json(result([msg("assistant", "official source")]));
      if (
        options.body.input.some(
          (item) =>
            item.type === "function_call_output" &&
            item.call_id === "call_lite_core",
        )
      )
        return json(result([msg("assistant", "LITE_CORE_RESULT_USED")]));
      return json(
        result([
          {
            type: "function_call",
            name: "exec_command",
            call_id: "call_lite_core",
            arguments: "{}",
            status: "completed",
          },
        ]),
      );
    },
  });
  const historicalCarrier = {
    type: "additional_tools",
    tools: [{ type: "function", name: "stale_history_tool" }],
  };
  const source = await call(e, GPT, "lite-source", [
    historicalCarrier,
    msg("user", "source turn"),
  ]);
  const currentCarrier = {
    type: "additional_tools",
    tools: [
      {
        type: "namespace",
        name: "functions",
        tools: [{ type: "function", name: "exec_command" }],
      },
      {
        type: "namespace",
        name: "mcp__acceptance_github",
        tools: [{ type: "function", name: "read_allowed" }],
      },
      {
        type: "namespace",
        name: "mcp__acceptance_gmail",
        tools: [{ type: "function", name: "read_forbidden" }],
      },
      {
        type: "namespace",
        name: "mcp__router_acceptance",
        tools: [{ type: "function", name: "read_user" }],
      },
    ],
  };
  const switched = await call(
    e,
    DS,
    "lite-switch",
    [currentCarrier, msg("user", "use the core tool")],
    "turn",
    headers,
    source.id,
  );
  const migrated = seen.filter((body) => body.model === DS).at(-1);
  const carriers = migrated.input.filter(
    (item) => item.type === "additional_tools",
  );
  const names = carriers.flatMap((item) => item.tools.map((tool) => tool.name));
  assert.equal(carriers.length, 1);
  assert.deepEqual(names, [
    "functions",
    "mcp__acceptance_github",
    "mcp__router_acceptance",
  ]);
  assert.doesNotMatch(JSON.stringify(migrated), /stale_history_tool|read_forbidden/);
  assert.equal(switched.output[0].name, "exec_command");
  const completed = await call(
    e,
    DS,
    "lite-result",
    [
      {
        type: "function_call_output",
        call_id: "call_lite_core",
        output: "CORE_RESULT_804",
      },
    ],
    "turn",
    headers,
    switched.id,
  );
  assert.match(completed.output[0].content[0].text, /LITE_CORE_RESULT_USED/);
  assert.match(JSON.stringify(seen.at(-1).input), /CORE_RESULT_804/);
  assert.ok(
    logs.some(
      (event) =>
        event.event === "plugin_tools_filtered" && event.removed_count > 0,
    ),
  );
  assert.ok(
    logs.some(
      (event) =>
        event.event === "route" &&
        event.model === DS &&
        event.additional_tool_definitions === 3 &&
        event.effective_tool_definitions === 3,
    ),
  );
});

test("migration summary restores the current Responses Lite tool carrier", async () => {
  const c = config();
  c.targets.go.modelFamily = "openai-gpt";
  c.targets.go.app = { enabled: true, useResponsesLite: true };
  const seen = [];
  let targetAttempts = 0;
  const e = new Engine(c, {
    send: async (_, options) => {
      seen.push(options.body);
      if (options.body.model === DS && ++targetAttempts === 1)
        return upstreamError(
          400,
          "context_length_exceeded",
          "maximum context length exceeded",
        );
      if (options.body.instructions?.startsWith("Create one factual"))
        return json(result([msg("assistant", "MIGRATION_SUMMARY_805")]));
      return json(result([msg("assistant", "done")]));
    },
  });
  await call(e, GPT, "summary-source", [msg("user", "source")]);
  const carrier = {
    type: "additional_tools",
    tools: [{ type: "function", name: "exec_command" }],
  };
  await call(e, DS, "summary-target", [
    carrier,
    msg("user", "older portable text"),
    msg("user", "current request"),
  ]);
  const targetBodies = seen.filter((body) => body.model === DS);
  assert.equal(targetBodies.length, 2);
  assert.equal(
    targetBodies.at(-1).input.filter((item) => item.type === "additional_tools")
      .length,
    1,
  );
  assert.match(JSON.stringify(targetBodies.at(-1).input), /MIGRATION_SUMMARY_805/);
  const summaryRequest = seen.find((body) =>
    body.instructions?.startsWith("Create one factual"),
  );
  assert.deepEqual(summaryRequest.tools, []);
  assert.doesNotMatch(JSON.stringify(summaryRequest.input), /additional_tools/);
});

test("custom prewarm retains Lite tool definitions for incremental first inference without calling upstream", async (t) => {
  const seen = [];
  const gw = createGateway(config(), {
    log: () => {},
    send: async (u, o) => {
      seen.push(o.body);
      return json(result([msg("assistant", "ok")]));
    },
  });
  await new Promise((r) => gw.server.listen(0, "127.0.0.1", r));
  t.after(() => gw.close());
  const ws = new WebSocket(
    `ws://127.0.0.1:${gw.server.address().port}/subscription/v1/responses`,
    { headers },
  );
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", j);
  });
  const request = (body) =>
    new Promise((r, j) => {
      const fn = (raw) => {
        const e = JSON.parse(raw);
        if (e.type === "response.completed" || e.type === "error") {
          ws.off("message", fn);
          e.type === "error" ? j(Error(e.error.message)) : r(e.response);
        }
      };
      ws.on("message", fn);
      ws.send(JSON.stringify({ type: "response.create", model: DS, ...body }));
    });
  const prefix = {
    type: "additional_tools",
    tools: [{ type: "function", name: "exec_command" }],
  };
  const warm = await request({
    generate: false,
    input: [prefix, msg("system", "PREFIX")],
  });
  assert.equal(seen.length, 0);
  await request({
    previous_response_id: warm.id,
    input: [msg("user", "read")],
    client_metadata: metadata("new"),
  });
  assert.deepEqual(seen[0].input, [
    prefix,
    msg("system", "PREFIX"),
    msg("user", "read"),
  ]);
  ws.close();
});

test("custom catalog uses explicit 400K metadata without claiming GPT compaction compatibility", () => {
  const source = {
    models: [
      {
        slug: "gpt-5.5",
        comp_hash: "2911",
        context_window: 272000,
        use_responses_lite: true,
        supports_image_detail_original: true,
      },
    ],
  };
  const c = buildModelCatalog(source);
  const d = c.models.find((x) => x.slug === DS);
  assert.equal(d.comp_hash, undefined);
  assert.equal(d.context_window, 400000);
  assert.equal(d.max_context_window, 400000);
  assert.equal(d.use_responses_lite, false);
  assert.equal(d.supports_image_detail_original, true);
  assert.deepEqual(d.input_modalities, ["text", "image"]);
  assert.deepEqual(
    d.supported_reasoning_levels.map((level) => level.effort),
    ["low", "medium", "high", "xhigh", "max"],
  );
  assert.equal(source.models.length, 1);
  assert.deepEqual(c.models[0], source.models[0]);
});

test("cancelled portable summary does not publish a checkpoint or switch billing channel", async () => {
  const controller = new AbortController();
  let started;
  const ready = new Promise((r) => (started = r));
  const seen = [];
  const e = new Engine(config(), {
    send: async (u, o) => {
      seen.push(u);
      started();
      await new Promise((r, j) =>
        o.signal.addEventListener("abort", () => j(Error("cancelled")), {
          once: true,
        }),
      );
    },
  });
  const running = (async () => {
    for await (const event of e.generate(
      "subscription",
      headers,
      {
        model: DS,
        client_metadata: metadata("a", "compaction"),
        input: [
          msg("user", "x".repeat(70000)),
          msg("assistant", "old answer"),
          msg("user", "current"),
          { type: "compaction_trigger" },
        ],
      },
      controller.signal,
    ))
      assert.fail("cancelled compaction produced output");
  })();
  await ready;
  controller.abort();
  await assert.rejects(running, /cancelled/);
  assert.equal(seen.length, 1);
  assert.ok(!seen[0].includes("chatgpt.com"));
  assert.ok(
    ![...e.state.items.keys()].some((k) => k.startsWith("checkpoint:")),
  );
});

test("zstd HTTP compaction completes and its checkpoint resumes on the same model", async (t) => {
  const { zstdCompressSync } = await import("node:zlib");
  const seen = [];
  const gateway = createGateway(config(), {
    log: () => {},
    send: async (_, options) => {
      seen.push(options.body);
      return json(result(options.body.input.some((x) => x.type === "compaction_trigger")
        ? [opaque] : [msg("assistant", "continued")]));
    },
  });
  await new Promise((r) => gateway.server.listen(0, "127.0.0.1", r));
  t.after(() => gateway.close());
  const url = `http://127.0.0.1:${gateway.server.address().port}/subscription/v1/responses`;
  const post = async (body) => {
    const res = await fetch(url, { method: "POST", headers: { ...headers, "content-encoding": "zstd" },
      body: zstdCompressSync(Buffer.from(JSON.stringify(body))) });
    assert.equal(res.status, 200);
    return res.json();
  };
  const input = [msg("user", "保留原文😀"), { type: "compaction_trigger" }];
  const checkpoint = await post({ model: GPT, input, client_metadata: metadata("compress", "compaction") });
  assert.deepEqual(seen[0].input, input);
  assert.deepEqual(checkpoint.output, [opaque]);
  const continued = await post({ model: GPT, input: [...checkpoint.output, msg("user", "continue")],
    client_metadata: metadata("resume") });
  assert.equal(continued.status, "completed");
  assert.deepEqual(seen.at(-1).input[0], opaque);
});

test("large native compaction calls the official backend once, resumes after restart and recompacts without migration summaries", async () => {
  const seen = [], logs = [];
  const send = async (_, o) => {
    seen.push(o.body);
    return json(result(o.body.input.some(x => x.type === "compaction_trigger") ? [opaque] : [msg("assistant", "continued")]));
  };
  const e = new Engine(config(), { send, log: x => logs.push(x) });
  const history = [msg("user", "中文FACT".repeat(100000)), { type: "compaction_trigger" }];
  const c = await call(e, GPT, "large", history, "compaction");
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].input, history);
  assert.equal(logs.filter(x => x.event === "portable_summary").length, 0);
  const restarted = new Engine(config(), { send });
  await call(restarted, GPT, "resume", c.output);
  assert.deepEqual(seen.at(-1).input, c.output);
  const again = await call(restarted, GPT, "again", [...c.output, msg("user", "next"), { type: "compaction_trigger" }], "compaction");
  assert.equal(seen.length, 3);
  await call(restarted, GPT, "after", again.output);
  assert.equal(seen.length, 4);
  await assert.rejects(call(restarted, DS, "switch", again.output), /no portable source/);
  await assert.rejects(call(restarted, GPT, "virtual", [{type: "compaction", encrypted_content: "gateway-checkpoint-v1:missing"}]), /Compacted history/);
});

test("native compaction does not fail when portable cache is too small", async () => {
  const e = new Engine({ ...config(), history: { maxBytes: 4096 } }, {
    send: async () => json(result([opaque])),
  });
  const c = await call(e, GPT, "small-cache", [msg("user", "a".repeat(10000)), { type: "compaction_trigger" }], "compaction");
  assert.deepEqual(c.output, [opaque]);
});

test("native images are archived and described once when switching to a text-only target", async () => {
  const seen = [];
  const e = new Engine(config(), { send: async (_, o) => {
    seen.push(o.body);
    if (o.body.input.some((x) => x.type === "compaction_trigger"))
      return json(result([opaque]));
    if (o.body.instructions?.startsWith("Describe the supplied image"))
      return json(result([msg("assistant", "A fixture image with uncertain content.")]));
    return json(result([msg("assistant", "continued")]));
  } });
  const input = [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,fixture" }] }, { type: "compaction_trigger" }];
  const c = await call(e, GPT, "image", input, "compaction");
  assert.deepEqual(seen[0].input, input);
  await call(e, GPT, "image-next", c.output);
  await call(e, DS, "image-switch", c.output);
  assert.equal(
    seen.filter((body) => body.instructions?.startsWith("Describe the supplied image")).length,
    1,
  );
  assert.match(JSON.stringify(seen.at(-1).input), /Lossy image description/);
  assert.ok(!JSON.stringify(seen.at(-1).input).includes("data:image\/png"));
});

test("image-capable custom targets receive the original image without lossy description", async () => {
  const seen = [];
  const c = config();
  c.targets.go.inputModalities = ["text", "image"];
  const e = new Engine(c, {
    send: async (_, options) => {
      seen.push(options.body);
      return json(result([msg("assistant", "image accepted")]));
    },
  });
  const input = [
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "describe" },
        {
          type: "input_image",
          image_url: "data:image/png;base64,fixture",
          detail: "original",
        },
      ],
    },
  ];
  await call(e, DS, "image-native", input);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].input, input);
  assert.ok(!JSON.stringify(seen[0]).includes("Lossy image description"));
  assert.ok(!seen[0].instructions?.startsWith("Describe the supplied image"));
});

test("virtual checkpoints, original history and successful summaries survive an engine restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-recovery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "history.sqlite");
  const archiveKey = Buffer.alloc(32, 9);
  let summaries = 0;
  const seen = [];
  const send = async (_, options) => {
    seen.push(options.body);
    if (options.body.instructions?.startsWith("Create one factual")) {
      summaries++;
      return json(result([msg("assistant", "SUMMARY_WITH_RESTART_491") ]));
    }
    return json(result([msg("assistant", "continued") ]));
  };
  let archive = new Archive(path, archiveKey);
  let engine = new Engine(config(), { archive, send });
  await call(engine, DS, "seed", [msg("user", "ORIGINAL_RESTART_491")]);
  const checkpoint = await call(
    engine,
    DS,
    "compact",
    [
      msg("user", "ORIGINAL_RESTART_491"),
      msg("assistant", "old answer"),
      msg("user", "CURRENT_RESTART_492"),
      { type: "compaction_trigger" },
    ],
    "compaction",
  );
  assert.equal(summaries, 1);
  archive.close();

  archive = new Archive(path, archiveKey);
  engine = new Engine(config(), { archive, send });
  const resumed = await call(engine, DS, "resume", checkpoint.output);
  assert.equal(summaries, 1);
  const latest = archive.history({
    owner: `api:${identity("subscription", headers, {}).auth}`,
    thread: "thread",
    branch: "thread",
  });
  assert.match(JSON.stringify(latest.original), /ORIGINAL_RESTART_491/);
  assert.match(JSON.stringify(latest.view), /SUMMARY_WITH_RESTART_491/);
  const events = [];
  for await (const event of engine.generate(
    "subscription",
    headers,
    {
      model: GPT,
      previous_response_id: resumed.id,
      input: [msg("user", "switch larger")],
      client_metadata: metadata("larger"),
    },
    new AbortController().signal,
  ))
    events.push(event);
  assert.equal(events.at(-1).response.status, "completed");
  assert.match(JSON.stringify(seen.at(-1).input), /ORIGINAL_RESTART_491/);
  assert.ok(!JSON.stringify(seen.at(-1).input).includes("SUMMARY_WITH_RESTART_491"));
  archive.close();
});

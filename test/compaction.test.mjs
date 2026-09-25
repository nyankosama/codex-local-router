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
import {
  expandCheckpoints,
  checkpointFor,
  checkpointKey,
  checkpointTargetStatus,
  portableItems,
  saveCheckpoint,
} from "../src/history.mjs";

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
  request = {},
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
    request,
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

test("checkpoint inspection separates usable, summary-needed and blocked history", () => {
  const target = config().targets.go;
  const base = {
    provider: "chatgpt-subscription",
    model: GPT,
    targetId: `official:${GPT}`,
    virtual: false,
    view: [opaque],
  };
  assert.equal(
    checkpointTargetStatus({ ...base, original: [msg("user", "portable")] }, target)
      .reason,
    "portable_original",
  );
  assert.deepEqual(checkpointTargetStatus(base, target), {
    compatible: false,
    needsSummary: false,
    reason: "portable_source_missing",
  });
  assert.deepEqual(
    checkpointTargetStatus(base, {
      ...target,
      compression: { mode: "summary", nativeMigrationSummary: true },
    }),
    {
      compatible: false,
      needsSummary: true,
      reason: "opaque_source_window",
    },
  );
  assert.equal(
    checkpointTargetStatus({ ...base, completeness: "gap_present" }, target).reason,
    "gap_present",
  );
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
  const seen = [], logs = [];
  const e = new Engine(config(), {
    log: (entry) => logs.push(entry),
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
  const completed = logs.find((entry) => entry.event === "compaction_completed");
  assert.equal(completed.upstream_calls, 1);
  assert.equal(completed.summary_calls, 1);
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
  const next = config();
  next.targets.go.compression.nativeMigrationSummary = true;
  const seen = [];
  let targetAttempts = 0;
  const e = new Engine(next, {
    send: async (_, options) => {
      seen.push(options.body);
      if (options.body.model === GPT && options.body.instructions)
        return json(result([msg("assistant", "Keep OVERFLOW_314 and completed tools.")]));
      if (options.body.model === DS && ++targetAttempts === 1)
        return upstreamError(
          400,
          "context_length_exceeded",
          "maximum context length exceeded",
        );
      return json(result([msg("assistant", "done") ]));
    },
  });
  await call(e, GPT, "source", [msg("user", "OVERFLOW_314")]);
  await call(e, DS, "target", [
    msg("user", "OVERFLOW_314"),
    msg("user", "continue"),
  ]);
  const summaries = seen.filter(
    (body) => body.model === GPT && body.instructions?.startsWith("Create one factual"),
  );
  assert.equal(summaries.length, 1);
  assert.deepEqual(summaries[0].tools, []);
  assert.equal(targetAttempts, 2);
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

  const blockedSeen = [];
  const blocked = new Engine(config(), {
    send: async (_, options) => {
      blockedSeen.push(options.body);
      if (options.body.model === DS)
        return upstreamError(
          400,
          "context_length_exceeded",
          "maximum context length exceeded",
        );
      return json(result([msg("assistant", "source") ]));
    },
  });
  await call(blocked, GPT, "blocked-source", [msg("user", "NO_SUMMARY_315")]);
  await assert.rejects(
    call(blocked, DS, "blocked-target", [msg("user", "continue")]),
    (error) => error.type === "context_length_exceeded",
  );
  assert.equal(
    blockedSeen.filter((body) =>
      body.instructions?.startsWith("Create one factual"),
    ).length,
    0,
  );
});

test("obvious local overflow summarizes before send and rejects an unsummarizable tail without network", async () => {
  const c = config();
  c.targets.go.compression.nativeMigrationSummary = true;
  c.targets.go.contextWindow = 10000;
  c.targets.go.effectiveContextWindowPercent = 95;
  c.targets.go.outputReserveTokens = 1000;
  const seen = [];
  const logs = [];
  let officialSummaries = 0;
  const e = new Engine(c, {
    log: (entry) => logs.push(entry),
    send: async (_, options) => {
      seen.push(options.body);
      if (options.body.instructions?.startsWith("Create one factual"))
        return json(result([msg("assistant", "LOCAL_PREFLIGHT_SUMMARY") ]));
      return json(result([msg("assistant", "done") ]));
    },
  });
  const preflightCheckpoint = {
    type: "compaction",
    encrypted_content: "official-preflight-checkpoint",
  };
  const preflightCtx = identity("subscription", headers, {
    input: [preflightCheckpoint],
    client_metadata: metadata("preflight-target"),
  });
  saveCheckpoint(e.state, preflightCtx, preflightCheckpoint, {
    provider: "chatgpt-subscription",
    model: GPT,
    targetId: `official:${GPT}`,
    original: [
      msg("user", `OLD_HISTORY_${"x".repeat(60000)}`),
      { ...msg("assistant", "old answer"), id: "item_gateway_preflight" },
    ],
    view: [preflightCheckpoint],
    completeness: "complete_original",
    virtual: false,
  });
  e.state.set("last-target:" + preflightCtx.owner, { ...c.targets.go }, preflightCtx);
  await call(
    e,
    DS,
    "preflight-target",
    [
      preflightCheckpoint,
      msg("user", "current request"),
      {
        type: "function_call_output",
        id: "fco_app_event",
        name: "send_message_to_thread",
        output:
          "<codex_delegation><input>DELEGATED_RESPONSE_ONLY</input></codex_delegation>",
      },
    ],
    "turn",
    headers,
    undefined,
    undefined,
    {
      officialSummary: async (body) => {
        officialSummaries++;
        assert.doesNotMatch(JSON.stringify(body.input), /item_gateway_/);
        return {
          type: "response.completed",
          response: result([msg("assistant", "LOCAL_PREFLIGHT_SUMMARY")]),
        };
      },
    },
  );
  const targetCalls = seen.filter((body) => body.model === DS);
  assert.equal(targetCalls.length, 1, "oversized target body must not reach upstream");
  assert.match(JSON.stringify(targetCalls[0].input), /LOCAL_PREFLIGHT_SUMMARY/);
  assert.match(JSON.stringify(targetCalls[0].input), /DELEGATED_RESPONSE_ONLY/);
  assert.ok(
    targetCalls[0].input.every(
      (item) => item.type !== "function_call_output" || item.call_id,
    ),
  );
  assert.equal(officialSummaries, 1);
  assert.equal(
    seen.filter((body) => body.instructions?.startsWith("Create one factual")).length,
    0,
  );
  assert.ok(logs.some((entry) =>
    entry.event === "native_migration_summary_budget" &&
    entry.decision === "summary_required"));

  let blockedCalls = 0;
  const blocked = new Engine(c, {
    send: async () => {
      blockedCalls++;
      return json(result([]));
    },
  });
  await assert.rejects(
    call(blocked, DS, "preflight-tail", [
      msg("user", `CURRENT_${"x".repeat(60000)}`),
    ]),
    (error) =>
      error.type === "context_length_exceeded" && error.status === 413,
  );
  assert.equal(blockedCalls, 0);
});

test("official access_programs denial is classified separately from history failures", async () => {
  const logs = [];
  const e = new Engine(config(), {
    log: (entry) => logs.push(entry),
    send: async () =>
      upstreamError(
        403,
        "permission_denied",
        "The access_programs parameter is not enabled for this organization.",
      ),
  });
  await assert.rejects(
    call(e, GPT, "access-programs", [msg("user", "continue")]),
    (error) => error.type === "official_access_programs_denied" && error.status === 403,
  );
  assert.equal(
    logs.find((entry) => entry.event === "provider_error")?.category,
    "access_programs_denied",
  );
});

test("a migration summary is generated once and a second explicit overflow fails without recursive compression", async () => {
  const next = config();
  next.targets.go.compression.nativeMigrationSummary = true;
  let summaries = 0;
  const e = new Engine(next, {
    send: async (_, options) => {
      if (options.body.model === GPT && options.body.instructions) {
        summaries++;
        return json(result([msg("assistant", "single summary") ]));
      }
      if (options.body.model === DS)
        return upstreamError(
          400,
          "context_length_exceeded",
          "context window limit exceeded",
        );
      return json(result([msg("assistant", "source") ]));
    },
  });
  await call(e, GPT, "source", [msg("user", "too large")]);
  await assert.rejects(
    call(e, DS, "target", [msg("user", "too large"), msg("user", "go")]),
    /one persisted migration summary/,
  );
  assert.equal(summaries, 1);
});

test("legacy virtual checkpoints use their trusted active view on a native target", () => {
  const next = config();
  next.targets.go.compression = { mode: "native" };
  const e = new Engine(next);
  const ctx = identity("subscription", headers, {
    client_metadata: metadata("legacy-native"),
  });
  const item = {
    type: "compaction",
    encrypted_content: "gateway-checkpoint-v1:legacy-native",
  };
  saveCheckpoint(e.state, ctx, item, {
    provider: "go",
    model: DS,
    targetId: "go",
    virtual: true,
    original: [msg("user", "FULL_OLD_HISTORY")],
    view: [msg("assistant", "TRUSTED_ACTIVE_VIEW")],
    completeness: "complete_original",
  });
  const diagnostics = [];
  const active = expandCheckpoints(
    e.state,
    ctx,
    [item, msg("user", "NEW_TAIL")],
    next.targets.go,
    { diagnostics: (entry) => diagnostics.push(entry) },
  );
  assert.match(JSON.stringify(active.input), /TRUSTED_ACTIVE_VIEW/);
  assert.match(JSON.stringify(active.input), /NEW_TAIL/);
  assert.doesNotMatch(JSON.stringify(active.input), /FULL_OLD_HISTORY/);
  assert.deepEqual(diagnostics, [{ event: "legacy_checkpoint_view_restored" }]);
  assert.match(
    JSON.stringify(expandCheckpoints(
      e.state,
      ctx,
      [item],
      next.targets.go,
      { portable: true },
    ).input),
    /FULL_OLD_HISTORY/,
  );
});

test("a failed migration summary can be retried but an uncertain result stays blocked", async () => {
  const e = new Engine(config()),
    source = e.officialTarget(GPT),
    ctx = identity("subscription", headers, {
      input: [],
      client_metadata: metadata("summary-retry"),
    }),
    signal = new AbortController().signal,
    input = [msg("user", "SUMMARY_RETRY_881")];
  let attempts = 0;
  await assert.rejects(
    e.singleSummary(
      config(), source, input, ctx, signal, {}, "retryable", 1000,
      async () => {
        attempts++;
        throw Object.assign(Error("temporary failure"), {
          type: "upstream_connection_error",
          status: 502,
        });
      },
    ),
    /temporary failure/,
  );
  const view = await e.singleSummary(
    config(), source, input, ctx, signal, {}, "retryable", 1000,
    async () => {
      attempts++;
      return {
        type: "response.completed",
        response: result([msg("assistant", "SUMMARY_RETRY_OK")]),
      };
    },
  );
  assert.equal(attempts, 2);
  assert.match(JSON.stringify(view), /SUMMARY_RETRY_OK/);

  let uncertainAttempts = 0;
  const uncertainInput = [msg("user", "SUMMARY_UNCERTAIN_882")];
  await assert.rejects(
    e.singleSummary(
      config(), source, uncertainInput, ctx, signal, {}, "uncertain", 1000,
      async () => {
        uncertainAttempts++;
        throw Object.assign(Error("cancelled"), { type: "cancelled" });
      },
    ),
    /cancelled/,
  );
  await assert.rejects(
    e.singleSummary(
      config(), source, uncertainInput, ctx, signal, {}, "uncertain", 1000,
      async () => {
        uncertainAttempts++;
      },
    ),
    (error) => error.type === "compaction_result_uncertain",
  );
  assert.equal(uncertainAttempts, 1);
});

test("an orphaned running summary is retried after restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-summary-restart-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const archive = new Archive(join(dir, "history.sqlite"), Buffer.alloc(32, 4));
  t.after(() => archive.close());
  const first = new Engine(config(), { archive });
  const source = first.officialTarget(GPT);
  const input = [msg("user", "SUMMARY_RESTART_883")];
  const ctx = identity("subscription", headers, {
    input: [],
    client_metadata: metadata("summary-restart"),
  });
  const key = first.summaryKey(ctx, input, "restartable");
  first.state.set(key, { status: "running", started: Date.now() }, ctx);

  const logs = [];
  const restarted = new Engine(config(), {
    archive,
    log: (entry) => logs.push(entry),
  });
  const view = await restarted.singleSummary(
    config(), source, input, ctx, new AbortController().signal, {},
    "restartable", 1000,
    async () => ({
      type: "response.completed",
      response: result([msg("assistant", "SUMMARY_RESTART_OK")]),
    }),
  );

  assert.match(JSON.stringify(view), /SUMMARY_RESTART_OK/);
  assert.equal(logs.filter((entry) => entry.event === "orphaned_summary_retried").length, 1);
});

test("official summary terminal logs only safe structured diagnostics", async () => {
  const logs = [];
  const e = new Engine(config(), { log: (entry) => logs.push(entry) });
  const source = e.officialTarget(GPT);
  const ctx = identity("subscription", headers, {
    input: [],
    client_metadata: metadata("summary-diagnostic"),
  });
  await assert.rejects(
    e.singleSummary(
      config(),
      source,
      [msg("user", "SUMMARY_DIAGNOSTIC_991")],
      ctx,
      new AbortController().signal,
      {},
      "diagnostic",
      1000,
      async () => ({
        type: "error",
        error: {
          type: "invalid_request_error",
          code: "invalid_previous_response",
          param: "previous_response_id",
          message: "private-value must not be logged; previous_response_id is invalid",
        },
      }),
    ),
    (error) => error.type === "compaction_summary_failed",
  );
  const terminal = logs.find(
    (entry) => entry.event === "native_migration_summary_source_terminal",
  );
  assert.deepEqual(
    {
      type: terminal.error_type,
      code: terminal.error_code,
      param: terminal.error_param,
      category: terminal.error_category,
    },
    {
      type: "invalid_request_error",
      code: "invalid_previous_response",
      param: "previous_response_id",
      category: "previous_response",
    },
  );
  assert.doesNotMatch(JSON.stringify(logs), /private-value/);
});

test("opaque official compaction creates one reusable native migration summary only when enabled", async (t) => {
  const next = config();
  next.targets.go.compression.nativeMigrationSummary = true;
  const seen = [];
  const summaries = [];
  const dir = await mkdtemp(join(tmpdir(), "gateway-native-migration-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const archive = new Archive(join(dir, "history.sqlite"), Buffer.alloc(32, 7));
  t.after(() => archive.close());
  const options = {
    archive,
    send: async (_, options) => {
      seen.push(options.body);
      if (options.body.instructions)
        return json(result([msg("assistant", "MIGRATED_FACT_771") ]));
      return json(result([msg("assistant", "continued") ]));
    },
  };
  const e = new Engine(next, options);
  const officialSummary = async (body) => {
    summaries.push(body);
    return {
      type: "response.completed",
      response: result([msg("assistant", "MIGRATED_FACT_771")]),
    };
  };
  const postCompactionCall = {
    type: "custom_tool_call",
    call_id: "call_post_compaction",
    name: "shell",
    input: "POST_COMPACTION_CALL_770",
  };
  const originalContext = {
    instructions: "ORIGINAL_CODEX_INSTRUCTIONS_769",
    tools: [{ type: "function", name: "shell", parameters: {} }],
    reasoning: { effort: "high", summary: "detailed" },
  };
  await e.commitOfficialObservation(
    headers,
    { model: GPT, input: [] },
    {
      id: "resp_opaque_source",
      status: "completed",
      output: [opaque, postCompactionCall],
    },
  );
  const ctx = identity("subscription", headers, {
    input: [opaque],
    client_metadata: metadata("migration-summary"),
  });

  const migrate = async (engine) => {
    const events = [];
    for await (const event of engine.generate(
      "subscription",
      headers,
      {
        model: DS,
        input: [opaque, msg("user", "LATEST_772")],
        client_metadata: metadata("migration-summary"),
        ...originalContext,
      },
      new AbortController().signal,
      { officialSummary },
    )) events.push(event);
    return events.at(-1).response;
  };
  await migrate(e);
  const restarted = new Engine(structuredClone(next), options);
  await migrate(restarted);

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].model, GPT);
  assert.equal(summaries[0].previous_response_id, undefined);
  assert.deepEqual(summaries[0].reasoning, originalContext.reasoning);
  assert.deepEqual(summaries[0].tools, originalContext.tools);
  assert.equal(summaries[0].instructions, originalContext.instructions);
  assert.match(JSON.stringify(summaries[0].input), /official-opaque-test-only/);
  assert.match(JSON.stringify(summaries[0].input), /Create one factual continuation summary/);
  assert.doesNotMatch(JSON.stringify(summaries[0].input), /POST_COMPACTION_CALL_770/);
  const generations = seen.filter((body) => body.model === DS);
  assert.equal(generations.length, 2);
  assert.match(JSON.stringify(generations[0].input), /MIGRATED_FACT_771/);
  assert.match(JSON.stringify(generations[0].input), /LATEST_772/);
  assert.doesNotMatch(JSON.stringify(generations[0].input), /official-opaque-test-only/);

  const disabled = config();
  const blocked = new Engine(disabled, { send: async () => json(result([])) });
  saveCheckpoint(blocked.state, ctx, opaque, {
    provider: "chatgpt-subscription",
    model: GPT,
    targetId: `official:${GPT}`,
    original: undefined,
    view: [opaque],
    completeness: "opaque_source_only",
    virtual: false,
  });
  await assert.rejects(
    call(blocked, DS, "migration-summary", [opaque]),
    (error) => error.type === "compaction_history_unavailable",
  );
});

test("cross-provider pre-turn compaction migrates before target-native compaction", async () => {
  const next = config();
  next.targets.go.contextWindow = 4000;
  next.targets.go.maxContextWindow = 4000;
  next.targets.go.outputReserveTokens = 100;
  next.targets.go.compression = {
    mode: "native",
    nativeMigrationSummary: true,
  };
  const seen = [], logs = [];
  const engine = new Engine(next, {
    log: (event) => logs.push(event),
    send: async (_, request) => {
      seen.push(request.body);
      return json(result([{ type: "compaction", encrypted_content: "target-native" }]));
    },
  });
  await engine.commitOfficialObservation(
    headers,
    {
      model: GPT,
      input: [msg("user", "SOURCE_ONLY_413 " + "x".repeat(20_000))],
      client_metadata: metadata("source"),
    },
    { id: "resp_pre_turn_migration", status: "completed", output: [opaque] },
  );
  const summaries = [];
  const compacted = await call(
    engine,
    DS,
    "target",
    [
      opaque,
      msg("user", "LATEST_TAIL " + "y".repeat(20_000)),
      { type: "compaction_trigger" },
    ],
    "compaction",
    headers,
    undefined,
    undefined,
    {
      officialSummary: async (body) => {
        summaries.push(body);
        return {
          type: "response.completed",
          response: result([msg("assistant", "MIGRATED_BEFORE_COMPACT")]),
        };
      },
    },
  );

  assert.equal(summaries.length, 1);
  assert.equal(seen.length, 1);
  assert.match(JSON.stringify(summaries[0].input), /LATEST_TAIL/);
  const requestedSummaryTokens = Number(
    summaries[0].input.at(-1).content.match(/within (\d+) tokens/)[1],
  );
  assert.ok(requestedSummaryTokens > 256);
  assert.match(JSON.stringify(seen[0].input), /MIGRATED_BEFORE_COMPACT/);
  assert.doesNotMatch(JSON.stringify(seen[0].input), /LATEST_TAIL/);
  assert.ok(seen[0].input.some((item) => item.type === "compaction_trigger"));
  assert.doesNotMatch(JSON.stringify(seen[0].input), /SOURCE_ONLY_413/);
  assert.doesNotMatch(JSON.stringify(seen[0].input), /official-opaque-test-only/);
  assert.equal(compacted.output[0].encrypted_content, "target-native");
  assert.ok(logs.some((event) =>
    event.event === "native_migration_summary_budget" &&
    event.decision === "upstream_owned_native" &&
    event.fixed_tokens >= event.input_budget));
});

test("third-party native compaction keeps a source view for later summary migration", async () => {
  const next = config();
  const sourceModel = "source-native-model";
  const targetModel = "target-summary-model";
  next.providers.source = { baseUrl: "http://127.0.0.1:9001" };
  next.providers.target = { baseUrl: "http://127.0.0.1:9002" };
  next.targets.source = {
    ...structuredClone(next.targets.go),
    id: "source",
    provider: "source",
    model: sourceModel,
    compression: {
      mode: "native",
      compatibility: { accountScope: "same", targets: ["source"] },
      nativeMigrationSummary: true,
    },
  };
  next.targets.target = {
    ...structuredClone(next.targets.go),
    id: "target",
    provider: "target",
    model: targetModel,
    contextWindow: 4000,
    maxContextWindow: 4000,
    outputReserveTokens: 100,
    compression: { mode: "summary", nativeMigrationSummary: true },
  };
  next.subscription.customModels = {
    [sourceModel]: "source",
    [targetModel]: "target",
  };
  const native = {
    type: "compaction",
    encrypted_content: "third-party-native-source-view",
  };
  const seen = [];
  const engine = new Engine(next, {
    send: async (_, request) => {
      seen.push(request.body);
      if (request.body.input.some((item) => item.type === "compaction_trigger"))
        return json(result([native]));
      if (request.body.instructions?.startsWith("Create one factual"))
        return json(result([msg("assistant", "MIGRATED_NATIVE_WINDOW")]));
      return json(result([msg("assistant", "continued")]));
    },
  });
  const compacted = await call(
    engine,
    sourceModel,
    "source-compact",
    [
      msg("user", "SOURCE_FACT " + "x".repeat(20_000)),
      { type: "compaction_trigger" },
    ],
    "compaction",
  );
  await call(engine, targetModel, "target-turn", [
    ...compacted.output,
    msg("user", "continue"),
  ]);

  const summary = seen.find((body) =>
    body.instructions?.startsWith("Create one factual"));
  assert.equal(summary.model, sourceModel);
  assert.deepEqual(summary.input[0], native);
  assert.match(JSON.stringify(seen.at(-1).input), /MIGRATED_NATIVE_WINDOW/);
  assert.doesNotMatch(
    JSON.stringify(seen.at(-1).input),
    /third-party-native-source-view/,
  );
});

test("cross-provider turn summarizes completed tail but preserves the current user request", async () => {
  const next = config();
  next.targets.go.contextWindow = 4000;
  next.targets.go.maxContextWindow = 4000;
  next.targets.go.outputReserveTokens = 100;
  next.targets.go.compression.nativeMigrationSummary = true;
  const seen = [], summaries = [];
  const engine = new Engine(next, {
    send: async (_, request) => {
      seen.push(request.body);
      return json(result([msg("assistant", "continued") ]));
    },
  });
  await engine.commitOfficialObservation(
    headers,
    { model: GPT, input: [] },
    { id: "resp_turn_tail", status: "completed", output: [opaque] },
  );

  await call(
    engine,
    DS,
    "turn-tail",
    [
      opaque,
      msg("user", "COMPLETED_TAIL " + "x".repeat(20_000)),
      msg("assistant", "COMPLETED_TAIL_RESULT"),
      msg("user", "CURRENT_REQUEST_VERBATIM"),
    ],
    "turn",
    headers,
    undefined,
    undefined,
    {
      officialSummary: async (body) => {
        summaries.push(body);
        return {
          type: "response.completed",
          response: result([msg("assistant", "MIGRATED_TAIL_SUMMARY")]),
        };
      },
    },
  );

  assert.equal(summaries.length, 1);
  assert.match(JSON.stringify(summaries[0].input), /COMPLETED_TAIL_RESULT/);
  assert.doesNotMatch(JSON.stringify(summaries[0].input), /CURRENT_REQUEST_VERBATIM/);
  assert.equal(seen.length, 1);
  assert.match(JSON.stringify(seen[0].input), /MIGRATED_TAIL_SUMMARY/);
  assert.match(JSON.stringify(seen[0].input), /CURRENT_REQUEST_VERBATIM/);
  assert.doesNotMatch(JSON.stringify(seen[0].input), /COMPLETED_TAIL_RESULT/);

  await call(
    engine,
    DS,
    "turn-tail-next",
    [
      opaque,
      msg("user", "COMPLETED_TAIL " + "x".repeat(20_000)),
      msg("assistant", "COMPLETED_TAIL_RESULT"),
      msg("user", "CURRENT_REQUEST_VERBATIM"),
      msg("assistant", "continued"),
      msg("user", "NEXT_REQUEST_VERBATIM"),
    ],
    "turn",
    headers,
    undefined,
    undefined,
    {
      officialSummary: async (body) => {
        summaries.push(body);
        return {
          type: "response.completed",
          response: result([msg("assistant", "MUST_NOT_RUN")]),
        };
      },
    },
  );
  assert.equal(summaries.length, 1);
  assert.equal(seen.length, 2);
  assert.match(JSON.stringify(seen[1].input), /MIGRATED_TAIL_SUMMARY/);
  assert.match(JSON.stringify(seen[1].input), /CURRENT_REQUEST_VERBATIM/);
  assert.match(JSON.stringify(seen[1].input), /NEXT_REQUEST_VERBATIM/);
  assert.doesNotMatch(JSON.stringify(seen[1].input), /COMPLETED_TAIL_RESULT/);
});

test("Lite migration reuse keeps current tool declarations outside the covered history", async () => {
  const next = config();
  Object.assign(next.targets.go, {
    contextWindow: 4000,
    maxContextWindow: 4000,
    outputReserveTokens: 100,
    app: { useResponsesLite: true },
    compression: { mode: "native", nativeMigrationSummary: true },
  });
  const sent = [];
  const engine = new Engine(next, { send: async (_, request) => {
    sent.push(request.body);
    return json(result([msg("assistant", "continued")]));
  } });
  const ctx = identity("subscription", headers, {
    client_metadata: metadata("tools-tail"),
  });
  saveCheckpoint(engine.state, ctx, opaque, {
    provider: "chatgpt-subscription", model: GPT, targetId: `official:${GPT}`,
    original: [], view: [opaque], completeness: "complete_original",
  });
  const oldTail = [msg("user", "x".repeat(20000)), msg("assistant", "done")];
  const tools = (name) => ({ type: "additional_tools", tools: [
    { type: "function", name, parameters: { type: "object", properties: {} } },
  ] });
  let calls = 0;
  const prepare = (body, context = ctx) => engine.prepareNativeMigrationSummaries(
    next, next.targets.go, body, context, new AbortController().signal, {},
    async (summaryBody) => {
      calls++;
      assert.ok(!summaryBody.input.some(x => x.type === "additional_tools"));
      return { type: "response.completed", response: result([msg("assistant", "SUMMARY")]) };
    }, body.input.filter(x => x.type === "additional_tools"),
  );
  await prepare({ input: [tools("old_tool"), opaque, ...oldTail, msg("user", "request") ] });
  const summary = checkpointFor(engine.state, ctx, opaque).checkpoint.migration.view;
  for (const name of ["get_goal", "exec_command"]) {
    const declaration = tools(name);
    const body = { input: [declaration, opaque, ...oldTail, msg("user", "request"), msg("user", "next")] };
    assert.deepEqual(await prepare(body), { generated: 0, reused: 1 });
    assert.deepEqual(body.input, [declaration, ...summary, msg("user", "request"), msg("user", "next")]);
  }
  const trigger = { type: "compaction_trigger" };
  const body = { input: [tools("get_goal"), opaque, ...oldTail, msg("user", "request"), trigger] };
  await prepare(body, { ...ctx, requestKind: "compaction" });
  assert.deepEqual(body.input, [tools("get_goal"), trigger, ...summary, msg("user", "request")]);
  await assert.rejects(prepare({ input: [opaque, msg("user", "CHANGED"), oldTail[1], msg("user", "request")] }),
    error => error.type === "compaction_result_uncertain");
  assert.equal(calls, 1);
  engine.state.save(ctx, { id: "prewarm-tools", output: [] }, [tools("get_goal")], next.targets.go);
  await call(engine, DS, "prewarm-migration", [opaque, ...oldTail, msg("user", "request")],
    "turn", headers, "prewarm-tools");
  assert.deepEqual(sent[0].input.filter(x => x.type === "additional_tools"), [tools("get_goal")]);
});

test("migration summary budget excludes the history window already covered by compaction", async () => {
  const next = config();
  next.targets.go.contextWindow = 20000;
  next.targets.go.outputReserveTokens = 1024;
  next.targets.go.inputModalities = ["text", "image"];
  next.targets.go.compression.nativeMigrationSummary = true;
  const seen = [];
  const logs = [];
  const e = new Engine(next, {
    log: (event) => logs.push(event),
    send: async (_, request) => {
      seen.push(request.body);
      return json(result([
        msg("assistant", request.body.instructions ? "MIGRATED_WINDOW_991" : "done"),
      ]));
    },
  });
  const old = msg("user", `OLD_WINDOW_990 ${"padding ".repeat(5000)}`);
  const screenshot = {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_image",
        image_url: `data:image/png;base64,${"a".repeat(900_000)}`,
      },
    ],
  };
  const privateReasoning = {
    type: "reasoning",
    summary: [],
    encrypted_content: "r".repeat(50_000),
  };
  const latest = msg("user", "LATEST_TAIL_992");
  const ctx = identity("subscription", headers, {
    input: [old, opaque, privateReasoning, screenshot, latest],
    client_metadata: metadata("tail-budget"),
  });
  saveCheckpoint(e.state, ctx, opaque, {
    provider: "chatgpt-subscription",
    model: GPT,
    targetId: `official:${GPT}`,
    original: [old],
    view: [old, opaque],
    completeness: "complete_original",
    virtual: false,
  });

  await call(e, DS, "tail-budget", [
    old,
    opaque,
    privateReasoning,
    screenshot,
    latest,
  ]);

  assert.equal(seen.filter((body) => body.instructions).length, 1);
  assert.equal(logs.filter((event) => event.event === "native_migration_summary_completed").length, 1);
  const budget = logs.find((event) => event.event === "native_migration_summary_budget");
  assert.equal(budget.decision, "summary_required");
  assert.ok(budget.fixed_tokens < budget.input_budget);
  assert.ok(budget.input_budget < budget.projected_tokens);
  assert.match(JSON.stringify(seen.at(-1).input), /MIGRATED_WINDOW_991/);
  assert.ok(
    seen.at(-1).input.some((item) =>
      item.content?.some((part) => part.type === "input_image"),
    ),
  );
  assert.match(JSON.stringify(seen.at(-1).input), /LATEST_TAIL_992/);
  assert.doesNotMatch(JSON.stringify(seen.at(-1).input), /"encrypted_content"/);
  assert.doesNotMatch(JSON.stringify(seen.at(-1).input), /OLD_WINDOW_990/);
  assert.doesNotMatch(JSON.stringify(seen.at(-1).input), /official-opaque-test-only/);
});

test("missing checkpoint view is recovered from encrypted history once", async (t) => {
  const next = config();
  next.targets.go.contextWindow = 10000;
  next.targets.go.outputReserveTokens = 1024;
  next.targets.go.compression.nativeMigrationSummary = true;
  const dir = await mkdtemp(join(tmpdir(), "gateway-checkpoint-view-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const archive = new Archive(join(dir, "history.sqlite"), Buffer.alloc(32, 8));
  t.after(() => archive.close());
  const seen = [], logs = [];
  const options = {
    archive,
    log: (entry) => logs.push(entry),
    send: async (_, request) => {
      seen.push(request.body);
      return json(result([msg("assistant", "done")]));
    },
  };
  const old = msg("user", `RECOVERED_OLD_WINDOW ${"padding ".repeat(5000)}`);
  const latest = msg("user", "RECOVERED_LATEST_TAIL");
  const pending = {
    type: "custom_tool_call",
    call_id: "call_recovered_pending",
    name: "shell",
    input: "RECOVERED_PENDING_CALL",
  };
  const completed = {
    type: "custom_tool_call_output",
    call_id: pending.call_id,
    output: "RECOVERED_PENDING_OUTPUT",
  };
  const active = [opaque, pending, completed, latest];
  const ctx = identity("subscription", headers, {
    input: active,
    client_metadata: metadata("checkpoint-view"),
  });
  archive.appendHistory({
    owner: ctx.account,
    thread: ctx.thread,
    branch: ctx.branch,
    target: {
      id: `official:${GPT}`,
      provider: "chatgpt-subscription",
      model: GPT,
    },
    original: [old],
    view: [opaque, pending],
  });
  const first = new Engine(next, options);
  saveCheckpoint(first.state, ctx, opaque, {
    provider: "chatgpt-subscription",
    model: GPT,
    targetId: `official:${GPT}`,
    original: [old],
    virtual: false,
  });
  const summaries = [];
  const officialSummary = async (body) => {
    summaries.push(body);
    return {
      type: "response.completed",
      response: result([msg("assistant", "RECOVERED_WINDOW_SUMMARY")]),
    };
  };
  await call(
    first,
    DS,
    "checkpoint-view",
    active,
    "turn",
    headers,
    undefined,
    undefined,
    { officialSummary },
  );
  await call(
    new Engine(structuredClone(next), options),
    DS,
    "checkpoint-view-restart",
    active,
    "turn",
    headers,
    undefined,
    undefined,
    { officialSummary },
  );

  assert.equal(summaries.length, 1);
  assert.doesNotMatch(JSON.stringify(summaries[0].input), /RECOVERED_PENDING_CALL/);
  assert.equal(
    logs.filter((entry) => entry.event === "checkpoint_view_recovered").length,
    1,
  );
  assert.equal(seen.length, 2);
  for (const body of seen) {
    assert.match(JSON.stringify(body.input), /RECOVERED_WINDOW_SUMMARY/);
    assert.match(JSON.stringify(body.input), /RECOVERED_LATEST_TAIL/);
    assert.match(JSON.stringify(body.input), /RECOVERED_PENDING_CALL/);
    assert.match(JSON.stringify(body.input), /RECOVERED_PENDING_OUTPUT/);
    assert.doesNotMatch(JSON.stringify(body.input), /RECOVERED_OLD_WINDOW/);
    assert.doesNotMatch(JSON.stringify(body.input), /official-opaque-test-only/);
  }
});

test("the observation gate hydrates a persisted official checkpoint after restart", async (t) => {
  const next = config();
  next.targets.go.compression.nativeMigrationSummary = true;
  const dir = await mkdtemp(join(tmpdir(), "gateway-observation-gate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const archive = new Archive(join(dir, "history.sqlite"), Buffer.alloc(32, 7));
  t.after(() => archive.close());
  const request = {
    model: DS,
    input: [opaque, msg("user", "AFTER_RESTART")],
    client_metadata: metadata("observation-gate"),
  };
  const observed = identity("subscription", headers, request);
  archive.appendHistory({
    owner: observed.account,
    thread: observed.thread,
    branch: observed.branch,
    target: {
      id: `official:${GPT}`,
      provider: "chatgpt-subscription",
      model: GPT,
    },
    original: [msg("user", "BEFORE_COMPACTION")],
    view: [opaque],
  });
  const legacy = new Engine(next, { archive });
  saveCheckpoint(legacy.state, observed, opaque, {
    provider: "chatgpt-subscription",
    model: GPT,
    targetId: `official:${GPT}`,
    virtual: false,
  });

  const logs = [];
  const restarted = new Engine(structuredClone(next), {
    archive,
    log: (entry) => logs.push(entry),
  });
  const ctx = await restarted.requireObservedHistory(headers, request);
  const checkpoint = checkpointFor(restarted.state, ctx, opaque).checkpoint;

  assert.deepEqual(checkpoint.view, [opaque]);
  assert.equal(
    logs.filter((entry) => entry.event === "checkpoint_view_recovered").length,
    1,
  );
});

test("an authenticated fork recovers legacy opaque compaction lineage without client parent metadata", async (t) => {
  const next = config();
  next.targets.go.compression.nativeMigrationSummary = true;
  const dir = await mkdtemp(join(tmpdir(), "gateway-fork-lineage-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const archive = new Archive(join(dir, "history.sqlite"), Buffer.alloc(32, 9));
  t.after(() => archive.close());
  const seen = [], logs = [];
  const options = {
    archive,
    log: (entry) => logs.push(entry),
    send: async (_, request) => {
      seen.push(request.body);
      return json(result([msg("assistant", request.body.instructions ? "FORK_SUMMARY_881" : "done") ]));
    },
  };
  const parentHeaders = { ...headers, "thread-id": "opaque-parent" };
  const parentRequest = { model: GPT, input: [], client_metadata: metadata("parent", "turn", "opaque-parent") };
  await new Engine(next, options).commitOfficialObservation(
    parentHeaders,
    parentRequest,
    { id: "resp_opaque_parent", status: "completed", output: [opaque] },
  );
  const parentCtx = identity("subscription", parentHeaders, parentRequest);
  const parentKey = checkpointKey(parentCtx, opaque);
  const checkpoint = archive.getState(parentKey);
  archive.setState(parentKey, {
    provider: checkpoint.provider,
    model: checkpoint.model,
    targetId: checkpoint.targetId,
    virtual: false,
  }, {
    owner: parentCtx.account,
    thread: parentCtx.thread,
    branch: parentCtx.branch,
  });
  const restarted = new Engine(structuredClone(next), options);
  await call(
    restarted,
    DS,
    "fork-turn",
    [opaque, msg("user", "LATEST_FORK_882")],
    "turn",
    { ...headers, "thread-id": "opaque-child" },
    undefined,
    metadata("fork-turn", "turn", "opaque-child"),
  );
  assert.equal(seen.filter((body) => body.instructions).length, 1);
  assert.equal(logs.filter((entry) => entry.event === "checkpoint_view_recovered").length, 1);
  assert.match(JSON.stringify(seen.at(-1).input), /FORK_SUMMARY_881/);
  assert.match(JSON.stringify(seen.at(-1).input), /LATEST_FORK_882/);

  await assert.rejects(
    call(
      restarted,
      DS,
      "other-account",
      [opaque],
      "turn",
      { ...headers, authorization: "Bearer other", "thread-id": "other-child" },
      undefined,
      metadata("other-account", "turn", "other-child"),
    ),
    (error) => error.type === "compaction_history_unavailable",
  );
});

test("a fork waits for an in-flight same-account compaction observation", async () => {
  const next = config();
  next.history = { observationWaitMs: 1000 };
  const engine = new Engine(next, {
    resolveIdentity: async () => "chatgpt:fixture",
  });
  const parentBody = {
    model: GPT,
    input: [],
    client_metadata: metadata("parent", "turn", "pending-parent"),
  };
  const parentHeaders = { ...headers, "thread-id": "pending-parent" };
  const prepared = await engine.officialRelayContext(parentHeaders, parentBody);
  let release;
  const observation = engine.queueOfficialObservation(prepared, async () => {
    await new Promise((resolve) => { release = resolve; });
    return engine.commitOfficialObservation(
      parentHeaders,
      parentBody,
      { id: "resp_pending_parent", status: "completed", output: [opaque] },
    );
  });
  await new Promise((resolve) => setImmediate(resolve));
  const childBody = {
    model: DS,
    input: [opaque],
    client_metadata: metadata("child", "turn", "pending-child"),
  };
  const childHeaders = { ...headers, "thread-id": "pending-child" };
  const required = engine.requireObservedHistory(childHeaders, childBody);
  release();
  const ctx = await required;
  await observation;
  assert.equal(
    checkpointFor(engine.state, ctx, opaque).checkpoint.provider,
    "chatgpt-subscription",
  );
});

test("official response lineage survives missing or changed thread metadata", async () => {
  const engine = new Engine(config());
  const parentHeaders = { ...headers, "thread-id": "response-parent" };
  await engine.commitOfficialObservation(
    parentHeaders,
    {
      model: GPT,
      input: [msg("user", "parent")],
      client_metadata: metadata("parent", "turn", "response-parent"),
    },
    {
      id: "resp_cross_thread_lineage",
      status: "completed",
      output: [msg("assistant", "saved")],
    },
  );
  const childBody = {
    model: GPT,
    previous_response_id: "resp_cross_thread_lineage",
    input: [],
    client_metadata: metadata("child", "turn", "response-child"),
  };
  const sameAccount = await engine.officialRelayContext(
    { ...headers, "thread-id": "response-child" },
    childBody,
  );
  assert.equal(sameAccount.previous?.continuationProvenance, "official-relay");
  const otherAccount = await engine.officialRelayContext(
    { ...headers, authorization: "Bearer other", "thread-id": "response-child" },
    childBody,
  );
  assert.equal(otherAccount.previous, undefined);
});

test("one migration preparation never makes multiple source-model calls", async () => {
  const next = config();
  next.targets.go.compression.nativeMigrationSummary = true;
  const seen = [];
  const e = new Engine(next, {
    send: async (_, options) => {
      seen.push(options.body);
      return json(result([msg("assistant", "unexpected") ]));
    },
  });
  const second = {
    type: "compaction",
    encrypted_content: "official-opaque-second-test-only",
  };
  await e.commitOfficialObservation(
    headers,
    { model: GPT, input: [] },
    { id: "resp_two_compactions", status: "completed", output: [opaque, second] },
  );
  await assert.rejects(
    call(e, DS, "two-migrations", [opaque, second, msg("user", "continue")]),
    (error) => error.type === "migration_summary_call_limit_exceeded",
  );
  assert.equal(seen.length, 0);
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
    [DS],
  );
  assert.deepEqual(officialSeen, [GPT, GPT, GPT]);
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
  c.targets.go.compression.nativeMigrationSummary = true;
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
  const c = config();
  c.targets.go.compression.nativeMigrationSummary = true;
  c.targets.go.app = { enabled: true, useResponsesLite: true };
  const gw = createGateway(c, {
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
  // Exercise the actual prewarm entrypoint before checkpoint migration, not a
  // synthetic state.save that already supplies the missing target identity.
  const ctx = await gw.engine.identify("subscription", headers, {
    client_metadata: metadata("migrated"),
  });
  saveCheckpoint(gw.engine.state, ctx, opaque, {
    provider: "chatgpt-subscription", model: GPT, targetId: `official:${GPT}`,
    completeness: "complete_original", original: [msg("user", "source")],
    view: [opaque],
    migration: { targetId: "go", status: "completed", view: [msg("assistant", "summary")] },
  });
  const warmMigration = await request({ generate: false, input: [prefix] });
  assert.equal(seen.length, 1);
  assert.equal(gw.engine.state.response(ctx, warmMigration.id).target?.id, "go");
  await request({
    previous_response_id: warmMigration.id,
    input: [opaque, msg("user", "read after migration")],
    client_metadata: metadata("migrated"),
  });
  assert.deepEqual(seen[1].input.filter(item => item.type === "additional_tools"), [prefix]);
  assert.equal(seen.length, 2);
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
  const { zstdCompressSync, zstdDecompressSync } = await import("node:zlib");
  const seen = [];
  const gateway = createGateway(config(), {
    log: () => {},
    send: async () => assert.fail("native official compaction entered Engine"),
    officialRequest: async (_, options) => {
      const body = JSON.parse(zstdDecompressSync(options.body));
      seen.push(body);
      return json(result(body.input.some((x) => x.type === "compaction_trigger")
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

test("native compaction canonicalizes only cross-target gateway-projected history", async () => {
  const seen = [];
  const engine = new Engine(config(), {
    send: async (_, options) => {
      seen.push(options.body);
      return json(result([opaque]));
    },
  });
  const priorCtx = identity("subscription", headers, {
    input: [],
    client_metadata: metadata("projected-native-prior"),
  });
  engine.state.set(
    "last-target:" + priorCtx.owner,
    { ...config().targets.go },
    priorCtx,
  );
  const projectedCall = {
    type: "function_call",
    id: "item_gateway_projected_call",
    call_id: "call_projected",
    name: "exec_command",
    arguments: "{}",
  };
  const projectedOutput = {
    type: "function_call_output",
    id: "item_gateway_projected_output",
    call_id: projectedCall.call_id,
    output: "done",
  };
  const compacted = await call(
    engine,
    GPT,
    "projected-native-compact",
    [
      { ...msg("assistant", "projected"), id: "item_gateway_projected_message" },
      projectedCall,
      projectedOutput,
      { type: "compaction_trigger" },
    ],
    "compaction",
  );

  assert.equal(seen.length, 1);
  assert.doesNotMatch(JSON.stringify(seen[0].input), /item_gateway_/);
  assert.ok(seen[0].input.some((item) => item.type === "compaction_trigger"));
  assert.equal(
    seen[0].input.find((item) => item.type === "function_call")?.call_id,
    projectedCall.call_id,
  );
  const ctx = identity("subscription", headers, {
    input: compacted.output,
    client_metadata: metadata("projected-native-resume"),
  });
  const checkpoint = checkpointFor(engine.state, ctx, compacted.output[0]);
  assert.doesNotMatch(JSON.stringify(checkpoint.checkpoint.original), /item_gateway_/);

  const sameTargetConfig = config();
  sameTargetConfig.targets.go.compression = { mode: "native" };
  const sameTargetSeen = [];
  const sameTargetEngine = new Engine(sameTargetConfig, {
    send: async (_, options) => {
      sameTargetSeen.push(options.body);
      return json(result([opaque]));
    },
  });
  const sameTargetCtx = identity("subscription", headers, {
    input: [],
    client_metadata: metadata("projected-native-same-target"),
  });
  sameTargetEngine.state.set(
    "last-target:" + sameTargetCtx.owner,
    { ...sameTargetConfig.targets.go },
    sameTargetCtx,
  );
  await call(
    sameTargetEngine,
    DS,
    "projected-native-same-target",
    [projectedCall, projectedOutput, { type: "compaction_trigger" }],
    "compaction",
  );
  assert.match(JSON.stringify(sameTargetSeen[0].input), /item_gateway_/);
});

test("custom native compaction owns oversized context and metadata-only continuation", async () => {
  const next = config();
  next.targets.go.contextWindow = 100;
  next.targets.go.maxContextWindow = 100;
  next.targets.go.outputReserveTokens = 10;
  next.targets.go.compression = { mode: "native" };
  const seen = [], logs = [];
  const send = async (_, options) => {
    seen.push(options.body);
    return json(result(
      options.body.input.some((item) => item.type === "compaction_trigger")
        ? [{ type: "compaction", encrypted_content: "custom-native-opaque" }]
        : [msg("assistant", "continued")],
    ));
  };
  const engine = new Engine(next, { send, log: (entry) => logs.push(entry) });
  const compacted = await call(
    engine,
    DS,
    "custom-native-compact",
    [msg("user", "NATIVE_CONTEXT_" + "x".repeat(20000)), { type: "compaction_trigger" }],
    "compaction",
  );
  assert.equal(seen.length, 1);
  assert.ok(logs.some((entry) =>
    entry.event === "context_budget_preflight_observed" &&
    entry.decision === "upstream_owned_native"));
  assert.equal(
    logs.find((entry) => entry.event === "compaction_completed")?.summary_calls,
    0,
  );

  const restarted = new Engine(structuredClone(next), { send });
  const request = {
    model: DS,
    input: [...compacted.output, msg("user", "continue")],
    client_metadata: metadata("custom-native-resume"),
  };
  const ctx = identity("subscription", headers, request);
  saveCheckpoint(restarted.state, ctx, compacted.output[0], {
    provider: "go",
    model: DS,
    targetId: "go",
    virtual: false,
    completeness: "metadata_only",
  });
  await restarted.requireObservedHistory(headers, request, "go");
  await call(restarted, DS, "custom-native-resume", request.input);
  assert.deepEqual(seen.at(-1).input[0], compacted.output[0]);

  await assert.rejects(
    restarted.requireObservedHistory(headers, {
      ...request,
      input: [{ type: "compaction", encrypted_content: "unknown-native" }],
    }, "go"),
    (error) => error.type === "history_observation_incomplete",
  );
});

test("native-compatible and completed migration checkpoints bypass migration tail estimates", async () => {
  const next = config();
  next.targets.go.contextWindow = 4000;
  next.targets.go.maxContextWindow = 4000;
  next.targets.go.outputReserveTokens = 100;
  next.targets.go.compression = {
    mode: "native",
    nativeMigrationSummary: true,
  };
  const seen = [], logs = [];
  const engine = new Engine(next, {
    log: (event) => logs.push(event),
    send: async (_, request) => {
      seen.push(request.body);
      return json(result([msg("assistant", "continued")]));
    },
  });
  const native = { type: "compaction", encrypted_content: "native-large-tail" };
  const nativeCtx = identity("subscription", headers, {
    input: [native], client_metadata: metadata("native-large-tail"),
  });
  saveCheckpoint(engine.state, nativeCtx, native, {
    provider: "go",
    model: DS,
    targetId: "go",
    virtual: false,
    completeness: "metadata_only",
  });
  const tail = msg("user", "x".repeat(6000));
  await call(engine, DS, "native-large-tail", [native, tail]);
  assert.deepEqual(seen.at(-1).input[0], native);

  const migrated = { type: "compaction", encrypted_content: "migrated-large-tail" };
  const migratedCtx = identity("subscription", headers, {
    input: [migrated], client_metadata: metadata("migrated-large-tail"),
  });
  saveCheckpoint(engine.state, migratedCtx, migrated, {
    provider: "chatgpt-subscription",
    model: GPT,
    targetId: `official:${GPT}`,
    view: [migrated],
    completeness: "opaque_source_only",
    virtual: false,
    migration: {
      targetId: "go",
      provider: "go",
      model: DS,
      status: "completed",
      sourceHash: "fixture",
      view: [msg("assistant", "MIGRATED_FACT")],
    },
  });
  await call(engine, DS, "migrated-large-tail", [migrated, tail]);
  assert.match(JSON.stringify(seen.at(-1).input), /MIGRATED_FACT/);
  assert.equal(logs.filter((event) => event.event === "native_migration_summary_completed").length, 0);
  assert.equal(logs.filter((event) => event.event === "native_migration_summary_reused").length, 1);
});

test("a reused migration summary is not regenerated after upstream context rejection", async () => {
  const next = config();
  next.targets.go.compression.nativeMigrationSummary = true;
  let targetCalls = 0, officialSummaries = 0;
  const engine = new Engine(next, {
    send: async () => {
      targetCalls++;
      return upstreamError(413, "context_length_exceeded", "maximum context length exceeded");
    },
  });
  const migrated = { type: "compaction", encrypted_content: "migrated-upstream-limit" };
  const ctx = identity("subscription", headers, {
    input: [migrated], client_metadata: metadata("migrated-upstream-limit"),
  });
  saveCheckpoint(engine.state, ctx, migrated, {
    provider: "chatgpt-subscription",
    model: GPT,
    targetId: `official:${GPT}`,
    view: [migrated],
    completeness: "opaque_source_only",
    virtual: false,
    migration: {
      targetId: "go",
      provider: "go",
      model: DS,
      status: "completed",
      sourceHash: "fixture",
      view: [msg("assistant", "MIGRATED_FACT")],
    },
  });
  await assert.rejects(
    call(
      engine,
      DS,
      "migrated-upstream-limit",
      [migrated, msg("user", "continue")],
      "turn",
      headers,
      undefined,
      undefined,
      {
        officialSummary: async () => {
          officialSummaries++;
          return { type: "response.completed", response: result([]) };
        },
      },
    ),
    (error) => error.type === "context_after_summary_exceeded",
  );
  assert.equal(targetCalls, 1);
  assert.equal(officialSummaries, 0);
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

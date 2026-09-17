import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Archive } from "../src/archive.mjs";
import {
  applyRolloutRecovery,
  checkpointScope,
  importRollout,
  planRolloutRecovery,
  readRollout,
} from "../src/rollout.mjs";
import { expandCheckpoints } from "../src/history.mjs";
import { StateStore } from "../src/state.mjs";

const key = Buffer.alloc(32, 19);

const line = (type, payload) => JSON.stringify({ type, payload });
const record = (ordinal, type, payload) => JSON.stringify({ ordinal, type, payload });
const compacted = (content = "official-checkpoint") => ({
  compaction_response_id: "compact-1",
  retained_context: { incomplete: false },
  replacement_history: [{ type: "compaction", encrypted_content: content }],
});

async function rolloutPath(root, thread, records, day = "2026/09/17") {
  const dir = join(root, day);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `rollout-test-${thread}.jsonl`);
  await writeFile(path, records.join("\n") + "\n");
  return path;
}

test("rollout import preserves original history across compaction and keeps the active view", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-rollout-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "rollout.jsonl");
  await writeFile(
    path,
    [
      line("session_meta", {
        id: "thread-rollout",
        model_provider: "openai",
        model: "gpt-test",
      }),
      line("response_item", {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "before" }],
      }),
      line("response_item", {
        type: "function_call",
        call_id: "call-1",
        name: "read",
        arguments: "{}",
      }),
      line("response_item", {
        type: "function_call_output",
        call_id: "call-1",
        output: "tool result",
      }),
      line("response_item", {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "first answer" }],
      }),
      line("compacted", {
        compaction_response_id: "compact-1",
        replacement_history: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "summary checkpoint" }],
          },
        ],
      }),
      // Codex App may emit an application-level output without a tool call id.
      // It is still an event and must not turn an otherwise complete import into a gap.
      line("response_item", {
        type: "custom_tool_call_output",
        output: "application event",
      }),
      line("response_item", {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "after" }],
      }),
      line("response_item", {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "second answer" }],
      }),
    ].join("\n"),
  );

  const rollout = await readRollout(path, "thread-rollout");
  await assert.rejects(
    readRollout(path, "different-thread"),
    (error) => error.type === "rollout_thread_mismatch",
  );

  const archive = new Archive(join(dir, "history.sqlite"), key);
  t.after(() => archive.close());
  const imported = importRollout(archive, rollout, {
    owner: "chatgpt:account",
    branch: "thread-rollout",
  });
  assert.equal(imported.versions, 2);

  const latest = archive.history({
    owner: "chatgpt:account",
    thread: "thread-rollout",
    branch: "thread-rollout",
  });
  assert.equal(latest.status, "complete_original");
  assert.equal(latest.original.length, 7);
  assert.equal(latest.view.length, 4);
  assert.equal(latest.original[0].content[0].text, "before");
  assert.equal(latest.view[0].content[0].text, "summary checkpoint");
  assert.equal(latest.view.at(-1).content[0].text, "second answer");
});

test("rollout recovery previews, writes, expands and repeats idempotently", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-rollout-recover-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessions = join(dir, "sessions");
  const thread = "thread-recover";
  const source = await rolloutPath(sessions, thread, [
    record(0, "session_meta", { id: thread, model_provider: "openai", model: "gpt-test" }),
    record(1, "turn_context", { model: "gpt-test" }),
    record(2, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "before" }] }),
    record(3, "response_item", { type: "function_call", call_id: "call-1", name: "read", arguments: "{}" }),
    record(4, "response_item", { type: "function_call_output", call_id: "call-1", output: "result" }),
    record(5, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }),
    record(6, "compacted", compacted()),
  ]);
  const plan = await planRolloutRecovery({ thread, source, sessionsRoot: sessions });
  assert.equal(plan.checkpoints.length, 1);
  assert.equal(plan.checkpoints[0].checkpoint.original.length, 4);
  assert.equal(plan.checkpoints[0].checkpoint.virtual, false);

  const archive = new Archive(join(dir, "history.sqlite"), key);
  t.after(() => archive.close());
  const account = "chatgpt:recover-account";
  assert.deepEqual(applyRolloutRecovery(archive, plan, { account }).written, 0);
  const applied = applyRolloutRecovery(archive, plan, { account, apply: true });
  assert.equal(applied.written, 1);
  assert.deepEqual(applied.events, [{ event: "rollout_checkpoint_recovered", count: 1 }]);
  assert.doesNotMatch(JSON.stringify(applied), /before|result|answer|official-checkpoint/);
  assert.equal(applyRolloutRecovery(archive, plan, { account, apply: true }).existing, 1);

  const auth = createHash("sha256").update(account).digest("hex");
  const { keyOwner } = checkpointScope(account, thread);
  const digest = createHash("sha256").update("official-checkpoint").digest("hex");
  const saved = archive.getState(`checkpoint:${keyOwner}:${digest}`);
  assert.equal(saved.recovery.sourceHash, plan.checkpoints[0].sourceHash);
  assert.equal(archive.checkpointStats({ owner: account, thread, branch: thread }).portable, 1);

  const state = new StateStore({}, archive);
  const expanded = expandCheckpoints(
    state,
    { auth, account, thread, branch: thread, owner: keyOwner },
    [{ type: "compaction", encrypted_content: "official-checkpoint" }],
    { id: "third-party", provider: "third-party", model: "gpt-test" },
    { portable: true },
  );
  assert.equal(expanded.input.length, 4);
  assert.ok(!JSON.stringify(expanded.input).includes("official-checkpoint"));
});

test("rollout recovery follows one exact parent chain and preserves fork boundaries", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-rollout-chain-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessions = join(dir, "sessions");
  const parent = "parent-thread";
  const child = "child-thread";
  await rolloutPath(sessions, parent, [
    record(0, "session_meta", { id: parent, model: "gpt-parent" }),
    record(1, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "parent" }] }),
    record(2, "compacted", compacted("parent-checkpoint")),
    record(3, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "after-fork" }] }),
  ]);
  const source = await rolloutPath(sessions, child, [
    record(0, "session_meta", {
      id: child,
      model: "gpt-child",
      history_base: { thread_id: parent, end_ordinal_exclusive: 3 },
      forked_from_id: parent,
      forked_from_ordinal_exclusive: 3,
    }),
    record(3, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "child" }] }),
    record(4, "compacted", compacted("child-checkpoint")),
  ]);
  const plan = await planRolloutRecovery({ thread: child, source, sessionsRoot: sessions });
  assert.deepEqual(plan.files.map((file) => file.thread), [parent, child]);
  assert.deepEqual(plan.checkpoints.map((checkpoint) => checkpoint.thread), [parent, child]);
  assert.equal(plan.checkpoints[1].checkpoint.original.length, 2);
  assert.match(JSON.stringify(plan.checkpoints[1].checkpoint.original), /parent/);
  assert.match(JSON.stringify(plan.checkpoints[1].checkpoint.original), /child/);
  assert.doesNotMatch(JSON.stringify(plan.checkpoints[1].checkpoint.original), /after-fork/);
});

test("rollout recovery rejects missing bases, bad boundaries and incomplete tools before writing", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-rollout-invalid-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessions = join(dir, "sessions");
  const archive = new Archive(join(dir, "history.sqlite"), key);
  t.after(() => archive.close());

  const missing = "missing-parent-child";
  const missingSource = await rolloutPath(sessions, missing, [
    record(0, "session_meta", {
      id: missing,
      history_base: { thread_id: "absent-parent", end_ordinal_exclusive: 2 },
      forked_from_id: "absent-parent",
      forked_from_ordinal_exclusive: 2,
    }),
    record(2, "response_item", { type: "message", role: "user", content: [] }),
    record(3, "compacted", compacted()),
  ]);
  await assert.rejects(
    planRolloutRecovery({ thread: missing, source: missingSource, sessionsRoot: sessions }),
    (error) => error.type === "rollout_history_base_missing",
  );

  const badTools = "bad-tools";
  const badToolsSource = await rolloutPath(sessions, badTools, [
    record(0, "session_meta", { id: badTools }),
    record(1, "response_item", { type: "function_call", call_id: "pending", name: "read", arguments: "{}" }),
    record(2, "compacted", compacted()),
  ]);
  await assert.rejects(
    planRolloutRecovery({ thread: badTools, source: badToolsSource, sessionsRoot: sessions }),
    (error) => error.type === "rollout_history_incomplete",
  );

  const virtual = "virtual-checkpoint";
  const virtualSource = await rolloutPath(sessions, virtual, [
    record(0, "session_meta", { id: virtual }),
    record(1, "response_item", { type: "message", role: "user", content: [] }),
    record(2, "compacted", compacted("gateway-checkpoint-v1:not-official")),
  ]);
  await assert.rejects(
    planRolloutRecovery({ thread: virtual, source: virtualSource, sessionsRoot: sessions }),
    (error) => error.type === "rollout_history_incomplete",
  );

  const parent = "short-parent";
  const child = "bad-boundary";
  await rolloutPath(sessions, parent, [
    record(0, "session_meta", { id: parent }),
    record(1, "response_item", { type: "message", role: "user", content: [] }),
  ]);
  const badBoundarySource = await rolloutPath(sessions, child, [
    record(0, "session_meta", {
      id: child,
      history_base: { thread_id: parent, end_ordinal_exclusive: 4 },
      forked_from_id: parent,
      forked_from_ordinal_exclusive: 4,
    }),
    record(4, "response_item", { type: "message", role: "user", content: [] }),
    record(5, "compacted", compacted()),
  ]);
  await assert.rejects(
    planRolloutRecovery({ thread: child, source: badBoundarySource, sessionsRoot: sessions }),
    (error) => error.type === "rollout_lineage_conflict",
  );
  assert.equal(archive.stats().records, 0);
});

test("rollout recovery rejects ambiguous sources, damaged JSON and checkpoint conflicts", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-rollout-conflict-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessions = join(dir, "sessions");
  const thread = "ambiguous-thread";
  const body = [
    record(0, "session_meta", { id: thread, model: "gpt-test" }),
    record(1, "response_item", { type: "message", role: "user", content: [] }),
    record(2, "compacted", compacted("conflict-checkpoint")),
  ];
  const source = await rolloutPath(sessions, thread, body, "2026/09/17");
  await rolloutPath(sessions, thread, body, "2026/09/18");
  await assert.rejects(
    planRolloutRecovery({ thread, sessionsRoot: sessions }),
    (error) => error.type === "rollout_lineage_conflict",
  );
  const damaged = await rolloutPath(sessions, "damaged-thread", [
    record(0, "session_meta", { id: "damaged-thread" }),
    "{not-json",
  ]);
  await assert.rejects(
    planRolloutRecovery({ thread: "damaged-thread", source: damaged, sessionsRoot: sessions }),
    (error) => error.type === "rollout_history_incomplete",
  );

  const plan = await planRolloutRecovery({ thread, source, sessionsRoot: sessions });
  const archive = new Archive(join(dir, "history.sqlite"), key);
  t.after(() => archive.close());
  const account = "chatgpt:conflict";
  const { keyOwner, scope } = checkpointScope(account, thread);
  const digest = createHash("sha256").update("conflict-checkpoint").digest("hex");
  archive.setState(`checkpoint:${keyOwner}:${digest}`, {
    ...plan.checkpoints[0].checkpoint,
    original: [{ type: "message", role: "user", content: [{ type: "input_text", text: "conflict" }] }],
  }, scope);
  await assert.rejects(
    Promise.resolve().then(() => applyRolloutRecovery(archive, plan, { account, apply: true })),
    (error) => error.type === "rollout_lineage_conflict",
  );
  assert.equal(archive.checkpointStats({ owner: account, thread, branch: thread }).recovered, 0);
});

test("rollout recovery streams a long source within the local linear-time guard", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-rollout-long-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessions = join(dir, "sessions");
  const thread = "long-thread";
  const rows = [record(0, "session_meta", { id: thread, model: "gpt-test" })];
  for (let index = 1; index <= 10_000; index++)
    rows.push(record(index, "response_item", {
      type: "message",
      role: index % 2 ? "user" : "assistant",
      content: [{ type: index % 2 ? "input_text" : "output_text", text: `item-${index}` }],
    }));
  rows.push(record(10_001, "compacted", compacted("long-checkpoint")));
  const source = await rolloutPath(sessions, thread, rows);
  const started = performance.now();
  const plan = await planRolloutRecovery({ thread, source, sessionsRoot: sessions });
  assert.equal(plan.checkpoints[0].checkpoint.original.length, 10_000);
  assert.ok(performance.now() - started < 2_000);
});

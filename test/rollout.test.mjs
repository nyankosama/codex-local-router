import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Archive } from "../src/archive.mjs";
import { importRollout, readRollout } from "../src/rollout.mjs";

const key = Buffer.alloc(32, 19);

const line = (type, payload) => JSON.stringify({ type, payload });

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

import test from "node:test";
import assert from "node:assert/strict";
import { SearchResponseStream } from "../src/response-stream.mjs";
import { probeSearchStreaming } from "../scripts/e2e/lib/search-streaming-probe.mjs";

for (const transport of ["http", "websocket"])
  for (const mode of ["subscription_bridge", "tool_fallback"])
    for (const rounds of [0, 2])
      test(`client receives text before upstream can finish: ${transport}/${mode}/${rounds} searches`,
        { timeout: 15000 }, () => probeSearchStreaming({ transport, mode, rounds }));

test("nameless functions stay private until classified; terminal-only items still work", () => {
  for (const name of ["private_search", "user_mcp"]) {
    const stream = new SearchResponseStream((item) => item.type === "function_call" && item.name === "private_search");
    const added = stream.push({ type: "response.output_item.added", output_index: 0,
      item: { id: "tool", type: "function_call", name: "", call_id: "call", arguments: "" } });
    assert.equal(added.length, 1); // response.created only
    assert.deepEqual(stream.push({ type: "response.function_call_arguments.delta", output_index: 0,
      item_id: "tool", delta: "{}" }), []);
    const done = stream.push({ type: "response.output_item.done", output_index: 0,
      item: { id: "tool", type: "function_call", name, call_id: "call", arguments: "{}" } });
    assert.equal(done.length, name === "private_search" ? 0 : 3);
    if (done.length) {
      assert.equal(done[0].item.name, "user_mcp");
      assert.equal(done[0].item.call_id, "call");
      assert.equal(done[1].item_id, done[0].item.id);
    }
    stream.beginRound();
    const terminal = { status: "incomplete", output: [{ id: "answer", type: "message", content: [] }] };
    assert.equal(stream.endRound(terminal).length, 2);
    assert.equal(stream.finish(terminal).type, "response.incomplete");
  }
});

test("unclassifiable or mutated tools fail closed instead of leaking an internal call", () => {
  const stream = new SearchResponseStream((item) => item.name === "private_search");
  assert.throws(() => stream.push({ type: "response.function_call_arguments.delta", output_index: 0, delta: "private" }), /invalid_upstream_response/);
  stream.push({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", name: "user_mcp" } });
  assert.throws(() => stream.push({ type: "response.output_item.done", output_index: 0,
    item: { type: "function_call", name: "private_search" } }), /invalid_upstream_response/);
});

test("done-only output is reconstructed and unfinished items never report success", () => {
  const stream = new SearchResponseStream(() => false);
  const item = { type: "message", id: "m", content: [] };
  const events = stream.push({ type: "response.output_item.done", output_index: 0, item });
  assert.deepEqual(events.map((e) => e.type), ["response.created", "response.output_item.added", "response.output_item.done"]);
  assert.equal(stream.endRound({ output: [item] }).length, 0);
  stream.beginRound();
  stream.push({ type: "response.output_item.added", output_index: 0, item });
  assert.throws(() => stream.endRound({ output: [] }), /upstream_stream_incomplete/);
});

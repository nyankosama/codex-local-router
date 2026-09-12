import test from "node:test";
import assert from "node:assert/strict";
import {
  inputToMessages,
  toChat,
  chatToResponse,
  chatChunkToEvents,
} from "../src/translate.mjs";
test("converts Responses input and tools to chat", () => {
  const q = toChat(
    {
      instructions: "be concise",
      input: [{ role: "user", content: "hi" }],
      tools: [
        { type: "function", name: "read", parameters: { type: "object" } },
      ],
    },
    "deepseek-v4-pro",
  );
  assert.deepEqual(q.messages, [
    { role: "system", content: "be concise" },
    { role: "user", content: "hi" },
  ]);
  assert.equal(q.tools[0].function.name, "read");
});
test("replays function call outputs", () => {
  const m = inputToMessages({
    input: [
      { type: "function_call", call_id: "c1", name: "read", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "ok" },
    ],
  });
  assert.equal(m[0].tool_calls[0].id, "c1");
  assert.deepEqual(m[1], { role: "tool", tool_call_id: "c1", content: "ok" });
});
test("converts chat response tool calls", () => {
  const r = chatToResponse(
    {
      choices: [
        {
          message: {
            role: "assistant",
            tool_calls: [
              { id: "c1", function: { name: "read", arguments: "{}" } },
            ],
          },
        },
      ],
    },
    "deepseek-v4-pro",
  );
  assert.equal(r.output[0].type, "function_call");
  assert.equal(r.output[0].call_id, "c1");
});
test("preserves streaming reasoning and text deltas", () => {
  const e = chatChunkToEvents(
    { choices: [{ delta: { reasoning_content: "think", content: "answer" } }] },
    {},
  );
  assert.deepEqual(
    e.map((x) => x.type),
    ["response.reasoning_summary_text.delta", "response.output_text.delta"],
  );
});
test("adds explicit web search fallback tool", () => {
  const q = toChat({ input: "search" }, "glm-5.3", { webSearchFallback: true });
  assert.equal(q.tools[0].function.name, "gateway_web_search");
});
test("maps Responses tool choice, reasoning effort and usage request to Chat", () => {
  const q = toChat(
    {
      input: "hi",
      stream: true,
      reasoning: { effort: "low" },
      tools: [{ type: "function", name: "echo" }],
      tool_choice: { type: "function", name: "echo" },
    },
    "chat",
  );
  assert.deepEqual(q.tool_choice, {
    type: "function",
    function: { name: "echo" },
  });
  assert.equal(q.reasoning_effort, "low");
  assert.equal(q.stream_options.include_usage, true);
});

import test from "node:test";
import assert from "node:assert/strict";
import { sseEvents } from "../src/sse.mjs";
import { deterministicProviderRequest } from "../scripts/e2e/lib/deterministic-upstream.mjs";

async function events(response) {
  const rows = [];
  for await (const row of sseEvents(response.body)) rows.push(row);
  return rows;
}

test("A10 deterministic Responses fixture streams exact local markers", async () => {
  const response = await deterministicProviderRequest("https://provider.invalid/v1/responses", {
    body: {
      model: "fixture-responses",
      stream: true,
      input: "Reply exactly E2E_LOCAL_FIXTURE_OK and nothing else.",
    },
  });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const rows = await events(response);
  assert.equal(rows.find((row) => row.type === "response.output_text.delta")?.delta, "E2E_LOCAL_FIXTURE_OK");
  assert.equal(rows.at(-1)?.type, "response.completed");
});

test("A10 deterministic Chat fixture closes the internal search loop locally", async () => {
  const first = await events(await deterministicProviderRequest("https://provider.invalid/v1/chat/completions", {
    body: {
      model: "fixture-chat",
      stream: true,
      messages: [{ role: "user", content: "Use search once." }],
    },
  }));
  assert.equal(first[0].choices[0].delta.tool_calls[0].function.name, "gateway_web_search");

  const second = await events(await deterministicProviderRequest("https://provider.invalid/v1/chat/completions", {
    body: {
      model: "fixture-chat",
      stream: true,
      messages: [
        { role: "user", content: "Use search once." },
        { role: "tool", tool_call_id: "fixture", content: "local result" },
      ],
    },
  }));
  assert.match(second[0].choices[0].delta.content, /deterministic search result/i);
  assert.equal(second.at(-1).choices[0].finish_reason, "stop");
});

import test from "node:test";
import assert from "node:assert/strict";
import { readSSE } from "../src/sse.mjs";

test("parses SSE events split across network chunks", async () => {
  const chunks = [
    'data: {"a":',
    "1}\n\n",
    'data: {"b":2}\n\n',
    "data: [DONE]\n\n",
  ];
  const events = [];
  await readSSE(
    (async function* () {
      for (const x of chunks) yield new TextEncoder().encode(x);
    })(),
    (e) => events.push(e),
  );
  assert.deepEqual(events, [{ a: 1 }, { b: 2 }]);
});

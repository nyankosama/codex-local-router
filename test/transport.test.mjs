import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { request } from "../src/transport.mjs";

test("curl failures expose only a structured transport diagnosis", async (t) => {
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  await assert.rejects(
    request(`http://127.0.0.1:${server.address().port}`, {
      body: {},
      timeoutMs: 5000,
    }),
    (error) =>
      error.type === "upstream_connection_error" &&
      Number.isInteger(error.transportCode) &&
      typeof error.transportCategory === "string" &&
      !error.message.includes("127.0.0.1"),
  );
});

test("curl partial-file failures are classified instead of left as other", async () => {
  const { transportCategoryOf } = await import("../src/transport.mjs");
  assert.equal(transportCategoryOf(18, ""), "truncated");
  assert.equal(transportCategoryOf(0, "curl: (18) end of response with 123 bytes missing"), "truncated");
  assert.equal(transportCategoryOf(28, ""), "timeout");
  assert.equal(transportCategoryOf(92, ""), "http2");
  assert.equal(transportCategoryOf(99, "unexpected"), "other");
});

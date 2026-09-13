import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { request } from "../src/transport.mjs";
import { requestRaw } from "../src/transport.mjs";

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

test("raw transport preserves method, query, request bytes and compressed response bytes", async (t) => {
  const requestBytes = Buffer.from([0, 1, 2, 127, 128, 255]);
  const responseBytes = Buffer.from([31, 139, 8, 0, 0, 255, 10, 11]);
  let captured;
  const server = await new Promise((resolve) => {
    const instance = createHttpServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        captured = {
          method: req.method,
          url: req.url,
          body: Buffer.concat(chunks),
          header: req.headers["x-fixture"],
        };
        res.writeHead(218, {
          "content-type": "application/octet-stream",
          "content-encoding": "gzip",
          "x-response": "preserved",
        });
        res.end(responseBytes);
      });
    });
    instance.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => server.close());
  const result = await requestRaw(
    `http://127.0.0.1:${server.address().port}/future/path?q=a%20b`,
    {
      method: "PATCH",
      headers: { "content-type": "application/octet-stream", "x-fixture": "kept" },
      body: requestBytes,
    },
  );
  const chunks = [];
  for await (const chunk of result.body) chunks.push(chunk);
  assert.equal(result.status, 218);
  assert.equal(result.headers.get("content-encoding"), "gzip");
  assert.equal(result.headers.get("x-response"), "preserved");
  assert.equal(Buffer.compare(Buffer.concat(chunks), responseBytes), 0);
  assert.equal(captured.method, "PATCH");
  assert.equal(captured.url, "/future/path?q=a%20b");
  assert.equal(captured.header, "kept");
  assert.equal(Buffer.compare(captured.body, requestBytes), 0);
});

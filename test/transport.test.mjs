import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { request } from "../src/transport.mjs";
import { requestRaw } from "../src/transport.mjs";
import { setTimeout as delay } from "node:timers/promises";

async function fixture(t, handler) {
  const server = createHttpServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}/responses`;
}

const consume = async (response) => {
  const chunks = [];
  for await (const chunk of response.body) chunks.push(chunk);
  return Buffer.concat(chunks);
};
const isTimeout = (error) => error.type === "upstream_timeout" &&
  error.transportCode === 28 && error.transportCategory === "timeout";

test("SSE keeps streaming beyond timeoutMs while non-SSE retains its total deadline", async (t) => {
  for (const streaming of [true, false]) {
    await t.test(streaming ? "active SSE" : "finite JSON", async (t) => {
      const url = await fixture(t, (_req, res) => {
        res.writeHead(200, { "content-type": streaming ? "text/event-stream; charset=utf-8" : "application/json" });
        res.flushHeaders();
        let count = 0;
        const timer = setInterval(() => {
          res.write(streaming ? `data: ${++count}\n\n` : " ");
          if (count === 20) res.end("data: [DONE]\n\n");
        }, 100);
        res.on("close", () => clearInterval(timer));
      });
      const started = Date.now();
      const result = requestRaw(url, { timeoutMs: 1000 }).then(consume);
      if (streaming) {
        assert.match((await result).toString(), /\[DONE\]/);
        assert.ok(Date.now() - started > 1000);
      } else await assert.rejects(result, isTimeout);
    });
  }
});

test("silent headers and stalled SSE both time out without retry", async (t) => {
  for (const headers of [false, true]) {
    await t.test(headers ? "after headers" : "before headers", async (t) => {
      let calls = 0;
      const url = await fixture(t, (_req, res) => {
        calls++;
        if (headers) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.flushHeaders();
        }
      });
      await assert.rejects(requestRaw(url, { timeoutMs: 600 }).then(consume), isTimeout);
      assert.equal(calls, 1);
    });
  }
});

test("SSE backpressure is not upstream inactivity", async (t) => {
  const payload = Buffer.alloc(2 * 1024 * 1024, 120);
  const url = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(payload);
  });
  const response = await requestRaw(url, { timeoutMs: 600 });
  await delay(1300);
  assert.deepEqual(await consume(response), payload);
});

test("active SSE remains cancellable and consumer close releases upstream", async (t) => {
  for (const abort of [true, false]) {
    await t.test(abort ? "AbortSignal" : "consumer close", async (t) => {
      let closed;
      const disconnected = new Promise((resolve) => { closed = resolve; });
      const url = await fixture(t, (_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: start\n\n");
        const timer = setInterval(() => res.write(": heartbeat\n\n"), 50);
        res.on("close", () => { clearInterval(timer); closed(); });
      });
      const controller = new AbortController();
      const response = await requestRaw(url, { timeoutMs: 600, signal: controller.signal });
      if (abort) {
        const reading = consume(response);
        controller.abort();
        await assert.rejects(reading, (error) => error.type === "cancelled");
      } else response.body.destroy();
      await disconnected;
    });
  }
});

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

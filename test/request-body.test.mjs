import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { gzipSync, deflateSync, zstdCompressSync } from "node:zlib";
import { WebSocket } from "ws";
import { createGateway } from "../src/server.mjs";
import { readRequestBody } from "../src/request-body.mjs";

const encoders = { identity: (x) => x, gzip: gzipSync, deflate: deflateSync, zstd: zstdCompressSync };
async function setup(t, limit = 1024 * 1024) {
  const logs = [], received = [];
  const gateway = createGateway({ maxBodyBytes: limit }, { log: (x) => logs.push(x) });
  gateway.engine.generate = async function* (_, headers, body) {
    received.push(body);
    yield { type: "response.completed", response: { id: "fixture", status: "completed", output: [] } };
  };
  await new Promise((r) => gateway.server.listen(0, "127.0.0.1", r));
  t.after(() => gateway.close());
  return { gateway, logs, received, url: `http://127.0.0.1:${gateway.server.address().port}/v1/responses` };
}

test("HTTP compaction bodies decode losslessly for identity, gzip, deflate and zstd (JSON and SSE)", async (t) => {
  const { url, received } = await setup(t);
  for (const [encoding, encode] of Object.entries(encoders)) {
    for (const stream of [false, true]) {
      const body = { model: "fixture", stream, input: [{ role: "user", content: "完整历史中文😀".repeat(12000) }, { type: "compaction_trigger" }] };
      const res = await fetch(url, { method: "POST", headers: { "content-encoding": encoding }, body: encode(Buffer.from(JSON.stringify(body))) });
      assert.equal(res.status, 200);
      assert.deepEqual(received.at(-1), body);
      if (stream) assert.match(await res.text(), /response.completed/);
      else assert.equal((await res.json()).status, "completed");
    }
  }
});

test("HTTP distinguishes bad JSON, corrupt compression, unsupported encodings and both size limits", async (t) => {
  const { url, received, logs } = await setup(t, 1024);
  for (const [encoding, body, status, type] of [
    ["identity", Buffer.from("bad json"), 400, "invalid_json"],
    ["zstd", zstdCompressSync(Buffer.from("bad json")), 400, "invalid_json"],
    ["zstd", Buffer.from("broken zstd"), 400, "invalid_compressed_body"],
    ["gzip", gzipSync(Buffer.from('{}')).subarray(0, 12), 400, "invalid_compressed_body"],
    ["br", Buffer.from("{}"), 415, "unsupported_content_encoding"],
    ["gzip, zstd", Buffer.from("{}"), 415, "unsupported_content_encoding"],
    ["identity", Buffer.alloc(1025, 32), 413, "request_too_large"],
    ["zstd", zstdCompressSync(Buffer.alloc(100000, 32)), 413, "request_too_large"],
  ]) {
    const res = await fetch(url, { method: "POST", headers: { "content-encoding": encoding }, body });
    assert.equal(res.status, status);
    assert.equal((await res.json()).error.type, type);
    assert.equal(logs.at(-1).phase, "request_body");
  }
  assert.equal(received.length, 0);
});

test("decoder accepts fragmented frames and cancels without hanging", async () => {
  const body = Buffer.from(JSON.stringify({ text: "中文😀".repeat(1000) }));
  const encoded = zstdCompressSync(body);
  const req = Readable.from(Array.from(encoded, (b) => Buffer.from([b])));
  req.headers = { "content-encoding": "zstd" };
  assert.deepEqual(await readRequestBody(req, { limit: 100000 }), JSON.parse(body));
  const pending = new Readable({ read() {} });
  pending.headers = { "content-encoding": "gzip" };
  const controller = new AbortController();
  const result = readRequestBody(pending, { limit: 100000, signal: controller.signal });
  controller.abort();
  await assert.rejects(result, { type: "cancelled" });
  pending.destroy();
});

test("WebSocket malformed JSON uses the same invalid_json classification", async (t) => {
  const { url } = await setup(t);
  const ws = new WebSocket(url.replace('http:', 'ws:'));
  await new Promise((r) => ws.once('open', r));
  const result = new Promise((r) => ws.once('message', (raw) => r(JSON.parse(raw))));
  ws.send('{broken');
  assert.equal((await result).error.type, 'invalid_json');
  ws.close();
});

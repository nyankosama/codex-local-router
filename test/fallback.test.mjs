import test from "node:test";
import assert from "node:assert/strict";
import { executeWithFallback } from "../src/fallback.mjs";
test("falls back on transient status", async () => {
  let n = 0;
  const r = await executeWithFallback(
    async () => ({ ok: false, status: 503 }),
    async () => ({ ok: true, status: 200 }),
  );
  assert.equal(r.status, 200);
});
test("does not fall back on auth errors", async () => {
  let n = 0;
  const r = await executeWithFallback(
    async () => ({ ok: false, status: 401 }),
    async () => {
      n++;
      return { ok: true };
    },
  );
  assert.equal(r.status, 401);
  assert.equal(n, 0);
});
test("falls back on 429 and timeout errors", async () => {
  for (const failure of [
    { ok: false, status: 429 },
    { ok: false, status: 500 },
    { name: "TimeoutError" },
  ]) {
    let called = 0;
    const r = await executeWithFallback(
      async () => {
        if (failure.name) throw Object.assign(Error("timeout"), failure);
        return failure;
      },
      async () => {
        called++;
        return { ok: true, status: 200 };
      },
    );
    assert.equal(r.status, 200);
    assert.equal(called, 1);
  }
});
test("does not fall back on capability errors", async () => {
  for (const failure of [
    { ok: false, status: 400 },
    { ok: false, status: 422 },
  ]) {
    let called = 0;
    const r = await executeWithFallback(
      async () => failure,
      async () => {
        called++;
        return { ok: true };
      },
    );
    assert.equal(r.status, failure.status);
    assert.equal(called, 0);
  }
});
test("does not fall back after client cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = 0;
  await assert.rejects(
    executeWithFallback(
      async () => {
        throw Object.assign(Error("cancelled"), { name: "AbortError" });
      },
      async () => {
        called++;
        return { ok: true };
      },
      { signal: controller.signal },
    ),
  );
  assert.equal(called, 0);
});
test("falls back on connection failure", async () => {
  let called = 0;
  const r = await executeWithFallback(
    async () => {
      throw Object.assign(Error("socket closed"), { name: "TypeError" });
    },
    async () => {
      called++;
      return { ok: true, status: 200 };
    },
  );
  assert.equal(r.status, 200);
  assert.equal(called, 1);
});

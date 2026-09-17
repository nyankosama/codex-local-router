import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  PromptCacheAffinity,
} from "../src/prompt-cache-affinity.mjs";
import { prepareThirdPartyProviderBody } from "../src/providers.mjs";

const percentile = (samples, value) => {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))];
};

class MemoryState {
  constructor() { this.values = new Map(); }
  get(key) { return structuredClone(this.values.get(key)); }
  set(key, value) { this.values.set(key, structuredClone(value)); }
}

test("cache affinity derivation and wire adaptation stay within local performance guards", async () => {
  const secret = Buffer.alloc(32, 19);
  const resolver = new PromptCacheAffinity(new MemoryState(), { secret });
  const config = {
    providers: { relay: { promptCaching: { affinity: "gateway-opaque" } } },
  };
  const target = {
    id: "gpt",
    provider: "relay",
    model: "gpt-test",
    modelFamily: "openai-gpt",
    wireApi: "responses",
  };
  const samples = [];
  for (let index = 0; index < 2000; index++) {
    const started = performance.now();
    await resolver.resolve(config, target, {
      prompt_cache_key: "stable-client-key",
    }, {
      auth: "account-hash",
      thread: "thread",
      turn: `turn-${index}`,
      requestKind: "turn",
    });
    samples.push(performance.now() - started);
  }
  assert.ok(percentile(samples, 0.95) < 5);

  const base = {
    model: "gpt-test",
    input: [{ role: "user", content: "synthetic" }],
    stream: true,
  };
  const key = "clr-pc-v1-" + "a".repeat(43);
  const plain = prepareThirdPartyProviderBody(target, base, { applied: false });
  const enabled = prepareThirdPartyProviderBody(target, base, {
    applied: true,
    providerKey: key,
  });
  const wireDelta = Buffer.byteLength(JSON.stringify(enabled)) -
    Buffer.byteLength(JSON.stringify(plain));
  assert.ok(wireDelta > 0 && wireDelta < 128);

  const small = [], large = [];
  const hugeInput = [{ role: "user", content: "x".repeat(2 * 1024 * 1024) }];
  for (let index = 0; index < 5000; index++) {
    let started = performance.now();
    prepareThirdPartyProviderBody(target, base, {
      applied: true,
      providerKey: key,
    });
    small.push(performance.now() - started);
    started = performance.now();
    prepareThirdPartyProviderBody(target, { ...base, input: hugeInput }, {
      applied: true,
      providerKey: key,
    });
    large.push(performance.now() - started);
  }
  assert.ok(percentile(small, 0.95) < 25);
  assert.ok(percentile(large, 0.95) < 25);
  // A shallow clone makes the operation independent of prompt byte length.
  assert.ok(percentile(large, 0.95) < percentile(small, 0.95) + 2);
});

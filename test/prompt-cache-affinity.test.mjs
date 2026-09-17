import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { validate } from "../src/config.mjs";
import {
  PromptCacheAffinity,
  promptCacheSecret,
  resolvePromptCacheAffinity,
  sanitizePromptCacheOptions,
} from "../src/prompt-cache-affinity.mjs";
import { StateStore } from "../src/state.mjs";

const secret = Buffer.alloc(32, 7);
const config = (affinity) => ({
  mode: "rules",
  defaultTarget: "gpt",
  providers: {
    relay: {
      adapter: "openai-compatible",
      baseUrl: "https://relay.example/v1",
      ...(affinity == null ? {} : { promptCaching: { affinity } }),
    },
    other: {
      adapter: "openai-compatible",
      baseUrl: "https://other.example/v1",
      promptCaching: { affinity: "gateway-opaque" },
    },
  },
  targets: {
    gpt: {
      provider: "relay",
      model: "gpt-test",
      modelFamily: "openai-gpt",
      wireApi: "responses",
    },
  },
  rules: [],
});

class MemoryState {
  constructor() { this.values = new Map(); }
  get(key) { return structuredClone(this.values.get(key)); }
  set(key, value) { this.values.set(key, structuredClone(value)); }
}

const ctx = (overrides = {}) => ({
  auth: "account-hash-a",
  thread: "thread-a",
  turn: "turn-a",
  requestKind: "turn",
  ...overrides,
});

test("prompt cache affinity validates explicit modes without changing legacy defaults", () => {
  for (const affinity of [undefined, "none", "gateway-opaque"])
    assert.doesNotThrow(() => validate(config(affinity)));
  for (const promptCaching of [
    {},
    { affinity: "automatic" },
    { affinity: "none", extra: true },
    "gateway-opaque",
  ]) {
    const candidate = config();
    candidate.providers.relay.promptCaching = promptCaching;
    assert.throws(() => validate(candidate), /invalid prompt cache affinity/);
  }
  assert.equal(
    resolvePromptCacheAffinity(config(), config().targets.gpt).reason,
    "provider-default-none",
  );
  assert.equal(
    resolvePromptCacheAffinity(config("none"), config("none").targets.gpt).reason,
    "provider-explicit-none",
  );
  assert.equal(
    resolvePromptCacheAffinity(
      config("gateway-opaque"),
      config("gateway-opaque").targets.gpt,
    ).mode,
    "gateway-opaque",
  );
});

test("official, non-GPT and Chat targets remain outside Gateway affinity", () => {
  const c = config("gateway-opaque");
  assert.equal(resolvePromptCacheAffinity(c, {
    provider: "chatgpt-subscription",
    model: "gpt-official",
    wireApi: "responses",
  }).mode, "passthrough");
  assert.equal(resolvePromptCacheAffinity(c, {
    provider: "relay",
    model: "deepseek",
    modelFamily: "other",
    wireApi: "responses",
  }).reason, "non-gpt-unchanged");
  assert.equal(resolvePromptCacheAffinity(c, {
    provider: "relay",
    model: "gpt-chat",
    modelFamily: "openai-gpt",
    wireApi: "chat_completions",
  }).reason, "non-responses-unchanged");
});

test("derived keys are stable per turn and isolated by account, provider and model", async () => {
  const state = new MemoryState();
  const resolver = new PromptCacheAffinity(state, { secret });
  const c = config("gateway-opaque"), target = { id: "gpt", ...c.targets.gpt };
  const first = await resolver.resolve(c, target, {
    prompt_cache_key: "private-client-key",
  }, ctx());
  const frozen = await resolver.resolve(c, target, {
    prompt_cache_key: "changed-mid-turn",
  }, ctx());
  assert.equal(first.providerKey, frozen.providerKey);
  assert.equal(first.lineageSource, "client_prompt_cache_key");
  assert.match(first.providerKey, /^clr-pc-v1-[A-Za-z0-9_-]{43}$/);

  const anotherAccount = await resolver.resolve(c, target, {
    prompt_cache_key: "private-client-key",
  }, ctx({ auth: "account-hash-b" }));
  assert.notEqual(first.providerKey, anotherAccount.providerKey);
  const anotherProvider = await resolver.resolve(c, {
    ...target,
    provider: "other",
  }, { prompt_cache_key: "private-client-key" }, ctx({ turn: "turn-b" }));
  assert.notEqual(first.providerKey, anotherProvider.providerKey);
  const anotherModel = await resolver.resolve(c, {
    ...target,
    model: "gpt-other",
  }, { prompt_cache_key: "private-client-key" }, ctx({ turn: "turn-c" }));
  assert.notEqual(first.providerKey, anotherModel.providerKey);

  const serialized = JSON.stringify([...state.values.entries()]);
  for (const raw of [
    "private-client-key",
    "changed-mid-turn",
    "thread-a",
    "turn-a",
  ]) assert.equal(serialized.includes(raw), false);
});

test("forks inherit only a client key or a previously verified parent lineage", async () => {
  const state = new MemoryState();
  const resolver = new PromptCacheAffinity(state, { secret });
  const c = config("gateway-opaque"), target = { id: "gpt", ...c.targets.gpt };
  const parent = await resolver.resolve(c, target, {}, ctx());
  const related = await resolver.resolve(c, target, {}, ctx({
    thread: "child-a",
    turn: "child-turn-a",
    parentThread: "thread-a",
  }));
  assert.equal(parent.providerKey, related.providerKey);
  assert.equal(related.lineageSource, "verified_parent_thread");

  const unrelated = await resolver.resolve(c, target, {}, ctx({
    thread: "child-b",
    turn: "child-turn-b",
    parentThread: "unknown-parent",
  }));
  assert.notEqual(parent.providerKey, unrelated.providerKey);
  assert.equal(unrelated.lineageSource, "thread");

  const sameClient = await resolver.resolve(c, target, {
    prompt_cache_key: "shared-client-key",
  }, ctx({ thread: "child-c", turn: "child-turn-c" }));
  const sameClientFork = await resolver.resolve(c, target, {
    prompt_cache_key: "shared-client-key",
  }, ctx({ thread: "child-d", turn: "child-turn-d" }));
  assert.equal(sameClient.providerKey, sameClientFork.providerKey);
});

test("thread lineage expires, rotates and remains bounded", async () => {
  let now = 10_000;
  const state = new MemoryState();
  const resolver = new PromptCacheAffinity(state, {
    secret,
    now: () => now,
    ttlMs: 100,
    maxLineages: 4,
  });
  const c = config("gateway-opaque"), target = { id: "gpt", ...c.targets.gpt };
  const before = await resolver.resolve(c, target, {}, ctx());
  now += 101;
  const after = await resolver.resolve(c, target, {}, ctx({ turn: "turn-b" }));
  assert.notEqual(before.providerKey, after.providerKey);
  for (let index = 0; index < 10; index++) {
    now++;
    await resolver.resolve(c, target, {}, ctx({
      thread: `thread-${index}`,
      turn: `turn-${index}`,
    }));
  }
  const stored = [...state.values.values()][0];
  assert.ok(stored.entries.length <= 4);
});

test("concurrent threads receive independent stable lineages", async () => {
  const resolver = new PromptCacheAffinity(new MemoryState(), { secret });
  const c = config("gateway-opaque"), target = { id: "gpt", ...c.targets.gpt };
  const first = await Promise.all(
    Array.from({ length: 16 }, (_, index) => resolver.resolve(
      c,
      target,
      {},
      ctx({ thread: `parallel-${index}`, turn: `turn-${index}` }),
    )),
  );
  assert.equal(new Set(first.map((item) => item.providerKey)).size, 16);
  const second = await Promise.all(
    Array.from({ length: 16 }, (_, index) => resolver.resolve(
      c,
      target,
      {},
      ctx({ thread: `parallel-${index}`, turn: `next-${index}` }),
    )),
  );
  assert.deepEqual(
    second.map((item) => item.providerKey),
    first.map((item) => item.providerKey),
  );
});

test("missing stable lineage safely omits the key and option filtering is strict", async () => {
  const resolver = new PromptCacheAffinity(new MemoryState(), { secret });
  const c = config("gateway-opaque"), target = { id: "gpt", ...c.targets.gpt };
  const result = await resolver.resolve(c, target, {
    prompt_cache_key: 42,
  }, ctx({ thread: undefined, turn: undefined }));
  assert.equal(result.applied, false);
  assert.equal(result.unavailableReason, "missing_lineage");
  assert.deepEqual(sanitizePromptCacheOptions({
    mode: "explicit",
    ttl: "30m",
    comparison_response_id: "private-response",
    extra: true,
  }), { mode: "explicit", ttl: "30m" });
  assert.equal(sanitizePromptCacheOptions({
    mode: "invalid",
    ttl: "24h",
    comparison_response_id: "private-response",
  }), undefined);
});

test("derived-only lineage survives a StateStore restart for a verified fork", async () => {
  const records = new Map();
  const archive = {
    getState(key) { return structuredClone(records.get(key)); },
    setState(key, value) { records.set(key, structuredClone(value)); },
  };
  const c = config("gateway-opaque"), target = { id: "gpt", ...c.targets.gpt };
  const first = new PromptCacheAffinity(
    new StateStore({ maxBytes: 1024 * 1024 }, archive),
    { secret },
  );
  const parent = await first.resolve(c, target, {}, ctx());
  const restarted = new PromptCacheAffinity(
    new StateStore({ maxBytes: 1024 * 1024 }, archive),
    { secret },
  );
  const fork = await restarted.resolve(c, target, {}, ctx({
    thread: "child-after-restart",
    turn: "child-turn-after-restart",
    parentThread: "thread-a",
  }));
  assert.equal(fork.providerKey, parent.providerKey);
  assert.equal(fork.lineageSource, "verified_parent_thread");
  const serialized = JSON.stringify([...records.entries()]);
  for (const raw of ["thread-a", "child-after-restart", "raw-account"])
    assert.equal(serialized.includes(raw), false);
});

test("the dedicated Keychain secret is lazy, generated once and verified", async () => {
  let loads = 0;
  const lazy = new PromptCacheAffinity(new MemoryState(), {
    loadSecret: async () => { loads++; return secret; },
  });
  const disabled = config("none"), target = { id: "gpt", ...disabled.targets.gpt };
  await lazy.resolve(disabled, target, { prompt_cache_key: "client" }, ctx());
  assert.equal(loads, 0);
  const enabled = config("gateway-opaque");
  await lazy.resolve(enabled, { id: "gpt", ...enabled.targets.gpt }, {
    prompt_cache_key: "client",
  }, ctx());
  await lazy.resolve(enabled, { id: "gpt", ...enabled.targets.gpt }, {
    prompt_cache_key: "client",
  }, ctx({ turn: "turn-b" }));
  assert.equal(loads, 1);

  const generated = Buffer.alloc(32, 29);
  let reads = 0, writes = 0;
  const run = async () => {
    reads++;
    if (reads === 1) throw Object.assign(Error("missing"), { code: 44 });
    return { stdout: generated.toString("hex") + "\n" };
  };
  const spawnProcess = () => {
    writes++;
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      end(value) {
        assert.equal(value.includes(generated.toString("hex")), true);
        queueMicrotask(() => child.emit("close", 0));
      },
    };
    return child;
  };
  const found = await promptCacheSecret({
    run,
    spawnProcess,
    random: () => generated,
  });
  assert.equal(found.equals(generated), true);
  assert.equal(reads, 2);
  assert.equal(writes, 1);
});

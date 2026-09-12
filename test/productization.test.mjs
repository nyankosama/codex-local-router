import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, validate } from "../src/config.mjs";
import { buildModelCatalog } from "../src/model-catalog.mjs";
import { providerEndpoint } from "../src/providers.mjs";
import { isExplicitContextError } from "../src/context.mjs";
import { configDiff, createConfig, rawConfig, writeConfigTransaction } from "../src/config-store.mjs";
import { preflightCandidate, renderLaunchAgent } from "../src/service-manager.mjs";
import { runtimePaths } from "../src/product.mjs";
import { callProvider } from "../src/providers.mjs";
import {
  createHistoryPayload,
  decryptHistoryPayload,
  encryptHistoryPayload,
  historyResumePrompt,
} from "../src/history-package.mjs";

const config = () => ({
  schemaVersion: 3,
  mode: "rules",
  defaultTarget: "deepseek",
  providers: {
    go: { baseUrl: "https://example.com/v1", adapter: "opencode-go" },
  },
  targets: {
    deepseek: { provider: "go", preset: "opencode-go/deepseek-v4.1-flash" },
  },
  subscription: { enabled: true, models: ["gpt-5.5"] },
});

test("versioned presets fill defaults while explicit model-channel settings win", () => {
  const normalized = validate(config());
  assert.equal(normalized.targets.deepseek.contextWindow, 400000);
  assert.deepEqual(normalized.targets.deepseek.inputModalities, ["text", "image"]);
  assert.equal(normalized.targets.deepseek.app.reasoningLevels.at(-1), "max");
  const explicit = config();
  explicit.targets.deepseek.contextWindow = 300000;
  explicit.targets.deepseek.inputModalities = ["text"];
  const overridden = validate(explicit);
  assert.equal(overridden.targets.deepseek.contextWindow, 300000);
  assert.deepEqual(overridden.targets.deepseek.inputModalities, ["text"]);
});

test("legacy configuration is runtime-compatible without enabling new persistence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "router-legacy-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "config.json");
  await writeFile(path, JSON.stringify({
    schemaVersion: 2,
    mode: "rules",
    defaultTarget: "deepseek",
    providers: { "opencode-go": { baseUrl: "https://example.com" } },
    targets: {
      deepseek: {
        provider: "opencode-go",
        model: "deepseek-v4.1-flash",
        wireApi: "responses",
        contextWindow: 131072,
        inputModalities: ["text"],
      },
    },
  }));
  const loaded = await loadConfig(path);
  assert.equal(loaded.targets.deepseek.contextWindow, 400000);
  assert.deepEqual(loaded.targets.deepseek.inputModalities, ["text", "image"]);
  assert.equal(loaded.targets.deepseek.capabilities.freeformTools, true);
  assert.equal(loaded.history.persistent.enabled, false);
});

test("custom catalog keeps official entries intact and does not copy private GPT instructions", () => {
  const official = {
    slug: "gpt-5.5",
    priority: 10,
    base_instructions: "OFFICIAL_PRIVATE_INSTRUCTION",
    model_messages: { secret: "OFFICIAL_MESSAGE" },
    comp_hash: "official",
  };
  const catalog = buildModelCatalog({ models: [official] }, validate(config()));
  assert.deepEqual(catalog.models[0], official);
  assert.equal(catalog.models[1].base_instructions, "");
  assert.equal(catalog.models[1].model_messages, null);
  assert.equal(catalog.models[1].comp_hash, undefined);
  assert.equal(catalog.models[1].apply_patch_tool_type, "freeform");
  const chat = config();
  chat.targets.deepseek = {
    provider: "go", model: "chat-model", wireApi: "chat_completions",
    contextWindow: 32000, inputModalities: ["text"], compression: { mode: "unsupported" },
    capabilities: { toolCalling: true }, app: { enabled: true, modelId: "chat-custom" },
  };
  assert.equal(buildModelCatalog({ models: [official] }, validate(chat)).models[1].apply_patch_tool_type, null);
});

test("provider endpoint joining avoids duplicate v1 and supports explicit paths", () => {
  assert.equal(providerEndpoint({ baseUrl: "https://example.com/v1" }, "responses"), "https://example.com/v1/responses");
  assert.equal(providerEndpoint({ baseUrl: "https://example.com/api", endpoints: { responses: "/responses-api" } }, "responses"), "https://example.com/api/responses-api");
  assert.equal(providerEndpoint({ baseUrl: "https://example.com/v1/responses" }, "responses"), "https://example.com/v1/responses");
});

test("generic request size errors do not trigger lossy context fallback", () => {
  assert.equal(isExplicitContextError(413, { error: { code: "request_too_large" } }), false);
  assert.equal(isExplicitContextError(400, { error: { code: "context_length_exceeded" } }), true);
  assert.equal(isExplicitContextError(400, { error: { code: "vendor_context" } }, { contextErrorCodes: ["vendor_context"] }), true);
});

test("config transactions preview, back up, apply, and reject stale writes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "router-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "config.json");
  const before = config();
  await createConfig(path, before, { apply: true });
  const after = structuredClone(before);
  after.providers.go.concurrency = 2;
  const preview = await writeConfigTransaction(path, before, after, { dataRoot: root });
  assert.equal(preview.applied, false);
  assert.deepEqual(await rawConfig(path), before);
  const applied = await writeConfigTransaction(path, before, after, { dataRoot: root, apply: true });
  assert.equal(applied.applied, true);
  assert.equal((await rawConfig(path)).providers.go.concurrency, 2);
  await assert.rejects(
    writeConfigTransaction(path, before, { ...after, timeoutMs: 1 }, { dataRoot: root, apply: true }),
    /changed after the preview/,
  );
  assert.ok(configDiff(before, after).some((item) => item.path === "providers.go.concurrency"));
});

test("history migration packages authenticate content and resume tools as completed facts", async () => {
  const versions = [{ version: 1, status: "complete_original", original: [], view: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    { type: "function_call", call_id: "c1", name: "read", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: "done" },
  ] }];
  const payload = createHistoryPayload({ owner: "a", thread: "t", branch: "t", versions });
  const encrypted = await encryptHistoryPayload(payload, "passphrase");
  assert.deepEqual(await decryptHistoryPayload(encrypted, "passphrase"), payload);
  await assert.rejects(decryptHistoryPayload(encrypted, "wrong"), /passphrase|authentication/);
  const prompt = historyResumePrompt(versions[0]);
  assert.match(prompt, /COMPLETED TOOL CALL c1/);
  assert.match(prompt, /Do not replay/);
});

test("LaunchAgent uses installed paths, user-level logs and safe network settings", () => {
  const plist = renderLaunchAgent({
    node: "/node",
    server: "/pkg/server.mjs",
    config: "/data/config.json",
    log: "/data/gateway Ring & log",
    env: { https_proxy: "http://127.0.0.1:7897/?a=1&b=2", API_KEY: "secret" },
  });
  assert.match(plist, /com\.nyankosama\.codex-local-router/);
  assert.match(plist, /\/pkg\/server\.mjs/);
  assert.match(plist, /Ring &amp; log/);
  assert.match(plist, /<key>https_proxy<\/key><string>http:\/\/127\.0\.0\.1:7897\/\?a=1&amp;b=2<\/string>/);
  assert.doesNotMatch(plist, /API_KEY|secret/);
});

test("candidate health checks keep their state separate from the live service", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "router-candidate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, CODEX_LOCAL_ROUTER_HOME: root };
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({
    schemaVersion: 3,
    listen: { host: "127.0.0.1", port: 0 },
    mode: "rules",
    defaultTarget: "model",
    providers: { local: { baseUrl: "http://127.0.0.1:9" } },
    targets: { model: { provider: "local", model: "test", wireApi: "responses", contextWindow: 32000 } },
    history: { persistent: { enabled: false } },
  }));
  const health = await preflightCandidate(new URL("../src/server.mjs", import.meta.url).pathname, configPath, { env });
  assert.equal(health.service, "codex-local-router");
  assert.equal(await access(runtimePaths(env).serviceState).then(() => true, () => false), false);
});

test("provider concurrency queues a second request until the first stream closes", async () => {
  const config = validate({
    schemaVersion: 3, mode: "rules", defaultTarget: "one",
    providers: { p: { baseUrl: "https://example.com", concurrency: 1 } },
    targets: { one: { provider: "p", model: "m", wireApi: "responses", contextWindow: 1000 } },
  });
  const target = config.targets.one;
  let releases = [];
  const send = async () => ({
    ok: true, status: 200, headers: new Headers({ "content-type": "text/event-stream" }),
    body: (async function* () { await new Promise((done) => releases.push(done)); yield Buffer.from("done"); })(),
  });
  const ctx = { entry: "api", headers: {}, channelSession: "s" };
  const first = await callProvider(config, target, { stream: true }, ctx, new AbortController().signal, send);
  let secondReady = false;
  const secondPromise = callProvider(config, target, { stream: true }, ctx, new AbortController().signal, send).then((response) => { secondReady = true; return response; });
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(secondReady, false);
  const consuming = (async () => { for await (const _ of first.body) {} })();
  releases.shift()();
  await consuming;
  const second = await secondPromise;
  assert.equal(secondReady, true);
  const consumingSecond = (async () => { for await (const _ of second.body) {} })();
  releases.shift()();
  await consumingSecond;
});

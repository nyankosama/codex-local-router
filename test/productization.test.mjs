import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { loadConfig, validate } from "../src/config.mjs";
import { buildModelCatalog } from "../src/model-catalog.mjs";
import { providerEndpoint } from "../src/providers.mjs";
import { isExplicitContextError } from "../src/context.mjs";
import { configDiff, createConfig, rawConfig, writeConfigTransaction } from "../src/config-store.mjs";
import {
  drainService,
  installSpaceSwitcher,
  preflightCandidate,
  renderLaunchAgent,
  renderSpaceSwitcherLaunchAgent,
  serviceStatus,
} from "../src/service-manager.mjs";
import { PACKAGE_VERSION, runtimePaths } from "../src/product.mjs";
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

test("runtime version is sourced from package.json", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(PACKAGE_VERSION, manifest.version);
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

test("ai.feei presets use distinct App IDs, conservative windows and standalone search only", () => {
  const input = {
    schemaVersion: 3,
    mode: "rules",
    defaultTarget: "sol",
    providers: { feei: {} },
    targets: {
      sol: { provider: "feei", preset: "feei/gpt-5.6-sol" },
      astra: { provider: "feei", preset: "feei/gpt-6-astra" },
    },
    rules: [],
    subscription: { enabled: true, models: ["gpt-official"] },
  };
  const normalized = validate(input);
  assert.equal(normalized.providers.feei.baseUrl, "https://ai.feei.cn/v1");
  assert.deepEqual(
    Object.values(normalized.targets).map((target) => target.app.modelId),
    ["feei-gpt-5.6-sol", "feei-gpt-6-astra"],
  );
  for (const target of Object.values(normalized.targets)) {
    assert.equal(target.modelFamily, "openai-gpt");
    assert.equal(target.contextWindow, 272000);
    assert.equal(target.maxContextWindow, 272000);
    assert.equal(target.compression.mode, "summary");
    assert.equal(target.capabilities.nativeWebSearch, false);
    assert.equal(target.app.supportsSearchTool, undefined);
    assert.equal(target.app.useResponsesLite, true);
  }
  const catalog = buildModelCatalog({
    models: [{ slug: "gpt-official", priority: 10 }],
  }, normalized);
  assert.equal(catalog.models[1].supports_search_tool, true);
  assert.equal(catalog.models[1].use_responses_lite, true);
  assert.equal(catalog.models[1].description.includes("ai.feei"), true);
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
    env: {
      https_proxy: "http://127.0.0.1:7897/?a=1&b=2",
      wss_proxy: "socks5://127.0.0.1:7898",
      API_KEY: "secret",
    },
  });
  assert.match(plist, /com\.nyankosama\.codex-local-router/);
  assert.match(plist, /\/pkg\/server\.mjs/);
  assert.match(plist, /Ring &amp; log/);
  assert.match(plist, /<key>https_proxy<\/key><string>http:\/\/127\.0\.0\.1:7897\/\?a=1&amp;b=2<\/string>/);
  assert.match(plist, /<key>wss_proxy<\/key><string>socks5:\/\/127\.0\.0\.1:7898<\/string>/);
  assert.doesNotMatch(plist, /API_KEY|secret/);
});

test("space switcher is a one-shot LaunchAgent and never copies provider secrets", () => {
  const plist = renderSpaceSwitcherLaunchAgent({
    node: "/node",
    admin: "/pkg/gateway-admin.mjs",
    log: "/data/switcher.log",
    env: {
      CODEX_HOME: "/isolated/codex",
      CODEX_LOCAL_ROUTER_HOME: "/isolated/router",
      FEEI_API_KEY: "secret",
    },
  });
  assert.match(plist, /com\.nyankosama\.codex-local-router\.space-switcher/);
  assert.match(plist, /<string>space<\/string><string>resume<\/string><string>--coordinator<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key><false\/>/);
  assert.doesNotMatch(plist, /launchctl submit|FEEI_API_KEY|secret/);
});

test("reinstalling an unchanged space switcher never terminates a running coordinator", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "router-switcher-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let loaded = false;
  const calls = [];
  const control = async (args) => {
    calls.push(args);
    if (args[0] === "print") {
      if (!loaded) throw Error("not loaded");
      return;
    }
    if (args[0] === "bootstrap") loaded = true;
    if (args[0] === "bootout") loaded = false;
  };
  const options = {
    env: {
      ...process.env,
      CODEX_LOCAL_ROUTER_HOME: root,
      CODEX_LOCAL_ROUTER_SPACE_SWITCHER_LAUNCH_AGENT: join(root, "switcher.plist"),
    },
    adminPath: join(root, "gateway-admin.mjs"),
    launchctl: control,
  };
  await installSpaceSwitcher(options);
  calls.length = 0;
  await installSpaceSwitcher(options);
  assert.equal(calls.some((args) => args[0] === "bootout"), false);
  assert.equal(calls.some((args) => args[0] === "bootstrap"), false);
  assert.equal(calls.some((args) => args.includes("-k")), false);
  assert.deepEqual(calls.map((args) => args[0]), ["print", "kickstart"]);
});

test("concurrent space switcher installers serialize before replacing an old definition", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "router-switcher-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plist = join(root, "switcher.plist");
  await writeFile(plist, "old definition");
  let loaded = true, bootouts = 0;
  let reportBootout;
  let releaseBootout;
  const bootoutEntered = new Promise((resolve) => { reportBootout = resolve; });
  const bootoutReleased = new Promise((resolve) => { releaseBootout = resolve; });
  const calls = [];
  const control = async (args) => {
    calls.push(args);
    if (args[0] === "print") {
      if (!loaded) throw Error("not loaded");
      return;
    }
    if (args[0] === "bootout") {
      bootouts++;
      reportBootout();
      await bootoutReleased;
      loaded = false;
    }
    if (args[0] === "bootstrap") loaded = true;
  };
  const options = {
    env: {
      ...process.env,
      CODEX_LOCAL_ROUTER_HOME: root,
      CODEX_LOCAL_ROUTER_SPACE_SWITCHER_LAUNCH_AGENT: plist,
    },
    adminPath: join(root, "gateway-admin.mjs"),
    launchctl: control,
  };
  const first = installSpaceSwitcher(options);
  await bootoutEntered;
  const second = installSpaceSwitcher(options);
  await new Promise((resolve) => setTimeout(resolve, 20));
  releaseBootout();
  await Promise.all([first, second]);
  assert.equal(bootouts, 1);
  assert.equal(calls.some((args) => args.includes("-k")), false);
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

test("service drain never treats an unavailable health response as zero active turns", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "router-drain-health-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let healthRequests = 0;
  const server = createServer((request, response) => {
    healthRequests++;
    if (healthRequests === 1) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ pid: 4242, activeTurns: 1 }));
      return;
    }
    response.statusCode = 503;
    response.end("unavailable");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({
    ...config(),
    listen: { host: "127.0.0.1", port: server.address().port },
  }));
  const signals = [];
  const result = await drainService(configPath, {
    env: {
      ...process.env,
      CODEX_LOCAL_ROUTER_HOME: join(root, "data"),
      CODEX_LOCAL_ROUTER_LAUNCH_AGENT: join(root, "router.plist"),
    },
    waitMs: 20,
    pollMs: 1,
    signal: (pid, name) => { signals.push([pid, name]); },
  });
  assert.equal(result.drained, false);
  assert.equal(result.reason, "active_turn_timeout");
  assert.deepEqual(signals, [[4242, "SIGUSR2"], [4242, "SIGUSR1"]]);
});

test("service drain fails closed when a loaded service has no trustworthy initial health", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "router-drain-initial-health-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = createServer((request, response) => {
    response.statusCode = 503;
    response.end("unavailable");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({
    ...config(),
    listen: { host: "127.0.0.1", port: server.address().port },
  }));
  const signals = [];
  const result = await drainService(configPath, {
    env: {
      ...process.env,
      CODEX_LOCAL_ROUTER_HOME: join(root, "data"),
      CODEX_LOCAL_ROUTER_LAUNCH_AGENT: join(root, "router.plist"),
      CODEX_LOCAL_ROUTER_TEST_LAUNCHCTL: "1",
      CODEX_LOCAL_ROUTER_TEST_SERVICE_LOADED: "1",
    },
    signal: (pid, name) => { signals.push([pid, name]); },
  });
  assert.equal(result.drained, false);
  assert.equal(result.reason, "health_unavailable");
  assert.deepEqual(signals, []);
});

test("service status ignores saved state from a different config or test instance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "router-status-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    CODEX_LOCAL_ROUTER_HOME: root,
    CODEX_LOCAL_ROUTER_LAUNCH_AGENT: join(root, "agent.plist"),
  };
  const paths = runtimePaths(env);
  const configPath = join(root, "config.json");
  await mkdir(paths.runtime, { recursive: true });
  await writeFile(configPath, JSON.stringify({
    schemaVersion: 3,
    listen: { host: "127.0.0.1", port: 9 },
    mode: "rules",
    defaultTarget: "model",
    providers: { local: { baseUrl: "http://127.0.0.1:9" } },
    targets: { model: { provider: "local", model: "test", wireApi: "responses", contextWindow: 32000 } },
  }));
  await writeFile(paths.serviceState, JSON.stringify({
    configPath: join(root, "test-config.json"),
    instance: "test-123",
    url: "http://127.0.0.1:8",
  }));
  const status = await serviceStatus(configPath, env);
  assert.equal(status.saved, null);
  assert.equal(status.health, null);
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

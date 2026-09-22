// Real Chat Completions file-tool workflow through an isolated Codex app-server.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { loadConfig, validate } from "../src/config.mjs";
import { writeAcceptanceEvidence } from "./e2e/lib/evidence-path.mjs";
import { buildModelCatalog } from "../src/model-catalog.mjs";
import { createGateway } from "../src/server.mjs";
import { request } from "../src/transport.mjs";
import { Archive } from "../src/archive.mjs";
import { createLocalIdentityResolver } from "../src/local-identity.mjs";

const targetId = process.env.ACCEPT_CHAT_TARGET ?? "balanced";
const appModel = "chat-completions-acceptance";
const root = await mkdtemp(join(tmpdir(), "gateway-chat-acceptance-"));
const home = join(root, "home"), fixture = join(root, "fixture");
const report = { at: new Date().toISOString(), targetId, appModel, passed: false };
let child, gateway, timer;
let lastOutcome, appStderr = "";
const diagnostics = [];
let serial = 0;
const pending = new Map();
const digest = (body) => createHash("sha256").update(body).digest("hex");
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++serial;
  pending.set(id, { resolve, reject });
  child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
});

try {
  await mkdir(home, { mode: 0o700 });
  await mkdir(fixture);
  const sourceHome = process.env.ACCEPT_SOURCE_CODEX_HOME ?? join(homedir(), ".codex");
  await symlink(join(sourceHome, "auth.json"), join(home, "auth.json"));
  const loaded = await loadConfig(
    process.env.GATEWAY_CONFIG ?? "config/gateway.subscription.local.json",
  );
  assert.ok(loaded.targets[targetId], `Chat target is not configured: ${targetId}`);
  const input = structuredClone(loaded);
  input.mode = "fixed";
  input.defaultTarget = targetId;
  input.fixedTarget = targetId;
  delete input.fallbackTarget;
  input.listen = { host: "127.0.0.1", port: 0 };
  input.history = { ...(input.history ?? {}), persistent: { enabled: false } };
  input.targets[targetId].app = {
    enabled: true,
    modelId: appModel,
    displayName: "Chat Completions acceptance",
    reasoningLevels: ["low"],
    defaultReasoningLevel: "low",
  };
  input.targets[targetId].capabilities = {
    ...(input.targets[targetId].capabilities ?? {}),
    freeformTools: false,
  };
  const config = validate(input);
  assert.equal(config.targets[targetId].wireApi, "chat_completions");
  const sourceCatalog = JSON.parse(await readFile(join(sourceHome, "models_cache.json"), "utf8"));
  const catalog = buildModelCatalog(sourceCatalog, config);
  const entry = catalog.models.find((model) => model.slug === appModel);
  assert.equal(entry.apply_patch_tool_type, null);
  await writeFile(join(home, "models.json"), JSON.stringify(catalog), { mode: 0o600 });

  const spec = "import test from 'node:test';import assert from 'node:assert/strict';import {normalizeName} from './name.mjs';test('trims',()=>assert.equal(normalizeName('  Ada  '),'Ada'));test('spaces',()=>assert.equal(normalizeName('Ada   Lovelace'),'Ada Lovelace'));\n";
  await writeFile(join(fixture, "name.mjs"), "export const normalizeName = value => value;\n");
  await writeFile(join(fixture, "name.test.mjs"), spec);
  const testHash = digest(spec);
  const upstream = [];
  const archive = new Archive(join(root, "history.sqlite"), Buffer.alloc(32, 9));
  gateway = createGateway(config, {
    archive,
    closeArchive: true,
    resolveIdentity: createLocalIdentityResolver(join(home, "auth.json")),
    send: (url, options) => {
      upstream.push({
        url: new URL(url).pathname,
        model: options.body.model,
        toolTypes: (options.body.tools ?? []).map((tool) => tool.type),
      });
      return request(url, options);
    },
    log: (event) => {
      if (["provider_error", "request_error", "ws_error", "route"].includes(event.event))
        diagnostics.push(event);
    },
  });
  await new Promise((done) => gateway.server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${gateway.server.address().port}/subscription/v1`;
  await writeFile(
    join(home, "config.toml"),
    `model_provider = "openai"\nmodel = "${appModel}"\nmodel_reasoning_effort = "low"\nweb_search = "disabled"\nopenai_base_url = "${base}"\nmodel_catalog_json = "${join(home, "models.json")}"\n`,
    { mode: 0o600 },
  );
  const harness = process.env.ACCEPT_CODEX_BINARY ?? "/Applications/ChatGPT.app/Contents/Resources/codex";
  child = spawn(harness, ["app-server", "--stdio"], {
    env: { ...process.env, CODEX_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => { appStderr = (appStderr + chunk).slice(-8000); });
  const commands = [];
  let finish;
  const completed = new Promise((resolve) => { finish = resolve; });
  child.on("exit", () => {
    for (const item of pending.values()) item.reject(Error("isolated app-server exited"));
    finish({ status: "backend_exited" });
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id != null && pending.has(message.id)) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) item.reject(Error(JSON.stringify(message.error)));
      else item.resolve(message.result);
    }
    if (message.method === "item/completed" && message.params?.item?.type === "commandExecution")
      commands.push(message.params.item);
    if (message.method === "turn/completed") {
      lastOutcome = message.params.turn;
      finish(lastOutcome);
    }
    if (/error|warning/i.test(message.method ?? "")) diagnostics.push(message);
  });
  timer = setTimeout(() => child.kill(), 600000);
  await rpc("initialize", {
    clientInfo: { name: "chat_completions_acceptance", version: "1.0" },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write('{"method":"initialized"}\n');
  const thread = await rpc("thread/start", {
    model: appModel,
    modelProvider: "openai",
    cwd: fixture,
    ephemeral: true,
    sandbox: "workspace-write",
    approvalPolicy: "never",
  });
  await rpc("turn/start", {
    threadId: thread.thread.id,
    model: appModel,
    input: [{
      type: "text",
      text: "Read name.mjs and name.test.mjs. Change normalizeName so both tests pass, run node --test name.test.mjs, and report the result. Do not modify the tests. Use tools to do the work.",
      text_elements: [],
    }],
  });
  const outcome = await completed;
  assert.equal(outcome.status, "completed");
  assert.equal(digest(await readFile(join(fixture, "name.test.mjs"))), testHash);
  assert.equal(spawnSync(process.execPath, ["--test", "name.test.mjs"], { cwd: fixture }).status, 0);
  assert.ok(commands.length > 0, "Codex executed no file workflow commands");
  assert.ok(upstream.length >= 2, "Chat tool continuation did not reach the provider");
  assert.ok(upstream.every((call) => call.url.endsWith("/v1/chat/completions")));
  assert.ok(upstream.every((call) => call.toolTypes.every((type) => type === "function")));
  report.upstreamCalls = upstream.length;
  report.commandCount = commands.length;
  report.testsUnchanged = true;
  report.independentTestsPassed = true;
  report.providerModel = upstream[0].model;
  report.toolTypes = [...new Set(upstream.flatMap((call) => call.toolTypes))];
  report.passed = true;
  console.log(JSON.stringify({ event: "chat_completions_acceptance_passed", ...report }));
} catch (error) {
  report.failure = error.message;
  report.outcome = lastOutcome;
  report.diagnostics = diagnostics;
  report.appStderr = appStderr;
  console.log(JSON.stringify({ event: "chat_completions_acceptance_failed", reason: error.message }));
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  child?.kill();
  if (gateway) await gateway.close();
  await rm(root, { recursive: true, force: true });
  await writeAcceptanceEvidence("chat-completions.json", report, { projectRoot: resolve(".") });
}

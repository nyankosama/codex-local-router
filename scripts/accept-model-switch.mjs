// Real App backend against an isolated production Gateway. Never modifies or stops the App.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { createGateway } from "../src/server.mjs";
import { writeAcceptanceEvidence } from "./e2e/lib/evidence-path.mjs";
import { loadConfig } from "../src/config.mjs";
import { request } from "../src/transport.mjs";
import { Archive } from "../src/archive.mjs";
import { createLocalIdentityResolver } from "../src/local-identity.mjs";

const GPT = "gpt-5.6-sol",
  DS = "deepseek-v4.1-flash";
const root = await mkdtemp(join(tmpdir(), "gateway-model-switch-"));
const home = join(root, "home"),
  fixture = join(root, "fixture");
const report = {
  at: new Date().toISOString(),
  catalog: "configured-multimodel",
  harness: "/Applications/ChatGPT.app/Contents/Resources/codex app-server",
  turns: [],
  routes: [],
};
let child, gateway, timer;
let serial = 0;
const pending = new Map(),
  active = new Map();
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++serial;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
async function turn(thread, model, prompt, expected, requireTool = false) {
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  const record = { thread, model, text: "", tools: 0, compactions: 0, finish };
  active.set(thread, record);
  const start = await rpc("turn/start", {
    threadId: thread,
    model,
    input: [{ type: "text", text: prompt, text_elements: [] }],
  });
  record.turn = start.turn.id;
  const outcome = await done;
  const checks = expected.map((token) => ({
    token,
    found: record.text.includes(token),
  }));
  const evidence = {
    thread,
    turn: record.turn,
    model,
    status: outcome.status,
    tools: record.tools,
    compactions: record.compactions,
    checks,
  };
  report.turns.push(evidence);
  console.log(JSON.stringify({ event: "turn_checked", ...evidence }));
  if (!checks.every((x) => x.found))
    console.log(
      JSON.stringify({
        event: "fixture_answer",
        text: record.text.slice(0, 2000),
      }),
    );
  assert.equal(outcome.status, "completed", "real App backend turn failed");
  assert.ok(
    checks.every((x) => x.found),
    "history recall check failed",
  );
  if (requireTool)
    assert.ok(record.tools > 0, "required file tool was not executed");
  active.delete(thread);
}
try {
  await mkdir(home, { mode: 0o700 });
  await mkdir(fixture);
  const sourceHome =
    process.env.ACCEPT_SOURCE_CODEX_HOME ?? join(homedir(), ".codex");
  await symlink(join(sourceHome, "auth.json"), join(home, "auth.json"));
  const config = await loadConfig(
    process.env.GATEWAY_CONFIG ?? "config/gateway.subscription.local.json",
  );
  const sourceCatalog = JSON.parse(
    await readFile(
      process.env.ACCEPT_MODEL_CATALOG ??
        join(sourceHome, "models_cache.json"),
      "utf8",
    ),
  );
  const { buildModelCatalog } = await import("../src/model-catalog.mjs");
  const catalog = buildModelCatalog(sourceCatalog, config);
  report.models = catalog.models
    .filter((x) => [GPT, DS].includes(x.slug))
    .map((x) => ({
      slug: x.slug,
      comp_hash: x.comp_hash,
      context_window: x.context_window,
      input_modalities: x.input_modalities,
      supports_image_detail_original: x.supports_image_detail_original,
    }));
  assert.equal(report.models.length, 2);
  const deepseek = report.models.find((model) => model.slug === DS);
  assert.equal(deepseek.comp_hash, undefined);
  assert.equal(deepseek.context_window, 400000);
  assert.deepEqual(deepseek.input_modalities, ["text", "image"]);
  assert.equal(deepseek.supports_image_detail_original, true);
  await writeFile(join(home, "models.json"), JSON.stringify(catalog), {
    mode: 0o600,
  });
  const archive = new Archive(join(root, "history.sqlite"), Buffer.alloc(32, 5));
  gateway = createGateway(config, {
    archive,
    closeArchive: true,
    resolveIdentity: createLocalIdentityResolver(join(home, "auth.json")),
    send: (url, options) => {
      console.log(
        JSON.stringify({
          event: "request_shape",
          model: options.body.model,
          tools: options.body.tools?.map((t) => ({
            type: t.type,
            name: t.name,
            functions: t.functions?.map((f) => f.name),
          })),
          items: options.body.input?.map((x) => x.type ?? x.role),
        }),
      );
      return request(url, options);
    },
    log: (event) => {
      report.routes.push(event);
      if (
        [
          "route",
          "provider_error",
          "ws_error",
          "compaction_completed",
          "history_migrated",
          "summary_started",
          "full_history_migrated",
        ].includes(event.event)
      )
        console.log(JSON.stringify(event));
    },
  });
  await new Promise((r) => gateway.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${gateway.server.address().port}/subscription/v1`;
  await writeFile(
    join(home, "config.toml"),
    `model_provider = "openai"\nmodel = "${GPT}"\nmodel_reasoning_effort = "low"\nweb_search = "disabled"\nopenai_base_url = "${base}"\nmodel_catalog_json = "${join(home, "models.json")}"\n`,
    { mode: 0o600 },
  );
  child = spawn(
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    ["app-server", "--stdio"],
    {
      env: { ...process.env, CODEX_HOME: home },
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  child.on("exit", () => {
    for (const p of pending.values())
      p.reject(Error("isolated app-server exited"));
    for (const r of active.values()) r.finish({ status: "backend_exited" });
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id != null && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error
        ? p.reject(
            Error(
              "app-server RPC error: " +
                JSON.stringify({
                  code: m.error.code ?? "unknown",
                  message: m.error.message,
                  data: m.error.data,
                }),
            ),
          )
        : p.resolve(m.result);
    }
    const r = active.get(m.params?.threadId);
    if (!r) return;
    if (m.method === "item/agentMessage/delta") r.text += m.params.delta;
    if (m.method === "item/completed") {
      if (
        [
          "commandExecution",
          "fileChange",
          "mcpToolCall",
          "dynamicToolCall",
        ].includes(m.params.item.type)
      )
        r.tools++;
      if (m.params.item.type === "contextCompaction") r.compactions++;
    }
    if (m.method === "turn/completed") r.finish(m.params.turn);
  });
  timer = setTimeout(() => child.kill(), 600000);
  report.stage = "initialize";
  await rpc("initialize", {
    clientInfo: { name: "gateway_switch_acceptance", version: "1.0" },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write('{"method":"initialized"}\n');
  report.stage = "account/read";
  const account = await rpc("account/read", { refreshToken: false });
  report.account = {
    type: account.account?.type,
    plan: account.account?.planType,
  };
  assert.equal(report.account.type, "chatgpt");
  const ids = [];
  for (const model of [GPT, DS]) {
    report.stage = `thread/start:${model}`;
    const t = await rpc("thread/start", {
      model,
      modelProvider: "openai",
      cwd: fixture,
      ephemeral: true,
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    ids.push(t.thread.id);
  }
  report.stage = "turns";
  const tokens = [0, 1].map(() => ({
    memory: "MEM_" + randomUUID().slice(0, 8),
    tool: "FILE_" + randomUUID().slice(0, 8),
  }));
  for (let i = 0; i < 2; i++)
    await writeFile(join(fixture, `marker-${i}.txt`), tokens[i].tool + "\n");
  await Promise.all(
    ids.map((id, i) =>
      turn(
        id,
        i ? DS : GPT,
        `Remember the conversation code ${tokens[i].memory}. Use the shell tool to read only ${join(fixture, `marker-${i}.txt`)}. Report the conversation code and the file code; remember both for later.`,
        [tokens[i].memory, tokens[i].tool],
        true,
      ),
    ),
  );
  // Subsequent success cannot come from rereading the fixture.
  for (let i = 0; i < 2; i++) await rm(join(fixture, `marker-${i}.txt`));
  for (let round = 0; round < 3; round++) {
    await Promise.all(
      ids.map((id, i) =>
        turn(
          id,
          (round + i) % 2 === 0 ? DS : GPT,
          "Without using any tools, recall the conversation code I gave you and the code you read from the file earlier. Output both exact codes.",
          [tokens[i].memory, tokens[i].tool],
        ),
      ),
    );
  }
  assert.equal(report.turns.length, 8);
  assert.equal(
    report.routes.filter((x) => x.event === "summary_started").length,
    0,
    "short model switches must not generate summaries",
  );
  assert.ok(
    report.routes.filter((x) => x.event === "full_history_migrated").length >= 6,
  );
  assert.ok(
    !report.routes.some((x) =>
      ["ws_error", "request_error", "provider_error"].includes(x.event),
    ),
  );
  report.passed = true;
  console.log(
    JSON.stringify({ event: "acceptance_passed", turns: report.turns.length }),
  );
} catch (e) {
  report.passed = false;
  report.failure = e.message;
  console.log(
    JSON.stringify({ event: "acceptance_failed", reason: e.message }),
  );
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  child?.kill();
  if (gateway) await gateway.close();
  await rm(root, { recursive: true, force: true });
  await writeAcceptanceEvidence(`model-switch-${report.catalog}.json`, report, { projectRoot: resolve(".") });
}

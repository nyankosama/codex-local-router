#!/usr/bin/env node
// Offline compatibility gate. Only synthetic instructions and loopback upstreams.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { resolveCore, isolatedCodexHome, runCliExec, startAppServer, writeDeterministicCodexInputs } from "./lib/harness.mjs";
import { deterministicProviderRequest } from "./lib/deterministic-upstream.mjs";
import { captureInstructions } from "../../src/instruction-source.mjs";
import { buildModelCatalog } from "../../src/model-catalog.mjs";
import { validate } from "../../src/config.mjs";
import { createGateway } from "../../src/server.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const core = await resolveCore();
const root = await mkdtemp(join(tmpdir(), "clr-instructions-"));
const captures = [];
const server = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    captures.push(body);
    const result = await deterministicProviderRequest("http://fixture.invalid/v1/responses", { body });
    response.writeHead(result.status, Object.fromEntries(result.headers));
    for await (const chunk of result.body) response.write(chunk);
    response.end();
  } catch {
    response.writeHead(500).end();
  }
});
const sockets = new WebSocketServer({ server });
sockets.on("connection", (socket) => socket.on("message", async (data) => {
  const body = JSON.parse(data);
  captures.push(body);
  const result = await deterministicProviderRequest("http://fixture.invalid/v1/responses", { body: { ...body, stream: true } });
  for await (const chunk of result.body)
    for (const line of chunk.toString().split("\n"))
      if (line.startsWith("data: ")) socket.send(line.slice(6));
}));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const results = [];
try {
  const work = join(root, "work");
  await mkdir(work);
  await writeFile(join(work, "AGENTS.md"), "Synthetic project instruction: PROJECT_SENTINEL.\n");
  const fixture = await writeDeterministicCodexInputs(join(root, "fixture"));
  for (const lite of [false, true]) {
    for (const path of ["official", "provider", "alias"]) {
      const home = join(root, `${path}-${lite}`);
      const model = path === "alias" ? "fixture-gpt-sol" : "gpt-5.6-sol";
      let catalog = JSON.parse(await readFile(fixture.catalogPath, "utf8"));
      Object.assign(catalog.models[0], {
        base_instructions: "SYNTHETIC_BASE_FALLBACK",
        model_messages: {
          instructions_template: "SYNTHETIC_TEMPLATE_SENTINEL {{ personality }}",
          instructions_variables: { personality_default: "DEFAULT_SENTINEL", personality_friendly: "FRIENDLY_SENTINEL", personality_pragmatic: "PRAGMATIC_SENTINEL" },
          persistent_instructions: "SYNTHETIC_PERSISTENT_SENTINEL",
        },
        use_responses_lite: lite,
        supports_search_tool: false,
      });
      let gateway = null;
      if (path === "alias") {
        catalog.models[0].model_messages = {
          instructions_template: "SYNTHETIC_TEMPLATE_SENTINEL PRAGMATIC_SENTINEL",
          instructions_variables: null,
          persistent_instructions: "SYNTHETIC_PERSISTENT_SENTINEL",
        };
        const target = captureInstructions({ provider: "fixture", model: "gpt-5.6-sol", modelFamily: "openai-gpt", wireApi: "responses", contextWindow: 272000,
          app: { enabled: true, modelId: model, useResponsesLite: lite, reasoningLevels: ["low"], defaultReasoningLevel: "low" }, standaloneSearch: { source: "disabled" } }, catalog, { clientVersion: core.version });
        target.app.instructionDelivery = lite ? "gateway-lite" : "client";
        const routerConfig = validate({
          schemaVersion: 3,
          mode: "fixed",
          fixedTarget: "fixture",
          defaultTarget: "fixture",
          providers: { fixture: { baseUrl: "https://example.com/v1", adapter: "openai-compatible" } },
          targets: { fixture: target },
          rules: [],
          history: {},
          subscription: { enabled: true, models: ["gpt-5.6-sol"] },
        });
        catalog = buildModelCatalog(catalog, routerConfig);
        gateway = createGateway(routerConfig, {
          resolveIdentity: async () => "synthetic-account",
          log: () => {},
          send: async (url, options) => {
            captures.push(structuredClone(options.body));
            return deterministicProviderRequest(url, options);
          },
        });
        await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
      }
      const catalogPath = join(home, "models.json");
      const baseUrl = path === "alias"
        ? `http://127.0.0.1:${gateway.server.address().port}/subscription/v1`
        : `http://127.0.0.1:${server.address().port}/v1`;
      await isolatedCodexHome({ home, baseUrl, catalogPath, authSource: fixture.authPath, model,
        extra: 'personality = "pragmatic"\ncli_auth_credentials_store = "file"\n[analytics]\nenabled = false\n' });
      await writeFile(catalogPath, JSON.stringify(catalog));
      if (path === "provider") {
        const config = (await readFile(join(home, "config.toml"), "utf8"))
          .replace('model_provider = "openai"', 'model_provider = "fixture"');
        await writeFile(join(home, "config.toml"), config + `\n[model_providers.fixture]\nname = "fixture"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
      }
      try { for (const client of ["cli", "app-server"]) {
        const start = captures.length;
        const prompt = "USER_SENTINEL. Reply exactly INSTRUCTIONS_OK without tools.";
        if (client === "cli") {
          const turn = await runCliExec({ corePath: core.path, home, cwd: work, args: ["--skip-git-repo-check"], prompt, timeoutMs: 20000 });
          assert.equal(turn.code, 0, `isolated CLI failed (${path}/${lite}): ${turn.stderr.slice(-2000)}`);
        } else {
          const app = startAppServer({ corePath: core.path, home, cwd: work });
          try {
            await app.initialize("instruction_fixture");
            const thread = await app.rpc("thread/start", { model, cwd: work, ephemeral: true, sandbox: "read-only", approvalPolicy: "never" });
            assert.equal((await app.request(thread.thread.id, model, prompt, { timeoutMs: 20000 })).status, "completed");
          } finally { await app.close(); }
        }
        const body = captures.slice(start).find((body) => JSON.stringify(body).includes("USER_SENTINEL"));
        assert.ok(body, "no model request captured");
        const wire = JSON.stringify(body);
        const base = body.instructions ?? (body.input ?? []).filter((item) => JSON.stringify(item).includes("SYNTHETIC_TEMPLATE_SENTINEL"))
          .flatMap((item) => item.content ?? []).map((item) => item.text ?? "").join("\n");
        results.push({ path, lite, client, instructionsHash: hash(base),
          template: wire.split("SYNTHETIC_TEMPLATE_SENTINEL").length - 1,
          persistent: wire.split("SYNTHETIC_PERSISTENT_SENTINEL").length - 1,
          fallback: wire.split("SYNTHETIC_BASE_FALLBACK").length - 1,
          project: wire.includes("PROJECT_SENTINEL"), user: wire.includes("USER_SENTINEL"),
          personality: wire.includes("PRAGMATIC_SENTINEL"), unexpandedVariables: wire.includes("{{ personality }}") });
      } } finally { await gateway?.close(); }
    }
  }
  const compatible = results.every((result) =>
    result.project && result.user && result.persistent === 0 && result.fallback === 0 &&
    (result.path === "official" && result.lite
      ? result.template === 0 && !result.personality
      : result.template === 1 && result.personality && !result.unexpandedVariables));
  console.log(JSON.stringify({ core, results, externalModelCalls: 0,
    persistentMode: "not-enabled-not-accepted", compatibility: compatible ? "PASS" : "FAIL" }, null, 2));
  for (const result of results) {
    assert.equal(result.template, result.path === "official" && result.lite ? 0 : 1);
    assert.equal(result.persistent, 0, "persistent mode was not enabled");
    assert.equal(result.fallback, 0);
    assert.ok(result.project && result.user);
    if (!(result.path === "official" && result.lite))
      assert.ok(result.personality && !result.unexpandedVariables);
  }
  const deliveredHashes = results
    .filter((result) => !(result.path === "official" && result.lite))
    .map((result) => result.instructionsHash);
  assert.equal(new Set(deliveredHashes).size, 1);
} finally {
  for (const socket of sockets.clients) socket.terminate();
  sockets.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}

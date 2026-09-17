#!/usr/bin/env node
// Local-only current-client probe; synthetic credentials, catalog and prompts.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { resolveCore, isolatedCodexHome, runCliExec, startAppServer, writeDeterministicCodexInputs } from "./lib/harness.mjs";
import { deterministicProviderRequest } from "./lib/deterministic-upstream.mjs";
import { captureMultiAgent } from "../../src/multi-agent-source.mjs";
import { buildModelCatalog } from "../../src/model-catalog.mjs";
import { validate } from "../../src/config.mjs";
import { createGateway } from "../../src/server.mjs";
import { applyThirdPartyTemplate } from "../../src/third-party-template.mjs";

const core = await resolveCore();
const generic = process.argv.includes("--generic-third-party");
const contextOnly = process.argv.includes("--context-only");
const candidateCommit = process.argv.includes("--candidate-commit")
  ? process.argv[process.argv.indexOf("--candidate-commit") + 1]
  : null;
const outputPath = process.argv.includes("--output")
  ? process.argv[process.argv.indexOf("--output") + 1]
  : null;
const root = await realpath(await mkdtemp(join(tmpdir(), "clr-multi-agent-")));
const captures = [], results = [];
let activeScenario, childSeen = false, parentRequests = 0, currentCase, caseStart = 0, gateway, passed = false, selectedModel;
const respond = async (body) => {
  captures.push(body);
  if (activeScenario && body.generate !== false) {
    const inputs = body.input ?? [];
    const child = inputs.some((item) => item.content && JSON.stringify(item.content).includes("CHILD_SENTINEL"));
    if (child) childSeen = true;
    const actions = process.argv.includes("--lifecycle")
      ? ["spawn_agent", "wait_agent", "send_message", "followup_task", "wait_agent", "interrupt_agent", "list_agents"]
      : ["spawn_agent", "wait_agent"];
    if (!child && parentRequests++ < actions.length) {
      const name = actions[parentRequests - 1];
      const args = name === "wait_agent" ? { timeout_ms: 10000 } : name === "list_agents" ? {} : name === "interrupt_agent" ? { target: "/root/probe" }
        : ["send_message", "followup_task"].includes(name) ? { target: "/root/probe", message: "CHILD_SENTINEL. Reply FOLLOWUP_OK without tools." }
        : { task_name: "probe", fork_turns: process.argv.includes("--fork") ? "all" : "none",
        ...(process.argv.includes("--override") ? { model: selectedModel, reasoning_effort: "high" } : {}),
        message: "CHILD_SENTINEL. Reply CHILD_OK without tools." };
      const item = { type: "function_call", namespace: "collaboration", name, id: `fc_${captures.length}`,
        call_id: `call_${captures.length}`, arguments: JSON.stringify(args), status: "completed" };
      const response = { id: `resp_${captures.length}`, object: "response", model: body.model, status: "completed", output: [item] };
      const events = [ { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments },
        { type: "response.function_call_arguments.done", output_index: 0, item_id: item.id, arguments: item.arguments },
        { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response } ];
      return { status: 200, ok: true, headers: new Headers({ "content-type": "text/event-stream" }),
        body: Readable.from(events.map((event) => Buffer.from(`data: ${JSON.stringify(event)}\n\n`))) };
    }
  }
  return deterministicProviderRequest("http://fixture.invalid/v1/responses", { body: { ...body, stream: true } });
};
const server = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const result = await respond(JSON.parse(Buffer.concat(chunks)));
  response.writeHead(result.status, Object.fromEntries(result.headers));
  for await (const chunk of result.body) response.write(chunk);
  response.end();
});
const ws = new WebSocketServer({ server });
ws.on("connection", (socket) => socket.on("message", async (data) => {
  const result = await respond(JSON.parse(data));
  for await (const chunk of result.body)
    for (const line of chunk.toString().split("\n"))
      if (line.startsWith("data: ")) socket.send(line.slice(6));
}));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  assert.equal(process.platform, "darwin", "this current-client gate requires macOS network isolation");
  const wrapper = join(root, "codex-local-only");
  const writeWrapper = async (port) => {
    const profile = `(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:${port}"))(allow network* (local unix-socket))(deny file-write*)(allow file-write* (subpath "${root}") (subpath "/dev"))`;
    await writeFile(wrapper, `#!/bin/sh\nmkdir -p "$CODEX_HOME/tmp"\nexport TMPDIR="$CODEX_HOME/tmp"\nexec /usr/bin/sandbox-exec -p '${profile}' '${core.path}' "$@"\n`);
    await chmod(wrapper, 0o700);
  };
  const work = join(root, "work"); await mkdir(work);
  const fixture = await writeDeterministicCodexInputs(join(root, "fixture"));
  const models = generic ? ["deepseek-v4.1-flash"] : ["gpt-5.6-sol", "feei-gpt-5.6-sol", "gpt-6-astra", "feei-gpt-6-astra"];
  const versions = generic ? (contextOnly ? [undefined, "v2"] : ["v2"]) : [undefined, "v2", "disabled"];
  const liteModes = generic ? [false] : [false, true];
  for (const model of models) {
    for (const version of versions) for (const lite of liteModes) for (const client of ["cli", "app-server"]) {
      const label = `${model}/${version ?? "absent"}/${lite ? "lite" : "standard"}/${client}`;
      if (process.env.MULTI_AGENT_CASE && !label.includes(process.env.MULTI_AGENT_CASE)) continue;
      if (!generic && process.argv.includes("--gateway") && !model.startsWith("feei-")) continue;
      currentCase = label; caseStart = captures.length;
      selectedModel = model;
      console.error(JSON.stringify({ model, version: version ?? "absent", lite, client }));
      activeScenario = version === "v2" && !contextOnly; childSeen = false; parentRequests = 0;
      const home = join(root, `${model}-${version}-${lite}-${client}`), catalogPath = join(home, "models.json");
      let catalog = JSON.parse(await readFile(fixture.catalogPath, "utf8"));
      const upstreamModel = model.replace(/^feei-/, "");
      let port = server.address().port, basePath = "/v1";
      if (!generic) Object.assign(catalog.models[0], { slug: upstreamModel, multi_agent_version: "v2",
          ...(model.includes("astra") ? { multi_agent_reasoning_effort: "xhigh" } : {}),
          supported_reasoning_levels: ["low", "high"].map((effort) => ({ effort, description: `${effort} reasoning effort` })),
          tool_mode: "code_mode_only", supports_search_tool: false, use_responses_lite: lite });
      if (model.startsWith("feei-") || generic) {
        let target = { provider: "fixture", model: upstreamModel, modelFamily: "openai-gpt", wireApi: "responses", contextWindow: 272000,
          capabilities: { responses: true, toolCalling: true, freeformTools: true },
          app: { enabled: true, modelId: model, displayName: catalog.models[0].display_name, description: catalog.models[0].description,
            toolMode: "code_mode_only", useResponsesLite: lite, reasoningLevels: ["low", "high"], defaultReasoningLevel: "low" } };
        if (generic) {
          target.modelFamily = "other";
          target.contextWindow = 400000;
          target.maxContextWindow = 400000;
          target.inputModalities = ["text", "image"];
          target.compression = { mode: "summary" };
          target.app.displayName = "DeepSeek V4.1 Flash (synthetic)";
          if (version === "v2") target = applyThirdPartyTemplate(target, "codex-general-v1");
          else { delete target.app.toolMode; delete target.app.defaultReasoningLevel; }
        } else if (version) target = captureMultiAgent(target, catalog, { clientVersion: core.version });
        const config = validate({ schemaVersion: 3, defaultTarget: "fixture", providers: { fixture: { baseUrl: "https://fixture.invalid/v1" } }, targets: { fixture: target },
          subscription: { enabled: true, models: catalog.models.map((entry) => entry.slug).filter((slug) => slug.startsWith("gpt-")) } });
        catalog = buildModelCatalog(catalog, config);
        catalog.models = catalog.models.filter((entry) => entry.slug === model);
        if (process.argv.includes("--gateway") || generic) {
          gateway = createGateway(config, { resolveIdentity: async () => "synthetic-account", log: (event) => {
            if (/error|failed|completed|route$/.test(event.event ?? "")) console.error(JSON.stringify({ gateway: event.event, type: event.type, status: event.status, model: event.model, phase: event.phase }));
          },
            send: async (_url, options) => respond(options.body),
            officialRequest: async () => { throw Error("official egress forbidden"); },
            createOfficialWebSocket: () => { throw Error("official egress forbidden"); } });
          await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
          port = gateway.server.address().port; basePath = "/subscription/v1";
        }
      } else if (!version) { delete catalog.models[0].multi_agent_version; delete catalog.models[0].multi_agent_reasoning_effort; }
      await writeWrapper(port);
      await isolatedCodexHome({ home, baseUrl: `http://127.0.0.1:${port}${basePath}`, catalogPath,
        authSource: fixture.authPath, model, extra: `[agents]\nenabled = ${version !== "disabled"}\n[features]\napps = false\nplugins = false\n[analytics]\nenabled = false\n` });
      await writeFile(catalogPath, JSON.stringify(catalog));
      const start = captures.length;
      const prompt = activeScenario ? "Use one subagent to answer a synthetic read-only question, then report its result." : "Reply PROBE_OK without tools.";
      if (client === "cli") {
        const result = await runCliExec({ corePath: wrapper, home, cwd: work,
          args: ["--skip-git-repo-check"], prompt, timeoutMs: 45000 });
        if (result.code !== 0) console.error(JSON.stringify({ clientEvents: result.rows }));
        assert.equal(result.code, 0, result.stderr.slice(-1500));
      } else {
        const app = startAppServer({ corePath: wrapper, home, cwd: work });
        try {
          await app.initialize("multi_agent_fixture");
          const thread = await app.rpc("thread/start", { model, cwd: work, ephemeral: true, sandbox: "danger-full-access", approvalPolicy: "never" });
          assert.equal((await app.request(thread.thread.id, model, prompt, { timeoutMs: 45000 })).status, "completed");
        } finally { await app.close(); }
      }
      const body = captures.slice(start).find((body) => body.generate !== false);
      assert.ok(body);
      // Lite sends definitions in the prewarm frame, then references that state.
      const definitions = captures.slice(start).flatMap((request) => [...(request.tools ?? []),
        ...(request.input ?? []).filter((item) => item.type === "additional_tools").flatMap((item) => item.tools ?? [])]);
      const tools = [...new Map(definitions.map((tool) => [tool.name, tool])).values()];
      assert.equal(tools.some((tool) => tool.name === "collaboration"), version === "v2",
        JSON.stringify({ model, version, lite, client, tools: tools.map((tool) => ({ name: tool.name, type: tool.type })), inputTypes: (body.input ?? []).map((item) => item.type) }));
      assert.equal(childSeen, activeScenario);
      const current = captures.slice(start);
      assert.ok(current.every((request) => request.model === (gateway ? upstreamModel : model)), "child changed model route");
      const generations = current.filter((request) => request.generate !== false);
      assert.ok(!JSON.stringify(current.flatMap((request) => (request.input ?? []).filter((item) => item.type === "function_call_output")))
        .match(/unknown tool|not found|invalid arguments|tool execution failed/i), "client tool lifecycle failed");
      assert.ok(generations.every((request) => request.reasoning?.effort ===
        (process.argv.includes("--override") && (request.input ?? []).some((item) => item.content && JSON.stringify(item.content).includes("CHILD_SENTINEL")) ? "high" : "low")), "unexpected effort override");
      const contextBytes = Buffer.byteLength(JSON.stringify({ instructions: body.instructions, tools, input: body.input }));
      results.push({ model, version: version ?? "absent", lite, client, toolNames: tools.map((tool) => tool.name),
        collaborationHash: createHash("sha256").update(JSON.stringify(tools.filter((tool) => tool.name === "collaboration")).replaceAll("feei-", "")).digest("hex"),
        roleHash: createHash("sha256").update(JSON.stringify((body.input ?? []).filter((item) => item.role === "developer")
          .flatMap((item) => item.content ?? []).flatMap((part) => (part.text ?? "").match(/<multi_agent_(?:role|mode)>[\s\S]*?<\/multi_agent_(?:role|mode)>/g) ?? []))
          .replaceAll("feei-", "")).digest("hex"),
        childSeen, requests: captures.slice(start).map((body) => ({ model: body.model, effort: body.reasoning?.effort,
          generate: body.generate, marker: JSON.stringify(body).includes("CHILD_SENTINEL"),
          inputShape: (body.input ?? []).map((item) => ({ type: item.type, role: item.role, hasMarker: JSON.stringify(item).includes("CHILD_SENTINEL") })),
          toolResults: (body.input ?? []).filter((item) => item.type === "function_call_output").map((item) => String(item.output).slice(0, 350)) })),
        inputBytes: Buffer.byteLength(JSON.stringify(body.input)), contextBytes,
        instructionOccurrences: JSON.stringify({ instructions: body.instructions, input: body.input }).split("Work as a coding agent in the user's project.").length - 1 });
      await gateway?.close(); gateway = null;
    }
  }
  if (!process.argv.includes("--gateway")) {
    for (const candidate of results.filter((row) => row.model.startsWith("feei-") && row.version === "v2")) {
      const reference = results.find((row) => row.model === candidate.model.slice(5) && row.version === candidate.version && row.lite === candidate.lite && row.client === candidate.client);
      if (!reference) continue;
      assert.equal(candidate.collaborationHash, reference.collaborationHash, "collaboration schema differs beyond the model alias");
      assert.equal(candidate.roleHash, reference.roleHash, "runtime role instructions differ beyond the model alias");
    }
  }
  if (generic && contextOnly) {
    for (const client of ["cli", "app-server"]) {
      const control = results.find((row) => row.client === client && row.version === "absent");
      const candidate = results.find((row) => row.client === client && row.version === "v2");
      assert.ok(control && candidate);
      assert.ok(candidate.contextBytes - control.contextBytes <= Math.max(8192, control.contextBytes * 0.1),
        `generic template context grew beyond guardrail for ${client}`);
      assert.equal(candidate.instructionOccurrences, 1);
    }
  }
  passed = true;
} finally {
  const expectedCases = generic ? (contextOnly ? 4 : 2) : process.argv.includes("--gateway") ? 24 : 48;
  const receipt = { core, candidateCommit, externalModelCalls: 0, passed, fork: process.argv.includes("--fork"), override: process.argv.includes("--override"), results, expectedCases, complete: results.length === expectedCases,
    lastCase: currentCase, lastRequests: captures.slice(caseStart).map((body) => ({ model: body.model, generate: body.generate,
      input: (body.input ?? []).map((item) => ({ type: item.type, role: item.role, child: JSON.stringify(item).includes("CHILD_SENTINEL"),
        output: item.type === "function_call_output" ? String(item.output).slice(0, 300) : undefined })) })) };
  if (outputPath) await writeFile(outputPath, JSON.stringify(receipt, null, 2), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(receipt, null, 2));
  for (const socket of ws.clients) socket.terminate();
  await gateway?.close();
  ws.close(); server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}

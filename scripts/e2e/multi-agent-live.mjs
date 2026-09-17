#!/usr/bin/env node
// Explicit, bounded live qualification. Parent and child generations share one budget.
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, realpath, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request } from "../../src/transport.mjs";
import { captureMultiAgent } from "../../src/multi-agent-source.mjs";
import { isolatedCodexHome, resolveCore, startAppServer, startIsolatedGateway, writeCatalog, writeDeterministicCodexInputs } from "./lib/harness.mjs";

const args = process.argv.slice(2), value = (key) => args[args.indexOf(key) + 1];
assert.ok(args.includes("--run") && ["--config", "--output", "--protocol", "--gateway-protocol"].every((key) => args.includes(key)),
  "requires --run --config PATH --output PATH --protocol RECEIPT --gateway-protocol RECEIPT (12 total generations maximum)");
const core = await resolveCore();
for (const [key, count] of [["--protocol", 48], ["--gateway-protocol", 24]]) {
  const gate = JSON.parse(await readFile(value(key), "utf8"));
  assert.ok(gate.passed && gate.complete && gate.results.length === count && gate.core.sha256 === core.sha256, "offline gate is incomplete or uses another client");
}
assert.equal(process.platform, "darwin");
const configPath = resolve(value("--config")), outputPath = resolve(value("--output"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const configHash = hash(await readFile(configPath));
const root = await realpath(await mkdtemp(join(tmpdir(), "clr-multi-agent-live-")));
const home = join(root, "codex"), work = join(root, "work");
const cases = [], egress = [], counts = new Map(), seen = new Set();
let gateway, app, sends = 0, blocked = 0, stopped = false;
const report = { candidateCommit: args.includes("--candidate-commit") ? value("--candidate-commit") : null,
  client: core, budget: 12, cases, egress, passed: false };
try {
  await mkdir(home); await mkdir(work);
  const marker = "MULTI_AGENT_SYNTHETIC_RESULT_42";
  await writeFile(join(work, "fixture.txt"), `${marker}\n`);
  await writeFile(join(work, "AGENTS.md"), "Synthetic read-only qualification. Only read fixture.txt; do not modify files or access the network. Delegate only when the prompt explicitly requests it.\n");
  const fixture = await writeDeterministicCodexInputs(join(root, "fixture"));
  const raw = JSON.parse(await readFile(configPath, "utf8"));
  const source = JSON.parse(await readFile(raw.subscription.catalogPath, "utf8"));
  gateway = await startIsolatedGateway({ configPath, authSource: fixture.authPath,
    tokenFile: join(root, "token"), archivePath: join(root, "history.sqlite"), archiveKey: randomBytes(32),
    promptCacheSecret: randomBytes(32), toolCodexHome: home, markerObservations: [{ label: "result", value: marker }],
    mutate(config) {
      config.targets = Object.fromEntries(["feei-sol", "feei-astra"].map((id) => {
        assert.ok(config.targets[id]);
        return [id, captureMultiAgent(config.targets[id], source, { clientVersion: core.version })];
      }));
      config.providers = { feei: config.providers.feei };
      assert.equal(new URL(config.providers.feei.baseUrl).origin, "https://ai.feei.cn");
      config.defaultTarget = "feei-sol"; config.mode = "rules"; config.rules = [];
      delete config.subscription.customModels; delete config.fixedTarget; delete config.fallbackTarget; delete config.passthroughTarget;
    },
    beforeOutbound(event) {
      const count = counts.get(event.model) ?? 0;
      if (stopped || event.host !== "ai.feei.cn" || !event.path.endsWith("/responses") || event.subscriptionBearer || event.accountHeader || !event.providerCredential ||
          !["gpt-5.6-sol", "gpt-6-astra"].includes(event.model) || count >= 6 || sends >= 12 || seen.has(event.requestFingerprint)) {
        blocked++; stopped = true; throw Error("live_budget_or_boundary_rejected");
      }
      counts.set(event.model, count + 1); sends++; seen.add(event.requestFingerprint);
      console.error(JSON.stringify({ generation: sends, model: event.model }));
    },
    async sendRequest(url, options) {
      const body = options.body, input = body.input ?? [];
      const definitions = [...(body.tools ?? []), ...input.filter((item) => item.type === "additional_tools").flatMap((item) => item.tools ?? [])];
      const row = { model: body.model, effort: body.reasoning?.effort, collaboration: definitions.some((tool) => tool.name === "collaboration"),
        agentMessage: input.some((item) => item.type === "agent_message"),
        toolResult: input.some((item) => /call_output$/.test(item.type ?? "") && JSON.stringify(item).includes(marker)),
        returnedAgentResult: input.some((item) => item.type === "agent_message" && JSON.stringify(item).includes(marker)) };
      egress.push(row);
      try { const response = await request(url, options); row.status = response.status; if (response.status !== 200) stopped = true; return response; }
      catch (error) { stopped = true; row.error = error.type ?? error.code ?? error.name; throw error; }
    },
    officialRequest: async () => { stopped = true; throw Error("official_egress_forbidden"); },
    providerSearchRequest: async () => { stopped = true; throw Error("search_egress_forbidden"); },
    createOfficialWebSocket: () => { stopped = true; throw Error("official_egress_forbidden"); },
  });
  const catalogPath = join(home, "models.json");
  await writeCatalog({ sourceCatalogPath: raw.subscription.catalogPath, config: gateway.config, targetPath: catalogPath });
  await isolatedCodexHome({ home, baseUrl: `${gateway.url}/subscription/v1`, catalogPath, authSource: fixture.authPath,
    model: "feei-gpt-5.6-sol", reasoningEffort: "low", webSearch: "disabled",
    extra: 'personality = "pragmatic"\ncli_auth_credentials_store = "file"\n[agents]\nmax_concurrent_threads_per_session = 1\n[features]\napps = false\nplugins = false\n[analytics]\nenabled = false\n' });
  const wrapper = join(root, "codex-local-only");
  const profile = `(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:${new URL(gateway.url).port}"))(allow network* (local unix-socket))(deny file-write*)(allow file-write* (subpath "${root}") (subpath "/dev"))`;
  await writeFile(wrapper, `#!/bin/sh\nmkdir -p "$CODEX_HOME/tmp"\nexport TMPDIR="$CODEX_HOME/tmp"\nexec /usr/bin/sandbox-exec -p '${profile}' '${core.path}' "$@"\n`);
  await chmod(wrapper, 0o700);
  app = startAppServer({ corePath: wrapper, home, cwd: work });
  await app.initialize("multi_agent_live_qualification");
  for (const model of ["feei-gpt-5.6-sol", "feei-gpt-6-astra"]) {
    if (stopped) break;
    const start = egress.length, outboundStart = gateway.outbound.length;
    const thread = await app.rpc("thread/start", { model, modelProvider: "openai", cwd: work, ephemeral: true, sandbox: "danger-full-access", approvalPolicy: "never" });
    const turn = await app.request(thread.thread.id, model,
      "Explicitly spawn exactly one subagent using collaboration.spawn_agent, task_name reader, fork_turns none; omit model and reasoning_effort so it inherits yours. Tell it to use functions.exec once to call tools.exec_command with cmd 'cat fixture.txt', print the result, then return the exact file text without other tools. You must not read the file yourself. Wait for its completion with collaboration.wait_agent, then return its exact result followed by PARENT_OK. Do not create further agents or call any other tool.", { timeoutMs: 180000 });
    const continuation = turn.status === "completed" && !stopped
      ? await app.request(thread.thread.id, model, "Without tools, repeat the reader's file content followed by CONTINUATION_OK.", { timeoutMs: 90000 }) : { status: "not_run", text: "" };
    const rows = egress.slice(start), outbound = gateway.outbound.slice(outboundStart);
    const row = { model, status: turn.status, continuation: continuation.status, generations: rows.length,
      resultInAnswer: turn.text.includes(marker), continuationResult: continuation.text.includes(marker),
      collaboration: rows.some((r) => r.collaboration), childInput: rows.some((r) => r.agentMessage),
      toolResult: rows.some((r) => r.toolResult), agentResultReturned: rows.some((r) => r.returnedAgentResult),
      routeSafe: outbound.every((r) => r.host === "ai.feei.cn" && r.providerCredential && !r.subscriptionBearer && !r.accountHeader),
      durationMs: turn.endedAt - turn.startedAt };
    row.passed = row.status === "completed" && row.continuation === "completed" && row.resultInAnswer && row.continuationResult &&
      row.collaboration && row.childInput && row.toolResult && row.agentResultReturned && row.routeSafe && rows.every((r) => r.status === 200);
    cases.push(row); if (!row.passed) stopped = true;
  }
} catch (error) { report.error = error.code ?? error.type ?? error.name; stopped = true; }
finally {
  await app?.close(); await gateway?.close();
  report.generations = sends; report.blocked = blocked;
  report.sourceConfigUnchanged = hash(await readFile(configPath)) === configHash;
  report.passed = !stopped && !blocked && cases.length === 2 && cases.every((row) => row.passed) && report.sourceConfigUnchanged;
  await writeFile(outputPath, JSON.stringify(report, null, 2), { mode: 0o600, flag: "wx" });
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify({ passed: report.passed, generations: sends, blocked }));
  if (!report.passed) process.exitCode = 1;
}

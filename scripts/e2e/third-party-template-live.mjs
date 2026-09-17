#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request } from "../../src/transport.mjs";
import { applyThirdPartyTemplate, GENERIC_INSTRUCTIONS } from "../../src/third-party-template.mjs";
import { isolatedCodexHome, resolveCore, runCliExec, runCliExecResume, startAppServer,
  startIsolatedGateway, writeCatalog, writeDeterministicCodexInputs } from "./lib/harness.mjs";

const args = process.argv.slice(2);
const value = (key) => args[args.indexOf(key) + 1];
assert.ok(args.includes("--run") && ["--config", "--output", "--context-receipt", "--protocol-receipt"].every((key) => args.includes(key)),
  "requires --run --config PATH --output PATH --context-receipt PATH --protocol-receipt PATH (12 generations maximum)");
const core = await resolveCore();
for (const [key, count] of [["--context-receipt", 4], ["--protocol-receipt", 2]]) {
  const receipt = JSON.parse(await readFile(resolve(value(key)), "utf8"));
  assert.ok(receipt.passed && receipt.complete && receipt.results?.length === count && receipt.core?.sha256 === core.sha256,
    "offline generic-template receipt is incomplete or uses another client");
  if (args.includes("--candidate-commit")) assert.equal(receipt.candidateCommit, value("--candidate-commit"));
}

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const configPath = resolve(value("--config")), outputPath = resolve(value("--output"));
const configHash = hash(await readFile(configPath));
const root = await realpath(await mkdtemp(join(tmpdir(), "clr-generic-live-")));
const home = join(root, "codex"), work = join(root, "work"), cases = [], egress = [];
const marker = "GENERIC_TEMPLATE_SYNTHETIC_RESULT_42";
let gateway, app, activeCase = null, generations = 0, stopped = false, blocked = 0;
const perCase = new Map(), fingerprints = new Set();
const limits = { "deepseek-cli": 3, "deepseek-app": 6, "feei-sol-app": 3 };
const report = { candidateCommit: args.includes("--candidate-commit") ? value("--candidate-commit") : null,
  client: core, budget: 12, cases, egress, passed: false };

try {
  await mkdir(home); await mkdir(work);
  await writeFile(join(work, "fixture.txt"), `${marker}\n`);
  await writeFile(join(work, "AGENTS.md"),
    "Synthetic read-only qualification. Only read fixture.txt; do not modify files or access the network. Delegate only when explicitly requested.\n");
  const fixture = await writeDeterministicCodexInputs(join(root, "fixture"));
  const raw = JSON.parse(await readFile(configPath, "utf8"));
  gateway = await startIsolatedGateway({ configPath, authSource: fixture.authPath,
    tokenFile: join(root, "token"), archivePath: join(root, "history.sqlite"), archiveKey: randomBytes(32),
    promptCacheSecret: randomBytes(32), toolCodexHome: home, markerObservations: [{ label: "result", value: marker }],
    mutate(config) {
      const deepseek = config.targets.deepseek;
      const sol = structuredClone(config.targets["feei-sol"]);
      assert.ok(deepseek && sol, "live config requires deepseek and feei-sol");
      for (const key of ["baseInstructions", "modelMessages", "instructionDelivery", "instructionSource", "multiAgent", "thirdPartyTemplate"])
        delete sol.app[key];
      config.targets = {
        deepseek: applyThirdPartyTemplate(deepseek, "codex-general-v1"),
        "feei-sol": applyThirdPartyTemplate(sol, "codex-general-v1"),
      };
      delete config.subscription.customModels;
      config.providers = { [deepseek.provider]: config.providers[deepseek.provider], feei: config.providers.feei };
      config.defaultTarget = "deepseek";
      config.mode = "rules";
      config.rules = [];
      delete config.fixedTarget; delete config.fallbackTarget; delete config.passthroughTarget;
    },
    beforeOutbound(event) {
      const count = perCase.get(activeCase) ?? 0;
      const allowed = activeCase && count < limits[activeCase] && generations < 12 && !fingerprints.has(event.requestFingerprint) &&
        ((activeCase.startsWith("deepseek") && event.host === "opencode.ai" && event.model === "deepseek-v4.1-flash") ||
         (activeCase === "feei-sol-app" && event.host === "ai.feei.cn" && event.model === "gpt-5.6-sol")) &&
        event.providerCredential && !event.subscriptionBearer && !event.accountHeader;
      if (!allowed) { blocked++; stopped = true; throw Error("live_budget_or_boundary_rejected"); }
      perCase.set(activeCase, count + 1); generations++; fingerprints.add(event.requestFingerprint);
      console.error(JSON.stringify({ generation: generations, case: activeCase, model: event.model }));
    },
    async sendRequest(url, options) {
      const body = options.body;
      const definitions = [...(body.tools ?? []), ...(body.input ?? []).filter((item) => item.type === "additional_tools").flatMap((item) => item.tools ?? [])];
      const row = { case: activeCase, model: body.model,
        genericInstructions: JSON.stringify({ instructions: body.instructions, input: body.input }).split(GENERIC_INSTRUCTIONS).length - 1,
        exec: definitions.some((tool) => tool.name === "exec"), collaboration: definitions.some((tool) => tool.name === "collaboration"),
        toolResult: (body.input ?? []).some((item) => /call_output$/.test(item.type ?? "") && JSON.stringify(item).includes(marker)),
        agentResult: (body.input ?? []).some((item) => item.type === "agent_message" && JSON.stringify(item).includes(marker)) };
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
    model: "deepseek-v4.1-flash", reasoningEffort: "low", webSearch: "disabled",
    extra: 'personality = "pragmatic"\ncli_auth_credentials_store = "file"\n[agents]\nmax_concurrent_threads_per_session = 1\n[features]\napps = false\nplugins = false\n[analytics]\nenabled = false\n' });
  const wrapper = join(root, "codex-local-only");
  const profile = `(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:${new URL(gateway.url).port}"))(allow network* (local unix-socket))(deny file-write*)(allow file-write* (subpath "${root}") (subpath "/dev"))`;
  await writeFile(wrapper, `#!/bin/sh\nmkdir -p "$CODEX_HOME/tmp"\nexport TMPDIR="$CODEX_HOME/tmp"\nexec /usr/bin/sandbox-exec -p '${profile}' '${core.path}' "$@"\n`);
  await chmod(wrapper, 0o700);

  activeCase = "deepseek-cli";
  const cliStart = egress.length;
  const cli = await runCliExec({ corePath: wrapper, home, cwd: work,
    globalArgs: ["--dangerously-bypass-approvals-and-sandbox"], args: ["--skip-git-repo-check"], timeoutMs: 180000,
    prompt: "Use functions.exec once to call tools.exec_command with cmd 'cat fixture.txt'. Then return the exact file text followed by CLI_OK." });
  const resume = cli.code === 0 && !stopped ? await runCliExecResume({ corePath: wrapper, home, cwd: work,
    globalArgs: ["--dangerously-bypass-approvals-and-sandbox"], timeoutMs: 90000,
    prompt: "Without tools, repeat the file content followed by CLI_CONTINUATION_OK." }) : { code: -1, stdout: "" };
  const cliRows = egress.slice(cliStart);
  cases.push({ name: activeCase, status: cli.code, continuation: resume.code, generations: cliRows.length,
    result: cli.stdout.includes(marker), continuationResult: resume.stdout.includes(marker),
    passed: cli.code === 0 && resume.code === 0 && cli.stdout.includes(marker) && resume.stdout.includes(marker) &&
      cliRows.some((row) => row.exec && row.toolResult) && cliRows.every((row) => row.status === 200 && row.genericInstructions === 1) });
  if (!cases.at(-1).passed) stopped = true;

  app = startAppServer({ corePath: wrapper, home, cwd: work });
  await app.initialize("generic_template_live");
  for (const spec of [
    { name: "deepseek-app", model: "deepseek-v4.1-flash", prompt: "Explicitly spawn exactly one subagent with collaboration.spawn_agent. Tell it to use functions.exec once to call tools.exec_command with cmd 'cat fixture.txt' and return the exact file text. Wait for it, then return its exact result followed by APP_PARENT_OK." },
    { name: "feei-sol-app", model: "feei-gpt-5.6-sol", prompt: "Use functions.exec once to call tools.exec_command with cmd 'cat fixture.txt'. Return the exact file text followed by SOL_OK." },
  ]) {
    if (stopped) break;
    activeCase = spec.name;
    const start = egress.length;
    const thread = await app.rpc("thread/start", { model: spec.model, modelProvider: "openai", cwd: work, ephemeral: true,
      sandbox: "danger-full-access", approvalPolicy: "never" });
    const turn = await app.request(thread.thread.id, spec.model, spec.prompt, { timeoutMs: 240000 });
    const continuation = turn.status === "completed" && !stopped
      ? await app.request(thread.thread.id, spec.model, "Without tools, repeat the fixture text followed by CONTINUATION_OK.", { timeoutMs: 120000 })
      : { status: "not_run", text: "" };
    const rows = egress.slice(start);
    const needsAgent = spec.name === "deepseek-app";
    cases.push({ name: spec.name, status: turn.status, continuation: continuation.status, generations: rows.length,
      result: turn.text.includes(marker), continuationResult: continuation.text.includes(marker),
      passed: turn.status === "completed" && continuation.status === "completed" && turn.text.includes(marker) && continuation.text.includes(marker) &&
        rows.some((row) => row.exec && row.toolResult) && (!needsAgent || rows.some((row) => row.collaboration && row.agentResult)) &&
        rows.every((row) => row.status === 200 && row.genericInstructions === 1) });
    if (!cases.at(-1).passed) stopped = true;
  }
} catch (error) {
  report.error = error.code ?? error.type ?? error.name;
  report.errorMessage = String(error.message ?? "unknown error").slice(0, 500);
  stopped = true;
} finally {
  await app?.close(); await gateway?.close();
  report.generations = generations;
  report.blocked = blocked;
  report.sourceConfigUnchanged = hash(await readFile(configPath)) === configHash;
  report.passed = !stopped && !blocked && cases.length === 3 && cases.every((entry) => entry.passed) &&
    generations <= 12 && report.sourceConfigUnchanged;
  await writeFile(outputPath, JSON.stringify(report, null, 2), { mode: 0o600, flag: "wx" });
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify({ passed: report.passed, generations, blocked }));
  if (!report.passed) process.exitCode = 1;
}

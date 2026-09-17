// E2E 运行入口：G0 门禁 + 6 条用例，证据默认写入本地 Router 数据目录。
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { evaluate, loadThresholds, verdict } from "./lib/criteria.mjs";
import {
  createEvidenceDirectory,
  persistCaseVerdict,
  resolveCore,
  verifyAcceptanceRevision,
  writeDeterministicCodexInputs,
  writeImmutableJson,
} from "./lib/harness.mjs";
import { parseNodeTestSummary } from "./lib/process-output.mjs";
import { evidencePath } from "./lib/evidence-path.mjs";
import { CASES } from "./cases.mjs";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};

const projectRoot = resolve(import.meta.dirname, "..", "..");
const artifactsRoot = evidencePath(value("out"), "e2e", { projectRoot });
const GROUP = value("group") ?? "all";
const ONLY = value("case");
const INCLUDE_PRE_RELEASE = flag("include-pre-release");
const INCLUDE_LIVE = flag("include-live");
const runId = value("run") ?? new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);

if ((GROUP === "live" || INCLUDE_LIVE) && !flag("run")) {
  console.error("Live E2E uses the installed Gateway and requires an explicit --run confirmation.");
  process.exit(2);
}

const ok = (name, pass, detail = "") => ({ name, ok: Boolean(pass), detail: String(detail).slice(0, 400) });

function sh(command, args, timeoutMs = 900000) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (x) => (out += x));
    child.stderr.on("data", (x) => (out += x));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, out });
    });
  });
}

const EGRESS_ALLOWLIST = [
  "chatgpt.com",
  "api.tavily.com",
  "api.exa.ai",
  "opencode.ai",
  "ai.feei.cn",
  "example.com",
];

export async function architectureScan() {
  const checks = [];
  const files = (await readdir(join(projectRoot, "src"))).filter((x) => x.endsWith(".mjs"));
  const sources = await Promise.all(files.map(async (name) => ({ name, text: await readFile(join(projectRoot, "src", name), "utf8") })));
  const all = sources.map((x) => x.text).join("\n");

  const proxy = sources.filter((x) => x.text.includes("opencode-go-proxy")).map((x) => x.name);
  checks.push(ok("no_bypass_proxy_process", proxy.length === 0, proxy.join(",")));

  const evalUse = sources.filter((x) => /\beval\s*\(/.test(x.text)).map((x) => x.name);
  checks.push(ok("no_eval", evalUse.length === 0, evalUse.join(",")));

  const dynamic = sources.filter((x) => /import\s*\(\s*[^"'`]/.test(x.text)).map((x) => x.name);
  checks.push(ok("no_dynamic_import", dynamic.length === 0, dynamic.join(",")));

  const thresholdFiles = sources.filter((x) => ["engine.mjs", "context.mjs"].includes(x.name) && /65536|64\s*\*\s*1024/.test(x.text)).map((x) => x.name);
  checks.push(ok("no_fixed_compaction_threshold", thresholdFiles.length === 0, thresholdFiles.join(",")));

  const hosts = [...new Set(all.match(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [])].map((x) => new URL(x).host);
  const offAllowlist = hosts.filter((x) => !EGRESS_ALLOWLIST.some((allowed) => x === allowed || x.endsWith(`.${allowed}`)));
  checks.push(ok("egress_allowlist", offAllowlist.length === 0, offAllowlist.join(",")));

  return checks;
}

async function runGate() {
  const gate = { at: new Date().toISOString(), checks: [], passed: false };
  const test = await sh("npm", ["test"]);
  const { total, passed, failed } = parseNodeTestSummary(test.out);
  gate.checks.push(
    ok(
      "npm_test",
      test.code === 0 && failed === "0" && Number(total) > 0,
      total ? `tests=${total} pass=${passed} fail=${failed}` : `exit=${test.code}`,
    ),
  );
  const audit = await sh("npm", ["run", "audit:package"], 300000);
  gate.checks.push(ok("audit_package", audit.code === 0 && /"ok":\s*true/.test(audit.out), `exit=${audit.code}`));
  gate.checks.push(...(await architectureScan()));
  gate.passed = gate.checks.every((x) => x.ok);
  return gate;
}

function sanitize(observation) {
  const lines = [];
  for (const event of observation.clientEvents ?? [])
    lines.push(JSON.stringify({
      at: event.at, type: event.type, sequence_number: event.sequence_number,
      item: event.item ? { type: event.item.type, phase: event.item.phase, id: event.item.id, status: event.item.status } : undefined,
    }));
  return lines.join("\n") + (lines.length ? "\n" : "");
}

const detailHash = (value) =>
  createHash("sha256").update(String(value)).digest("hex").slice(0, 20);

function safeEvent(event) {
  return {
    at: event.at,
    type: event.type,
    sequence_number: event.sequence_number,
    output_index: event.output_index,
    item: event.item ? {
      type: event.item.type,
      phase: event.item.phase,
      id: event.item.id,
      call_id: event.item.call_id,
      status: event.item.status,
    } : undefined,
    response: event.response ? {
      id: event.response.id,
      status: event.response.status,
      model: event.response.model,
      outputItems: Array.isArray(event.response.output) ? event.response.output.length : undefined,
      usage: event.response.usage,
    } : undefined,
  };
}

function safeAssertions(assertions = []) {
  return assertions.map((assertion) => ({
    name: assertion.name,
    ok: assertion.ok,
    ...(assertion.detail ? { detailHash: detailHash(assertion.detail) } : {}),
  }));
}

function safeObservation(observation) {
  return {
    ...observation,
    terminal: (observation.terminal ?? []).map(safeEvent),
    clientEvents: (observation.clientEvents ?? []).map(safeEvent),
    streams: (observation.streams ?? []).map((stream) => stream.map(safeEvent)),
    assertions: safeAssertions(observation.assertions),
  };
}

async function main() {
  const runDir = join(artifactsRoot, runId);
  const implementation = await verifyAcceptanceRevision(
    projectRoot,
    process.env.ACCEPTANCE_COMMIT,
  );
  await createEvidenceDirectory(runDir);
  await mkdir(join(runDir, "raw"), { recursive: false, mode: 0o700 });
  const fixtureRoot = await mkdtemp(join(tmpdir(), "codex-router-e2e-inputs-"));
  const fixtureInputs = await writeDeterministicCodexInputs(fixtureRoot);
  const realAuthSource = join(homedir(), ".codex", "auth.json");
  const realCatalogSource = join(homedir(), ".codex", "models_cache.json");
  const { thresholds, sha256: thresholdsSha256 } = await loadThresholds();
  const core = GROUP === "l0" ? null : await resolveCore();
  const summary = {
    runId,
    startedAt: new Date().toISOString(),
    group: GROUP,
    caseFilter: ONLY ?? null,
    execution: {
      upstreamMode: GROUP === "live" ? "installed-live-service" : GROUP === "l0" ? "none" : "injected-deterministic",
      productionConfigUsed: GROUP === "live",
    },
    thresholdsSha256,
    implementation,
    harness: core ? { kind: core.source, version: core.version, sha256: core.sha256 } : null,
    gate: null,
    cases: [],
    manual: {
      status: "pending",
      attestedBy: null,
      items: [
        "App 模型菜单包含 DeepSeek V4.1 Flash 且推理档位到 max",
        "新建 DeepSeek 会话可以正常回答",
        "在 DeepSeek 会话附加一张图片，不出现「不支持图像输入」",
        "同一会话 GPT 与 DeepSeek 双向切换后继续可用",
        "订阅账号与额度信息显示正常",
      ],
    },
    knownLimits: [],
  };

  if (GROUP === "l0" || GROUP === "all") {
    summary.gate = await runGate();
    console.log(JSON.stringify({ event: "gate", passed: summary.gate.passed, checks: summary.gate.checks }));
  }

  const selected = Object.entries(CASES)
    .filter(([id, spec]) =>
      ONLY
        ? id === ONLY && (GROUP === "all" || GROUP === spec.group) && (spec.group !== "live" || INCLUDE_LIVE || GROUP === "live")
        : GROUP === "all"
          ? (spec.group !== "live" || INCLUDE_LIVE) && (INCLUDE_PRE_RELEASE || !spec.preRelease)
          : GROUP === spec.group,
    )
    // 发布前用例（容量边界）始终最后执行。
    .sort(([, a], [, b]) => Number(Boolean(a.preRelease)) - Number(Boolean(b.preRelease)))
    .sort(([a], [b]) => a.localeCompare(b));

  const ctx = {
    runId,
    runDir,
    core,
    thresholds,
    prodConfigPath: join(homedir(), "Library", "Application Support", "Codex Local Router", "config.json"),
    fixtureConfigPath: join(projectRoot, "config", "gateway.example.json"),
    authSource: fixtureInputs.authPath,
    catalogSource: fixtureInputs.catalogPath,
    live: {
      url: "http://127.0.0.1:8788",
      logPath: join(homedir(), "Library", "Application Support", "Codex Local Router", "logs", "gateway.log"),
      catalogPath: join(homedir(), ".codex", "model-catalogs", "codex-local-router.json"),
    },
    entryKind: null,
  };

  for (const [id, spec] of selected) {
    const startedAt = Date.now();
    ctx.authSource = spec.group === "live" ? realAuthSource : fixtureInputs.authPath;
    ctx.catalogSource = spec.group === "live" ? realCatalogSource : fixtureInputs.catalogPath;
    ctx.entryKind = id === "E2E-1" || id === "E2E-4" || id === "E2E-5" ? "A" : "B";
    console.log(JSON.stringify({ event: "case_start", case: id, title: spec.title }));
    let record;
    try {
      const observation = await spec.run(ctx);
      const criteria = evaluate(observation, thresholds);
      const assertionFailures = (observation.assertions ?? []).filter((x) => !x.ok);
      const baseVerdict = verdict(criteria);
      const finalVerdict = assertionFailures.length ? "FAIL" : baseVerdict;
      record = {
        case: id,
        title: spec.title,
        verdict: finalVerdict,
        criteria,
        assertions: safeAssertions(observation.assertions),
        assertionFailures: assertionFailures.map((x) => x.name),
        durationMs: Date.now() - startedAt,
        modelCalls: (observation.payloads ?? []).length,
        evidence: {
          observation: `${runId}/${id}.json`,
          raw: `${runId}/raw/${id}.jsonl`,
        },
        detail: observation.detail ?? {},
      };
      // The case verdict is authoritative.  buildObservation's default PASS
      // is only a probe shape and must not contradict a failed assertion.
      const persistedObservation = persistCaseVerdict(safeObservation(observation), finalVerdict);
      await writeImmutableJson(join(runDir, `${id}.json`), persistedObservation);
      await writeFile(join(runDir, "raw", `${id}.jsonl`), sanitize(observation), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      record = {
        case: id,
        title: spec.title,
        verdict: "FAIL",
        criteria: [],
        assertions: [],
        assertionFailures: [error.message],
        durationMs: Date.now() - startedAt,
        modelCalls: 0,
        evidence: { observation: null, raw: null },
        detail: { error: error.message, stack: String(error.stack).split("\n").slice(0, 4).join(" | ") },
      };
    }
    summary.cases.push(record);
    console.log(JSON.stringify({ event: "case_done", case: id, verdict: record.verdict, durationMs: record.durationMs }));
  }

  summary.endedAt = new Date().toISOString();
  summary.verdict = summary.cases.some((x) => x.verdict === "FAIL")
    ? "FAIL"
    : summary.cases.some((x) => x.verdict === "ANOMALY")
      ? "ANOMALY"
      : summary.gate && !summary.gate.passed
        ? "FAIL"
      : "PASS";
  await writeImmutableJson(join(runDir, "summary.json"), summary);
  await rm(fixtureRoot, { recursive: true, force: true });
  console.log(JSON.stringify({ event: "summary", runId, verdict: summary.verdict, cases: summary.cases.map((x) => `${x.case}:${x.verdict}`) }));
  // 显式退出：失败路径可能残留监听句柄，不能阻塞门禁与 CI。
  process.exit(summary.verdict === "FAIL" ? 1 : 0);
}

await main();

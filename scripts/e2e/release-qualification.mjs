#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { evidencePath } from "./lib/evidence-path.mjs";
import {
  RELEASE_QUALIFICATION,
  qualifyReleaseReceipts,
  validateReleaseQualification,
} from "./lib/release-qualification.mjs";

const exec = promisify(execFile);
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? undefined : argv[index + 1];
};
if (!flag("run")) {
  console.error("Release qualification makes bounded real GLM, ai.feei, OpenAI and Tavily requests. Re-run with --run after reviewing docs/public/acceptance.md.");
  process.exit(2);
}
if (!process.env.ACCEPTANCE_COMMIT)
  throw Error("ACCEPTANCE_COMMIT is required");
if (!process.env.TAVILY_API_KEY)
  throw Error("TAVILY_API_KEY is required");

const projectRoot = resolve(import.meta.dirname, "..", "..");
const commit = process.env.ACCEPTANCE_COMMIT;
const runId = new Date().toISOString().replaceAll(/[^0-9]/g, "").slice(0, 14);
const output = evidencePath(value("out"), join("release", `${runId}-${commit.slice(0, 12)}`), { projectRoot });
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
await mkdir(output, { mode: 0o700 });

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const receipts = {};
const minute = 60 * 1000;
const capabilityReceipt = join(output, "compressionCapability.json");
const stages = [
  ["profiles", "profile-qualification.mjs", [], 15 * minute],
  ["compressionCapability", "compression-capability.mjs",
    ["--run", "--max-generations", "12"], 30 * minute],
  ["appSmoke", "history-migration-acceptance.mjs",
    ["--run", "--app-smoke-only", "--max-generations", "24"],
    25 * minute],
  ["nativeCompaction", "native-compaction-acceptance.mjs",
    ["--run", "--max-generations", "64"], 45 * minute],
  ["universalSearch", "universal-search-acceptance.mjs", ["--run", "--max-generations", "8"], 15 * minute],
  ["officialSearch", "official-search-acceptance.mjs", ["--run"], 15 * minute],
  ["historyMigration", "history-migration-acceptance.mjs",
    [
      "--run",
      "--max-generations",
      "48",
      "--capability-receipt",
      capabilityReceipt,
    ],
    45 * minute],
];
let harnessError = null;

const deterministicReceipt = join(output, "deterministic.json");
const checks = {
  cleanWorktree: false,
  diffCheck: false,
  npmTest: false,
  packageAudit: false,
};
try {
  const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: projectRoot })).stdout.trim();
  const status = (await exec("git", ["status", "--porcelain"], { cwd: projectRoot })).stdout.trim();
  if (head !== commit) throw Error("commit_mismatch");
  if (status) throw Error("worktree_not_clean");
  checks.cleanWorktree = true;
  await exec("git", ["show", "--check", "--oneline", "HEAD"], { cwd: projectRoot });
  checks.diffCheck = true;
  await exec("npm", ["test"], {
    cwd: projectRoot,
    timeout: 15 * minute,
    maxBuffer: 16 * 1024 * 1024,
  });
  checks.npmTest = true;
  await exec("npm", ["run", "audit:package"], {
    cwd: projectRoot,
    timeout: 5 * minute,
    maxBuffer: 16 * 1024 * 1024,
  });
  checks.packageAudit = true;
} catch (error) {
  harnessError = { stage: "deterministic", type: error?.code ?? error?.message ?? "stage_failed" };
}
receipts.deterministic = {
  verdict: Object.values(checks).every(Boolean) ? "PASS" : "FAIL",
  implementation: { commit },
  checks,
};
await writeFile(deterministicReceipt, `${JSON.stringify(receipts.deterministic, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600,
});

for (const [name, script, args, timeout] of stages) {
  if (harnessError) break;
  const receipt = join(output, `${name}.json`);
  try {
    await exec(process.execPath, [join(import.meta.dirname, script), ...args, "--out", receipt], {
      cwd: projectRoot,
      env: process.env,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    });
    receipts[name] = JSON.parse(await readFile(receipt, "utf8"));
    if (receipts[name].verdict !== "PASS") throw Error("stage_failed");
  } catch (error) {
    if (!receipts[name]) {
      try { receipts[name] = JSON.parse(await readFile(receipt, "utf8")); } catch {}
    }
    harnessError = {
      stage: name,
      type: receipts[name]?.harnessError?.type ?? error?.code ?? "release_qualification_stage_failed",
    };
    break;
  }
}

const qualified = qualifyReleaseReceipts(receipts, commit);
const summary = {
  schemaVersion: RELEASE_QUALIFICATION.schemaVersion,
  type: RELEASE_QUALIFICATION.type,
  generatedAt: new Date().toISOString(),
  ...qualified,
  receiptHashes: Object.fromEntries(await Promise.all(
    Object.entries(receipts).map(async ([name]) => [
      name,
      sha256(await readFile(join(output, `${name}.json`))),
    ]),
  )),
  harnessError,
  appUi: "not-tested",
};
if (summary.verdict === "PASS") validateReleaseQualification(summary, commit);
await writeFile(join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600,
});
console.log(JSON.stringify(summary, null, 2));
if (summary.verdict !== "PASS") process.exitCode = 1;

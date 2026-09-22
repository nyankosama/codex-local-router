import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { writeAcceptanceEvidence } from "./e2e/lib/evidence-path.mjs";
const base = process.env.ACCEPT_GATEWAY_URL ?? "http://127.0.0.1:18791";
const root = await mkdtemp(join(tmpdir(), "gateway-cli-accept-"));
const spec = `import test from 'node:test';import assert from 'node:assert/strict';import {normalizeName} from './name.mjs';test('trims edges',()=>assert.equal(normalizeName('  Ada  '),'Ada'));test('collapses spaces',()=>assert.equal(normalizeName('Ada   Lovelace'),'Ada Lovelace'));\n`;
const digest = (x) => createHash("sha256").update(x).digest("hex");
const outputs = [];
for (const profile of ["official", "feei"]) {
  const cwd = join(root, profile);
  await mkdir(cwd);
  await writeFile(
    join(cwd, "name.mjs"),
    "export const normalizeName = value => value;\n",
  );
  await writeFile(join(cwd, "name.test.mjs"), spec);
  const flags =
    profile === "official"
      ? [
          "-c",
          'model_provider="openai"',
          "-c",
          `openai_base_url="${base}/subscription/v1"`,
        ]
      : [
          "-c",
          'model_provider="feei"',
          "-c",
          'model_providers.feei.name="ai.feei.cn"',
          "-c",
          `model_providers.feei.base_url="${base}/v1"`,
          "-c",
          'model_providers.feei.wire_api="responses"',
        ];
  const prompt =
    "This is a controlled acceptance task. Read name.mjs and name.test.mjs. First change normalizeName to trim edges ONLY (intentionally leave internal multiple spaces unchanged). Run node --test name.test.mjs and observe the expected failing test. Then fix normalizeName to also collapse consecutive whitespace into one space. Run the same tests again, requiring all to pass. Do not modify the tests, create extra tests, or inspect files outside this working directory. Finish with a brief summary mentioning the initial failure and repair. Execute all steps with tools.";
  const child = spawn(
    "codex",
    [
      "exec",
      "--ignore-user-config",
      "--ephemeral",
      "--skip-git-repo-check",
      "-C",
      cwd,
      "-s",
      "workspace-write",
      "-c",
      'approval_policy="never"',
      ...flags,
      "-m",
      "gpt-5.5",
      "-c",
      'model_reasoning_effort="low"',
      "--json",
      prompt,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "",
    err = "";
  child.stdout.on("data", (x) => (out += x));
  child.stderr.on("data", (x) => (err += x));
  const timer = setTimeout(() => child.kill(), 360000);
  const code = await new Promise((r) => child.on("close", r));
  clearTimeout(timer);
  await writeFile(join(root, profile + ".jsonl"), out, { mode: 0o600 });
  const rows = out
    .split("\n")
    .filter(Boolean)
    .map((x) => {
      try {
        return JSON.parse(x);
      } catch {
        return {};
      }
    });
  const commands = rows
    .filter(
      (x) =>
        x.type === "item.completed" && x.item?.type === "command_execution",
    )
    .map((x) => x.item);
  assert.equal(code, 0, profile + " CLI failed");
  assert.equal(
    digest(await readFile(join(cwd, "name.test.mjs"))),
    digest(Buffer.from(spec)),
    "tests were modified",
  );
  assert.ok(
    commands.some((x) => x.exit_code !== 0 && x.command.includes("--test")),
    profile + " missing expected test failure",
  );
  assert.ok(
    commands.some((x) => x.exit_code === 0 && x.command.includes("--test")),
    profile + " missing repaired passing test",
  );
  const checked = spawnSync(process.execPath, ["--test", "name.test.mjs"], {
    cwd,
  });
  assert.equal(checked.status, 0);
  outputs.push({
    profile,
    exit_code: code,
    tests_unchanged: true,
    independent_tests_passed: true,
    commands,
    final: rows.findLast((x) => x.item?.type === "agent_message")?.item.text,
  });
  console.log(JSON.stringify({ event: "workflow_passed", profile, root }));
}
await writeAcceptanceEvidence("cli.json", outputs);

#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { assertAllowedFiles, filesUnder, scanTextFiles } from "./public-boundary.mjs";

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "codex-local-router-package-audit-"));
try {
  const { stdout } = await exec(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", root],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const report = JSON.parse(stdout)[0];
  const archive = resolve(root, report.filename);
  await exec("tar", ["-xzf", archive, "-C", root]);
  const packageRoot = join(root, "package");
  const names = (await Promise.all(
    (await readdir(packageRoot)).map((entry) => filesUnder(packageRoot, entry)),
  )).flat().sort();
  assertAllowedFiles(names);
  const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  for (const command of ["codex-local-router", "llm-auto-gateway"])
    if (packageJson.bin?.[command] !== "scripts/gateway-admin.mjs")
      throw Error(`package is missing the ${command} executable`);
  for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
    const match = /^node\s+([^\s]+)/.exec(command);
    if (match && !names.includes(match[1]))
      throw Error(`package script ${name} references missing file ${match[1]}`);
  }
  if (!names.some((name) => name.startsWith("test/") && name.endsWith(".test.mjs")))
    throw Error("package test script has no packaged test files");
  const scanned = await scanTextFiles(packageRoot, names, {
    skip: ["scripts/public-boundary.mjs"],
  });
  console.log(JSON.stringify({
    ok: true,
    package: report.filename,
    files: names.length,
    textFiles: scanned.textFiles,
    bytes: report.size,
    commands: Object.keys(packageJson.bin),
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}

#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";

const exec = promisify(execFile);
const { stdout } = await exec("npm", ["pack", "--dry-run", "--json"], {
  maxBuffer: 10 * 1024 * 1024,
});
const report = JSON.parse(stdout)[0];
const names = report.files.map((file) => file.path);
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
for (const command of ["codex-local-router", "llm-auto-gateway"])
  if (packageJson.bin?.[command] !== "scripts/gateway-admin.mjs")
    throw Error(`package is missing the ${command} executable`);
const denied = names.filter((name) =>
  /(^|\/)(artifacts|test|\.runtime|node_modules)(\/|$)/.test(name) ||
  /(^|\/)(auth\.json|history\.sqlite|gateway\.subscription\.local\.json)$/.test(name) ||
  /\.before-|\.bak$|(?:^|\/)rollout-[^/]*\.jsonl$/i.test(name),
);
if (denied.length) throw Error(`package contains denied paths:\n${denied.join("\n")}`);

const textFiles = names.filter((name) => /\.(?:mjs|js|json|md|toml|txt)$/.test(name));
const findings = [];
const patterns = [
  [/\/Users\/[A-Za-z0-9._-]+\//g, "absolute user path"],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, "private key"],
  [/\bBearer\s+[A-Za-z0-9._~+\/-]{24,}/g, "bearer token"],
  [/(?:sk|sess|ghp)_[A-Za-z0-9_-]{24,}/g, "credential-shaped token"],
];
for (const name of textFiles) {
  const body = await readFile(name, "utf8");
  for (const [pattern, label] of patterns)
    if (pattern.test(body)) findings.push(`${name}: ${label}`);
}
if (findings.length) throw Error(`package content audit failed:\n${findings.join("\n")}`);
console.log(JSON.stringify({ ok: true, package: report.filename, files: names.length, bytes: report.size, commands: Object.keys(packageJson.bin) }, null, 2));

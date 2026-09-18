#!/usr/bin/env node
import { execFile } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
const exactAllowed = new Set([
  "README.md",
  "README.zh-CN.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CHANGELOG.md",
  "package.json",
  "package-lock.json",
  ".github/workflows/release.yml",
  "scripts/release-scope.mjs",
  "scripts/export-public.mjs",
  "test/documentation.test.mjs",
  "test/release-scope.test.mjs",
]);

const allowedPath = (path) => exactAllowed.has(path)
  || path.startsWith("docs/public/")
  || path.startsWith(".github/ISSUE_TEMPLATE/");
const userDocumentation = (path) => path === "README.md"
  || path === "README.zh-CN.md"
  || path.startsWith("docs/public/");
const comparablePackage = (value) => {
  const copy = structuredClone(value);
  delete copy.version;
  return copy;
};
const comparableLock = (value) => {
  const copy = structuredClone(value);
  delete copy.version;
  if (copy.packages?.[""]) delete copy.packages[""].version;
  return copy;
};
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function classifyReleaseScope({ files, beforePackage, afterPackage, beforeLock, afterLock }) {
  const changedFiles = [...new Set(files)].sort();
  const reasons = [];
  const unknown = changedFiles.filter((path) => !allowedPath(path));
  if (unknown.length) reasons.push(`runtime or unknown paths changed: ${unknown.join(", ")}`);
  if (!changedFiles.some(userDocumentation)) reasons.push("no user documentation changed");
  if (changedFiles.includes("package.json") && !same(comparablePackage(beforePackage), comparablePackage(afterPackage)))
    reasons.push("package.json changed beyond the root version");
  if (changedFiles.includes("package-lock.json") && !same(comparableLock(beforeLock), comparableLock(afterLock)))
    reasons.push("package-lock.json changed beyond root version fields");
  return { docsOnly: reasons.length === 0, changedFiles, reasons };
}

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const git = async (...args) => (await exec("git", args, { maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
const gitJson = async (ref, path) => JSON.parse(await git("show", `${ref}:${path}`));

export async function classifyGitRange(base, head = "HEAD") {
  if (!base) throw Error("--base is required");
  await git("rev-parse", "--verify", `${base}^{commit}`);
  await git("rev-parse", "--verify", `${head}^{commit}`);
  const files = (await git("diff", "--name-only", "--diff-filter=ACMRTD", `${base}...${head}`))
    .split("\n")
    .filter(Boolean);
  return classifyReleaseScope({
    files,
    beforePackage: await gitJson(base, "package.json"),
    afterPackage: await gitJson(head, "package.json"),
    beforeLock: await gitJson(base, "package-lock.json"),
    afterLock: await gitJson(head, "package-lock.json"),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await classifyGitRange(argument("--base"), argument("--head") ?? "HEAD");
    if (process.env.GITHUB_OUTPUT)
      await appendFile(process.env.GITHUB_OUTPUT, `docs_only=${result.docsOnly}\n`);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

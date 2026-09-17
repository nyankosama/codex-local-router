import { execFile } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const SENSITIVE_PATTERNS = [
  [/\/Users\/[A-Za-z0-9._-]+\//g, "absolute user path"],
  [/@(?:alipay|antfin|antgroup)\.com/gi, "company email"],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, "private key"],
  [/\bBearer\s+[A-Za-z0-9._~+\/-]{24,}/g, "bearer token"],
  [/(?:sk|sess|ghp)_[A-Za-z0-9_-]{24,}/g, "credential-shaped token"],
];

export function deniedPublicPath(name) {
  const path = String(name).replaceAll("\\", "/").replace(/^\.\//, "");
  return (
    /(^|\/)(?:artifacts|\.runtime|node_modules)(\/|$)/.test(path) ||
    (path.startsWith("docs/e2e/") && path !== "docs/e2e/thresholds.json") ||
    /(^|\/)(?:auth\.json|history\.sqlite|gateway\.subscription\.local\.json)$/.test(path) ||
    /(^|\/)config\/.*(?:\.local\.json|\.before-)/.test(path) ||
    /\.before-|\.bak$|(?:^|\/)rollout-[^/]*\.jsonl$/i.test(path)
  );
}

export function safeRelativePath(root, path) {
  const absolute = resolve(root, path);
  const name = relative(root, absolute);
  if (!name || isAbsolute(name) || name === ".." || name.startsWith(`..${sep}`))
    throw Error(`public path escapes source root: ${path}`);
  return { absolute, name: name.replaceAll(sep, "/") };
}

export async function packageFiles(root) {
  const { stdout } = await exec(
    "npm",
    ["pack", "--dry-run", "--ignore-scripts", "--json"],
    { cwd: root, maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(stdout)[0].files.map((file) => file.path);
}

export async function filesUnder(root, entry) {
  const start = safeRelativePath(root, entry);
  const files = [];
  async function visit(path, name) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw Error(`public selection contains symbolic link: ${name}`);
    if (info.isDirectory()) {
      for (const child of await readdir(path))
        await visit(resolve(path, child), `${name}/${child}`);
      return;
    }
    if (!info.isFile()) throw Error(`public selection contains unsupported entry: ${name}`);
    files.push(name.replaceAll("\\", "/"));
  }
  await visit(start.absolute, start.name);
  return files;
}

export function assertAllowedFiles(files) {
  const rejected = files.filter(deniedPublicPath);
  if (rejected.length)
    throw Error(`public selection contains denied paths:\n${rejected.join("\n")}`);
}

export async function scanTextFiles(root, files, options = {}) {
  const skip = new Set(options.skip ?? []);
  const findings = [];
  let textFiles = 0;
  for (const name of files) {
    if (skip.has(name)) continue;
    const { absolute } = safeRelativePath(root, name);
    const data = await readFile(absolute);
    if (data.includes(0)) continue;
    const body = data.toString("utf8");
    textFiles++;
    for (const [pattern, label] of SENSITIVE_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(body)) findings.push(`${name}: ${label}`);
    }
  }
  if (findings.length)
    throw Error(`public content audit failed:\n${findings.join("\n")}`);
  return { files: files.length, textFiles };
}

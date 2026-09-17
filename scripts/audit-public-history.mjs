#!/usr/bin/env node
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { SENSITIVE_PATTERNS, deniedPublicPath } from "./public-boundary.mjs";

const exec = promisify(execFile);
const ref = process.argv[2] ?? "HEAD";
const { stdout } = await exec("git", ["rev-list", "--objects", ref], {
  maxBuffer: 32 * 1024 * 1024,
});
const objects = [];
for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
  const [id, ...parts] = line.split(" ");
  if (parts.length) objects.push([id, parts.join(" ")]);
}

const findings = [];
const batch = spawnSync("git", ["cat-file", "--batch"], {
  input: `${objects.map(([id]) => id).join("\n")}\n`,
  maxBuffer: 256 * 1024 * 1024,
});
if (batch.error || batch.status !== 0)
  throw batch.error ?? Error(batch.stderr.toString("utf8").trim() || "git cat-file failed");
let offset = 0;
for (const [id, path] of objects) {
  const headerEnd = batch.stdout.indexOf(10, offset);
  if (headerEnd < 0) throw Error("truncated git cat-file header");
  const [returnedId, type, sizeText] = batch.stdout.subarray(offset, headerEnd).toString("utf8").split(" ");
  const size = Number(sizeText), bodyStart = headerEnd + 1, bodyEnd = bodyStart + size;
  if (returnedId !== id || !Number.isFinite(size) || batch.stdout[bodyEnd] !== 10)
    throw Error("invalid git cat-file batch output");
  const body = batch.stdout.subarray(bodyStart, bodyEnd);
  offset = bodyEnd + 1;
  if (path === "scripts/public-boundary.mjs") continue;
  if (type !== "blob") continue;
  if (!Number.isFinite(size) || size > 5 * 1024 * 1024) continue;
  if (body.includes(0)) continue;
  const text = body.toString("utf8");
  if (deniedPublicPath(path)) findings.push({ path, category: "denied path" });
  for (const [pattern, category] of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) findings.push({ path, category });
  }
}

const unique = [...new Map(findings.map((item) => [`${item.path}\0${item.category}`, item])).values()];
console.log(JSON.stringify({
  ok: unique.length === 0,
  ref,
  note: "Findings identify historical paths and categories only; no content was emitted.",
  findings: unique,
}, null, 2));

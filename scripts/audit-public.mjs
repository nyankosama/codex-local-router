#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { publicEntries, sourceRoot } from "./export-public.mjs";

const patterns = [
  [/\/Users\/[A-Za-z0-9._-]+\//g, "absolute user path"],
  [/@(?:alipay|antfin|antgroup)\.com/gi, "company email"],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, "private key"],
  [/\bBearer\s+[A-Za-z0-9._~+\/-]{24,}/g, "bearer token"],
  [/(?:sk|sess|ghp)_[A-Za-z0-9_-]{24,}/g, "credential-shaped token"],
];

async function filesUnder(path) {
  const info = await readdir(path, { withFileTypes: true }).catch(() => null);
  if (!info) return [path];
  const files = [];
  for (const entry of info) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(child)));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

const { entries } = await publicEntries();
const files = (await Promise.all(entries.map((entry) => filesUnder(join(sourceRoot, entry)))))
  .flat()
  .filter((path, index, all) => all.indexOf(path) === index);
const findings = [];
let textFiles = 0;
for (const path of files) {
  const name = relative(sourceRoot, path);
  if (name === "scripts/audit-public.mjs") continue;
  const data = await readFile(path);
  if (data.includes(0)) continue;
  const body = data.toString("utf8");
  textFiles++;
  for (const [pattern, label] of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(body)) findings.push(`${name}: ${label}`);
  }
}
if (findings.length)
  throw Error(`public source audit failed:\n${findings.join("\n")}`);
console.log(JSON.stringify({ ok: true, files: files.length, textFiles }, null, 2));

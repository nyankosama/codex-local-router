import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { runtimePaths } from "../../../src/product.mjs";

const sourceRoot = resolve(import.meta.dirname, "..", "..", "..");

export function evidencePath(explicit, relativePath, options = {}) {
  const projectRoot = resolve(options.projectRoot ?? sourceRoot);
  const output = resolve(explicit ?? resolve(runtimePaths(options.env).evidence, relativePath));
  if (output === projectRoot || output.startsWith(`${projectRoot}${sep}`))
    throw Error("acceptance evidence must be written outside the source tree");
  return output;
}

export async function writeAcceptanceEvidence(filename, value, options = {}) {
  const index = process.argv.indexOf("--out");
  const explicit = index >= 0 ? process.argv[index + 1] : null;
  if (index >= 0 && !explicit) throw Error("--out requires a file path");
  const output = evidencePath(explicit, `legacy/${filename}`, options);
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return output;
}

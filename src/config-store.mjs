import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicJSON, withFileLock } from "./files.mjs";
import { dataDir } from "./product.mjs";
import { validate } from "./config.mjs";

export async function rawConfig(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function changes(before, after, prefix = "") {
  const result = [];
  const keys = new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ]);
  for (const key of [...keys].sort()) {
    const path = prefix ? `${prefix}.${key}` : key;
    const left = before?.[key], right = after?.[key];
    if (
      left && right &&
      typeof left === "object" && typeof right === "object" &&
      !Array.isArray(left) && !Array.isArray(right)
    ) result.push(...changes(left, right, path));
    else if (JSON.stringify(left) !== JSON.stringify(right))
      result.push({ path, before: left, after: right });
  }
  return result;
}

export function configDiff(before, after) {
  return changes(before, after);
}

export async function writeConfigTransaction(path, before, after, options = {}) {
  validate(after);
  const diff = configDiff(before, after);
  if (!diff.length) return { changed: false, diff, config: before };
  if (!options.apply) return { changed: true, applied: false, diff, config: after };
  const root = options.dataRoot ?? dataDir(options.env ?? process.env);
  const backups = join(root, "backups", "config");
  await mkdir(backups, { recursive: true, mode: 0o700 });
  return withFileLock(join(root, "config.lock"), async () => {
    const current = await rawConfig(path);
    if (JSON.stringify(current) !== JSON.stringify(before))
      throw Object.assign(Error("configuration changed after the preview"), {
        code: "config_conflict",
      });
    const backup = join(backups, `config-${Date.now()}.json`);
    await atomicJSON(backup, before);
    await atomicJSON(path, after);
    return { changed: true, applied: true, diff, backup, config: after };
  });
}

export async function createConfig(path, config, options = {}) {
  validate(config);
  if (!options.apply) return { changed: true, applied: false, diff: configDiff({}, config), config };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await atomicJSON(path, config);
  return { changed: true, applied: true, diff: configDiff({}, config), config };
}

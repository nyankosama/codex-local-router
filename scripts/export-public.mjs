#!/usr/bin/env node
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { assertAllowedFiles, filesUnder, packageFiles, safeRelativePath } from "./public-boundary.mjs";

export const sourceRoot = resolve(new URL("..", import.meta.url).pathname);

const repositoryEntries = [
  "test",
  ".github",
  "scripts/maintainer",
  "scripts/audit-package.mjs",
  "scripts/audit-public.mjs",
  "scripts/audit-public-history.mjs",
  "scripts/export-public.mjs",
  "scripts/public-boundary.mjs",
  "scripts/release-scope.mjs",
  "scripts/run-tests.mjs",
  "package-lock.json",
  "CONTRIBUTING.md",
  ".gitignore",
];

const exists = (path) => lstat(path).then(() => true, () => false);

export async function publicEntries(root = sourceRoot) {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const groups = await Promise.all(repositoryEntries.map((entry) => filesUnder(root, entry)));
  const entries = [...new Set([...(await packageFiles(root)), ...groups.flat()])].sort();
  assertAllowedFiles(entries);
  return { packageJson, entries };
}

export async function exportPublic(destinationArg, options = {}) {
  if (!destinationArg)
    throw Error("usage: node scripts/export-public.mjs /absolute/path/to/empty-destination");
  const root = resolve(options.root ?? sourceRoot);
  const destination = resolve(destinationArg);
  const home = resolve(options.home ?? homedir());
  if (
    destination === parse(destination).root ||
    destination === home ||
    destination === root ||
    destination.startsWith(`${root}${sep}`)
  ) throw Error("refusing unsafe public export destination");

  const destinationInfo = await lstat(destination).catch(() => null);
  if (destinationInfo?.isSymbolicLink())
    throw Error("refusing symbolic-link public export destination");
  if (destinationInfo) {
    if (await exists(join(destination, ".git")))
      throw Error("refusing public export destination containing .git");
    if ((await readdir(destination)).length)
      throw Error("public export destination must be empty");
  }

  const { packageJson, entries } = await publicEntries(root);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(dirname(destination), ".codex-local-router-export-"));
  try {
    for (const entry of entries) {
      const source = safeRelativePath(root, entry).absolute;
      const target = join(staging, entry);
      const info = await lstat(source);
      if (info.isSymbolicLink()) throw Error(`public selection contains symbolic link: ${entry}`);
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target, { errorOnExist: true, force: false, preserveTimestamps: true });
    }
    if (destinationInfo) await rm(destination, { recursive: true });
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return { ok: true, name: packageJson.name, version: packageJson.version, destination, files: entries };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await exportPublic(process.argv[2]), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

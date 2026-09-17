#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const scripts = new Set([
  "cache-affinity-rollback.mjs",
  "instruction-snapshot-rollback.mjs",
  "generic-template-rollback.mjs",
]);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

async function filesUnder(root) {
  const files = [];
  async function visit(path) {
    const name = relative(root, path).replaceAll(sep, "/");
    if (name === "node_modules/.bin" || name.startsWith("node_modules/.bin/")) return;
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw Error(`installed package contains symbolic link: ${name}`);
    if (info.isDirectory()) {
      for (const child of await readdir(path)) await visit(join(path, child));
    } else if (info.isFile()) files.push({ path, name });
    else throw Error(`installed package contains unsupported entry: ${name}`);
  }
  await visit(root);
  return files;
}

export async function verifyRecoveryBundle(output) {
  const root = resolve(output);
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  for (const entry of manifest.files) {
    const path = resolve(root, "package", entry.path);
    const local = relative(resolve(root, "package"), path);
    if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`))
      throw Error(`recovery manifest path escapes package: ${entry.path}`);
    const data = await readFile(path);
    if (data.length !== entry.bytes || sha256(data) !== entry.sha256)
      throw Error(`recovery bundle hash mismatch: ${entry.path}`);
  }
  const state = await readFile(manifest.rollbackState);
  if (sha256(state) !== manifest.rollbackStateSha256)
    throw Error("rollback state changed after recovery preparation");
  return manifest;
}

export async function prepareLegacyRecovery(input) {
  const installedRoot = await realpath(resolve(input.installedRoot));
  const output = resolve(input.output);
  const statePath = resolve(input.statePath);
  const script = `${input.rollbackScript.replace(/\.mjs$/, "")}.mjs`;
  if (!scripts.has(script)) throw Error("unsupported rollback script");
  if (output === installedRoot || output.startsWith(`${installedRoot}${sep}`))
    throw Error("recovery output must be outside the installed package");
  const destinationInfo = await lstat(output).catch(() => null);
  if (destinationInfo && (!destinationInfo.isDirectory() || (await readdir(output)).length))
    throw Error("recovery output must be an empty directory");
  const packageJson = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
  if (packageJson.name !== "codex-local-router") throw Error("installed root is not codex-local-router");
  await readFile(join(installedRoot, "scripts", script));
  const state = await readFile(statePath);
  JSON.parse(state);
  const sourceFiles = (await filesUnder(installedRoot)).filter(({ name }) =>
    name === "package.json" || ["src/", "scripts/", "node_modules/"].some((prefix) => name.startsWith(prefix)),
  );
  await mkdir(output, { recursive: true, mode: 0o700 });
  const packageRoot = join(output, "package");
  const files = [];
  for (const entry of sourceFiles) {
    const data = await readFile(entry.path);
    const destination = join(packageRoot, entry.name);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(entry.path, destination);
    files.push({ path: entry.name, bytes: data.length, sha256: sha256(data) });
  }
  const rollbackScript = join(output, "package", "scripts", script);
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    sourcePackage: installedRoot,
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    rollbackState: statePath,
    rollbackStateSha256: sha256(state),
    rollbackScript,
    rollbackCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(rollbackScript)} --state ${JSON.stringify(statePath)}`,
    files,
  };
  await writeFile(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await verifyRecoveryBundle(output);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const value = (name) => {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : null;
  };
  try {
    if (value("verify")) {
      const manifest = await verifyRecoveryBundle(value("verify"));
      console.log(JSON.stringify({ verified: true, files: manifest.files.length }, null, 2));
    } else {
      const required = ["installed-root", "state", "rollback-script", "out"];
      if (required.some((name) => !value(name)))
        throw Error(`use ${required.map((name) => `--${name} VALUE`).join(" ")}`);
      const manifest = await prepareLegacyRecovery({
        installedRoot: value("installed-root"),
        statePath: value("state"),
        rollbackScript: value("rollback-script"),
        output: value("out"),
      });
      console.log(JSON.stringify({
        prepared: true,
        files: manifest.files.length,
        rollbackCommand: manifest.rollbackCommand,
      }, null, 2));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

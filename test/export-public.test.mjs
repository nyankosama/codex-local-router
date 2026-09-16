import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, parse, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const present = (path) => access(path).then(() => true, () => false);
const sourceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryCheckout = await present(join(sourceRoot, "package-lock.json"));
const repositoryOnly = {
  skip: repositoryCheckout ? false : "repository-only public-export check",
};
const exporter = () => import("../scripts/export-public.mjs");

test("public manifest derives package files and excludes private evidence", repositoryOnly, async () => {
  const { publicEntries } = await exporter();
  const { entries } = await publicEntries();
  assert.ok(entries.includes("scripts/e2e"));
  assert.ok(entries.includes("docs/e2e/thresholds.json"));
  assert.ok(entries.includes("test"));
  assert.ok(!entries.some((entry) => entry === "artifacts" || entry.startsWith("artifacts/")));
  assert.ok(!entries.includes("docs/e2e/acceptance.md"));
});

test("public export refuses destructive destinations", repositoryOnly, async (t) => {
  const { exportPublic } = await exporter();
  const root = await mkdtemp(join(tmpdir(), "router-export-safety-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  await mkdir(join(repository, ".git"), { recursive: true });
  await assert.rejects(exportPublic(), /usage/);
  await assert.rejects(exportPublic(parse(sourceRoot).root), /unsafe/);
  await assert.rejects(exportPublic(homedir()), /unsafe/);
  await assert.rejects(exportPublic(sourceRoot), /unsafe/);
  await assert.rejects(exportPublic(repository), /containing \.git/);
  const symlinkTarget = join(root, "symlink-target");
  const symlinkPath = join(root, "symlink");
  await mkdir(symlinkTarget);
  await symlink(symlinkTarget, symlinkPath);
  await assert.rejects(exportPublic(symlinkPath), /symbolic-link/);
  const nonEmpty = join(root, "non-empty");
  await mkdir(nonEmpty);
  await writeFile(join(nonEmpty, "keep.txt"), "keep\n");
  await assert.rejects(exportPublic(nonEmpty), /must be empty/);
  assert.equal(await readFile(join(nonEmpty, "keep.txt"), "utf8"), "keep\n");
});

test("public export contains the installable source tree only", repositoryOnly, async (t) => {
  const { exportPublic } = await exporter();
  const root = await mkdtemp(join(tmpdir(), "router-export-success-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, "public");
  const result = await exportPublic(destination);
  assert.equal(result.ok, true);
  assert.equal(await present(join(destination, "scripts/e2e/run.mjs")), true);
  assert.equal(await present(join(destination, "docs/e2e/thresholds.json")), true);
  assert.equal(await present(join(destination, "docs/e2e/acceptance.md")), false);
  assert.equal(await present(join(destination, "artifacts")), false);
  assert.equal(await present(join(destination, ".git")), false);
  const manifest = JSON.parse(await readFile(join(destination, "package.json"), "utf8"));
  for (const entry of manifest.files)
    assert.equal(await present(join(destination, entry)), true, `missing package path ${entry}`);
});

import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const script = resolve(root, "scripts/release-scope.mjs");
const sourceOnly = { skip: await access(script).then(() => false, () => "source-only release classifier") };
const load = () => import("../scripts/release-scope.mjs");
const fixture = (files, mutate = () => {}) => {
  const beforePackage = { name: "codex-local-router", version: "0.5.6", dependencies: { ws: "8.21.3" } };
  const afterPackage = structuredClone(beforePackage);
  afterPackage.version = "0.5.7";
  const beforeLock = { name: "codex-local-router", version: "0.5.6", packages: { "": { version: "0.5.6", dependencies: { ws: "8.21.3" } } } };
  const afterLock = structuredClone(beforeLock);
  afterLock.version = "0.5.7";
  afterLock.packages[""].version = "0.5.7";
  mutate({ afterPackage, afterLock });
  return { files, beforePackage, afterPackage, beforeLock, afterLock };
};

test("release classifier accepts documentation plus version-only metadata", sourceOnly, async () => {
  const { classifyReleaseScope } = await load();
  const result = classifyReleaseScope(fixture([
    "README.md",
    "docs/public/providers.md",
    ".github/workflows/release.yml",
    "scripts/release-scope.mjs",
    "test/release-scope.test.mjs",
    "package.json",
    "package-lock.json",
  ]));
  assert.equal(result.docsOnly, true);
});

test("release classifier fails closed for runtime, dependency, workflow-only and unknown changes", sourceOnly, async () => {
  const { classifyReleaseScope } = await load();
  assert.equal(classifyReleaseScope(fixture(["README.md", "src/server.mjs"])).docsOnly, false);
  assert.equal(classifyReleaseScope(fixture(["README.md", "package.json"], ({ afterPackage }) => {
    afterPackage.dependencies.ws = "9.0.0";
  })).docsOnly, false);
  assert.equal(classifyReleaseScope(fixture([".github/workflows/release.yml"])).docsOnly, false);
  assert.equal(classifyReleaseScope(fixture(["README.md", "unknown.txt"])).docsOnly, false);
});

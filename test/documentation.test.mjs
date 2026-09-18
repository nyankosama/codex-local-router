import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const exists = (path) => access(path).then(() => true, () => false);
const repositoryOnly = { skip: await exists(join(root, "scripts/export-public.mjs")) ? false : "repository-only link check" };
const markdownFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(entries.map((entry) => entry.isDirectory()
    ? markdownFiles(join(directory, entry.name))
    : entry.name.endsWith(".md") ? [join(directory, entry.name)] : []));
  return groups.flat();
};
const currentDocs = await markdownFiles(join(root, "docs/public"));
const linkFiles = (await Promise.all([
  join(root, "README.md"),
  join(root, "README.zh-CN.md"),
  join(root, "CONTRIBUTING.md"),
  join(root, "SECURITY.md"),
  ...currentDocs,
].map(async (path) => await exists(path) ? path : null))).filter(Boolean);

test("relative Markdown links resolve", repositoryOnly, async () => {
  for (const file of linkFiles) {
    const body = await readFile(file, "utf8");
    for (const match of body.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].replace(/^<|>$/g, "").split("#", 1)[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      assert.equal(await exists(resolve(dirname(file), decodeURIComponent(target))), true, `${file}: missing ${target}`);
    }
  }
});

test("public documentation is bilingual and evidence is explicitly frozen", async () => {
  for (const file of currentDocs.filter((path) => !path.endsWith(".zh-CN.md"))) {
    const counterpart = file.replace(/\.md$/, ".zh-CN.md");
    assert.equal(await exists(counterpart), true, `missing ${counterpart}`);
  }
  for (const file of currentDocs.filter((path) => dirname(path).endsWith("/evidence") && !path.endsWith("/README.md") && !path.endsWith("/README.zh-CN.md"))) {
    const body = await readFile(file, "utf8");
    assert.match(body, /(?:Frozen evidence[\s\S]*Applies to:|冻结证据[\s\S]*适用范围：)/, `${file}: missing frozen evidence metadata`);
  }
});

test("user entry points contain no pinned tarball or private rollout instructions", async () => {
  const files = [join(root, "README.md"), join(root, "README.zh-CN.md"), join(root, "docs/public/README.md"), join(root, "docs/public/README.zh-CN.md")];
  for (const file of files) {
    const body = await readFile(file, "utf8");
    assert.doesNotMatch(body, /codex-local-router-\d+\.\d+\.\d+\.tgz/);
    assert.doesNotMatch(body, /scripts\/maintainer|artifacts\/|docs\/e2e|rollout\.mjs|release-live|codex-local-router-release/);
  }
});

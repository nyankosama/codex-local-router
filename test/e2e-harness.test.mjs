import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedCodexHome, runCliExec } from "../scripts/e2e/lib/harness.mjs";

test("A10 CLI harness places one-run search flags before the exec subcommand", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "router-cli-harness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const core = join(root, "codex-fixture");
  await writeFile(core, [
    "#!/usr/bin/env node",
    "console.log(JSON.stringify({ type: 'argv', argv: process.argv.slice(2) }));",
    "",
  ].join("\n"), { mode: 0o700 });
  await chmod(core, 0o700);

  const run = await runCliExec({
    corePath: core,
    home: join(root, "codex-home"),
    cwd: root,
    globalArgs: ["--search"],
    args: ["--ephemeral"],
    prompt: "fixture prompt",
    timeoutMs: 5000,
  });
  assert.equal(run.code, 0);
  assert.deepEqual(run.rows[0].argv, [
    "--search",
    "exec",
    "--json",
    "--ephemeral",
    "fixture prompt",
  ]);
});

test("A10 isolated official-search home can preserve the Codex default search mode", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "router-search-home-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const auth = join(root, "auth-source.json");
  const home = join(root, "codex-home");
  await writeFile(auth, "{}", { mode: 0o600 });
  await isolatedCodexHome({
    home,
    baseUrl: "http://127.0.0.1:32123/subscription/v1",
    catalogPath: join(root, "models.json"),
    authSource: auth,
    model: "gpt-fixture",
    webSearch: null,
  });
  assert.doesNotMatch(await readFile(join(home, "config.toml"), "utf8"), /^web_search\s*=/m);
});

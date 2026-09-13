import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validate } from "../src/config.mjs";
import { disableIntegration, integrationStatus, syncIntegration } from "../src/integration.mjs";

const gatewayConfig = (catalog) => validate({
  schemaVersion: 3,
  mode: "rules",
  defaultTarget: "deepseek",
  providers: { go: { baseUrl: "https://example.com", adapter: "opencode-go" } },
  targets: { deepseek: { provider: "go", preset: "opencode-go/deepseek-v4.1-flash" } },
  subscription: { enabled: true, models: ["gpt-5.5"], catalogPath: catalog },
});

test("integration sync is idempotent and disable preserves unrelated user edits", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "router-integration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, "codex"), data = join(root, "data");
  await mkdir(codexHome, { recursive: true });
  const configPath = join(codexHome, "config.toml");
  const source = join(codexHome, "models_cache.json");
  await writeFile(configPath, 'model = "gpt-5.5"\nservice_tier = "default"\n\n[projects."/before"]\ntrust_level = "trusted"\n');
  await writeFile(source, JSON.stringify({ models: [{ slug: "gpt-5.5", priority: 10, comp_hash: "official" }] }));
  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    CODEX_LOCAL_ROUTER_HOME: data,
    CODEX_APP_RUNNING: "0",
    CODEX_MODEL_CATALOG_SOURCE: source,
  };
  const config = gatewayConfig(source);
  const first = await syncIntegration(config, { env, codexHome, gatewayConfigPath: join(data, "config.json") });
  assert.equal(first.changed, true);
  assert.match(await readFile(configPath, "utf8"), /BEGIN codex-local-router managed settings/);
  const second = await syncIntegration(config, { env, codexHome });
  assert.equal(second.changed, false);
  await writeFile(configPath, (await readFile(configPath, "utf8")) + '\n[projects."/after"]\ntrust_level = "trusted"\n');
  const third = await syncIntegration(config, { env, codexHome });
  assert.equal(third.changed, false);
  await writeFile(
    configPath,
    (await readFile(configPath, "utf8")).replace(
      'model = "gpt-5.5"',
      'model = "deepseek-v4.1-flash"',
    ),
  );
  assert.equal(
    (await integrationStatus(config, { env, codexHome })).configCurrent,
    true,
  );
  const selected = await syncIntegration(config, { env, codexHome });
  assert.equal(selected.changed, true);
  assert.equal(selected.pending, false);
  assert.equal(selected.state.managed.model, "deepseek-v4.1-flash");
  const status = await integrationStatus(config, { env, codexHome });
  assert.equal(status.configCurrent, true);
  assert.equal(status.targets[0].contextWindow, 400000);
  await disableIntegration({ env, codexHome });
  const restored = await readFile(configPath, "utf8");
  assert.match(restored, /model = "gpt-5.5"/);
  assert.match(restored, /projects\."\/before"/);
  assert.match(restored, /projects\."\/after"/);
  assert.doesNotMatch(restored, /codex-local-router managed settings/);
  assert.deepEqual(await disableIntegration({ env, codexHome }), { changed: false, conflicts: [] });
});

test("running App produces a pending transaction without editing Codex config", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "router-integration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, "codex"), source = join(codexHome, "models_cache.json");
  await mkdir(codexHome, { recursive: true });
  const original = 'model = "gpt-5.5"\n';
  await writeFile(join(codexHome, "config.toml"), original);
  await writeFile(source, JSON.stringify({ models: [{ slug: "gpt-5.5", priority: 10 }] }));
  const env = { ...process.env, CODEX_HOME: codexHome, CODEX_LOCAL_ROUTER_HOME: join(root, "data"), CODEX_APP_RUNNING: "1", CODEX_MODEL_CATALOG_SOURCE: source };
  const result = await syncIntegration(gatewayConfig(source), { env, codexHome });
  assert.equal(result.pending, true);
  assert.equal(await readFile(join(codexHome, "config.toml"), "utf8"), original);
  assert.equal((await integrationStatus(gatewayConfig(source), { env, codexHome })).pending, true);
});

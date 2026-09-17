import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const exec = promisify(execFile);
const script = resolve("scripts/codex-app-upgrade.mjs");

test("legacy probe state migrates to idempotent product integration without blocking on old backups", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-app-upgrade-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "codex"), data = join(root, "data");
  await mkdir(home, { recursive: true });
  const configPath = join(home, "config.toml");
  const oldCatalog = join(home, "old-catalog.json");
  const gatewayPath = join(root, "gateway.json");
  const legacyState = join(home, ".llm-auto-gateway-app-probe.state");
  const config = [
    "# BEGIN llm-auto-gateway Codex App probe",
    'model_provider = "openai"',
    'model = "gpt-5.5"',
    'openai_base_url = "http://127.0.0.1:8788/subscription/v1"',
    `model_catalog_json = ${JSON.stringify(oldCatalog)}`,
    "# END llm-auto-gateway Codex App probe",
    "",
    '[projects."/unrelated/project"]',
    'trust_level = "trusted"',
    "",
  ].join("\n");
  const official = { slug: "gpt-5.5", display_name: "GPT 5.5", priority: 10, context_window: 272000, comp_hash: "official" };
  await writeFile(configPath, config);
  await writeFile(join(home, "models_cache.json"), JSON.stringify({ models: [official] }));
  await writeFile(oldCatalog, JSON.stringify({ models: [official, { slug: "deepseek-v4.1-flash", context_window: 131072, comp_hash: "old" }] }));
  const oldBackup = `${configPath}.llm-auto-gateway-app-probe.bak`;
  await writeFile(oldBackup, 'model = "gpt-5.5"\nservice_tier = "default"\n');
  await writeFile(legacyState, [
    "version=2",
    `config_path=${configPath}`,
    `backup_path=${oldBackup}`,
    `catalog_path=${oldCatalog}`,
    "config_hash=outdated",
    "base_url=http://127.0.0.1:8788/subscription/v1",
    "custom_model=deepseek-v4.1-flash",
    "",
  ].join("\n"));
  await writeFile(gatewayPath, JSON.stringify({
    schemaVersion: 3, mode: "fixed", defaultTarget: "deepseek", fixedTarget: "deepseek",
    providers: { go: { adapter: "opencode-go", baseUrl: "https://example.com" } },
    targets: { deepseek: { provider: "go", preset: "opencode-go/deepseek-v4.1-flash" } },
    subscription: { enabled: true, models: ["gpt-5.5"] },
  }));
  const environment = {
    ...process.env,
    CODEX_HOME: home,
    CODEX_LOCAL_ROUTER_HOME: data,
    CODEX_LOCAL_ROUTER_TEST_DRIVER_APP_STATE: "stopped",
    CODEX_MODEL_CATALOG_SOURCE: join(home, "models_cache.json"),
  };
  await exec(process.execPath, [
    "--import", resolve("test/support/process-stubs.mjs"), script, gatewayPath,
  ], { env: environment });
  const catalogPath = join(home, "model-catalogs", "codex-local-router.json");
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const deepseek = catalog.models.find((model) => model.slug === "deepseek-v4.1-flash");
  assert.equal(deepseek.context_window, 400000);
  assert.equal(deepseek.comp_hash, undefined);
  assert.deepEqual(deepseek.input_modalities, ["text", "image"]);
  assert.equal(deepseek.supported_reasoning_levels.at(-1).effort, "max");
  const upgradedConfig = await readFile(configPath, "utf8");
  assert.match(upgradedConfig, /BEGIN codex-local-router managed settings/);
  assert.match(upgradedConfig, /model = "gpt-5.5"/);
  assert.match(upgradedConfig, /projects\."\/unrelated\/project"/);
  const statePath = join(data, "integration", "codex.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.schemaVersion, 4);
  assert.equal(state.migratedFrom, legacyState);

  const second = JSON.parse((await exec(process.execPath, [script, gatewayPath], { env: environment })).stdout);
  assert.equal(second.changed, false);

  await writeFile(configPath, upgradedConfig.replace('model = "gpt-5.5"', 'model = "different-model"'));
  await assert.rejects(exec(process.execPath, [script, gatewayPath], { env: environment }), /managed settings changed/);
});

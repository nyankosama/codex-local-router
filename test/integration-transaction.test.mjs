import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validate } from "../src/config.mjs";
import {
  appIsRunning,
  disableIntegration,
  editCodexConfig,
  inspectCodexBaseline,
  integrationStatus,
  restoreCodexConfig,
  syncIntegration,
} from "../src/integration.mjs";

const gatewayConfig = (catalog) => validate({
  schemaVersion: 3,
  mode: "rules",
  defaultTarget: "deepseek",
  providers: { go: { baseUrl: "https://example.com", adapter: "opencode-go" } },
  targets: { deepseek: { provider: "go", preset: "opencode-go/deepseek-v4.1-flash" } },
  subscription: { enabled: true, models: ["gpt-5.5"], catalogPath: catalog },
});

test("production App detection ignores legacy test switches and fails closed when process inspection is unavailable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "router-app-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, "codex"), data = join(root, "data");
  await mkdir(codexHome, { recursive: true });
  const source = join(codexHome, "models_cache.json");
  await writeFile(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n');
  await writeFile(source, JSON.stringify({ models: [{ slug: "gpt-5.5" }] }));
  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    CODEX_LOCAL_ROUTER_HOME: data,
    CODEX_MODEL_CATALOG_SOURCE: source,
    CODEX_APP_RUNNING: "0",
    CODEX_LOCAL_ROUTER_TEST_LAUNCHCTL: "1",
  };
  const unavailable = async () => { throw Error("ps unavailable"); };
  assert.equal(await appIsRunning(env, { exec: unavailable }), null);
  const status = await integrationStatus(gatewayConfig(source), {
    env,
    codexHome,
    appRunning: async () => null,
  });
  assert.equal(status.appRunning, null);
  assert.equal(status.appRunningError, "app_state_unknown");
  await assert.rejects(
    syncIntegration(gatewayConfig(source), {
      env,
      codexHome,
      appRunning: async () => null,
    }),
    (error) => error.code === "app_state_unknown",
  );
});

test("managed multiline TOML assignments are removed and restored as complete values", () => {
  const multilineModel = 'model = """\\\ngpt-5.5"""';
  const source = `${multilineModel}\nmodel_provider = "openai"\n\n[mcp_servers.user]\ncommand = "safe"\n`;
  const managed = {
    model_provider: "openai",
    model: "custom-model",
    openai_base_url: "http://127.0.0.1:8788/subscription/v1",
    model_catalog_json: "/tmp/router-catalog.json",
  };
  const edited = editCodexConfig(source, managed);
  assert.equal(edited.baseline.model, multilineModel);
  assert.doesNotMatch(edited.text, /gpt-5\.5/);
  const restored = restoreCodexConfig(edited.text, {
    managed,
    baseline: edited.baseline,
  });
  assert.match(restored.text, /model = """\\\ngpt-5\.5"""/);
  assert.match(restored.text, /\[mcp_servers\.user\]\ncommand = "safe"/);
  assert.deepEqual(inspectCodexBaseline(restored.text).values, {
    model: "gpt-5.5",
    model_provider: "openai",
  });
});

test("quoted managed TOML keys and trailing comments are canonicalized safely", () => {
  const source = '"model" = "gpt-5.5" # selected\n\'model_provider\' = "\\U0000006fpenai" # official\n';
  const inspected = inspectCodexBaseline(source);
  assert.deepEqual(inspected.values, {
    model: "gpt-5.5",
    model_provider: "openai",
  });
  const managed = {
    model_provider: "openai",
    model: "custom-model",
    openai_base_url: "http://127.0.0.1:8788/subscription/v1",
    model_catalog_json: "/tmp/router-catalog.json",
  };
  const edited = editCodexConfig(source, managed);
  assert.doesNotMatch(edited.text, /"model"\s*=/);
  assert.doesNotMatch(edited.text, /'model_provider'\s*=/);
  const restored = restoreCodexConfig(edited.text, {
    managed,
    baseline: edited.baseline,
  });
  assert.deepEqual(inspectCodexBaseline(restored.text).values, inspected.values);
  assert.throws(
    () => inspectCodexBaseline('"model_provider" = "third-party"\n"openai_base_url" = "https://third-party.invalid/v1"\n'),
    (error) => error.code === "official_baseline_ambiguous",
  );
});

test("multiline arrays cannot hide following top-level managed keys", () => {
  const thirdParty = 'extra = [\n  ["a"],\n]\nmodel_provider = "custom"\nopenai_base_url = "https://example.invalid/v1"\n';
  assert.throws(
    () => inspectCodexBaseline(thirdParty),
    (error) => error.code === "official_baseline_ambiguous",
  );
  const official = thirdParty.replace(
    'model_provider = "custom"\nopenai_base_url = "https://example.invalid/v1"',
    'model_provider = "openai"',
  );
  const managed = {
    model_provider: "openai",
    model: "custom-model",
    openai_base_url: "http://127.0.0.1:8788/subscription/v1",
    model_catalog_json: "/tmp/router-catalog.json",
  };
  const edited = editCodexConfig(official, managed);
  assert.match(edited.text, /\["a"\],\n\]\n\n# BEGIN codex-local-router managed settings/);
  assert.doesNotMatch(edited.text, /model_provider = "openai"\n# BEGIN/);

  const quoteRun = 'custom = ["""ends with quote""""]\nmodel_provider = "custom"\n';
  assert.throws(
    () => inspectCodexBaseline(quoteRun),
    (error) => error.code === "official_baseline_ambiguous",
  );
  const quoteEdited = editCodexConfig(
    quoteRun.replace('model_provider = "custom"', 'model_provider = "openai"'),
    managed,
  );
  assert.ok(quoteEdited.text.indexOf("]") < quoteEdited.text.indexOf("# BEGIN"));
});

test("integration sync is idempotent and disable preserves unrelated user edits", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "router-integration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, "codex"), data = join(root, "data");
  await mkdir(codexHome, { recursive: true });
  const configPath = join(codexHome, "config.toml");
  const source = join(codexHome, "models_cache.json");
  const multiline = 'developer_instructions = """first\n\n\nmodel = "example"\n[example]\nsecond"""';
  await writeFile(configPath, `model = "gpt-5.5"\nservice_tier = "default"\n${multiline}\n\n[projects."/before"]\ntrust_level = "trusted"\n`);
  await writeFile(source, JSON.stringify({ models: [{ slug: "gpt-5.5", priority: 10, comp_hash: "official" }] }));
  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    CODEX_LOCAL_ROUTER_HOME: data,
    CODEX_MODEL_CATALOG_SOURCE: source,
  };
  const config = gatewayConfig(source);
  const stopped = async () => false;
  const first = await syncIntegration(config, { env, codexHome, appRunning: stopped, gatewayConfigPath: join(data, "config.json") });
  assert.equal(first.changed, true);
  assert.match(await readFile(configPath, "utf8"), /BEGIN codex-local-router managed settings/);
  assert.match(await readFile(configPath, "utf8"), new RegExp(multiline.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const second = await syncIntegration(config, { env, codexHome, appRunning: stopped });
  assert.equal(second.changed, false);
  await writeFile(configPath, (await readFile(configPath, "utf8")) + '\n[projects."/after"]\ntrust_level = "trusted"\n');
  const third = await syncIntegration(config, { env, codexHome, appRunning: stopped });
  assert.equal(third.changed, false);
  await writeFile(
    configPath,
    (await readFile(configPath, "utf8")).replace(
      'model = "gpt-5.5"',
      'model = "deepseek-v4.1-flash"',
    ),
  );
  assert.equal(
    (await integrationStatus(config, { env, codexHome, appRunning: stopped })).configCurrent,
    true,
  );
  const selected = await syncIntegration(config, { env, codexHome, appRunning: stopped });
  assert.equal(selected.changed, true);
  assert.equal(selected.pending, false);
  assert.equal(selected.state.managed.model, "deepseek-v4.1-flash");
  const status = await integrationStatus(config, { env, codexHome, appRunning: stopped });
  assert.equal(status.configCurrent, true);
  assert.equal(status.targets[0].contextWindow, 400000);
  await disableIntegration({ env, codexHome, appRunning: stopped });
  const restored = await readFile(configPath, "utf8");
  assert.match(restored, /model = "gpt-5.5"/);
  assert.match(restored, /projects\."\/before"/);
  assert.match(restored, /projects\."\/after"/);
  assert.match(restored, new RegExp(multiline.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(restored, /codex-local-router managed settings/);
  assert.deepEqual(await disableIntegration({ env, codexHome, appRunning: stopped }), { changed: false, conflicts: [] });
});

test("running App produces a pending transaction without editing Codex config", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "router-integration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, "codex"), source = join(codexHome, "models_cache.json");
  await mkdir(codexHome, { recursive: true });
  const original = 'model = "gpt-5.5"\n';
  await writeFile(join(codexHome, "config.toml"), original);
  await writeFile(source, JSON.stringify({ models: [{ slug: "gpt-5.5", priority: 10 }] }));
  const env = { ...process.env, CODEX_HOME: codexHome, CODEX_LOCAL_ROUTER_HOME: join(root, "data"), CODEX_MODEL_CATALOG_SOURCE: source };
  const running = async () => true;
  const result = await syncIntegration(gatewayConfig(source), { env, codexHome, appRunning: running });
  assert.equal(result.pending, true);
  assert.equal(await readFile(join(codexHome, "config.toml"), "utf8"), original);
  assert.equal((await integrationStatus(gatewayConfig(source), { env, codexHome, appRunning: running })).pending, true);
});

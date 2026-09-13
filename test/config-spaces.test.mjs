import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendSpaceRevision,
  composeRuntimeConfig,
  createSpace,
  detectSpaceDrift,
  diffSpaceRevisions,
  initializeSpaces,
  listConfigurationSpaces,
  parseSpaceRef,
  resolveSpace,
  spaceHistory,
} from "../src/config-spaces.mjs";

function runtimeConfig(catalogPath, concurrency = 4) {
  return {
    schemaVersion: 3,
    listen: { host: "127.0.0.1", port: 0 },
    access: { required: false },
    mode: "rules",
    defaultTarget: "custom",
    providers: {
      provider: {
        adapter: "openai-compatible",
        baseUrl: "https://example.com/v1",
        apiKeyEnv: "TEST_PROVIDER_KEY",
        concurrency,
      },
    },
    targets: {
      custom: {
        provider: "provider",
        model: "upstream-model",
        modelFamily: "other",
        wireApi: "responses",
        contextWindow: 100000,
        app: { enabled: true, modelId: "custom-model" },
      },
    },
    rules: [],
    pluginTools: { thirdPartyGpt: { additionalAllowedPlugins: [], excludedDefaultPlugins: [] } },
    history: { persistent: { enabled: false } },
    maxBodyBytes: 1024,
    maxConnections: 4,
    timeoutMs: 1000,
    subscription: { enabled: true, catalogPath, models: ["gpt-5.5"] },
  };
}

async function fixture(t, status = "disabled") {
  const root = await mkdtemp(join(tmpdir(), "router-spaces-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "codex"), data = join(root, "data");
  await mkdir(home, { recursive: true });
  const catalog = join(home, "models_cache.json");
  await writeFile(catalog, JSON.stringify({ models: [{ slug: "gpt-5.5" }] }));
  await writeFile(join(home, "config.toml"), 'model = "gpt-5.5"\nmodel_provider = "openai"\n\n[mcp_servers.user]\ncommand = "safe"\n');
  const config = runtimeConfig(catalog);
  const configPath = join(data, "config.json");
  await mkdir(data, { recursive: true });
  await writeFile(configPath, JSON.stringify(config));
  const env = {
    ...process.env,
    CODEX_HOME: home,
    CODEX_LOCAL_ROUTER_HOME: data,
    CODEX_LOCAL_ROUTER_CONFIG: configPath,
    CODEX_APP_RUNNING: "0",
  };
  const integrationState = {
    schemaVersion: 3,
    status,
    managed: {
      model_provider: "openai",
      model: "custom-model",
      openai_base_url: "http://127.0.0.1:8788/subscription/v1",
      model_catalog_json: join(home, "model-catalogs", "codex-local-router.json"),
    },
    baseline: {
      model: 'model = "gpt-5.5"',
      model_provider: 'model_provider = "openai"',
    },
  };
  return { root, home, data, catalog, config, configPath, env, integrationState };
}

test("configuration spaces initialize from disabled and applied legacy states", async (t) => {
  const disabled = await fixture(t, "disabled");
  const first = await initializeSpaces({
    env: disabled.env,
    config: disabled.config,
    configPath: disabled.configPath,
    codexHome: disabled.home,
    integrationState: disabled.integrationState,
  });
  assert.equal(first.changed, true);
  assert.deepEqual(first.index.active, { space: "official", revision: 1 });
  assert.equal((await resolveSpace("official", disabled.env)).kind, "official");
  assert.equal((await resolveSpace("default", disabled.env)).defaultCodexModel, "custom-model");
  assert.equal((await initializeSpaces({ env: disabled.env })).changed, false);

  const applied = await fixture(t, "applied");
  const second = await initializeSpaces({
    env: applied.env,
    config: applied.config,
    configPath: applied.configPath,
    codexHome: applied.home,
    integrationState: applied.integrationState,
  });
  assert.deepEqual(second.index.active, { space: "default", revision: 1 });
});

test("fresh initialization recognizes an official direct Codex configuration", async (t) => {
  const f = await fixture(t);
  const result = await initializeSpaces({
    env: f.env,
    config: f.config,
    configPath: f.configPath,
    codexHome: f.home,
    integrationState: null,
  });
  assert.deepEqual(result.index.active, { space: "official", revision: 1 });
  const official = await resolveSpace("official@1", f.env);
  assert.equal(official.defaultCodexModel, "gpt-5.5");
  assert.deepEqual(official.codexBaseline.values, {
    model: "gpt-5.5",
    model_provider: "openai",
  });
});

test("space revisions are immutable, cloneable, comparable and detect runtime drift", async (t) => {
  const f = await fixture(t);
  await initializeSpaces({ env: f.env, config: f.config, integrationState: f.integrationState });
  const clone = await createSpace("alternate", "default", { env: f.env });
  assert.equal(clone.revision.revision, 1);
  const changed = runtimeConfig(f.catalog, 2);
  const added = await appendSpaceRevision("alternate", {
    kind: "router",
    source: "provider-edit",
    config: changed,
    defaultCodexModel: "custom-model",
  }, { env: f.env });
  assert.equal(added.changed, true);
  assert.equal(added.revision.revision, 2);
  await assert.rejects(appendSpaceRevision("alternate", {
    kind: "router",
    source: "stale-provider-edit",
    config: runtimeConfig(f.catalog, 8),
    defaultCodexModel: "custom-model",
  }, { env: f.env, expectedLatestRevision: 1 }), (error) =>
    error.code === "space_operation_conflict");
  const repeated = await appendSpaceRevision("alternate", {
    kind: "router",
    source: "provider-edit",
    config: changed,
    defaultCodexModel: "custom-model",
  }, { env: f.env });
  assert.equal(repeated.changed, false);
  assert.equal((await spaceHistory("alternate", f.env)).length, 2);
  const before = await resolveSpace("alternate@1", f.env);
  const after = await resolveSpace("alternate@2", f.env);
  assert.deepEqual(diffSpaceRevisions(before, after), [{
    path: "config.providers.provider.concurrency",
    before: 4,
    after: 2,
  }]);
  assert.equal((await listConfigurationSpaces(f.env)).length, 3);

  const materialized = composeRuntimeConfig(f.config, await resolveSpace("default", f.env));
  await writeFile(f.configPath, JSON.stringify(materialized));
  const indexPath = join(f.data, "spaces", "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  index.active = { space: "default", revision: 1 };
  await writeFile(indexPath, JSON.stringify(index));
  assert.equal((await detectSpaceDrift({ env: f.env })).drift, false);
  materialized.providers.provider.concurrency = 9;
  await writeFile(f.configPath, JSON.stringify(materialized));
  assert.equal((await detectSpaceDrift({ env: f.env })).drift, true);
});

test("space names and revisions fail closed on invalid or tampered state", async (t) => {
  assert.deepEqual(parseSpaceRef("fee-gpt@3"), { space: "fee-gpt", revision: 3 });
  assert.throws(() => parseSpaceRef("Bad Space"), /space name/);
  const f = await fixture(t);
  await initializeSpaces({ env: f.env, config: f.config, integrationState: f.integrationState });
  const path = join(f.data, "spaces", "default", "1.json");
  const value = JSON.parse(await readFile(path, "utf8"));
  value.defaultCodexModel = "tampered";
  await writeFile(path, JSON.stringify(value));
  await assert.rejects(resolveSpace("default", f.env), /hash mismatch/);
});

test("initialization rejects pending and ambiguous official baselines", async (t) => {
  const pending = await fixture(t, "pending_app_quit");
  await assert.rejects(
    initializeSpaces({ env: pending.env, config: pending.config, integrationState: pending.integrationState }),
    /pending integration/,
  );
  const ambiguous = await fixture(t);
  await writeFile(join(ambiguous.home, "config.toml"), 'model_provider = "proxy"\n');
  await assert.rejects(
    initializeSpaces({ env: ambiguous.env, config: ambiguous.config, integrationState: null }),
    /not an unambiguous official direct configuration/,
  );
});

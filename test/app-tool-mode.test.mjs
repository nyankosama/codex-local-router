import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validate } from "../src/config.mjs";
import { buildModelCatalog } from "../src/model-catalog.mjs";
import { initializeSpaces, resolveSpace, readSpaceIndex, readSpaceTransaction,
  composeRuntimeConfig, detectSpaceDrift, diffSpaceRevisions } from "../src/config-spaces.mjs";

const fixture = () => ({
  schemaVersion: 3, defaultTarget: "sol",
  providers: { vendor: { baseUrl: "https://fixture.invalid/v1" } },
  targets: Object.fromEntries(["sol", "astra"].map((id) => [id, {
    provider: "vendor", model: `gpt-${id}`, modelFamily: "openai-gpt",
    wireApi: "responses", contextWindow: 100000,
    capabilities: { responses: true, toolCalling: true, freeformTools: true },
    app: { enabled: true, modelId: `vendor-${id}` },
  }])),
});
const source = { models: [{ slug: "gpt-official", tool_mode: "code_mode_only", base_instructions: "SYNTHETIC" }] };

test("code mode is explicit, validates its carrier, and only adds the requested catalog field", () => {
  const before = validate(fixture());
  assert.equal(before.targets.sol.app.toolMode, undefined);
  const baseline = buildModelCatalog(source, before);
  assert.equal(Object.hasOwn(baseline.models[1], "tool_mode"), false);
  for (const lite of [false, true]) {
    const input = fixture();
    input.targets.sol.app.useResponsesLite = lite;
    input.targets.sol.app.toolMode = "code_mode_only";
    const catalog = buildModelCatalog(source, validate(input));
    assert.deepEqual(catalog.models[0], source.models[0]);
    assert.equal(catalog.models[1].tool_mode, "code_mode_only");
    assert.equal(Object.hasOwn(catalog.models[2], "tool_mode"), false);
    delete input.targets.sol.app.toolMode;
    const { tool_mode, ...rest } = catalog.models[1];
    assert.deepEqual(rest, buildModelCatalog(source, validate(input)).models[1], "mode copied unrelated official metadata");
  }
  for (const mutate of [
    (t) => { t.app.toolMode = "auto"; },
    (t) => { t.app.toolMode = false; },
    (t) => { t.app.toolMode = {}; },
    (t) => { t.app.enabled = false; },
    (t) => { t.wireApi = "chat_completions"; t.capabilities.responses = false; },
    (t) => { t.capabilities.freeformTools = false; },
    (t) => { t.capabilities.toolCalling = false; },
  ]) {
    const input = fixture();
    input.targets.sol.app.toolMode = "code_mode_only";
    mutate(input.targets.sol);
    assert.throws(() => validate(input), /App (tool mode|code mode)/);
  }
});

test("CLI code mode is atomic, versioned, reversible and preserves both default model states", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tool-mode-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "codex"), router = join(root, "router");
  await mkdir(home); await mkdir(router);
  const catalogPath = join(home, "models_cache.json"), configPath = join(router, "config.json");
  await writeFile(catalogPath, JSON.stringify(source));
  await writeFile(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "synthetic", account_id: "synthetic-account" } }));
  await writeFile(join(home, "config.toml"), 'model_provider = "openai"\nmodel = "gpt-official"\ncli_auth_credentials_store = "file"\n');
  const initial = structuredClone(validate(fixture()));
  initial.subscription = { enabled: true, models: ["gpt-official"], catalogPath };
  await writeFile(configPath, JSON.stringify(initial));
  const env = { ...process.env, HOME: root, CODEX_HOME: home, CODEX_LOCAL_ROUTER_HOME: router,
    CODEX_LOCAL_ROUTER_CONFIG: configPath, CODEX_CLI_PATH: process.execPath,
    XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_CACHE_HOME: join(root, "xdg-cache"), XDG_DATA_HOME: join(root, "xdg-data"),
    CODEX_LOCAL_ROUTER_TEST_DRIVER_APP_STATE: "running", CODEX_LOCAL_ROUTER_TEST_DRIVER_LAUNCHCTL: "1" };
  await initializeSpaces({ env, config: initial, configPath, integrationState: {
    schemaVersion: 3, status: "disabled", baseline: { model: 'model = "gpt-official"', model_provider: 'model_provider = "openai"' },
  } });
  const cli = async (...args) => JSON.parse((await promisify(execFile)(process.execPath,
    [resolve("test/support/gateway-admin-test-driver.mjs"), ...args, "--space", "default", "--json"], { env })).stdout);
  const batch = ["model", "set-tool-mode", "--ids", "sol,astra", "--tool-mode", "code_mode_only"];
  assert.equal((await cli(...batch)).applied, false);
  for (const args of [
    ["--ids", "sol,missing", "--tool-mode", "code_mode_only"],
    ["--ids", "sol,sol", "--tool-mode", "code_mode_only"],
    ["--ids", "sol,", "--tool-mode", "code_mode_only"],
    ["--ids", "sol"], ["--tool-mode", "code_mode_only"],
    ["--ids", "sol", "--tool-mode", "auto"],
  ]) await assert.rejects(cli("model", "set-tool-mode", ...args, "--yes"));
  assert.equal((await readSpaceIndex(env)).spaces.default.latestRevision, 1);
  const changed = await cli(...batch, "--yes");
  assert.equal(changed.revision, 2); assert.equal(changed.switch, null);
  assert.equal((await cli(...batch, "--yes")).changed, false);
  const first = await resolveSpace("default@1", env), second = await resolveSpace("default@2", env);
  assert.equal(first.config.targets.sol.app.toolMode, undefined);
  assert.equal(second.config.targets.sol.app.toolMode, "code_mode_only");
  assert.equal(second.config.targets.astra.app.toolMode, "code_mode_only");
  assert.equal(first.defaultCodexModel, second.defaultCodexModel);
  assert.deepEqual(diffSpaceRevisions(first, second).map((entry) => entry.path).sort(),
    ["config.targets.astra.app.toolMode", "config.targets.sol.app.toolMode"]);
  assert.deepEqual(JSON.parse(await readFile(configPath)), initial, "dormant change touched runtime");
  const rows = await cli("model", "list");
  assert.equal(rows[0].appCapabilityProfile.toolMode, "code_mode_only");
  assert.equal((await cli("model", "probe", "--id", "astra")).appCapabilityProfile.toolMode, "code_mode_only");
  const cleared = await cli("model", "set-tool-mode", "--ids", "sol,astra", "--tool-mode", "default", "--yes");
  assert.equal(cleared.revision, 3);
  const third = await resolveSpace("default@3", env);
  assert.deepEqual(third.config, first.config);
  assert.deepEqual(composeRuntimeConfig(initial, first), composeRuntimeConfig(initial, third));

  for (const args of [
    ["model", "add", "--id", "new", "--provider", "vendor", "--upstream-model", "gpt-new", "--app-model", "vendor-new", "--model-family", "openai-gpt", "--context-window", "100000", "--freeform-tools"],
    ["model", "add", "--id", "new", "--provider", "vendor", "--preset", "feei/gpt-5.6-sol"],
    ["model", "edit", "--id", "sol"],
    ["model", "edit", "--id", "sol", "--preset", "feei/gpt-5.6-sol"],
  ]) {
    const preview = await cli(...args, "--tool-mode", "code_mode_only");
    assert.equal(preview.applied, false);
    assert.match(JSON.stringify(preview.diff), /code_mode_only/);
  }
  await assert.rejects(cli("model", "edit", "--id", "sol", "--tool-mode", "code_mode_only", "--no-app", "--yes"));
  await cli("model", "edit", "--id", "sol", "--tool-mode", "code_mode_only", "--yes");
  const noApp = await cli("model", "edit", "--id", "sol", "--no-app");
  assert.ok(noApp.diff.some((entry) => entry.path === "targets.sol.app.toolMode" && entry.after == null));
  await cli("model", "edit", "--id", "sol", "--tool-mode", "default", "--yes");

  // Active-space edits reuse the existing hash-protected pending transaction.
  const latest = await resolveSpace("default", env);
  await writeFile(configPath, JSON.stringify(composeRuntimeConfig(initial, latest)));
  const index = await readSpaceIndex(env);
  index.active = { space: "default", revision: latest.revision };
  await writeFile(join(router, "spaces", "index.json"), JSON.stringify(index));
  await writeFile(join(home, "config.toml"), 'model_provider = "openai"\nmodel = "vendor-astra"\ncli_auth_credentials_store = "file"\n');
  const drifted = composeRuntimeConfig(initial, latest);
  drifted.targets.sol.app.toolMode = "code_mode_only";
  await writeFile(configPath, JSON.stringify(drifted));
  assert.equal((await detectSpaceDrift({ env, configPath })).drift, true);
  await assert.rejects(cli(...batch, "--yes"));
  await writeFile(configPath, JSON.stringify(composeRuntimeConfig(initial, latest)));
  const activated = await cli(...batch, "--yes");
  assert.equal(activated.switch.pending, true);
  assert.equal((await readSpaceTransaction(env)).preservedCodexModel, "vendor-astra");
  assert.equal((await resolveSpace("default", env)).defaultCodexModel, "vendor-sol");
  assert.match(await readFile(join(home, "config.toml"), "utf8"), /model = "vendor-astra"/);
  assert.deepEqual((await readSpaceIndex(env)).active, index.active);
});

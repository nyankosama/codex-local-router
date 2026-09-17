import test from "node:test";
import assert from "node:assert/strict";
import { captureInstructions, validateInstructionSource, instructionStatus, instructionHash, redactInstructions } from "../src/instruction-source.mjs";
import { validate } from "../src/config.mjs";
import { buildModelCatalog } from "../src/model-catalog.mjs";
import { diffSpaceRevisions, composeRuntimeConfig } from "../src/config-spaces.mjs";
import { configDiff } from "../src/config-store.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializeSpaces, resolveSpace, readSpaceIndex, readSpaceTransaction } from "../src/config-spaces.mjs";

const target = () => ({ id: "sol", provider: "vendor", model: "gpt-source", modelFamily: "openai-gpt", wireApi: "responses", contextWindow: 100000,
  app: { enabled: true, modelId: "vendor-sol" } });
const source = () => ({ models: [{ slug: "gpt-source", base_instructions: "", model_messages: {
  instructions_template: "SYNTHETIC_TEMPLATE {{ personality }}", instructions_variables: { personality_pragmatic: "SYNTHETIC_PERSONALITY" },
  persistent_instructions: "SYNTHETIC_PERSISTENT", approvals: { never: "NOT_INHERITED" }, token_budget: "NOT_INHERITED",
}, supports_search_tool: true, use_responses_lite: true }] });
const config = (entry) => ({ schemaVersion: 3, defaultTarget: "sol", providers: { vendor: { baseUrl: "https://fixture.invalid/v1" } }, targets: { sol: entry } });
const capture = (entry = target(), catalog = source(), options = {}) => captureInstructions(entry, catalog, { clientVersion: "fixture-1", ...options });

test("instruction snapshots copy only allowed fields, preserve missing fields and exact alias mapping", () => {
  const original = source(), entry = capture(target(), original);
  assert.equal(entry.app.baseInstructions, "");
  assert.deepEqual(Object.keys(entry.app.modelMessages), ["instructions_template", "instructions_variables", "persistent_instructions"]);
  assert.equal(entry.app.instructionSource.sourceModel, "gpt-source");
  assert.equal(entry.app.useResponsesLite, undefined);
  assert.equal(entry.app.supportsSearchTool, undefined);
  validate(config(entry));
  const catalog = buildModelCatalog(original, validate(config(entry)));
  assert.deepEqual(catalog.models[0], original.models[0]);
  assert.deepEqual(catalog.models[1].model_messages, entry.app.modelMessages);
  const alias = capture({ ...target(), model: "vendor-alias" }, original, { sourceModel: "gpt-source" });
  assert.equal(alias.app.instructionSource.upstreamModel, "vendor-alias");
  delete original.models[0].base_instructions;
  delete original.models[0].model_messages.instructions_variables;
  const missing = capture(target(), original);
  const projected = buildModelCatalog(original, validate(config(missing))).models[1];
  assert.equal(Object.hasOwn(projected, "base_instructions"), false);
  assert.equal(Object.hasOwn(projected.model_messages, "instructions_variables"), false);
});

test("missing, ambiguous, empty or malformed source is explicit; automatic creation remains configurable", () => {
  for (const catalog of [null, { models: [] }, { models: [{ slug: "gpt-other", base_instructions: "wrong model" }] },
    { models: [{ slug: "gpt-source", base_instructions: " " }] },
    { models: [source().models[0], source().models[0]] },
    { models: [{ slug: "gpt-source", model_messages: { instructions_template: 42 } }] }]) {
    assert.throws(() => capture(target(), catalog), /instruction source/);
    const unresolved = capture(target(), catalog, { automatic: true });
    assert.equal(unresolved.app.instructionSource.status, "source-unresolved");
    validateInstructionSource(unresolved);
    assert.equal(unresolved.app.baseInstructions, undefined);
  }
});

test("legacy load and user instructions never silently inherit; other families require explicit capture", () => {
  assert.equal(validate(config(target())).targets.sol.app.instructionSource, undefined);
  const other = { ...target(), modelFamily: "other" };
  assert.deepEqual(capture(other, source(), { automatic: true }), other);
  assert.equal(capture(other).app.instructionSource.mode, "official-snapshot");
  for (const entry of [{ ...target(), wireApi: "chat_completions" },
    { ...target(), app: { enabled: false } }, { ...target(), provider: "chatgpt-subscription" }]) {
    assert.deepEqual(capture(entry, source(), { automatic: true }), entry);
    assert.throws(() => capture(entry), /target ineligible/);
  }
  for (const custom of [{ baseInstructions: "CUSTOM" }, { modelMessages: { instructions_template: "CUSTOM" } }]) {
    const entry = { ...target(), app: { ...target().app, ...custom } };
    assert.deepEqual(capture(entry, source(), { automatic: true }), entry);
    assert.throws(() => capture(entry), /custom conflict/);
    assert.deepEqual(capture(entry, source(), { sourceModel: "none" }).app, { ...entry.app, instructionSource: { mode: "none" } });
  }
});

test("unchanged sync is idempotent; source changes are diagnostic until explicitly synchronized", () => {
  const entry = capture(), catalog = source();
  catalog.models[0].priority = 999;
  assert.deepEqual(capture(entry, catalog, { now: "2030-01-01T00:00:00Z" }), entry);
  assert.equal(instructionStatus(entry, catalog).updateAvailable, false);
  catalog.models[0].model_messages.instructions_template += " UPDATED";
  assert.equal(instructionStatus(entry, catalog).updateAvailable, true);
  assert.deepEqual(buildModelCatalog(catalog, validate(config(entry))).models[1].model_messages, entry.app.modelMessages);
  const updated = capture(entry, catalog);
  assert.equal(updated.app.instructionSource.snapshotVersion, 2);
  assert.notEqual(updated.app.instructionSource.contentHash, entry.app.instructionSource.contentHash);
});

test("tampering, upstream model changes and extra inherited capabilities fail validation", () => {
  const entry = capture();
  for (const mutate of [
    (t) => { t.app.baseInstructions = "TAMPERED"; },
    (t) => { t.model = "other"; },
    (t) => { t.app.instructionSource.snapshotVersion = 0; },
    (t) => { t.app.instructionSource.capturedAt = "invalid"; },
    (t) => { t.app.modelMessages.approvals = "forbidden"; },
  ]) {
    const modified = structuredClone(entry); mutate(modified);
    assert.throws(() => validate(config(modified)), /instruction snapshot/);
  }
  const changedModel = { ...entry, model: "alias-v2" };
  assert.throws(() => capture(changedModel), /snapshot invalid/);
  assert.equal(capture(changedModel, source(), { sourceModel: "gpt-source" }).app.instructionSource.upstreamModel, "alias-v2");
  const custom = structuredClone(entry); delete custom.app.instructionSource;
  custom.app.baseInstructions = "CUSTOM";
  assert.doesNotThrow(() => validate(config(custom)));
  const disabled = capture(entry, source(), { sourceModel: "none" });
  assert.equal(disabled.app.baseInstructions, undefined);
  assert.equal(disabled.app.modelMessages, undefined);
  assert.deepEqual(capture(disabled, source(), { automatic: true }), disabled);
});

test("CLI summaries redact whole targets, nested message fields and leaf diffs", () => {
  const entry = capture();
  for (const value of [entry, { targets: { sol: entry } }, configDiff(config(target()), config(entry)),
    [{ path: "targets.sol.app.modelMessages.instructions_template", before: "PRIVATE", after: "SECRET" }],
    buildModelCatalog(source(), validate(config(entry)))]) {
    const summary = JSON.stringify(redactInstructions(value));
    assert.doesNotMatch(summary, /SYNTHETIC_TEMPLATE|SYNTHETIC_PERSISTENT|PRIVATE|SECRET/);
    assert.match(summary, /sha256/);
  }
  assert.equal(instructionHash({ b: 1, a: 2 }), instructionHash({ a: 2, b: 1 }));
});

test("space projection, diff and historical materialization pin instruction content", () => {
  const one = capture(), two = capture(one, { models: [{ slug: "gpt-source", base_instructions: "NEW_TEMPLATE" }] });
  const revision = (entry) => ({ kind: "router", config: config(entry), defaultCodexModel: "vendor-sol" });
  assert.ok(diffSpaceRevisions(revision(one), revision(two)).some((row) => row.path.includes("instruction")));
  assert.deepEqual(composeRuntimeConfig(config(two), revision(one)).targets.sol, one);
});

test("CLI batch sync previews safely, commits one dormant revision and retains exact historical snapshots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "instruction-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "codex"), router = join(root, "router");
  await mkdir(home); await mkdir(router);
  const catalogPath = join(home, "models_cache.json"), configPath = join(router, "config.json");
  await writeFile(catalogPath, JSON.stringify(source()));
  await writeFile(join(home, "auth.json"), JSON.stringify({
    tokens: { access_token: "synthetic", account_id: "synthetic-account" },
  }));
  await writeFile(join(home, "config.toml"), 'model_provider = "openai"\nmodel = "gpt-source"\ncli_auth_credentials_store = "file"\n');
  const initial = config(target());
  initial.targets.astra = { ...target(), id: "astra", app: { enabled: true, modelId: "vendor-astra" } };
  initial.subscription = { enabled: true, models: ["gpt-source"], catalogPath };
  await writeFile(configPath, JSON.stringify(initial));
  const env = { ...process.env, HOME: root, CODEX_HOME: home, CODEX_LOCAL_ROUTER_HOME: router,
    CODEX_LOCAL_ROUTER_CONFIG: configPath, CODEX_CLI_PATH: process.execPath,
    XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_CACHE_HOME: join(root, "xdg-cache"), XDG_DATA_HOME: join(root, "xdg-data"),
    CODEX_LOCAL_ROUTER_TEST_DRIVER_APP_STATE: "running", CODEX_LOCAL_ROUTER_TEST_DRIVER_LAUNCHCTL: "1" };
  await initializeSpaces({ env, config: initial, configPath, integrationState: {
    schemaVersion: 3, status: "disabled", baseline: { model: 'model = "gpt-source"', model_provider: 'model_provider = "openai"' },
  } });
  const cli = async (...args) => {
    const result = await promisify(execFile)(process.execPath, [resolve("test/support/gateway-admin-test-driver.mjs"), ...args, "--json"], { env });
    assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_TEMPLATE|SYNTHETIC_PERSISTENT/);
    return JSON.parse(result.stdout);
  };
  const args = ["model", "sync-instructions", "--ids", "sol,astra", "--space", "default"];
  const preview = await cli(...args);
  assert.equal(preview.applied, false);
  assert.equal((await readSpaceIndex(env)).spaces.default.latestRevision, 1);
  await assert.rejects(cli("model", "sync-instructions", "--ids", "sol,missing", "--space", "default", "--yes"));
  assert.equal((await readSpaceIndex(env)).spaces.default.latestRevision, 1);
  const applied = await cli(...args, "--yes");
  assert.equal(applied.revision, 2); assert.equal(applied.switch, null);
  const second = await resolveSpace("default@2", env);
  assert.ok(second.config.targets.sol.app.instructionSource.contentHash);
  assert.ok(second.config.targets.astra.app.instructionSource.contentHash);
  assert.equal((await cli(...args, "--yes")).changed, false);
  assert.equal((await readSpaceIndex(env)).spaces.default.latestRevision, 2);
  assert.deepEqual(JSON.parse(await readFile(configPath)), initial, "dormant edit changed runtime config");
  const first = await resolveSpace("default@1", env);
  assert.equal(first.config.targets.sol.app.instructionSource, undefined);
  assert.equal(first.defaultCodexModel, second.defaultCodexModel);
  const rows = await cli("model", "list", "--space", "default");
  assert.equal(rows.find((row) => row.id === "sol").instructions.status, "pinned");
  assert.equal((await cli("model", "probe", "--id", "sol", "--space", "default")).instructions.updateAvailable, false);
  await cli("space", "show", "default@2");
  await cli("space", "diff", "default@1", "default@2");
  const autoPreview = await cli("model", "add", "--id", "new-model", "--provider", "vendor", "--upstream-model", "gpt-source", "--app-model", "new-alias", "--model-family", "openai-gpt", "--context-window", "100000", "--template", "legacy", "--space", "default");
  assert.equal(autoPreview.applied, false);
  assert.ok(autoPreview.diff.some((row) => row.path === "targets.new-model" && row.after.app.instructionSource.status === "pinned"));
  const aliasPreview = await cli("model", "add", "--id", "new-model", "--provider", "vendor", "--upstream-model", "vendor-alias", "--instructions-from", "gpt-source", "--app-model", "new-alias", "--model-family", "openai-gpt", "--context-window", "100000", "--template", "legacy", "--space", "default");
  assert.ok(aliasPreview.diff.some((row) => row.path === "targets.new-model" && row.after.app.instructionSource.sourceModel === "gpt-source"));
  const disabled = await cli("model", "edit", "--id", "sol", "--space", "default", "--instructions-from", "none", "--yes");
  assert.equal(disabled.revision, 3);
  assert.equal((await resolveSpace("default@3", env)).config.targets.sol.app.baseInstructions, undefined);
  const changedSource = source();
  changedSource.models[0].model_messages.instructions_template += " changed";
  await writeFile(catalogPath, JSON.stringify(changedSource));
  const latest = await resolveSpace("default@3", env);
  const runtime = composeRuntimeConfig(initial, latest);
  await writeFile(configPath, JSON.stringify(runtime));
  const index = await readSpaceIndex(env);
  index.active = { space: "default", revision: 3 };
  await writeFile(join(router, "spaces", "index.json"), JSON.stringify(index));
  // The active App selection and versioned space default must not be silently unified.
  await writeFile(join(home, "config.toml"), 'model_provider = "openai"\nmodel = "vendor-astra"\ncli_auth_credentials_store = "file"\n');
  const preserved = await cli(...args, "--yes");
  assert.equal(preserved.revision, 4);
  assert.equal(preserved.switch.pending, true);
  assert.equal((await readSpaceTransaction(env)).preservedCodexModel, "vendor-astra");
  assert.equal((await resolveSpace("default@4", env)).defaultCodexModel, "vendor-sol");
  assert.match(await readFile(join(home, "config.toml"), "utf8"), /model = "vendor-astra"/);
});

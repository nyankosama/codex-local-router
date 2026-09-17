import test from "node:test";
import assert from "node:assert/strict";
import { captureMultiAgent, validateMultiAgentSource, catalogMultiAgent, multiAgentStatus } from "../src/multi-agent-source.mjs";
import { validate } from "../src/config.mjs";
import { buildModelCatalog } from "../src/model-catalog.mjs";
import { classifyTool } from "../src/tool-policy.mjs";
import { discoverToolSources } from "../src/tool-sources.mjs";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { initializeSpaces, resolveSpace, readSpaceIndex, composeRuntimeConfig, readSpaceTransaction, detectSpaceDrift } from "../src/config-spaces.mjs";

const target = () => ({ provider: "vendor", model: "gpt-sol", modelFamily: "openai-gpt", wireApi: "responses",
  contextWindow: 100000, capabilities: { responses: true, toolCalling: true }, app: { enabled: true, modelId: "vendor-sol" } });
const source = { models: [{ slug: "gpt-sol", multi_agent_version: "v2", include_plugin_usage_instructions: true },
  { slug: "gpt-astra", multi_agent_version: "v2", multi_agent_reasoning_effort: "xhigh" }] };
const options = { clientVersion: "synthetic-client" };

test("multi-agent snapshots are explicit, narrow, immutable and content-idempotent", () => {
  const original = target(), captured = captureMultiAgent(original, source, options);
  assert.equal(original.app.multiAgent, undefined);
  assert.deepEqual(catalogMultiAgent(original), {});
  assert.deepEqual(catalogMultiAgent(captured), { multi_agent_version: "v2" });
  assert.deepEqual(captureMultiAgent(captured, { ...source, unrelated: true }, options), captured);
  const astra = captureMultiAgent(captured, source, { ...options, sourceModel: "gpt-astra" });
  assert.equal(astra.app.multiAgent.snapshotVersion, 2);
  assert.deepEqual(catalogMultiAgent(astra), { multi_agent_version: "v2", multi_agent_reasoning_effort: "xhigh" });
  assert.deepEqual(captureMultiAgent(astra, null, { sourceModel: "none" }), original);
  const config = validate({ schemaVersion: 3, defaultTarget: "sol", providers: { vendor: { baseUrl: "https://fixture.invalid/v1" } }, targets: { sol: captured } });
  const catalog = buildModelCatalog(source, config);
  assert.deepEqual(catalog.models.slice(0, 2), source.models);
  assert.equal(catalog.models[2].multi_agent_version, "v2");
  assert.equal(catalog.models[2].include_plugin_usage_instructions, undefined);
  const changed = structuredClone(source); changed.models[0].multi_agent_version = "v1";
  assert.equal(multiAgentStatus(captured, changed).updateAvailable, true);
  assert.equal(catalogMultiAgent(captured).multi_agent_version, "v2");
});

test("multi-agent rejects invalid sources, target changes and snapshot tampering", () => {
  for (const catalog of [null, { models: [] }, { models: [{ slug: "gpt-sol" }] },
    { models: [source.models[0], source.models[0]] },
    { models: [{ slug: "gpt-sol", multi_agent_version: "v3" }] },
    { models: [{ slug: "gpt-sol", multi_agent_version: "v2", multi_agent_reasoning_effort: null }] }])
    assert.throws(() => captureMultiAgent(target(), catalog, options));
  for (const mutate of [
    (t) => { t.provider = "chatgpt-subscription"; },
    (t) => { t.app.enabled = false; }, (t) => { t.wireApi = "chat_completions"; },
    (t) => { t.capabilities.toolCalling = false; },
  ]) { const t = target(); mutate(t); assert.throws(() => captureMultiAgent(t, source, options)); }
  const other = target(); other.modelFamily = "other";
  assert.equal(captureMultiAgent(other, source, options).app.multiAgent.mode, "official-snapshot");
  const captured = captureMultiAgent(target(), source, options);
  for (const mutate of [
    (t) => { t.model = "changed"; }, (t) => { t.app.multiAgent.contentHash = "0".repeat(64); },
    (t) => { t.app.multiAgent.capabilities.multi_agent_version = "v1"; },
    (t) => { t.app.multiAgent.capabilities.arbitrary = true; },
    (t) => { t.app.multiAgent.extra = true; }, (t) => { t.app.multiAgent = null; },
  ]) { const t = structuredClone(captured); mutate(t); assert.throws(() => validateMultiAgentSource(t)); }
  const aliased = target(); aliased.app.instructionSource = { status: "pinned", upstreamModel: aliased.model, sourceModel: "gpt-astra" };
  assert.equal(captureMultiAgent(aliased, source, options).app.multiAgent.sourceModel, "gpt-astra");
});

test("client collaboration namespace is core without widening arbitrary functions", async () => {
  const registry = await discoverToolSources();
  assert.equal(classifyTool({ type: "namespace", name: "collaboration", tools: [] }, registry).kind, "core");
  assert.equal(classifyTool({ type: "function", name: "spawn_agent" }, registry).kind, "unknown");
  registry.userMcpServers.add("collaboration");
  assert.equal(classifyTool({ type: "namespace", name: "collaboration", tools: [] }, registry).kind, "collision");
});

test("CLI multi-agent batch is atomic, idempotent, versioned and reversible", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "multi-agent-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "codex"), router = join(root, "router");
  await mkdir(home); await mkdir(router);
  const catalogPath = join(home, "models_cache.json"), configPath = join(router, "config.json");
  await writeFile(catalogPath, JSON.stringify(source));
  await writeFile(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "synthetic", account_id: "synthetic-account" } }));
  await writeFile(join(home, "config.toml"), 'model_provider = "openai"\nmodel = "gpt-sol"\ncli_auth_credentials_store = "file"\n');
  const config = validate({ schemaVersion: 3, defaultTarget: "sol", providers: { vendor: { baseUrl: "https://fixture.invalid/v1" } },
    targets: { sol: target(), astra: { ...target(), model: "gpt-astra", app: { enabled: true, modelId: "vendor-astra" } } },
    subscription: { enabled: true, models: ["gpt-sol"], catalogPath } });
  await writeFile(configPath, JSON.stringify(config));
  const env = { ...process.env, HOME: root, CODEX_HOME: home, CODEX_LOCAL_ROUTER_HOME: router,
    CODEX_LOCAL_ROUTER_CONFIG: configPath, CODEX_CLI_PATH: process.execPath,
    CODEX_LOCAL_ROUTER_TEST_DRIVER_APP_STATE: "running", CODEX_LOCAL_ROUTER_TEST_DRIVER_LAUNCHCTL: "1" };
  await initializeSpaces({ env, config, configPath, integrationState: { schemaVersion: 3, status: "disabled",
    baseline: { model: 'model = "gpt-sol"', model_provider: 'model_provider = "openai"' } } });
  const cli = async (...args) => JSON.parse((await promisify(execFile)(process.execPath,
    [resolve("test/support/gateway-admin-test-driver.mjs"), ...args, "--space", "default", "--json"], { env })).stdout);
  const batch = ["model", "sync-multi-agent", "--ids", "sol,astra"];
  assert.equal((await cli(...batch)).applied, false);
  for (const ids of ["sol,missing", "sol,sol", "sol,"])
    await assert.rejects(cli("model", "sync-multi-agent", "--ids", ids, "--yes"));
  assert.equal((await readSpaceIndex(env)).spaces.default.latestRevision, 1);
  assert.equal((await cli(...batch, "--yes")).revision, 2);
  assert.equal((await cli(...batch, "--yes")).changed, false);
  const second = await resolveSpace("default@2", env);
  assert.deepEqual(catalogMultiAgent(second.config.targets.astra), { multi_agent_version: "v2", multi_agent_reasoning_effort: "xhigh" });
  assert.equal((await cli("model", "probe", "--id", "sol")).multiAgent.capabilities.multi_agent_version, "v2");
  assert.equal((await cli("model", "list"))[1].multiAgent.sourceModel, "gpt-astra");
  assert.equal((await cli("model", "edit", "--id", "sol", "--multi-agent-from", "none")).applied, false);
  await cli(...batch, "--multi-agent-from", "none", "--yes");
  assert.deepEqual((await resolveSpace("default", env)).config, (await resolveSpace("default@1", env)).config);
  assert.deepEqual(JSON.parse(await readFile(configPath)), config);
  assert.equal(second.defaultCodexModel, (await resolveSpace("default@1", env)).defaultCodexModel);
  const latest = await resolveSpace("default", env);
  const runtime = composeRuntimeConfig(config, latest);
  await writeFile(configPath, JSON.stringify(runtime));
  const index = await readSpaceIndex(env);
  index.active = { space: "default", revision: latest.revision };
  await writeFile(join(router, "spaces/index.json"), JSON.stringify(index));
  await writeFile(join(home, "config.toml"), 'model_provider = "openai"\nmodel = "vendor-astra"\ncli_auth_credentials_store = "file"\n');
  const drift = structuredClone(runtime);
  drift.targets.sol.app.multiAgent = captureMultiAgent(drift.targets.sol, source, options).app.multiAgent;
  await writeFile(configPath, JSON.stringify(drift));
  assert.equal((await detectSpaceDrift({ env, configPath })).drift, true);
  await assert.rejects(cli(...batch, "--yes"));
  await writeFile(configPath, JSON.stringify(runtime));
  const pending = await cli(...batch, "--yes");
  assert.equal(pending.switch.pending, true);
  assert.equal((await readSpaceTransaction(env)).preservedCodexModel, "vendor-astra");
  assert.deepEqual((await readSpaceIndex(env)).active, index.active);
  assert.equal((await resolveSpace("default", env)).defaultCodexModel, latest.defaultCodexModel);
});

test("multi-agent catalog projection is bounded and under the local latency guardrail", (t) => {
  const captured = captureMultiAgent(target(), source, options), times = [];
  for (let i = 0; i < 1000; i++) {
    const start = performance.now(); catalogMultiAgent(captured); times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[949] < 25, `projection p95 ${times[949]}ms`);
  t.diagnostic(`projection p95 ${times[949].toFixed(4)}ms`);
});

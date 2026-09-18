import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validate } from "../src/config.mjs";
import { buildModelCatalog } from "../src/model-catalog.mjs";
import { applyManagedInstructions, catalogInstructions } from "../src/instruction-source.mjs";
import { catalogMultiAgent, configureMultiAgent } from "../src/multi-agent-source.mjs";
import { applyThirdPartyTemplate, GENERIC_INSTRUCTIONS, thirdPartyTemplateStatus } from "../src/third-party-template.mjs";
import { resolvePluginToolPolicy } from "../src/tool-policy.mjs";
import { resolvePromptCacheAffinity } from "../src/prompt-cache-affinity.mjs";
import { initializeSpaces, resolveSpace } from "../src/config-spaces.mjs";

const deepseek = () => ({
  id: "deepseek",
  provider: "vendor",
  model: "deepseek-v4.1-flash",
  modelFamily: "other",
  wireApi: "responses",
  contextWindow: 400000,
  maxContextWindow: 400000,
  effectiveContextWindowPercent: 95,
  inputModalities: ["text", "image"],
  compression: { mode: "summary" },
  capabilities: { responses: true, streaming: true, toolCalling: true, freeformTools: true },
  app: { enabled: true, modelId: "fixture-deepseek", reasoningLevels: ["low", "medium", "high", "xhigh", "max"] },
});
const source = { models: [{ slug: "gpt-fixture", base_instructions: "OFFICIAL_FIXTURE" }] };
const config = (target = deepseek()) => ({
  schemaVersion: 3,
  defaultTarget: "deepseek",
  providers: { vendor: { baseUrl: "https://fixture.invalid/v1" } },
  targets: { deepseek: target },
});

test("codex-general-v1 materializes one generic instruction, code mode, v2 agents and the standard plugin policy", () => {
  const original = deepseek();
  const applied = applyThirdPartyTemplate(original, "codex-general-v1");
  assert.equal(original.app.toolMode, undefined);
  assert.equal(applied.app.toolMode, "code_mode_only");
  assert.equal(applied.app.capabilityProfile, "standard-tools");
  assert.equal(applied.app.useResponsesLite, false);
  assert.equal(applied.standaloneSearch.source, "disabled");
  assert.equal(applied.app.instructionSource.mode, "builtin-template");
  assert.equal(applied.app.baseInstructions, GENERIC_INSTRUCTIONS);
  assert.deepEqual(catalogMultiAgent(applied), { multi_agent_version: "v2" });
  const checked = validate({ ...config(applied), thirdPartyDefaults: { template: "codex-general-v1" } });
  assert.equal(resolvePluginToolPolicy(checked, checked.targets.deepseek).mode, "allowlist");
  const catalog = buildModelCatalog(source, checked).models.at(-1);
  assert.equal(catalog.base_instructions, GENERIC_INSTRUCTIONS);
  assert.equal(catalog.tool_mode, "code_mode_only");
  assert.equal(catalog.multi_agent_version, "v2");
  assert.equal(catalog.use_responses_lite, false);
});

test("legacy is a no-op and incompatible generic targets fail closed", () => {
  const target = deepseek();
  assert.deepEqual(applyThirdPartyTemplate(target, "legacy"), target);
  const materialized = applyThirdPartyTemplate(target, "codex-general-v1");
  const unmanaged = applyThirdPartyTemplate(materialized, "legacy");
  assert.equal(unmanaged.app.thirdPartyTemplate, undefined);
  assert.equal(unmanaged.app.toolMode, "code_mode_only");
  assert.equal(unmanaged.app.multiAgent.capabilities.multi_agent_version, "v2");
  for (const mutate of [
    (entry) => { entry.wireApi = "chat_completions"; },
    (entry) => { entry.app.enabled = false; },
    (entry) => { entry.capabilities.freeformTools = false; },
    (entry) => { entry.provider = "chatgpt-subscription"; },
  ]) {
    const entry = deepseek(); mutate(entry);
    assert.throws(() => applyThirdPartyTemplate(entry, "codex-general-v1"), /requires/);
  }

  const go = deepseek();
  go.preset = "opencode-go/deepseek-v4.1-flash";
  assert.deepEqual(applyThirdPartyTemplate(go, "legacy"), go);
  assert.deepEqual(thirdPartyTemplateStatus(go), {
    template: "legacy",
    version: null,
    status: "restricted",
    reason: "preset-compatibility-guard",
  });
  assert.throws(
    () => applyThirdPartyTemplate(go, "codex-general-v1"),
    (error) => error.code === "third_party_template_provider_unqualified",
  );
});

test("legacy-only presets reject direct Code mode and multi-agent configuration", () => {
  const codeMode = deepseek();
  codeMode.preset = "opencode-go/deepseek-v4.1-flash";
  codeMode.app.toolMode = "code_mode_only";
  assert.throws(() => validate(config(codeMode)), /code mode is not qualified/);

  const multiAgent = configureMultiAgent(deepseek(), "v2");
  multiAgent.preset = "opencode-go/deepseek-v4.1-flash";
  assert.throws(() => validate(config(multiAgent)), /multi-agent is not qualified/);
});

test("managed instruction sources are exclusive and generic non-GPT targets may opt into cache affinity", () => {
  const generic = applyThirdPartyTemplate(deepseek(), "codex-general-v1");
  assert.throws(() => applyManagedInstructions(generic, { mode: "custom", text: "CUSTOM" }), /conflict/);
  const custom = applyManagedInstructions(deepseek(), { mode: "custom", text: "CUSTOM" });
  assert.equal(catalogInstructions(custom).base_instructions, "CUSTOM");
  const configured = config(generic);
  configured.providers.vendor.promptCaching = { affinity: "gateway-opaque" };
  assert.equal(resolvePromptCacheAffinity(configured, generic).mode, "gateway-opaque");
  assert.equal(resolvePromptCacheAffinity(configured, deepseek()).reason, "non-gpt-unchanged");
});

test("CLI applies templates atomically and space defaults affect only later creation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "third-party-template-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "codex"), router = join(root, "router");
  await mkdir(home); await mkdir(router);
  const catalogPath = join(home, "models_cache.json"), configPath = join(router, "config.json");
  await writeFile(catalogPath, JSON.stringify(source));
  await writeFile(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "synthetic", account_id: "synthetic" } }));
  await writeFile(join(home, "config.toml"), 'model_provider = "openai"\nmodel = "gpt-fixture"\ncli_auth_credentials_store = "file"\n');
  const initial = validate({ ...config(), subscription: { enabled: true, models: ["gpt-fixture"], catalogPath } });
  await writeFile(configPath, JSON.stringify(initial));
  const env = { ...process.env, HOME: root, CODEX_HOME: home, CODEX_LOCAL_ROUTER_HOME: router,
    CODEX_LOCAL_ROUTER_CONFIG: configPath, CODEX_CLI_PATH: process.execPath,
    XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_CACHE_HOME: join(root, "xdg-cache"), XDG_DATA_HOME: join(root, "xdg-data"),
    CODEX_LOCAL_ROUTER_TEST_DRIVER_APP_STATE: "running", CODEX_LOCAL_ROUTER_TEST_DRIVER_LAUNCHCTL: "1" };
  await initializeSpaces({ env, config: initial, configPath, integrationState: { schemaVersion: 3, status: "disabled",
    baseline: { model: 'model = "gpt-fixture"', model_provider: 'model_provider = "openai"' } } });
  const cli = async (...args) => JSON.parse((await promisify(execFile)(process.execPath,
    [resolve("test/support/gateway-admin-test-driver.mjs"), ...args, "--space", "default", "--json"], { env })).stdout);
  const preview = await cli("model", "apply-template", "--ids", "deepseek", "--template", "codex-general-v1");
  assert.equal(preview.applied, false);
  const applied = await cli("model", "apply-template", "--ids", "deepseek", "--template", "codex-general-v1", "--yes");
  assert.equal(applied.revision, 2);
  assert.equal((await cli("model", "apply-template", "--ids", "deepseek", "--template", "codex-general-v1", "--yes")).changed, false);
  assert.equal((await resolveSpace("default@2", env)).config.targets.deepseek.app.toolMode, "code_mode_only");
  const added = await cli("model", "add", "--id", "go", "--provider", "vendor", "--preset", "opencode-go/deepseek-v4.1-flash", "--yes");
  assert.equal(added.revision, 3);
  const go = (await resolveSpace("default@3", env)).config.targets.go;
  assert.equal(go.app.toolMode, undefined);
  assert.equal(go.app.multiAgent, undefined);
  assert.equal(go.app.thirdPartyTemplate, undefined);
  const defaults = await cli("space", "set-third-party-template", "legacy", "--yes");
  assert.equal(defaults.revision, 4);
  const fourth = await resolveSpace("default@4", env);
  assert.equal(fourth.config.thirdPartyDefaults.template, "legacy");
  assert.equal(fourth.config.targets.deepseek.app.thirdPartyTemplate.id, "codex-general-v1");
  assert.deepEqual(JSON.parse(await readFile(configPath)), initial, "dormant edits changed runtime config");
});

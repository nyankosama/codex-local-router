import test from "node:test";
import assert from "node:assert/strict";
import { validate, upgradeConfig } from "../src/config.mjs";
import { buildModelCatalog } from "../src/model-catalog.mjs";

const legacy = () => ({
  mode: "rules",
  defaultTarget: "deepseek",
  providers: {
    "opencode-go": { baseUrl: "https://opencode.ai/zen/go" },
    generic: { baseUrl: "http://127.0.0.1:9999" },
  },
  targets: {
    deepseek: {
      provider: "opencode-go",
      model: "deepseek-v4.1-flash",
      wireApi: "responses",
      contextWindow: 131072,
      capabilities: { toolCalling: true },
    },
  },
  subscription: {
    enabled: true,
    models: ["gpt-5.5"],
    customModels: { "deepseek-v4.1-flash": "deepseek" },
  },
});

test("legacy upgrade makes DeepSeek 400K, derives App mapping and leaves unknown models unsupported", () => {
  const old = legacy();
  old.targets.deepseek.inputModalities = ["text"];
  old.targets.other = {
    provider: "generic",
    model: "legacy-model",
    wireApi: "chat_completions",
  };
  const { config, changes } = upgradeConfig(old);
  assert.equal(config.schemaVersion, 4);
  assert.equal(config.targets.deepseek.preset, "opencode-go/deepseek-v4.1-flash");
  assert.equal(config.targets.deepseek.contextWindow, 400000);
  assert.equal(config.targets.deepseek.maxContextWindow, 400000);
  assert.equal(config.targets.deepseek.compression.mode, "unsupported");
  assert.deepEqual(config.targets.deepseek.inputModalities, ["text", "image"]);
  assert.equal(
    config.providers["opencode-go"].responsesMessagePhasePolicy,
    "defer_until_done",
  );
  assert.equal(
    config.providers.generic.responsesMessagePhasePolicy,
    "passthrough",
  );
  assert.equal(config.targets.deepseek.app.modelId, "deepseek-v4.1-flash");
  assert.deepEqual(config.targets.deepseek.app.reasoningLevels, [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.equal(config.targets.other.contextWindow, 131072);
  assert.equal(config.targets.other.maxContextWindow, 131072);
  assert.equal(config.targets.other.compression.mode, "unsupported");
  assert.equal(config.subscription.customModels, undefined);
  assert.equal(config.access.required, true);
  assert.match(config.access.tokenFile, /access-token$/);
  assert.equal(config.history.persistent.diskMaxBytes, 10 * 1024 ** 3);
  assert.ok(changes.length > 0);
  const normalized = validate(config);
  assert.equal(normalized.subscription.customModels["deepseek-v4.1-flash"], "deepseek");
});

test("schema v2 requires every model-channel target to declare a context window", () => {
  const input = upgradeConfig(legacy()).config;
  input.targets.another = {
    provider: "generic",
    model: "new-model",
    wireApi: "responses",
  };
  assert.throws(
    () => validate(input),
    /target another requires an explicit context window/,
  );
});

test("remote plaintext providers require explicit authorization", () => {
  const input = upgradeConfig(legacy()).config;
  input.providers.generic.baseUrl = "http://provider.example/v1";
  assert.throws(() => validate(input), /invalid provider address/);
  input.providers.generic.allowInsecureHttp = true;
  assert.equal(validate(input).providers.generic.allowInsecureHttp, true);
  input.providers.generic.allowInsecureHttp = "yes";
  assert.throws(() => validate(input), /invalid insecure HTTP setting/);
});

test("adding a model on existing adapters only changes config and generated catalog", () => {
  const input = upgradeConfig(legacy()).config;
  input.targets.another = {
    provider: "generic",
    model: "vendor-model-1",
    wireApi: "chat_completions",
    contextWindow: 65536,
    maxContextWindow: 65536,
    effectiveContextWindowPercent: 90,
    outputReserveTokens: 8192,
    inputModalities: ["text"],
    compression: { mode: "unsupported" },
    capabilities: { responses: false, toolCalling: true },
    app: {
      enabled: true,
      modelId: "vendor-model-1-via-gateway",
      displayName: "Vendor Model 1",
      defaultReasoningLevel: "max",
      reasoningLevels: ["low", "max"],
    },
  };
  const config = validate(input);
  const official = {
    slug: "gpt-5.5",
    display_name: "GPT 5.5",
    context_window: 272000,
    comp_hash: "official",
    priority: 10,
  };
  const catalog = buildModelCatalog({ models: [official] }, config);
  assert.deepEqual(catalog.models[0], official);
  assert.deepEqual(
    catalog.models.slice(1).map((model) => model.slug),
    ["deepseek-v4.1-flash", "vendor-model-1-via-gateway"],
  );
  assert.equal(catalog.models[1].comp_hash, undefined);
  assert.deepEqual(catalog.models[1].input_modalities, ["text", "image"]);
  assert.equal(catalog.models[1].supports_image_detail_original, true);
  assert.equal(catalog.models[2].context_window, 65536);
  assert.equal(catalog.models[2].default_reasoning_level, "max");
  assert.deepEqual(catalog.models[2].supported_reasoning_levels, [
    { effort: "low", description: "low reasoning effort" },
    { effort: "max", description: "max reasoning effort" },
  ]);
});

test("App reasoning levels reject invalid, duplicate and unsupported defaults", () => {
  const input = upgradeConfig(legacy()).config;
  input.targets.deepseek.app.reasoningLevels = ["low", "turbo"];
  assert.throws(
    () => validate(input),
    /invalid App reasoning levels for target deepseek/,
  );
  input.targets.deepseek.app.reasoningLevels = ["low", "low"];
  assert.throws(
    () => validate(input),
    /duplicate App reasoning levels for target deepseek/,
  );
  input.targets.deepseek.app.reasoningLevels = ["low", "max"];
  input.targets.deepseek.app.defaultReasoningLevel = "high";
  assert.throws(
    () => validate(input),
    /default App reasoning level is unsupported for target deepseek/,
  );
  delete input.targets.deepseek.app.reasoningLevels;
  input.targets.deepseek.app.defaultReasoningLevel = "max";
  assert.equal(validate(input).targets.deepseek.app.defaultReasoningLevel, "max");
});

test("native compression defaults to the same target and validates explicit compatibility", () => {
  const input = upgradeConfig(legacy()).config;
  input.targets.deepseek.compression = { mode: "native" };
  assert.deepEqual(validate(input).targets.deepseek.compression.compatibility, {
    accountScope: "same",
    targets: ["deepseek"],
  });
  input.targets.deepseek.compression.compatibility = {
    accountScope: "same",
    targets: ["other"],
  };
  assert.throws(() => validate(input), /explicit same-account compatibility/);
});

test("native migration summaries are independent from same-target compression", () => {
  const input = upgradeConfig(legacy()).config;
  input.targets.deepseek.compression.nativeMigrationSummary = true;
  assert.equal(
    validate(input).targets.deepseek.compression.nativeMigrationSummary,
    true,
  );
  input.targets.deepseek.compression.mode = "unsupported";
  assert.equal(
    validate(input).targets.deepseek.compression.nativeMigrationSummary,
    true,
  );
  input.targets.deepseek.compression = {
    mode: "summary",
    nativeMigrationSummary: "yes",
  };
  assert.throws(() => validate(input), /invalid native migration summary setting/);
});

test("v3 summary configuration upgrades once to unsupported without losing migration authorization", () => {
  const input = upgradeConfig(legacy()).config;
  input.schemaVersion = 3;
  input.targets.deepseek.compression = {
    mode: "summary",
    nativeMigrationSummary: true,
  };
  const first = upgradeConfig(input);
  assert.equal(first.config.schemaVersion, 4);
  assert.deepEqual(first.config.targets.deepseek.compression, {
    mode: "unsupported",
    nativeMigrationSummary: true,
  });
  assert.match(first.changes.join("\n"), /legacy summary default removed/);
  assert.deepEqual(upgradeConfig(first.config).changes, []);
});

test("v3 FEEI summaries upgrade to the accepted same-target native preset", () => {
  const input = {
    schemaVersion: 3,
    defaultTarget: "sol",
    providers: { feei: { baseUrl: "https://ai.feei.cn/v1" } },
    targets: {
      sol: {
        provider: "feei",
        preset: "feei/gpt-5.6-sol",
        compression: { mode: "summary", nativeMigrationSummary: true },
      },
    },
    subscription: { enabled: true, models: ["gpt-official"] },
  };
  const upgraded = upgradeConfig(input).config;
  assert.deepEqual(upgraded.targets.sol.compression, {
    mode: "native",
    compatibility: { accountScope: "same", targets: ["sol"] },
    nativeMigrationSummary: true,
  });
  assert.equal(validate(upgraded).targets.sol.compression.mode, "native");
});

test("Responses message phase policy is provider-scoped and validated", () => {
  const input = upgradeConfig(legacy()).config;
  input.providers.generic.responsesMessagePhasePolicy = "defer_until_done";
  assert.equal(
    validate(input).providers.generic.responsesMessagePhasePolicy,
    "defer_until_done",
  );
  input.providers.generic.responsesMessagePhasePolicy = "guess";
  assert.throws(
    () => validate(input),
    /invalid Responses message phase policy guess/,
  );
});

test("Plugin policy config keeps legacy targets passthrough and validates families and aliases", () => {
  const input = upgradeConfig(legacy()).config;
  input.targets.deepseek.modelFamily = "openai-gpt";
  input.targets.deepseek.pluginToolPolicy = {
    mode: "allowlist",
    allowedPlugins: ["spreadsheets", "github"],
  };
  input.pluginTools = {
    thirdPartyGpt: {
      additionalAllowedPlugins: ["gmail"],
      excludedDefaultPlugins: ["sites"],
    },
  };
  const normalized = validate(input);
  assert.deepEqual(normalized.targets.deepseek.pluginToolPolicy.allowedPlugins, [
    "connected_documents",
    "github",
  ]);
  assert.equal(normalized.targets.deepseek.modelFamily, "openai-gpt");

  const invalid = structuredClone(input);
  invalid.targets.deepseek.modelFamily = "gpt";
  assert.throws(() => validate(invalid), /invalid model family/);

  const conflict = structuredClone(input);
  conflict.pluginTools.thirdPartyGpt.additionalAllowedPlugins = ["spreadsheets"];
  conflict.pluginTools.thirdPartyGpt.excludedDefaultPlugins = ["codex_document_control"];
  assert.throws(() => validate(conflict), /both adds and excludes connected_documents/);
});

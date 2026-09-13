import test from "node:test";
import assert from "node:assert/strict";
import { validate } from "../src/config.mjs";
import { buildModelCatalog } from "../src/model-catalog.mjs";
import {
  normalizeProviderSearchEndpoint,
  providerStandaloneSearchUrl,
  resolveStandaloneSearchPolicy,
} from "../src/standalone-search.mjs";

function fixture() {
  return {
    schemaVersion: 3,
    mode: "rules",
    defaultTarget: "gpt",
    providers: {
      vendor: {
        baseUrl: "https://provider.example/v1",
        adapter: "openai-compatible",
        apiKeyEnv: "TEST_VENDOR_KEY",
      },
    },
    targets: {
      gpt: {
        provider: "vendor",
        model: "gpt-upstream",
        modelFamily: "openai-gpt",
        wireApi: "responses",
        contextWindow: 100000,
        capabilities: { responses: true, nativeWebSearch: false },
        app: { enabled: true, modelId: "vendor-gpt" },
      },
      other: {
        provider: "vendor",
        model: "other-upstream",
        modelFamily: "other",
        wireApi: "responses",
        contextWindow: 100000,
        capabilities: { responses: true, nativeWebSearch: false },
        app: { enabled: true, modelId: "vendor-other" },
      },
    },
    subscription: { enabled: true, models: ["gpt-official"] },
  };
}

test("standalone search policy preserves official priority and scopes GPT defaults", () => {
  const config = validate(fixture());
  assert.deepEqual(resolveStandaloneSearchPolicy(config, {
    id: "official:gpt-future",
    provider: "chatgpt-subscription",
    model: "gpt-future",
  }), {
    source: "subscription",
    reason: "official-subscription",
    advertised: true,
    providerEndpointConfigured: false,
  });
  assert.equal(resolveStandaloneSearchPolicy(config, config.targets.gpt).source, "subscription");
  assert.equal(resolveStandaloneSearchPolicy(config, config.targets.gpt).reason, "third-party-gpt-default");
  assert.equal(config.targets.gpt.app.useResponsesLite, true);
  assert.equal(resolveStandaloneSearchPolicy(config, config.targets.other).source, null);
  assert.equal(resolveStandaloneSearchPolicy(config, config.targets.other).advertised, false);
});

test("target policy, legacy flags and space default follow the fixed precedence", () => {
  const input = fixture();
  input.standaloneSearch = { thirdPartyGpt: { defaultSource: "disabled" } };
  assert.equal(
    resolveStandaloneSearchPolicy(validate(input), validate(input).targets.gpt).source,
    "disabled",
  );

  const explicit = fixture();
  explicit.providers.vendor.standaloneSearch = { endpoint: "alpha/search" };
  explicit.targets.gpt.standaloneSearch = { source: "provider" };
  const normalized = validate(explicit);
  assert.equal(resolveStandaloneSearchPolicy(normalized, normalized.targets.gpt).source, "provider");
  assert.equal(normalized.targets.gpt.app.useResponsesLite, true);

  const legacy = fixture();
  legacy.targets.gpt.app.supportsSearchTool = false;
  assert.equal(
    resolveStandaloneSearchPolicy(validate(legacy), validate(legacy).targets.gpt).source,
    "disabled",
  );

  const compatible = fixture();
  compatible.targets.gpt.app.supportsSearchTool = true;
  compatible.targets.gpt.standaloneSearch = { source: "subscription" };
  assert.doesNotThrow(() => validate(compatible));
  compatible.targets.gpt.standaloneSearch.source = "disabled";
  assert.throws(() => validate(compatible), /conflicting standalone search policy/);

  const incompatible = fixture();
  incompatible.targets.gpt.app.useResponsesLite = false;
  assert.throws(
    () => validate(incompatible),
    /standalone search requires Responses Lite/,
  );
});

test("provider standalone search requires an explicit safe endpoint and App Responses target", () => {
  const input = fixture();
  input.targets.gpt.standaloneSearch = { source: "provider" };
  assert.throws(() => validate(input), /endpoint is missing/);
  input.providers.vendor.standaloneSearch = { endpoint: "alpha/search" };
  assert.doesNotThrow(() => validate(input));
  input.targets.gpt.wireApi = "chat_completions";
  input.targets.gpt.capabilities.responses = false;
  assert.throws(() => validate(input), /App-enabled Responses target/);

  assert.equal(normalizeProviderSearchEndpoint("/alpha/search"), "alpha/search");
  for (const endpoint of [
    "https://evil.example/search",
    "//evil.example/search",
    "../search",
    "%2e%2e/search",
    "%252e%252e/search",
    "alpha/search?q=secret",
    "alpha/search#fragment",
  ]) assert.throws(() => normalizeProviderSearchEndpoint(endpoint));
  assert.equal(
    providerStandaloneSearchUrl(
      {
        baseUrl: "https://provider.example/v1",
        standaloneSearch: { endpoint: "alpha/search" },
      },
      "/subscription/v1/alpha/search?q=a%20b&limit=4",
    ),
    "https://provider.example/v1/alpha/search?q=a%20b&limit=4",
  );
});

test("catalog support is derived from the effective standalone policy", () => {
  const input = fixture();
  input.standaloneSearch = { thirdPartyGpt: { defaultSource: "disabled" } };
  let config = validate(input);
  let catalog = buildModelCatalog({ models: [{ slug: "gpt-official", priority: 10 }] }, config);
  assert.equal(catalog.models.find((model) => model.slug === "vendor-gpt").supports_search_tool, false);
  assert.equal(catalog.models.find((model) => model.slug === "vendor-other").supports_search_tool, false);

  input.targets.gpt.standaloneSearch = { source: "subscription" };
  config = validate(input);
  catalog = buildModelCatalog({ models: [{ slug: "gpt-official", priority: 10 }] }, config);
  const gpt = catalog.models.find((model) => model.slug === "vendor-gpt");
  assert.equal(gpt.supports_search_tool, true);
  assert.equal(gpt.use_responses_lite, true);
});

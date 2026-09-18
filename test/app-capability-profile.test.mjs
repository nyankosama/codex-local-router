import test from "node:test";
import assert from "node:assert/strict";
import { validate } from "../src/config.mjs";
import { buildModelCatalog } from "../src/model-catalog.mjs";
import { resolveAppCapabilityProfile } from "../src/app-capability-profile.mjs";

function fixture() {
  return {
    schemaVersion: 3,
    mode: "rules",
    defaultTarget: "gpt",
    providers: {
      vendor: {
        baseUrl: "https://provider.example/v1",
        adapter: "openai-compatible",
      },
    },
    targets: {
      gpt: {
        provider: "vendor",
        model: "gpt-upstream",
        modelFamily: "openai-gpt",
        wireApi: "responses",
        contextWindow: 100000,
        capabilities: { responses: true, toolCalling: true },
        app: { enabled: true, modelId: "vendor-gpt" },
      },
    },
    subscription: { enabled: true, models: ["gpt-official"] },
  };
}

test("explicit standard-tools uses Standard Responses and does not advertise standalone search", () => {
  const input = fixture();
  input.targets.gpt.app.capabilityProfile = "standard-tools";
  const config = validate(input);
  assert.equal(config.targets.gpt.app.useResponsesLite, false);
  assert.deepEqual(config.targets.gpt.standaloneSearch, { source: "disabled" });
  assert.deepEqual(resolveAppCapabilityProfile(config, config.targets.gpt), {
    profile: "standard-tools",
    reason: "target-explicit",
    useResponsesLite: false,
    toolSurface: "policy-filtered-standard",
    standaloneSearchAdvertised: false,
  });

  const catalog = buildModelCatalog(
    { models: [{ slug: "gpt-official", priority: 10 }] },
    config,
  );
  const custom = catalog.models.at(-1);
  assert.equal(custom.supports_search_tool, false);
  assert.equal(custom.use_responses_lite, false);
  assert.equal(custom.gateway_capability_profile, "standard-tools");
  assert.equal(custom.gateway_capability_profile_reason, "target-explicit");
  assert.equal(custom.gateway_tool_surface, "policy-filtered-standard");
});

test("subscription bridge advertises search without enabling Lite or Provider-native search", () => {
  const input = fixture();
  input.targets.gpt.app.capabilityProfile = "standard-tools";
  input.targets.gpt.subscriptionSearch = { delivery: "standard-tool" };
  const config = validate(input);
  const custom = buildModelCatalog(
    { models: [{ slug: "gpt-official", priority: 10 }] },
    config,
  ).models.at(-1);
  assert.equal(custom.supports_search_tool, true);
  assert.equal(custom.use_responses_lite, false);
  assert.equal(custom.gateway_subscription_search_delivery, "standard-tool");
  assert.equal(config.targets.gpt.capabilities.nativeWebSearch, undefined);

  for (const mutate of [
    (target) => { target.app.useResponsesLite = true; },
    (target) => { target.standaloneSearch = { source: "subscription" }; },
    (target) => { target.capabilities.nativeWebSearch = true; },
  ]) {
    const invalid = fixture();
    invalid.targets.gpt.subscriptionSearch = { delivery: "standard-tool" };
    mutate(invalid.targets.gpt);
    assert.throws(() => validate(invalid), /conflicting subscription search delivery/);
  }
});

test("explicit lite-search requires Lite transport and an active standalone source", () => {
  const input = fixture();
  input.targets.gpt.app.capabilityProfile = "lite-search";
  const config = validate(input);
  assert.equal(config.targets.gpt.app.useResponsesLite, true);
  assert.equal(resolveAppCapabilityProfile(config, config.targets.gpt).profile, "lite-search");
  assert.equal(resolveAppCapabilityProfile(config, config.targets.gpt).toolSurface, "reduced-responses-lite");

  const disabled = fixture();
  disabled.targets.gpt.app.capabilityProfile = "lite-search";
  disabled.targets.gpt.standaloneSearch = { source: "disabled" };
  assert.throws(() => validate(disabled), /lite-search requires standalone search/);

  const standardWithSearch = fixture();
  standardWithSearch.targets.gpt.app.capabilityProfile = "standard-tools";
  standardWithSearch.targets.gpt.standaloneSearch = { source: "subscription" };
  assert.throws(
    () => validate(standardWithSearch),
    /standard-tools cannot advertise standalone search/,
  );
});

test("legacy explicit Lite stays Lite while an unprofiled new GPT target defaults Standard", () => {
  const explicitLite = fixture();
  explicitLite.targets.gpt.app.useResponsesLite = true;
  let config = validate(explicitLite);
  assert.equal(config.targets.gpt.app.capabilityProfile, undefined);
  assert.equal(resolveAppCapabilityProfile(config, config.targets.gpt).profile, "lite-search");
  assert.equal(resolveAppCapabilityProfile(config, config.targets.gpt).reason, "legacy-responses-lite");

  const implicit = fixture();
  config = validate(implicit);
  assert.equal(config.targets.gpt.app.useResponsesLite, undefined);
  assert.equal(config.targets.gpt.app.capabilityProfile, undefined);
  assert.equal(config.targets.gpt.standaloneSearch.source, "disabled");
  assert.equal(resolveAppCapabilityProfile(config, config.targets.gpt).profile, "standard-tools");
  assert.equal(
    resolveAppCapabilityProfile(config, config.targets.gpt).reason,
    "standard-default",
  );
});

test("legacy transport-only Lite stays unprofiled while explicit profiles remain strict", () => {
  const liteWithoutSearch = fixture();
  liteWithoutSearch.targets.gpt.app.useResponsesLite = true;
  liteWithoutSearch.targets.gpt.standaloneSearch = { source: "disabled" };
  const legacy = validate(liteWithoutSearch);
  assert.deepEqual(resolveAppCapabilityProfile(legacy, legacy.targets.gpt), {
    profile: null,
    reason: "legacy-responses-lite-transport-only",
    useResponsesLite: true,
    toolSurface: "legacy-responses-lite",
    standaloneSearchAdvertised: false,
  });

  const explicitLiteWithoutSearch = fixture();
  explicitLiteWithoutSearch.targets.gpt.app.capabilityProfile = "lite-search";
  explicitLiteWithoutSearch.targets.gpt.standaloneSearch = { source: "disabled" };
  assert.throws(() => validate(explicitLiteWithoutSearch), /lite-search requires standalone search/);

  const standardWithSearch = fixture();
  standardWithSearch.targets.gpt.app.useResponsesLite = false;
  standardWithSearch.targets.gpt.standaloneSearch = { source: "subscription" };
  assert.throws(
    () => validate(standardWithSearch),
    /standalone search requires Responses Lite|standard-tools cannot advertise standalone search/,
  );

  const nonBoolean = fixture();
  nonBoolean.targets.gpt.app.capabilityProfile = "standard-tools";
  nonBoolean.targets.gpt.app.useResponsesLite = "true";
  assert.throws(
    () => validate(nonBoolean),
    /invalid App Responses Lite flag/,
  );
});

test("an explicit space search default remains an implied Lite compatibility signal", () => {
  const input = fixture();
  input.standaloneSearch = { thirdPartyGpt: { defaultSource: "subscription" } };
  const config = validate(input);
  assert.equal(config.targets.gpt.standaloneSearch, undefined);
  assert.equal(config.targets.gpt.app.useResponsesLite, true);
  assert.deepEqual(resolveAppCapabilityProfile(config, config.targets.gpt), {
    profile: "lite-search",
    reason: "space-default-implied-lite",
    useResponsesLite: true,
    toolSurface: "reduced-responses-lite",
    standaloneSearchAdvertised: true,
  });
});

test("legacy non-Responses GPT targets remain unprofiled and unchanged", () => {
  const chat = fixture();
  chat.targets.gpt.wireApi = "chat_completions";
  chat.targets.gpt.capabilities.responses = false;
  chat.targets.gpt.inputModalities = ["text"];
  chat.targets.gpt.app.useResponsesLite = true;
  const config = validate(chat);
  assert.equal(config.targets.gpt.app.useResponsesLite, true);
  assert.deepEqual(resolveAppCapabilityProfile(config, config.targets.gpt), {
    profile: null,
    reason: "non-responses-unchanged",
    useResponsesLite: true,
    toolSurface: "unchanged",
    standaloneSearchAdvertised: true,
  });
  const catalog = buildModelCatalog(
    { models: [{ slug: "gpt-official", priority: 10 }] },
    config,
  );
  assert.equal(catalog.models[1].gateway_capability_profile, null);
  assert.equal(catalog.models[1].gateway_capability_profile_reason, "non-responses-unchanged");
  assert.equal(catalog.models[1].gateway_tool_surface, "unchanged");
});

test("an app-absent legacy GPT target is distinct from an explicitly disabled App target", () => {
  const absent = fixture();
  delete absent.targets.gpt.app;
  let config = validate(absent);
  assert.deepEqual(resolveAppCapabilityProfile(config, config.targets.gpt), {
    profile: null,
    reason: "app-absent",
    useResponsesLite: false,
    toolSurface: "unchanged",
    standaloneSearchAdvertised: true,
  });

  const disabled = fixture();
  disabled.targets.gpt.app.enabled = false;
  config = validate(disabled);
  assert.deepEqual(resolveAppCapabilityProfile(config, config.targets.gpt), {
    profile: null,
    reason: "app-disabled",
    useResponsesLite: false,
    toolSurface: "unchanged",
    standaloneSearchAdvertised: false,
  });
});

test("third-party profiles are capability based and still reject unrelated protocol shapes", () => {
  const invalidName = fixture();
  invalidName.targets.gpt.app.capabilityProfile = "everything";
  assert.throws(() => validate(invalidName), /invalid App capability profile/);

  const nonGpt = fixture();
  nonGpt.targets.gpt.modelFamily = "other";
  nonGpt.targets.gpt.app.capabilityProfile = "standard-tools";
  assert.equal(validate(nonGpt).targets.gpt.app.capabilityProfile, "standard-tools");

  const chat = fixture();
  chat.targets.gpt.wireApi = "chat_completions";
  chat.targets.gpt.capabilities.responses = false;
  chat.targets.gpt.app.capabilityProfile = "standard-tools";
  assert.throws(() => validate(chat), /requires Responses target/);
});

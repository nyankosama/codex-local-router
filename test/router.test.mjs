import test from "node:test";
import assert from "node:assert/strict";
import {
  contextFromRequest,
  decide,
  planCapabilities,
} from "../src/router.mjs";
import { validate } from "../src/config.mjs";
const config = {
  mode: "rules",
  defaultTarget: "strong",
  providers: { p: {} },
  targets: {
    strong: {
      provider: "p",
      model: "strong",
      wireApi: "chat_completions",
      capabilities: { nativeWebSearch: true, toolCalling: true },
    },
    cheap: {
      provider: "p",
      model: "cheap",
      wireApi: "chat_completions",
      capabilities: { toolCalling: true },
    },
  },
  rules: [{ name: "low", match: { thinkLevel: "low" }, target: "cheap" }],
};
test("routes by think level and defaults conservatively", () => {
  assert.equal(
    decide(config, contextFromRequest({ reasoning: { effort: "low" } })).target,
    "cheap",
  );
  assert.equal(
    decide(config, contextFromRequest({ reasoning: { effort: "high" } }))
      .target,
    "strong",
  );
});
test("routes fixed and passthrough modes", () => {
  assert.equal(
    decide({ ...config, mode: "fixed", fixedTarget: "cheap" }, {}, "strong")
      .target,
    "cheap",
  );
  assert.equal(
    decide({ ...config, mode: "passthrough" }, {}, "strong").model,
    "strong",
  );
});
test("plans native, tool fallback and unsupported search", () => {
  const c = contextFromRequest({ tools: [{ type: "web_search_preview" }] });
  assert.equal(planCapabilities(config.targets.strong, c).mode, "native");
  assert.equal(planCapabilities(config.targets.cheap, c).mode, "tool_fallback");
  assert.equal(
    planCapabilities(
      {
        ...config,
        targets: { x: { provider: "p", model: "x", capabilities: {} } },
      }.targets.x,
      c,
    ).mode,
    "unsupported",
  );
});
test("rejects hosted search when a standalone search route is selected", () => {
  const c = contextFromRequest({ tools: [{ type: "web_search" }] });
  assert.deepEqual(
    planCapabilities(config.targets.cheap, c, {
      standaloneSearchSource: "subscription",
    }),
    { mode: "unsupported", reason: "standalone_search_protocol_mismatch" },
  );
  assert.deepEqual(
    planCapabilities(config.targets.cheap, c, {
      standaloneSearchSource: "provider",
    }),
    { mode: "unsupported", reason: "standalone_search_protocol_mismatch" },
  );
  assert.deepEqual(
    planCapabilities(config.targets.cheap, c, {
      standaloneSearchSource: "disabled",
    }),
    { mode: "unsupported", reason: "standalone_search_disabled" },
  );
  assert.equal(
    planCapabilities(config.targets.strong, c, {
      standaloneSearchSource: "disabled",
    }).mode,
    "native",
  );
});
test("rejects invalid target references", () => {
  assert.throws(() => validate({ ...config, defaultTarget: "missing" }));
});

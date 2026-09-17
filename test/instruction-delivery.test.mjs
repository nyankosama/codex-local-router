import test from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/engine.mjs";
import { validate } from "../src/config.mjs";
import { captureInstructions } from "../src/instruction-source.mjs";
import {
  applyInstructionDelivery,
  gatewayLiteInstruction,
} from "../src/instruction-delivery.mjs";
import { codexInstructionOverrideStatus } from "../src/integration.mjs";
import { deterministicProviderRequest } from "../scripts/e2e/lib/deterministic-upstream.mjs";
import { performance } from "node:perf_hooks";

const source = (variables = null) => ({ models: [{
  slug: "gpt-source",
  base_instructions: "BASE_FALLBACK",
  model_messages: {
    instructions_template: "SYNTHETIC_OFFICIAL_BASE",
    instructions_variables: variables,
    persistent_instructions: "NOT_ALWAYS_ACTIVE",
  },
}] });

function target(delivery = "gateway-lite", variables = null) {
  const captured = captureInstructions({
    id: "sol",
    provider: "vendor",
    model: "gpt-source",
    modelFamily: "openai-gpt",
    wireApi: "responses",
    contextWindow: 100000,
    inputModalities: ["text"],
    capabilities: { responses: true, toolCalling: true, streaming: true },
    compression: { mode: "unsupported" },
    app: {
      enabled: true,
      modelId: "vendor-sol",
      useResponsesLite: true,
      capabilityProfile: "lite-search",
    },
    standaloneSearch: { source: "subscription" },
  }, source(variables), { clientVersion: "fixture" });
  captured.app.instructionDelivery = delivery;
  return captured;
}

const context = {
  entry: "subscription",
  requestKind: "turn",
  responsesLite: true,
};

test("gateway-lite delivery inserts one exact developer message after leading additional tools", () => {
  const original = {
    model: "vendor-sol",
    input: [
      { type: "additional_tools", tools: [{ type: "function", name: "fixture" }] },
      { type: "message", role: "developer", content: [{ type: "input_text", text: "AGENTS" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "USER" }] },
    ],
  };
  const delivered = applyInstructionDelivery(target(), original, context);
  assert.equal(delivered.applied, true);
  assert.equal(delivered.body.input[0], original.input[0]);
  assert.equal(delivered.body.input[1].content[0].text, "SYNTHETIC_OFFICIAL_BASE");
  assert.deepEqual(delivered.body.input.slice(2), original.input.slice(1));
  assert.deepEqual(original.input.map((item) => item.type), ["additional_tools", "message", "message"]);
  assert.equal(applyInstructionDelivery(target(), delivered.body, context).reason, "already-present");
});

test("gateway-lite delivery is explicit, rejects conflicts and never guesses runtime variables", () => {
  const body = { input: [{ role: "user", content: "fixture" }] };
  assert.equal(applyInstructionDelivery(target("client"), body, context).body, body);
  assert.equal(applyInstructionDelivery(target(), body, { ...context, entry: "api" }).body, body);
  assert.equal(applyInstructionDelivery(target(), body, { ...context, responsesLite: false }).body, body);
  assert.throws(
    () => applyInstructionDelivery(target(), { ...body, instructions: "OTHER" }, context),
    (error) => error.type === "instruction_delivery_conflict" && error.status === 409,
  );
  assert.equal(
    applyInstructionDelivery(target(), { ...body, instructions: "SYNTHETIC_OFFICIAL_BASE" }, context).reason,
    "matching-top-level",
  );
  assert.throws(
    () => applyInstructionDelivery(target(), { input: "fixture" }, context),
    (error) => error.type === "instruction_delivery_input_unsupported" && error.status === 409,
  );
  assert.throws(
    () => validate({ defaultTarget: "sol", providers: { vendor: { baseUrl: "https://fixture.invalid/v1" } }, targets: { sol: target("gateway-lite", { personality: "x" }) } }),
    /runtime instruction variables/,
  );
  assert.equal(gatewayLiteInstruction(target()), "SYNTHETIC_OFFICIAL_BASE");
});

test("Engine applies Lite delivery on subscription HTTP and WS views without archiving it", async () => {
  const config = validate({
    schemaVersion: 3,
    mode: "fixed",
    fixedTarget: "sol",
    defaultTarget: "sol",
    providers: { vendor: { baseUrl: "https://fixture.invalid/v1", adapter: "openai-compatible" } },
    targets: { sol: target() },
    rules: [],
    history: {},
    subscription: { enabled: true, models: ["gpt-source"] },
  });
  for (const transport of ["http", "websocket"]) {
    const sent = [], logs = [];
    const engine = new Engine(config, {
      log: (event) => logs.push(event),
      send: async (url, options) => {
        sent.push(structuredClone(options.body));
        return deterministicProviderRequest(url, options);
      },
    });
    const input = [
      { type: "additional_tools", tools: [] },
      { type: "message", role: "developer", content: [{ type: "input_text", text: "AGENTS" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Reply exactly DELIVERY_OK" }] },
    ];
    for await (const _ of engine.generate(
      "subscription",
      { authorization: "Bearer synthetic", "chatgpt-account-id": "synthetic" },
      { model: "vendor-sol", input },
      new AbortController().signal,
      { transport, responsesLite: true },
    )) {}
    assert.equal(sent.length, 1);
    assert.ok(sent[0].input.some((item) => item.content?.[0]?.text === "SYNTHETIC_OFFICIAL_BASE"));
    assert.equal(sent[0].input.filter((item) => JSON.stringify(item).includes("SYNTHETIC_OFFICIAL_BASE")).length, 1);
    assert.ok(logs.some((event) => event.event === "instruction_snapshot_delivered"));
    const saved = [...engine.state.items.entries()]
      .find(([key]) => key.startsWith("response:"))?.[1].value;
    assert.ok(saved);
    assert.equal(JSON.stringify(saved.input).includes("SYNTHETIC_OFFICIAL_BASE"), false);
    assert.equal(JSON.stringify(saved.original).includes("SYNTHETIC_OFFICIAL_BASE"), false);
    assert.equal(JSON.stringify(input).includes("SYNTHETIC_OFFICIAL_BASE"), false);
  }
});

test("Codex instruction override detection covers top-level and the selected profile only", () => {
  assert.deepEqual(codexInstructionOverrideStatus('model = "x"\n'), {
    configured: false,
    topLevel: false,
    selectedProfile: null,
    selectedProfileOverride: false,
  });
  assert.equal(codexInstructionOverrideStatus('model_instructions_file = "base.md"\n').configured, true);
  assert.deepEqual(
    codexInstructionOverrideStatus('profile = "work"\n[profiles.other]\nmodel_instructions_file = "other.md"\n'),
    { configured: false, topLevel: false, selectedProfile: "work", selectedProfileOverride: false },
  );
  assert.equal(
    codexInstructionOverrideStatus('profile = "work"\n[profiles."work"]\nmodel_instructions_file = "work.md"\n').configured,
    true,
  );
  assert.equal(codexInstructionOverrideStatus('# model_instructions_file = "ignored"\n').configured, false);
});

test("instruction delivery stays local, bounded and records its actual wire increment", () => {
  const body = { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "fixture" }] }] };
  const before = Buffer.byteLength(JSON.stringify(body));
  const samples = [];
  let delivered;
  for (let index = 0; index < 1000; index++) {
    const started = performance.now();
    delivered = applyInstructionDelivery(target(), body, context);
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  assert.ok(samples[Math.floor(samples.length * 0.95)] < 25);
  const increment = Buffer.byteLength(JSON.stringify(delivered.body)) - before;
  assert.ok(increment >= Buffer.byteLength("SYNTHETIC_OFFICIAL_BASE"));
  assert.ok(increment < Buffer.byteLength("SYNTHETIC_OFFICIAL_BASE") + 256);
});

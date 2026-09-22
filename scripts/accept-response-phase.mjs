// Real OpenCode Go phase-stability probe through an isolated Gateway.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, validate } from "../src/config.mjs";
import { createGateway } from "../src/server.mjs";
import { request } from "../src/transport.mjs";
import { sseEvents } from "../src/sse.mjs";
import { writeAcceptanceEvidence } from "./e2e/lib/evidence-path.mjs";

const report = {
  at: new Date().toISOString(),
  model: "deepseek-v4.1-flash",
  passed: false,
};
const logs = [];
let gateway;
try {
  const loaded = await loadConfig(
    process.env.GATEWAY_CONFIG ?? "config/gateway.subscription.local.json",
  );
  const configInput = structuredClone(loaded);
  const targetId =
    configInput.subscription?.customModels?.[report.model] ??
    Object.keys(configInput.targets).find(
      (id) => configInput.targets[id].model === report.model,
    );
  assert.ok(targetId, "DeepSeek target is not configured");
  configInput.mode = "fixed";
  configInput.defaultTarget = targetId;
  configInput.fixedTarget = targetId;
  delete configInput.fallbackTarget;
  configInput.listen = { host: "127.0.0.1", port: 0 };
  configInput.history = {
    ...(configInput.history ?? {}),
    persistent: { enabled: false },
  };
  const config = validate(configInput);
  assert.equal(
    config.providers[config.targets[targetId].provider]
      .responsesMessagePhasePolicy,
    "defer_until_done",
  );

  gateway = createGateway(config, {
    send: request,
    log: (event) => logs.push(event),
  });
  await new Promise((done) => gateway.server.listen(0, "127.0.0.1", done));
  const startedAt = Date.now();
  const response = await fetch(
    `http://127.0.0.1:${gateway.server.address().port}/v1/responses`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: report.model,
        input:
          "Before using the required phase_probe tool, send one brief process update explaining that you are about to check it. Then call the tool exactly once. Do not claim a tool result.",
        tools: [
          {
            type: "function",
            name: "phase_probe",
            description: "A no-op tool used to verify event ordering.",
            parameters: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ],
        tool_choice: "auto",
        max_output_tokens: 1024,
        reasoning: { effort: "low" },
        stream: true,
      }),
      signal: AbortSignal.timeout(300000),
    },
  );
  if (!response.ok) {
    const error = await response.json();
    throw Error(error.error?.type ?? `HTTP ${response.status}`);
  }
  const events = [];
  for await (const event of sseEvents(response.body))
    events.push({
      sequenceNumber: event.sequence_number,
      type: event.type,
      outputIndex: event.output_index,
      itemId: event.item?.id,
      itemType: event.item?.type,
      phase: event.item?.phase,
      elapsedMs: Date.now() - startedAt,
    });
  assert.deepEqual(
    events.map((event) => event.sequenceNumber),
    events.map((_, index) => index),
    "Gateway sequence numbers are not continuous",
  );
  const messageAdded = events.filter(
    (event) =>
      event.type === "response.output_item.added" &&
      event.itemType === "message",
  );
  const messageDone = events.filter(
    (event) =>
      event.type === "response.output_item.done" &&
      event.itemType === "message",
  );
  const functionAdded = events.find(
    (event) =>
      event.type === "response.output_item.added" &&
      event.itemType === "function_call",
  );
  assert.ok(messageAdded.length, "Upstream produced no process message");
  assert.equal(messageAdded.length, messageDone.length);
  for (const added of messageAdded) {
    const done = messageDone.find(
      (candidate) =>
        candidate.itemId === added.itemId ||
        candidate.outputIndex === added.outputIndex,
    );
    assert.ok(done, `Message ${added.itemId ?? added.outputIndex} has no done event`);
    assert.equal(added.phase, done.phase, "Client observed an unstable phase");
  }
  assert.ok(functionAdded, "DeepSeek did not call phase_probe");
  assert.ok(
    events.indexOf(messageDone.at(-1)) < events.indexOf(functionAdded),
    "The tool appeared before the process message completed",
  );
  const releases = logs.filter(
    (event) => event.event === "response_message_phase_released",
  );
  assert.ok(releases.length, "Gateway recorded no deferred message release");
  assert.ok(
    releases.some((event) => event.phase_changed),
    "OpenCode Go did not reproduce the phase transition in this probe",
  );
  report.policy = "defer_until_done";
  report.eventCount = events.length;
  report.eventTypes = Object.fromEntries(
    [...new Set(events.map((event) => event.type))].map((type) => [
      type,
      events.filter((event) => event.type === type).length,
    ]),
  );
  report.trace = events.filter(
    (event) =>
      ["response.completed", "response.incomplete"].includes(event.type) ||
      (["response.output_item.added", "response.output_item.done"].includes(
        event.type,
      ) && ["message", "function_call"].includes(event.itemType)),
  );
  report.releases = releases.map((event) => ({
    initialPhase: event.initial_phase,
    finalPhase: event.final_phase,
    phaseChanged: event.phase_changed,
    bufferedEvents: event.buffered_events,
    bufferedBytes: event.buffered_bytes,
    waitMs: event.wait_ms,
  }));
  report.functionCalls = events.filter(
    (event) =>
      event.type === "response.output_item.done" &&
      event.itemType === "function_call",
  ).length;
  report.passed = true;
  console.log(JSON.stringify({ event: "response_phase_acceptance_passed", ...report }));
} catch (error) {
  report.failure = error.message;
  report.diagnostics = logs
    .filter((event) =>
      ["provider_error", "request_error"].includes(event.event),
    )
    .map((event) => ({
      event: event.event,
      status: event.status,
      type: event.type,
      category: event.category,
      code: event.code,
      param: event.param,
    }));
  console.log(
    JSON.stringify({
      event: "response_phase_acceptance_failed",
      reason: error.message,
    }),
  );
  process.exitCode = 1;
} finally {
  if (gateway) await gateway.close();
  await writeAcceptanceEvidence("response-phase-deepseek.json", report, { projectRoot: resolve(".") });
}

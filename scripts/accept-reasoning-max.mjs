// Real DeepSeek max-reasoning probe through an isolated production Gateway.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, validate } from "../src/config.mjs";
import { createGateway } from "../src/server.mjs";
import { request } from "../src/transport.mjs";
import { writeAcceptanceEvidence } from "./e2e/lib/evidence-path.mjs";

const report = {
  at: new Date().toISOString(),
  model: "deepseek-v4.1-flash",
  requestedEffort: "max",
  passed: false,
};
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
  assert.ok(
    configInput.targets[targetId].app?.reasoningLevels?.some((level) =>
      (typeof level === "string" ? level : level.effort) === "max"),
    "DeepSeek App target does not declare max reasoning",
  );
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
  let forwardedEffort;
  let upstreamCalls = 0;
  gateway = createGateway(config, {
    send: async (url, options) => {
      upstreamCalls += 1;
      forwardedEffort = options.body.reasoning?.effort;
      return request(url, options);
    },
    log: () => {},
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
        input: "Reply with exactly MAX_OK and nothing else.",
        reasoning: { effort: "max" },
        max_output_tokens: 256,
        stream: false,
      }),
      signal: AbortSignal.timeout(180000),
    },
  );
  const result = await response.json();
  if (!response.ok)
    throw Error(result.error?.type ?? `HTTP ${response.status}`);
  const output = result.output
    ?.flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text)
    .join("\n");
  assert.equal(forwardedEffort, "max", "Gateway did not forward max reasoning");
  assert.equal(upstreamCalls, 1, "max reasoning unexpectedly retried upstream");
  assert.equal(result.status, "completed");
  assert.ok(output?.trim(), "DeepSeek returned no answer");
  report.forwardedEffort = forwardedEffort;
  report.upstreamCalls = upstreamCalls;
  report.status = result.status;
  report.outputChars = output.length;
  report.reasoningTokens =
    result.usage?.output_tokens_details?.reasoning_tokens ?? null;
  report.durationMs = Date.now() - startedAt;
  report.passed = true;
  console.log(JSON.stringify({ event: "reasoning_max_acceptance_passed", ...report }));
} catch (error) {
  report.failure = error.message;
  console.log(
    JSON.stringify({
      event: "reasoning_max_acceptance_failed",
      reason: error.message,
    }),
  );
  process.exitCode = 1;
} finally {
  if (gateway) await gateway.close();
  await writeAcceptanceEvidence("reasoning-max-deepseek.json", report, { projectRoot: resolve(".") });
}

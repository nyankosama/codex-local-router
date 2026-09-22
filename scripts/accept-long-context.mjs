// Real OpenCode Go capacity probe through the subscription/custom-model route.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import { loadConfig, validate } from "../src/config.mjs";
import { createGateway } from "../src/server.mjs";
import { request } from "../src/transport.mjs";
import { Archive } from "../src/archive.mjs";
import { createLocalIdentityResolver } from "../src/local-identity.mjs";
import { writeAcceptanceEvidence } from "./e2e/lib/evidence-path.mjs";

const repeats = Number(process.env.ACCEPT_CONTEXT_REPEATS ?? 360000);
if (!Number.isInteger(repeats) || repeats < 250000 || repeats > 375000)
  throw Error("ACCEPT_CONTEXT_REPEATS must be between 250000 and 375000");
const root = await mkdtemp(join(tmpdir(), "gateway-long-context-"));
const report = {
  at: new Date().toISOString(),
  model: "deepseek-v4.1-flash",
  repeats,
  inputBytes: 0,
  usage: null,
  passed: false,
};
let gateway;
try {
  const loaded = await loadConfig(
    process.env.GATEWAY_CONFIG ?? "config/gateway.subscription.local.json",
  );
  const runtime = structuredClone(loaded);
  runtime.timeoutMs = 600000;
  const config = validate(runtime);
  const targetId = config.subscription.customModels[report.model];
  assert.ok(targetId, "DeepSeek App target is not configured");
  assert.equal(config.targets[targetId].contextWindow, 400000);
  const authPath = join(homedir(), ".codex/auth.json");
  const auth = JSON.parse(await readFile(authPath, "utf8"));
  const start = "LONG_CONTEXT_START_927";
  const end = "LONG_CONTEXT_END_384";
  const text = `${start}\n${"a ".repeat(repeats)}\n${end}\nReply with both marker strings exactly and no other text.`;
  report.inputBytes = Buffer.byteLength(text);
  const archive = new Archive(join(root, "history.sqlite"), Buffer.alloc(32, 6));
  gateway = createGateway(config, {
    archive,
    closeArchive: true,
    resolveIdentity: createLocalIdentityResolver(authPath),
    send: request,
    log: (event) => {
      if (["route", "provider_error", "request_error", "completed"].includes(event.event))
        console.log(JSON.stringify(event));
    },
  });
  await new Promise((done) => gateway.server.listen(0, "127.0.0.1", done));
  const response = await fetch(
    `http://127.0.0.1:${gateway.server.address().port}/subscription/v1/responses`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${auth.tokens.access_token}`,
        "chatgpt-account-id": auth.tokens.account_id,
        "thread-id": "long-context-capacity-probe",
        "turn-id": "capacity-turn-1",
      },
      body: JSON.stringify({
        model: report.model,
        input: [{ role: "user", content: [{ type: "input_text", text }] }],
        max_output_tokens: 2048,
        reasoning: { effort: "low" },
        stream: false,
      }),
      signal: AbortSignal.timeout(600000),
    },
  );
  const result = await response.json();
  if (!response.ok) throw Error(result.error?.type ?? `HTTP ${response.status}`);
  report.status = result.status;
  report.incompleteDetails = result.incomplete_details ?? null;
  report.usage = result.usage ?? null;
  const output = result.output
    ?.flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text)
    .join("\n");
  assert.match(output ?? "", /LONG_CONTEXT_START_927/);
  assert.match(output ?? "", /LONG_CONTEXT_END_384/);
  assert.ok(
    Number(result.usage?.input_tokens) >= 250000,
    "upstream usage did not prove a 250K+ token request",
  );
  report.passed = true;
  console.log(JSON.stringify({ event: "long_context_passed", usage: report.usage }));
} catch (error) {
  report.failure = error.message;
  console.log(JSON.stringify({ event: "long_context_failed", reason: error.message }));
  process.exitCode = 1;
} finally {
  if (gateway) await gateway.close();
  await rm(root, { recursive: true, force: true });
  await writeAcceptanceEvidence("long-context-400k.json", report, { projectRoot: resolve(".") });
}

// Exercise the App's bundled backend in an isolated CODEX_HOME, never the running App.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";
writeFileSync(
  "/tmp/llm-gateway-hybrid-probe/probe-marker.txt",
  "HYBRID_TOOL_READ_OK\n",
);
const child = spawn(
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  ["app-server", "--stdio"],
  {
    env: {
      ...process.env,
      CODEX_HOME:
        process.env.PROBE_CODEX_HOME || "/tmp/llm-gateway-hybrid-probe/home",
    },
    stdio: ["pipe", "pipe", "ignore"],
  },
);
const pending = new Map();
let id = 0;
const turns = new Map();
const texts = new Map();
let completedTurns = 0;
const log = (x) => console.log(JSON.stringify(x));
createInterface({ input: child.stdout }).on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id !== undefined && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result);
  }
  if (m.method === "item/agentMessage/delta") {
    texts.set(
      m.params.threadId,
      (texts.get(m.params.threadId) || "") + m.params.delta,
    );
    log({
      event: "text_delta",
      thread: m.params.threadId,
      delta: m.params.delta,
    });
  }
  if (m.method === "turn/completed") {
    if (m.params.turn.status === "completed") completedTurns++;
    log({
      event: "turn_completed",
      thread: m.params.threadId,
      status: m.params.turn.status,
    });
    turns.get(m.params.threadId)?.(m.params.turn);
  }
});
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    child.stdin.write(JSON.stringify({ id: n, method, params }) + "\n");
  });
}
async function turn(threadId, model, text) {
  const done = new Promise((resolve) => turns.set(threadId, resolve));
  await call("turn/start", {
    threadId,
    model,
    input: [{ type: "text", text, text_elements: [] }],
  });
  const result = await done;
  if (result.status !== "completed") throw Error(`Turn ${result.status}`);
  return result;
}
const timer = setTimeout(() => {
  log({ event: "timeout" });
  child.kill();
  process.exitCode = 1;
}, 240000);
try {
  await call("initialize", {
    clientInfo: { name: "hybrid_probe", version: "1.0" },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write('{"method":"initialized"}\n');
  const account = await call("account/read", { refreshToken: false });
  log({
    event: "account",
    type: account.account?.type,
    plan: account.account?.planType,
    requiresOpenaiAuth: account.requiresOpenaiAuth,
  });
  assert.equal(account.account?.type, "chatgpt");
  assert.equal(account.requiresOpenaiAuth, true);
  if (process.env.PROBE_ACCOUNT_ONLY) {
    const limits = await call("account/rateLimits/read");
    log({
      event: "rate_limits",
      available: !!limits.rateLimits || !!limits.rateLimitsByLimitId,
      keys: Object.keys(limits),
    });
    assert.ok(limits.rateLimits || limits.rateLimitsByLimitId);
  } else {
    const models = await call("model/list", {});
    log({ event: "models", ids: models.data?.map((x) => x.id) });
    assert.ok(models.data.some((x) => x.id === "gpt-5.5"));
    assert.ok(models.data.some((x) => x.id === "deepseek-v4.1-flash"));
    const a = await call("thread/start", {
      model: "gpt-5.5",
      modelProvider: "openai",
      cwd: "/tmp/llm-gateway-hybrid-probe",
      ephemeral: true,
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    const b = await call("thread/start", {
      model: "deepseek-v4.1-flash",
      modelProvider: "openai",
      cwd: "/tmp/llm-gateway-hybrid-probe",
      ephemeral: true,
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    log({
      event: "threads",
      gpt: a.thread.id,
      deepseek: b.thread.id,
      providers: [a.modelProvider, b.modelProvider],
    });
    await Promise.all([
      turn(
        a.thread.id,
        "gpt-5.5",
        "Reply exactly APP_BACKEND_GPT_OK. No tools.",
      ),
      turn(
        b.thread.id,
        "deepseek-v4.1-flash",
        "Reply exactly APP_BACKEND_DEEPSEEK_OK. No tools.",
      ),
    ]);
    await turn(
      b.thread.id,
      "gpt-5.5",
      "Reply exactly SWITCH_TO_GPT_OK. No tools.",
    );
    await Promise.all([
      turn(
        b.thread.id,
        "deepseek-v4.1-flash",
        "Use a shell tool to read /tmp/llm-gateway-hybrid-probe/probe-marker.txt and report its contents. Do not inspect any other files.",
      ),
      turn(
        a.thread.id,
        "gpt-5.5",
        "Reply exactly GPT_UNAFFECTED_OK. No tools.",
      ),
    ]);
    for (const token of [
      "APP_BACKEND_GPT_OK",
      "APP_BACKEND_DEEPSEEK_OK",
      "SWITCH_TO_GPT_OK",
      "GPT_UNAFFECTED_OK",
      "HYBRID_TOOL_READ_OK",
    ])
      assert.ok(
        [...texts.values()].some((x) => x.includes(token)),
        token,
      );
    assert.equal(completedTurns, 5);
    log({ event: "assertions_passed", completedTurns });
  }
} catch (e) {
  log({ event: "error", message: e.message });
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  child.kill();
}

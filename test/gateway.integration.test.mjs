import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
  );
const json = (res, value, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};
const gatewayEnv = (dir, configPath) => ({
  ...process.env,
  CODEX_LOCAL_ROUTER_HOME: join(dir, "router-home"),
  GATEWAY_CONFIG: configPath,
  GATEWAY_STATE_PATH: join(dir, "gateway-state.json"),
  GATEWAY_INSTANCE_ID: `test-${process.pid}`,
});

for (const failureStatus of [429, 503])
  test(`Gateway forwards session, converts chat, and falls back on ${failureStatus}`, async (t) => {
    let calls = 0;
    let seenSession;
    const upstream = http.createServer((req, res) => {
      if (req.url !== "/v1/chat/completions") return json(res, {});
      calls++;
      seenSession = req.headers["x-opencode-session"];
      if (calls === 1) return json(res, { error: "busy" }, failureStatus);
      let body = "";
      req.on("data", (x) => (body += x));
      req.on("end", () =>
        json(res, {
          id: "chat-1",
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
    const upstreamPort = await listen(upstream);
    const dir = await mkdtemp(join(tmpdir(), "gateway-it-"));
    const config = {
      listen: { host: "127.0.0.1", port: 0 },
      mode: "rules",
      defaultTarget: "primary",
      providers: {
        mock: {
          adapter: "opencode-go",
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          apiKeyEnv: "",
        },
      },
      targets: {
        primary: {
          provider: "mock",
          model: "primary",
          wireApi: "chat_completions",
          capabilities: { toolCalling: true },
        },
        fallback: {
          provider: "mock",
          model: "fallback",
          wireApi: "chat_completions",
          capabilities: { toolCalling: true },
        },
      },
      rules: [],
      fallbackTarget: "fallback",
    };
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify(config));
    const gateway = spawn(process.execPath, ["src/server.mjs"], {
      env: gatewayEnv(dir, configPath),
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(async () => {
      gateway.kill("SIGTERM");
      upstream.close();
      await rm(dir, { recursive: true, force: true });
    });
    const port = await new Promise((resolve, reject) => {
      let out = "";
      gateway.stdout.on("data", (x) => {
        out += x;
        const m = out.match(/127\.0\.0\.1:(\d+)/);
        if (m) resolve(Number(m[1]));
      });
      gateway.on("error", reject);
      setTimeout(() => reject(Error("gateway start timeout")), 5000);
    });
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-session": "session-it",
      },
      body: JSON.stringify({ model: "x", input: "hello" }),
    });
    const value = await response.json();
    assert.equal(response.status, 200);
    assert.equal(value.output_text, "ok");
    assert.equal(calls, 2);
    assert.equal(seenSession, "session-it");
    const state = JSON.parse(await readFile(join(dir, "gateway-state.json"), "utf8"));
    assert.equal(state.configPath, configPath);
    assert.equal(state.instance, `test-${process.pid}`);
  });

test("Gateway falls back after an upstream timeout", async (t) => {
  let calls = 0;
  const upstream = http.createServer((req, res) => {
    calls++;
    if (calls === 1) {
      res.writeHead(200, { "content-type": "application/json" });
      res.flushHeaders();
      const timer = setTimeout(() => res.end(JSON.stringify({ error: "late" })), 1500);
      res.on("close", () => clearTimeout(timer));
      return;
    }
    json(res, {
      choices: [{ message: { role: "assistant", content: "recovered" } }],
    });
  });
  const upstreamPort = await listen(upstream),
    dir = await mkdtemp(join(tmpdir(), "gateway-timeout-"));
  const config = {
    listen: { host: "127.0.0.1", port: 0 },
    mode: "rules",
    defaultTarget: "primary",
    providers: {
      mock: { baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKeyEnv: "" },
    },
    targets: {
      primary: {
        provider: "mock",
        model: "primary",
        wireApi: "chat_completions",
        timeoutMs: 500,
        capabilities: { toolCalling: true },
      },
      fallback: {
        provider: "mock",
        model: "fallback",
        wireApi: "chat_completions",
        capabilities: { toolCalling: true },
      },
    },
    rules: [],
    fallbackTarget: "fallback",
  };
  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  const gateway = spawn(process.execPath, ["src/server.mjs"], {
    env: gatewayEnv(dir, configPath),
    stdio: ["ignore", "pipe", "ignore"],
  });
  t.after(async () => {
    gateway.kill("SIGTERM");
    upstream.close();
    await rm(dir, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    let out = "";
    gateway.stdout.on("data", (x) => {
      out += x;
      const m = out.match(/127\.0\.0\.1:(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    setTimeout(() => reject(Error("gateway start timeout")), 5000);
  });
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "hello" }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).output_text, "recovered");
  assert.equal(calls, 2);
});

test("Gateway does not fallback after a stream has started", async (t) => {
  let calls = 0;
  const upstream = http.createServer((req, res) => {
    calls++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    setTimeout(() => res.destroy(), 20);
  });
  const upstreamPort = await listen(upstream),
    dir = await mkdtemp(join(tmpdir(), "gateway-stream-"));
  const config = {
    listen: { host: "127.0.0.1", port: 0 },
    mode: "rules",
    defaultTarget: "primary",
    providers: {
      mock: { baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKeyEnv: "" },
    },
    targets: {
      primary: {
        provider: "mock",
        model: "primary",
        wireApi: "chat_completions",
        capabilities: { toolCalling: true },
      },
      fallback: {
        provider: "mock",
        model: "fallback",
        wireApi: "chat_completions",
        capabilities: { toolCalling: true },
      },
    },
    rules: [],
    fallbackTarget: "fallback",
  };
  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  const gateway = spawn(process.execPath, ["src/server.mjs"], {
    env: gatewayEnv(dir, configPath),
    stdio: ["ignore", "pipe", "ignore"],
  });
  t.after(async () => {
    gateway.kill("SIGTERM");
    upstream.close();
    await rm(dir, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    let out = "";
    gateway.stdout.on("data", (x) => {
      out += x;
      const m = out.match(/127\.0\.0\.1:(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    setTimeout(() => reject(Error("gateway start timeout")), 5000);
  });
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stream: true, input: "hello" }),
    });
  } catch {
    response = null;
  }
  if (response) {
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /event: error/);
    assert.doesNotMatch(text, /event: response.completed/);
  }
  assert.equal(calls, 1);
});

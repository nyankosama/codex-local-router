import http from "node:http";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { request } from "../src/transport.mjs";
import { createGateway } from "../src/server.mjs";
import { validate } from "../src/config.mjs";
import { writeAcceptanceEvidence } from "./e2e/lib/evidence-path.mjs";
const seen = [];
const log = [];
const relay = http.createServer(async (req, res) => {
  let text = "";
  for await (const c of req) text += c;
  const body = JSON.parse(text);
  seen.push(body.model);
  if (body.model === "controlled-429") {
    res.writeHead(429, { "content-type": "application/json" });
    return res.end("{}");
  }
  try {
    const r = await request("https://opencode.ai/zen/go/v1/responses", {
      headers: {
        authorization: req.headers.authorization,
        "content-type": "application/json",
        "x-opencode-session": req.headers["x-opencode-session"],
        accept: "text/event-stream",
      },
      body,
      timeoutMs: 90000,
    });
    res.writeHead(r.status, { "content-type": "text/event-stream" });
    for await (const c of r.body) res.write(c);
    res.end();
  } catch {
    res.writeHead(502);
    res.end();
  }
});
await new Promise((r) => relay.listen(0, "127.0.0.1", r));
const c = validate({
  mode: "fixed",
  fixedTarget: "primary",
  defaultTarget: "primary",
  fallbackTarget: "fallback",
  providers: {
    go: {
      baseUrl: `http://127.0.0.1:${relay.address().port}`,
      apiKeyEnv: "OPENCODE_GO_API_KEY",
    },
  },
  targets: {
    primary: {
      provider: "go",
      model: "controlled-429",
      wireApi: "responses",
      capabilities: { toolCalling: true },
    },
    fallback: {
      provider: "go",
      model: "deepseek-v4.1-flash",
      wireApi: "responses",
      capabilities: { toolCalling: true },
    },
  },
});
const gw = createGateway(c, { log: (x) => log.push(x) });
await new Promise((r) => gw.server.listen(0, "127.0.0.1", r));
try {
  const r = await fetch(
    `http://127.0.0.1:${gw.server.address().port}/v1/responses`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "controlled",
        input: "Reply FALLBACK_OK",
        stream: false,
      }),
    },
  );
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.status, "completed");
  assert.deepEqual(seen, ["controlled-429", "deepseek-v4.1-flash"]);
  assert.ok(log.some((x) => x.event === "fallback"));
  await writeAcceptanceEvidence("fallback.json", {
    status: r.status,
    seen,
    log,
    output: body.output,
  });
  console.log(
    "Real fallback passed: controlled 429 -> OpenCode Go completed response",
  );
} finally {
  await gw.close();
  await new Promise((r) => relay.close(r));
}

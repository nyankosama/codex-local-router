// Isolated protocol probe. Does not change Codex configuration or read ChatGPT credentials.
// Subscription authentication comes only from the requesting Codex process.
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
const port = Number(process.env.PROBE_PORT || 18789);
const log = (value) => console.log(JSON.stringify(value));
const quote = (value) => JSON.stringify(String(value));
const goSessions = new Map();
const server = http.createServer(async (req, res) => {
  if (req.url === "/healthz") {
    res.end("ok");
    return;
  }
  if (req.method !== "POST" || req.url !== "/v1/responses") {
    res.writeHead(404);
    res.end();
    return;
  }
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 20_000_000) {
      res.writeHead(413);
      res.end();
      return;
    }
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  const thirdParty = body.model === "deepseek-v4.1-flash";
  const id = randomUUID();
  const headers = {
    "content-type": "application/json",
    accept: "text/event-stream",
  };
  let url;
  if (thirdParty) {
    let key = process.env.OPENCODE_GO_API_KEY;
    if (!key) {
      try {
        key = execFileSync(
          "/usr/bin/security",
          [
            "find-generic-password",
            "-a",
            process.env.USER,
            "-s",
            "codex-opencode-go-api-key",
            "-w",
          ],
          { stdio: ["ignore", "pipe", "ignore"] },
        )
          .toString()
          .trim();
      } catch {
        res.writeHead(503);
        res.end('{"error":{"message":"OpenCode Go credential unavailable"}}');
        return;
      }
    }
    headers.authorization = `Bearer ${key}`;
    const sessionKey = req.headers["session-id"] || id;
    if (!goSessions.has(sessionKey)) goSessions.set(sessionKey, randomUUID());
    headers["x-opencode-session"] = `probe_${goSessions.get(sessionKey)}`;
    delete body.client_metadata;
    delete body.prompt_cache_key;
    url = "https://opencode.ai/zen/go/v1/responses";
  } else {
    if (!body.model?.startsWith("gpt-") || !req.headers.authorization) {
      res.writeHead(400);
      res.end();
      return;
    }
    for (const name of [
      "authorization",
      "chatgpt-account-id",
      "openai-beta",
      "originator",
      "user-agent",
      "session-id",
      "thread-id",
      "turn-id",
      "x-codex-turn-metadata",
    ]) {
      if (req.headers[name]) headers[name] = req.headers[name];
    }
    url = "https://chatgpt.com/backend-api/codex/responses";
  }
  log({
    event: "route",
    id,
    model: body.model,
    target: thirdParty ? "opencode-go" : "chatgpt-subscription",
    auth_present: !!req.headers.authorization,
    account_header_present: !!req.headers["chatgpt-account-id"],
    session: req.headers["session-id"],
    input_items: body.input?.length,
    tool_results: body.input?.filter((x) => x.type === "function_call_output")
      .length,
    third_party_identity_stripped: thirdParty,
  });
  // stdin config keeps tokens and request content out of process arguments and files.
  const child = spawn("/usr/bin/curl", [
    "--http1.1",
    "--silent",
    "--show-error",
    "--no-buffer",
    "--include",
    "--suppress-connect-headers",
    "--connect-timeout",
    "15",
    "--max-time",
    "90",
    "--config",
    "-",
  ]);
  child.stdin.on("error", () => {});
  child.stdin.end(
    `url = ${quote(url)}\nrequest = "POST"\n${Object.entries(headers)
      .map(([k, v]) => `header = ${quote(`${k}: ${v}`)}`)
      .join("\n")}\ndata-binary = ${quote(JSON.stringify(body))}\n`,
  );
  let pending = Buffer.alloc(0),
    started = false,
    status = 0,
    completed = false,
    tail = "";
  child.stdout.on("data", (chunk) => {
    if (!started) {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const end = pending.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = pending.subarray(0, end).toString();
        pending = pending.subarray(end + 4);
        status = Number(head.match(/^HTTP\/\S+ (\d+)/)?.[1] || 502);
        if (status < 200) continue;
        const contentType =
          head.match(/content-type: ([^\r\n]+)/i)?.[1] ||
          "application/octet-stream";
        res.writeHead(status, {
          "content-type": contentType,
          "cache-control": "no-cache",
        });
        started = true;
        chunk = pending;
        pending = Buffer.alloc(0);
        break;
      }
    }
    const observed = tail + chunk.toString();
    if (observed.includes("response.completed")) completed = true;
    tail = observed.slice(-100);
    if (!res.write(chunk)) {
      child.stdout.pause();
      res.once("drain", () => child.stdout.resume());
    }
  });
  child.stderr.resume(); // No raw upstream diagnostics, credentials, or response bodies in logs.
  child.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  child.on("close", (code) => {
    log({ event: "done", id, status, exit_code: code, completed });
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  res.on("close", () => {
    if (!res.writableFinished) child.kill();
  });
});
// Probe-only dependency, installed outside the repository. Production transport is not changed.
const { WebSocketServer } = await import(
  process.env.PROBE_WS_MODULE ||
    "/tmp/llm-gateway-hybrid-probe/node_modules/ws/wrapper.mjs"
);
const wss = new WebSocketServer({
  server,
  path: "/v1/responses",
  maxPayload: 20_000_000,
});
wss.on("connection", (ws, request) => {
  const history = new Map();
  let chain = Promise.resolve();
  ws.on("message", (data) => {
    chain = chain
      .then(async () => {
        const message = JSON.parse(data.toString());
        log({
          event: "ws_request",
          type: message.type,
          model: message.model,
          generate: message.generate,
          previous: !!message.previous_response_id,
        });
        if (message.generate === false) {
          const response = {
            id: `probe_warmup_${randomUUID()}`,
            object: "response",
            status: "completed",
            output: [],
          };
          history.set(response.id, []);
          ws.send(
            JSON.stringify({
              type: "response.created",
              response: { ...response, status: "in_progress" },
            }),
          );
          ws.send(JSON.stringify({ type: "response.completed", response }));
          return;
        }
        const body = { ...message, stream: true };
        delete body.type;
        delete body.generate;
        if (body.previous_response_id) {
          const previous = history.get(body.previous_response_id);
          if (!previous) throw Error("unknown previous response");
          body.input = [...previous, ...(body.input || [])];
          delete body.previous_response_id;
        }
        const controller = new AbortController();
        const cancel = () => controller.abort();
        ws.once("close", cancel);
        try {
          const localHeaders = { "content-type": "application/json" };
          for (const name of [
            "authorization",
            "chatgpt-account-id",
            "openai-beta",
            "originator",
            "user-agent",
            "session-id",
            "thread-id",
            "turn-id",
            "x-codex-turn-metadata",
          ])
            if (request.headers[name])
              localHeaders[name] = request.headers[name];
          const response = await fetch(
            `http://127.0.0.1:${port}/v1/responses`,
            {
              method: "POST",
              headers: localHeaders,
              body: JSON.stringify(body),
              signal: controller.signal,
            },
          );
          if (!response.ok) {
            ws.send(
              JSON.stringify({
                type: "error",
                status: response.status,
                error: {
                  type: "upstream_error",
                  message: `Probe upstream HTTP ${response.status}`,
                },
              }),
            );
            return;
          }
          const decoder = new TextDecoder();
          let buffer = "";
          for await (const chunk of response.body) {
            buffer += decoder.decode(chunk, { stream: true });
            let end;
            while ((end = buffer.indexOf("\n\n")) >= 0) {
              const block = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              const payload = block
                .split("\n")
                .filter((x) => x.startsWith("data:"))
                .map((x) => x.slice(5).trim())
                .join("\n");
              if (!payload || payload === "[DONE]") continue;
              const event = JSON.parse(payload);
              if (event.type === "response.completed")
                history.set(event.response.id, [
                  ...(body.input || []),
                  ...(event.response.output || []),
                ]);
              if (ws.readyState === 1) ws.send(payload);
            }
          }
        } finally {
          ws.off("close", cancel);
        }
      })
      .catch((e) => {
        log({ event: "ws_error", name: e.name, code: e.cause?.code });
        if (ws.readyState === 1) ws.close(1011, "probe error");
      });
  });
});
server.listen(port, "127.0.0.1", () => log({ event: "listening", port }));

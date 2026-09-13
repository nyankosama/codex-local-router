import http from "node:http";
import {
  readRequestBody,
  readRequestBodyWithWire,
  readWireBody,
  parseJSON,
} from "./request-body.mjs";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.mjs";
import { Engine } from "./engine.mjs";
import { checkTransport, stopTransport } from "./transport.mjs";
import { openArchive } from "./archive.mjs";
import { createLocalIdentityResolver } from "./local-identity.mjs";
import { fail, publicError } from "./errors.mjs";
import { credential } from "./providers.mjs";
import { PACKAGE_VERSION, PRODUCT_ID } from "./product.mjs";
import { atomicJSON } from "./files.mjs";
import { discoverToolSources } from "./tool-sources.mjs";
import {
  officialRelayUrl,
  relayOfficialHttp,
  validateOfficialRelayPath,
} from "./official-relay.mjs";
import { OfficialWebSocketSession } from "./official-websocket.mjs";
export function createGateway(config, options = {}) {
  const log =
    options.log ??
    ((event) =>
      console.error(JSON.stringify({ at: new Date().toISOString(), ...event })));
  const engine = new Engine(config, { ...options, log }),
    controllers = new Set();
  let accepting = true;
  const json = (res, status, value) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  const entryOf = (path) =>
    path.startsWith("/subscription/v1/") ? "subscription" : "api";
  const equal = (left, right) => {
    const a = Buffer.from(left ?? ""), b = Buffer.from(right ?? "");
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const apiAuthorized = async (headers) => {
    if (!engine.config.access?.required) return true;
    const policy = engine.config.access;
    let token;
    if (policy.tokenFile) token = (await readFile(policy.tokenFile, "utf8")).trim();
    else token = await credential(policy);
    return equal(headers.authorization?.replace(/^Bearer /, ""), token);
  };
  const allowedOrigin = (req) =>
    !req.headers.origin ||
    (engine.config.allowedOrigins ?? []).includes(req.headers.origin);
  const models = (entry) =>
    entry === "subscription"
      ? [
          ...(engine.config.subscription?.models ?? []),
          ...Object.keys(engine.config.subscription?.customModels ?? {}),
        ]
      : Object.values(engine.config.targets).map((t) => t.model);
  const subscriptionAuthorized = async (headers) => {
    if (!engine.config.subscription?.enabled)
      throw fail("subscription_disabled", 404);
    if (!headers.authorization?.startsWith("Bearer "))
      throw fail("subscription_auth_required", 401);
    if (engine.resolveIdentity)
      await engine.resolveIdentity("subscription", headers);
  };
  const controller = () => {
    const c = new AbortController();
    controllers.add(c);
    return c;
  };
  const write = async (res, text, signal) => {
    if (signal.aborted) throw fail("cancelled", 499);
    if (!res.write(text))
      await new Promise((resolve, reject) => {
        const done = () => {
            clean();
            resolve();
          },
          closed = () => {
            clean();
            reject(fail("cancelled", 499));
          },
          clean = () => {
            res.off("drain", done);
            res.off("close", closed);
          };
        res.once("drain", done);
        res.once("close", closed);
      });
  };
  const server = http.createServer(async (req, res) => {
    if (!allowedOrigin(req))
      return json(res, 403, publicError(fail("origin_rejected", 403)));
    if (req.method === "GET" && req.url === "/healthz")
      return json(res, 200, {
        ok: true,
        service: PRODUCT_ID,
        version: PACKAGE_VERSION,
        pid: process.pid,
        subscription: !!engine.config.subscription?.enabled,
        instance: process.env.GATEWAY_INSTANCE_ID ?? null,
        accepting,
        activeTurns: controllers.size,
      });
    const entry = entryOf(req.url);
    try {
      if (entry === "api" && !(await apiAuthorized(req.headers)))
        return json(res, 401, publicError(fail("local_access_denied", 401)));
      if (entry === "subscription") await subscriptionAuthorized(req.headers);
    } catch (error) {
      return json(res, error.status ?? 401, publicError(error));
    }
    const pathname = (() => {
      try { return new URL(req.url, "http://router.invalid").pathname; }
      catch { return ""; }
    })();
    if (req.method === "GET" && pathname === "/v1/models")
      return json(res, 200, {
        object: "list",
        data: [...new Set(models("api"))].map((id) => ({ id, object: "model" })),
      });
    if (entry === "api" && !(req.method === "POST" && pathname === "/v1/responses"))
      return json(res, 404, publicError(fail("not_found", 404)));
    if (entry === "subscription") {
      try { validateOfficialRelayPath(req.url, req.method); }
      catch (error) { return json(res, error.status, publicError(error)); }
    }
    if (!accepting)
      return json(res, 503, publicError(fail("service_draining", 503)));
    if (controllers.size >= (engine.config.maxConnections ?? 64))
      return json(res, 503, publicError(fail("capacity_exceeded", 503)));
    const c = controller(), requestId = randomUUID(), startedAt = Date.now();
    req.on("aborted", () => c.abort());
    res.on("close", () => {
      if (!res.writableFinished) c.abort();
    });
    const bodyStats = {};
    let phase = "request_body", requestModel, responseStreaming = false, responseSequence = 0;
    try {
      const isResponses = pathname === "/subscription/v1/responses" || pathname === "/v1/responses";
      let body, wire;
      if (isResponses) {
        const read = await readRequestBodyWithWire(req, {
          limit: engine.config.maxBodyBytes ?? 20 * 1024 * 1024,
          signal: c.signal,
          stats: bodyStats,
        });
        body = read.body;
        wire = read.wire;
        responseStreaming = body.stream === true;
        requestModel =
          typeof body?.model === "string" && body.model.length <= 200
            ? body.model
            : undefined;
      } else {
        wire = await readWireBody(req, {
          limit: engine.config.maxBodyBytes ?? 20 * 1024 * 1024,
          signal: c.signal,
          stats: bodyStats,
        });
      }

      if (entry === "subscription") {
        const custom = isResponses && engine.config.subscription.customModels?.[body.model];
        let managed = false, officialClassification;
        if (custom) {
          await engine.requireObservedHistory(req.headers, body);
          managed = true;
        } else if (isResponses) {
          officialClassification = await engine.officialRequestNeedsEngine(req.headers, body);
          managed = officialClassification.needsEngine;
        }
        if (!managed) {
          phase = "official_relay";
          const requestWire = wire.length || req.headers["content-length"] || req.headers["transfer-encoding"]
            ? wire
            : undefined;
          const result = await relayOfficialHttp({
            req,
            res,
            wire: requestWire,
            config: engine.config,
            signal: c.signal,
            send: options.officialRequest,
            log,
            observe: isResponses
              ? (observation) => engine.queueOfficialObservation(
                  officialClassification,
                  () => engine.observeOfficial(req.headers, body, observation),
                )
              : undefined,
          });
          log({
            event: "official_relay_completed",
            transport: "http",
            request_id: requestId,
            path: pathname,
            status: result.status,
            response_bytes: result.bytes,
            catalog_injected: result.injected,
            duration_ms: Date.now() - startedAt,
          });
          return;
        }
      }

      phase = "inference";
      res.setHeader("x-gateway-request-id", requestId);
      let response;
      for await (const event of engine.generate(entry, req.headers, body, c.signal)) {
        if (["response.completed", "response.incomplete"].includes(event.type))
          response = event.response;
        if (body.stream) {
          if (!res.headersSent)
            res.writeHead(200, {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
            });
          await write(
            res,
            `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: responseSequence++ })}\n\n`,
            c.signal,
          );
        }
      }
      if (!response) throw fail("upstream_stream_incomplete", 502);
      if (body.stream) res.end();
      else json(res, 200, response);
    } catch (error) {
      log({
        event: "request_error",
        at: new Date().toISOString(),
        transport: "http",
        phase,
        ...bodyStats,
        request_id: requestId,
        model: requestModel,
        duration_ms: Date.now() - startedAt,
        type: error.type ?? "gateway_error",
        status: error.status ?? 502,
        error_name: error.type ? undefined : error.name,
      });
      if (!res.headersSent) json(res, error.status ?? 502, publicError(error));
      else if (
        responseStreaming &&
        ["disallowed_plugin_tool_call", "tool_policy_conflict"].includes(error.type)
      )
        res.end(
          `event: error\ndata: ${JSON.stringify({
            type: "error",
            status: error.status ?? 502,
            ...publicError(error),
            sequence_number: responseSequence++,
          })}\n\n`,
        );
      else res.destroy();
    } finally {
      c.abort();
      controllers.delete(c);
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.maxBodyBytes ?? 20 * 1024 * 1024,
    perMessageDeflate: false,
  });
  server.on("upgrade", async (req, socket, head) => {
    const pathname = (() => {
      try { return new URL(req.url, "http://router.invalid").pathname; }
      catch { return ""; }
    })();
    if (
      !(
        pathname === "/v1/responses" ||
        pathname.startsWith("/subscription/v1/")
      ) ||
      !allowedOrigin(req) ||
      wss.clients.size >= (engine.config.maxConnections ?? 64)
    )
      return socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    if (!accepting)
      return socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    if (entryOf(req.url) === "api" && !(await apiAuthorized(req.headers).catch(() => false)))
      return socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    if (entryOf(req.url) === "subscription") {
      try {
        validateOfficialRelayPath(req.url, "GET");
        await subscriptionAuthorized(req.headers);
      } catch {
        return socket.end(
          "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n",
        );
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req),
    );
  });
  wss.on("connection", (ws, req) => {
    const headers = { ...req.headers };
    if (!headers["thread-id"] && !headers["session-id"])
      headers["session-id"] = randomUUID();
    let busy = false,
      active,
      queue = Promise.resolve(),
      queued = 0;
    const entry = entryOf(req.url);
    const pathname = new URL(req.url, "http://router.invalid").pathname;
    const officialSession = entry === "subscription"
      ? new OfficialWebSocketSession(headers, {
          createSocket: options.createOfficialWebSocket,
          url: officialRelayUrl(req.url, "GET").replace(/^https:/, "wss:"),
          maxPayload: engine.config.maxBodyBytes ?? 20 * 1024 * 1024,
          log,
        })
      : null;
    const send = (event) =>
      new Promise((resolve, reject) => {
        if (ws.readyState !== 1) return reject(fail("cancelled", 499));
        ws.send(JSON.stringify(event), (e) =>
          e ? reject(fail("cancelled", 499)) : resolve(),
        );
      });
    const sendRaw = (data, isBinary) =>
      new Promise((resolve, reject) => {
        if (ws.readyState !== 1) return reject(fail("cancelled", 499));
        ws.send(data, { binary: !!isBinary }, (error) =>
          error ? reject(fail("cancelled", 499)) : resolve(),
        );
      });
    let alive = true;
    ws.on("pong", () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 30000);
    heartbeat.unref();
    ws.on("close", () => {
      clearInterval(heartbeat);
      active?.abort();
      officialSession?.close();
    });
    ws.on("error", () => active?.abort());
    ws.on("message", (data, isBinary) => {
      if (queued >= 8) {
        ws.close(1008, "request queue exceeded");
        return;
      }
      queued++;
      queue = queue
        .then(async () => {
          if (ws.readyState !== 1) {
            queued--;
            return;
          }
          if (controllers.size >= (engine.config.maxConnections ?? 64)) {
            queued--;
            await send({
              type: "error",
              status: 503,
              ...publicError(fail("capacity_exceeded", 503)),
            });
            return;
          }
          busy = true;
          active = controller();
          const startedAt = Date.now(),
            wireBytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
          let seq = 0,
            requestModel,
            phase = "request";
          try {
            if (entry === "subscription" && pathname !== "/subscription/v1/responses") {
              phase = "official_relay";
              await officialSession.run(data, isBinary, {
                signal: active.signal,
                forward: sendRaw,
              });
              return;
            }
            const message = parseJSON(data);
            requestModel =
              typeof message?.model === "string" && message.model.length <= 200
                ? message.model
                : undefined;
            if (message.type !== "response.create")
              throw fail("unsupported_ws_event", 400);
            const body = { ...message, stream: true };
            delete body.type;
            phase = "inference";
            const custom =
              entry === "subscription" &&
              engine.config.subscription.customModels?.[body.model];
            let managed = entry !== "subscription", officialClassification;
            if (custom) {
              await engine.requireObservedHistory(headers, body);
              managed = true;
            } else if (entry === "subscription") {
              officialClassification = await engine.officialRequestNeedsEngine(headers, body);
              managed = officialClassification.needsEngine;
            }
            if (!managed) {
              phase = "official_relay";
              await officialSession.run(data, isBinary, {
                signal: active.signal,
                forward: sendRaw,
                observe: message.generate === false
                  ? undefined
                  : (event) => engine.queueOfficialObservation(
                      officialClassification,
                      () => engine.observeOfficialEvent(headers, body, event),
                    ),
              });
              return;
            }
            delete body.generate;
            if (message.generate === false) {
              // Local protocol prewarm only; route/auth validation still applies.
              engine.route(engine.config, entry, body, { headers });
              const response = {
                id: `warmup_${randomUUID()}`,
                object: "response",
                status: "completed",
                output: [],
              };
              const ctx = await engine.identify(entry, headers, body);
              const warmInput =
                typeof body.input === "string"
                  ? [{ role: "user", content: body.input }]
                  : (body.input ?? []);
              if (!Array.isArray(warmInput)) throw fail("invalid_request", 400);
              // Codex may send tool definitions/prefix in prewarm and only a delta
              // in its next frame. No inference occurs, but the prefix is real state.
              const replay = engine.state.replay(ctx, {
                ...body,
                input: warmInput,
              });
              engine.state.save(ctx, response, replay.body.input, null);
              await send({
                type: "response.created",
                response: { ...response, status: "in_progress" },
                sequence_number: seq++,
              });
              await send({
                type: "response.completed",
                response,
                sequence_number: seq++,
              });
            } else
              for await (const event of engine.generate(
                entryOf(req.url),
                headers,
                body,
                active.signal,
              ))
                await send({ ...event, sequence_number: seq++ });
          } catch (e) {
            log({
              event: "ws_error",
              at: new Date().toISOString(),
              transport: "websocket",
              phase,
              wire_bytes: wireBytes,
              decoded_bytes: wireBytes,
              model: requestModel,
              duration_ms: Date.now() - startedAt,
              ...(e.gatewayContext ?? {}),
              type: e.type ?? "invalid_request",
              status: e.status ?? 400,
              transport_code: e.transportCode,
              transport_category: e.transportCategory,
            });
            await send({
              type: "error",
              status: e.status ?? 400,
              ...publicError(e),
            }).catch(() => {});
          } finally {
            active.abort();
            controllers.delete(active);
            active = null;
            busy = false;
            queued--;
          }
        })
        .catch(() => ws.close(1011));
    });
  });
  return {
    server,
    engine,
    startDrain() {
      accepting = false;
    },
    resume() {
      accepting = true;
    },
    status() {
      return { accepting, activeTurns: controllers.size };
    },
    async close() {
      for (const c of controllers) c.abort();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      if (options.closeArchive) options.archive?.close();
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const path = process.env.GATEWAY_CONFIG ?? "config/gateway.json";
  try {
    checkTransport();
    const config = await loadConfig(path);
    const toolRegistry = await discoverToolSources();
    const persistent = config.history?.persistent;
    const archive = persistent?.enabled
      ? await openArchive(persistent, {
          log: (event) => console.error(JSON.stringify(event)),
        })
      : undefined;
    const gateway = createGateway(config, {
      archive,
      closeArchive: !!archive,
      resolveIdentity: createLocalIdentityResolver(),
      toolRegistry,
    });
    gateway.server.listen(
      config.listen?.port ?? 8788,
      config.listen?.host ?? "127.0.0.1",
      async () => {
        const address = gateway.server.address();
        const statePath = process.env.GATEWAY_STATE_PATH;
        if (statePath)
          await atomicJSON(statePath, {
            pid: process.pid,
            startedAt: Date.now(),
            runningVersion: PACKAGE_VERSION,
            configPath: path,
            instance: process.env.GATEWAY_INSTANCE_ID ?? null,
            url: `http://${config.listen?.host ?? "127.0.0.1"}:${address.port}`,
          }).catch(() => {});
        console.log(
          `gateway listening on http://${config.listen?.host ?? "127.0.0.1"}:${gateway.server.address().port}`,
        );
      },
    );
    process.on("SIGHUP", async () => {
      try {
        gateway.engine.update(await loadConfig(path));
        console.error(JSON.stringify({ event: "config_reloaded" }));
      } catch {
        console.error(JSON.stringify({ event: "config_reload_rejected" }));
      }
    });
    process.on("SIGUSR2", () => {
      gateway.startDrain();
      console.error(JSON.stringify({ event: "service_draining" }));
    });
    process.on("SIGUSR1", () => {
      gateway.resume();
      console.error(JSON.stringify({ event: "service_resumed" }));
    });
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, async () => {
        await gateway.close();
        stopTransport();
      });
  } catch {
    console.error("configuration or transport dependency invalid");
    process.exitCode = 1;
  }
}

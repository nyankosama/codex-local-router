import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { request } from "./transport.mjs";
import { fail } from "./errors.mjs";
const exec = promisify(execFile);
const limiters = new Map();

class Limiter {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }
  async acquire(signal) {
    if (signal?.aborted) throw fail("cancelled", 499);
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      const abort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(fail("cancelled", 499));
      };
      waiter.resolve = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.waiters.push(waiter);
    });
    this.active++;
  }
  release() {
    this.active = Math.max(0, this.active - 1);
    this.waiters.shift()?.resolve();
  }
}

function limiter(key, maximum) {
  const current = limiters.get(key);
  if (current && current.limit === maximum) return current;
  const next = new Limiter(maximum);
  limiters.set(key, next);
  return next;
}

export function providerEndpoint(provider, wireApi) {
  const endpoint =
    provider.endpoints?.[
      wireApi === "responses" ? "responses" : "chatCompletions"
    ] ?? (wireApi === "responses" ? "/v1/responses" : "/v1/chat/completions");
  const url = new URL(provider.baseUrl);
  const base = url.pathname.replace(/\/$/, "");
  if (base.endsWith(endpoint)) return url.toString().replace(/\/$/, "");
  const path = base.endsWith("/v1") && endpoint.startsWith("/v1/")
    ? base + endpoint.slice(3)
    : base + endpoint;
  url.pathname = path.replace(/\/{2,}/g, "/");
  return url.toString().replace(/\/$/, "");
}

function limitedBody(body, release) {
  if (!body?.[Symbol.asyncIterator]) {
    release();
    return body;
  }
  return (async function* () {
    try {
      yield* body;
    } finally {
      release();
    }
  })();
}
export async function credential(p) {
  if (p.apiKeyEnv && process.env[p.apiKeyEnv]) return process.env[p.apiKeyEnv];
  if (p.keychain) {
    try {
      return (
        await exec(
          "/usr/bin/security",
          [
            "find-generic-password",
            "-a",
            p.keychain.account,
            "-s",
            p.keychain.service,
            "-w",
          ],
          { timeout: 5000 },
        )
      ).stdout.trim();
    } catch {
      throw fail("provider_credential_missing", 503);
    }
  }
  if (p.apiKeyEnv) throw fail("provider_credential_missing", 503);
}
export async function callProvider(
  config,
  target,
  body,
  ctx,
  signal,
  send = request,
) {
  const headers = {
    "content-type": "application/json",
    accept: body.stream ? "text/event-stream" : "application/json",
  };
  let url;
  const provider =
    target.provider === "chatgpt-subscription"
      ? { concurrency: config.subscription?.concurrency ?? 8, baseUrl: "subscription" }
      : config.providers[target.provider];
  const gate = limiter(
    `${target.provider}:${provider.baseUrl}`,
    provider.concurrency ?? 4,
  );
  await gate.acquire(signal);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    gate.release();
  };
  try {
  if (target.provider === "chatgpt-subscription") {
    if (ctx.entry !== "subscription" || !ctx.headers.authorization)
      throw fail("subscription_auth_required", 401);
    for (const k of [
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
      if (ctx.headers[k]) headers[k] = ctx.headers[k];
    // WS request metadata, unlike the handshake, changes when a conversation
    // switches between Responses Lite and standard Responses models.
    const lite =
      ctx.responsesLite ??
      (body.client_metadata
        ? body.client_metadata
            .ws_request_header_x_openai_internal_codex_responses_lite === "true"
        : ctx.headers["x-openai-internal-codex-responses-lite"] === "true");
    if (lite) headers["x-openai-internal-codex-responses-lite"] = "true";
    if (body.client_metadata?.["x-codex-turn-metadata"])
      headers["x-codex-turn-metadata"] =
        body.client_metadata["x-codex-turn-metadata"];
    if (ctx.thread) headers["thread-id"] = ctx.thread;
    if (ctx.turn) headers["turn-id"] = ctx.turn;
    url = "https://chatgpt.com/backend-api/codex/responses";
  } else {
    const p = config.providers[target.provider],
      key = await credential(p);
    if (key) headers.authorization = `Bearer ${key}`;
    if (p.adapter === "opencode-go")
      headers["x-opencode-session"] = ctx.channelSession;
    body = { ...body };
    delete body.client_metadata;
    delete body.prompt_cache_key;
    delete body.metadata;
    delete body.session_id;
    url = providerEndpoint(p, target.wireApi);
  }
  const response = await send(url, {
    headers,
    body,
    signal,
    timeoutMs: target.timeoutMs ?? config.timeoutMs ?? 180000,
  });
  response.body = limitedBody(response.body, release);
  return response;
  } catch (error) {
    release();
    throw error;
  }
}

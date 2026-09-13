import { fail } from "./errors.mjs";

function clean(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    ? value
    : undefined;
}

export function searchCorrelation(headers = {}, body = {}) {
  const flat = body.client_metadata ?? {};
  let meta = {};
  try {
    meta = JSON.parse(
      flat["x-codex-turn-metadata"] ?? headers["x-codex-turn-metadata"] ?? "{}",
    );
  } catch {
    meta = {};
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) meta = {};
  return {
    turn: clean(meta.turn_id ?? flat.turn_id ?? headers["turn-id"]),
    thread: clean(meta.thread_id ?? flat.thread_id ?? headers["thread-id"]),
    session: clean(meta.session_id ?? flat.session_id ?? headers["session-id"]),
  };
}

const routeKey = (accountHash, scope, value) =>
  `standalone-search-route:${accountHash}:${scope}:${value}`;

export class StandaloneSearchRoutes {
  constructor(state, { now = () => Date.now(), ttlMs } = {}) {
    this.state = state;
    this.now = now;
    this.ttlMs = ttlMs ?? state.ttlMs;
  }

  save(accountHash, headers, body, route, ctx) {
    const ids = searchCorrelation(headers, body);
    const lease = {
      schemaVersion: 1,
      target: route.target,
      provider: route.provider,
      source: route.source,
      endpoint: route.endpoint ?? null,
      providerBaseUrl: route.providerBaseUrl ?? null,
      credentialRef: route.credentialRef ?? null,
      configDigest: route.configDigest,
      createdAt: this.now(),
      correlation: ids,
    };
    const keys = [];
    if (ids.turn) keys.push(routeKey(accountHash, "turn", ids.turn));
    if (ids.thread) keys.push(routeKey(accountHash, "thread", ids.thread));
    if (ids.session) keys.push(routeKey(accountHash, "session", ids.session));
    keys.push(routeKey(accountHash, "account", "current"));
    for (const key of keys) this.state.set(key, lease, ctx);
    return lease;
  }

  resolve(accountHash, headers, body = {}, { allowAccountFallback = false } = {}) {
    const ids = searchCorrelation(headers, body);
    const hasScopedIdentity = !!(ids.turn || ids.thread || ids.session);
    const candidates = [
      ids.turn && ["turn", ids.turn],
      ids.thread && ["thread", ids.thread],
      ids.session && ["session", ids.session],
      allowAccountFallback && !hasScopedIdentity && ["account", "current"],
    ].filter(Boolean);
    for (const [scope, value] of candidates) {
      const lease = this.state.get(routeKey(accountHash, scope, value));
      if (!lease) continue;
      if (this.now() - lease.createdAt > this.ttlMs) continue;
      return { ...lease, matchedBy: scope };
    }
    return null;
  }
}

export function requireStandaloneSearchRoute(route) {
  if (!route || !["subscription", "provider", "disabled"].includes(route.source))
    throw fail(
      "standalone_search_route_unresolved",
      409,
      "Standalone search could not be associated with a model turn",
    );
  if (route.source === "disabled") throw fail(
    "standalone_search_disabled",
    409,
    "Standalone search is disabled for the selected model",
  );
  return route;
}

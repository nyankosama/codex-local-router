import { createHash } from "node:crypto";

export const STANDALONE_SEARCH_SOURCES = Object.freeze([
  "subscription",
  "provider",
  "disabled",
]);

const sources = new Set(STANDALONE_SEARCH_SOURCES);

export function validateStandaloneSearchSource(source, label = "standalone search source") {
  if (!sources.has(source)) throw Error(`invalid ${label}`);
  return source;
}

function decodedSegments(path) {
  let value = path;
  for (let index = 0; index < 3; index++) {
    let decoded;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      throw Error("invalid provider standalone search endpoint encoding");
    }
    if (decoded === value) break;
    value = decoded;
  }
  return value.replaceAll("\\", "/").split("/");
}

export function normalizeProviderSearchEndpoint(endpoint) {
  if (typeof endpoint !== "string" || !endpoint.trim())
    throw Error("invalid provider standalone search endpoint");
  const raw = endpoint.trim();
  if (
    /^[a-z][a-z\d+.-]*:/i.test(raw) ||
    raw.startsWith("//") ||
    raw.includes("?") ||
    raw.includes("#") ||
    raw.includes("\0") ||
    decodedSegments(raw).some((segment) => segment === "..")
  ) throw Error("invalid provider standalone search endpoint");
  const normalized = raw.replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  if (!normalized || decodedSegments(normalized).some((segment) => segment === "."))
    throw Error("invalid provider standalone search endpoint");
  return normalized;
}

export function providerStandaloneSearchUrl(provider, requestUrl = "/subscription/v1/alpha/search") {
  const endpoint = normalizeProviderSearchEndpoint(provider?.standaloneSearch?.endpoint);
  const base = new URL(provider.baseUrl);
  const inbound = new URL(requestUrl, "http://router.invalid");
  const result = new URL(base);
  result.pathname = `${base.pathname.replace(/\/$/, "")}/${endpoint}`.replace(/\/{2,}/g, "/");
  result.search = inbound.search;
  result.hash = "";
  if (result.origin !== base.origin)
    throw Error("provider standalone search endpoint changed origin");
  return result.toString();
}

export function resolveStandaloneSearchPolicy(config, target, options = {}) {
  const official = options.official === true || target?.provider === "chatgpt-subscription";
  if (official) return {
    source: "subscription",
    reason: "official-subscription",
    advertised: true,
    providerEndpointConfigured: false,
  };

  let source = null;
  let reason =
    target?.modelFamily === "openai-gpt" && target?.app?.enabled === false
      ? "app-disabled"
      : "non-gpt-unchanged";
  if (target?.standaloneSearch?.source != null) {
    source = validateStandaloneSearchSource(
      target.standaloneSearch.source,
      `standalone search source for target ${target.id ?? target.model ?? "unknown"}`,
    );
    reason = "target-explicit";
  } else if (target?.app?.supportsSearchTool != null) {
    source = target.app.supportsSearchTool ? "subscription" : "disabled";
    reason = "legacy-app-support";
  } else if (
    target?.modelFamily === "openai-gpt" &&
    target?.app?.enabled === false
  ) {
    // An explicitly hidden GPT target cannot use the Codex App standalone
    // search carrier. Keep explicit target and legacy alias precedence above,
    // but do not let space defaults or the old native-search compatibility
    // bridge re-advertise a capability that the App cannot reach.
    source = null;
    reason = "app-disabled";
  } else if (
    target?.modelFamily === "openai-gpt" &&
    target?.app?.enabled !== false
  ) {
    source = validateStandaloneSearchSource(
      config?.standaloneSearch?.thirdPartyGpt?.defaultSource ?? "subscription",
      "standaloneSearch.thirdPartyGpt.defaultSource",
    );
    reason = config?.standaloneSearch?.thirdPartyGpt?.defaultSource == null
      ? "third-party-gpt-default"
      : "space-default";
  } else if (target?.capabilities?.nativeWebSearch === true) {
    // Preserve the catalog behavior of old configurations without making
    // nativeWebSearch the new policy authority.
    source = "subscription";
    reason = "legacy-native-search-compatibility";
  }

  const provider = target ? config?.providers?.[target.provider] : null;
  return {
    source,
    reason,
    advertised: source != null && source !== "disabled",
    providerEndpointConfigured:
      source === "provider" && typeof provider?.standaloneSearch?.endpoint === "string",
  };
}

export function standaloneSearchConfigDigest(config, target, policy) {
  const provider = config.providers?.[target.provider];
  const value = {
    target: target.id,
    provider: target.provider,
    source: policy.source,
    baseUrl: provider?.baseUrl ?? null,
    endpoint: policy.source === "provider"
      ? provider?.standaloneSearch?.endpoint ?? null
      : null,
  };
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export const SUBSCRIPTION_SEARCH_DELIVERIES = Object.freeze([
  "standard-tool",
  "disabled",
]);

export function validateSubscriptionSearchDelivery(value, label = "subscription search delivery") {
  if (!SUBSCRIPTION_SEARCH_DELIVERIES.includes(value))
    throw Error(`invalid ${label}`);
  return value;
}

export function resolveSubscriptionSearchPolicy(target) {
  const delivery = target?.subscriptionSearch?.delivery ?? "disabled";
  return {
    delivery,
    reason: target?.subscriptionSearch?.delivery == null
      ? "not-configured"
      : "target-explicit",
    advertised:
      delivery === "standard-tool" && target?.app?.enabled === true,
    carrier: delivery === "standard-tool" ? "hosted-to-standard-function" : "none",
  };
}

export function hostedSearchTool(tools = []) {
  return tools.find(
    (tool) => tool?.type === "web_search" || tool?.type === "web_search_preview",
  ) ?? null;
}

export function hostedSearchRequest(tool) {
  if (!tool) return null;
  const allowedDomains = tool.filters?.allowed_domains ?? tool.allowed_domains;
  if (
    allowedDomains != null &&
    (!Array.isArray(allowedDomains) ||
      allowedDomains.some((domain) => typeof domain !== "string" || !domain.trim()))
  ) throw fail("subscription_search_request_unsupported", 400);

  let mode = tool.mode ?? tool.search_mode;
  if (mode == null && typeof tool.external_web_access === "boolean")
    mode = tool.external_web_access ? "live" : "cached";
  if (mode == null && tool.type === "web_search_preview") mode = "cached";
  if (mode != null && !["cached", "indexed", "live"].includes(mode))
    throw fail("subscription_search_request_unsupported", 400);
  const normalizedDomains = (allowedDomains ?? []).map((value) => {
    const domain = value.trim().toLowerCase().replace(/^\*\./, "");
    let parsed;
    try { parsed = new URL(`https://${domain}`); } catch {
      throw fail("subscription_search_request_unsupported", 400);
    }
    if (
      !parsed.hostname ||
      parsed.hostname !== domain ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) throw fail("subscription_search_request_unsupported", 400);
    return domain;
  });
  return {
    type: tool.type,
    mode: mode ?? null,
    allowedDomains: normalizedDomains,
  };
}
import { fail } from "./errors.mjs";

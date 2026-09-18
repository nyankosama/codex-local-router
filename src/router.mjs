import { hostedSearchRequest, hostedSearchTool } from "./subscription-search.mjs";

export function contextFromRequest(body, headers = {}) {
  const modelID = body.model ?? body.model_id;
  const thinkLevel =
    body.reasoning?.effort ?? body.thinkLevel ?? body.think_level;
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const searchTool = hostedSearchTool(tools);
  return {
    modelID,
    thinkLevel,
    stream: body.stream === true,
    hasTools: tools.length > 0,
    toolNames: tools.map((t) => t.name ?? t.type).filter(Boolean),
    requestedWebSearch: searchTool != null,
    hostedWebSearch: hostedSearchRequest(searchTool),
    routeHeader: headers["x-gateway-route"],
  };
}

function matches(match, ctx) {
  return Object.entries(match ?? {}).every(([key, value]) => {
    if (key === "tool") return ctx.toolNames.includes(value);
    if (key === "hasTools") return ctx.hasTools === value;
    if (key === "routeHeader") return ctx.routeHeader === value;
    return ctx[key] === value;
  });
}

export function decide(config, ctx, requestedModel) {
  if (config.mode === "fixed")
    return { target: config.fixedTarget, rule: "fixed" };
  if (config.mode === "passthrough")
    return { target: null, model: requestedModel, rule: "passthrough" };
  for (const rule of config.rules ?? [])
    if (matches(rule.match, ctx))
      return { target: rule.target, rule: rule.name };
  return { target: config.defaultTarget, rule: "default" };
}

export function planCapabilities(
  target,
  ctx,
  { standaloneSearchSource = null, subscriptionSearchDelivery = "disabled" } = {},
) {
  if (!ctx.requestedWebSearch) return { mode: "none" };
  if (target.capabilities?.nativeWebSearch) return { mode: "native" };
  if (subscriptionSearchDelivery === "standard-tool")
    return { mode: "subscription_bridge", request: ctx.hostedWebSearch };
  if (["subscription", "provider"].includes(standaloneSearchSource))
    return { mode: "unsupported", reason: "standalone_search_protocol_mismatch" };
  if (standaloneSearchSource === "disabled")
    return { mode: "unsupported", reason: "standalone_search_disabled" };
  if (target.capabilities?.toolCalling) return { mode: "tool_fallback" };
  return { mode: "unsupported" };
}

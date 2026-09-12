export function contextFromRequest(body, headers = {}) {
  const modelID = body.model ?? body.model_id;
  const thinkLevel =
    body.reasoning?.effort ?? body.thinkLevel ?? body.think_level;
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return {
    modelID,
    thinkLevel,
    stream: body.stream === true,
    hasTools: tools.length > 0,
    toolNames: tools.map((t) => t.name ?? t.type).filter(Boolean),
    requestedWebSearch: tools.some((t) =>
      /web_search|web-search/.test(t.type ?? t.name ?? ""),
    ),
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

export function planCapabilities(target, ctx) {
  if (!ctx.requestedWebSearch) return { mode: "none" };
  if (target.capabilities?.nativeWebSearch) return { mode: "native" };
  if (target.capabilities?.toolCalling) return { mode: "tool_fallback" };
  return { mode: "unsupported" };
}

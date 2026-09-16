const stableTransportCategories = new Set([
  "connect",
  "empty_response",
  "receive",
  "timeout",
  "tls",
]);

function failedStatus(status) {
  return Number.isFinite(status) && (status < 200 || status >= 300);
}

function stableTransportFailure(category) {
  return typeof category === "string" && stableTransportCategories.has(category);
}

function observedProviderStatusFailure(event) {
  return event.event === "provider_error" && failedStatus(event.status);
}

function observedProviderTransportFailure(event) {
  return event.event === "upstream_transport_error" &&
    stableTransportFailure(event.transportCategory);
}

export function stableProviderFailureObserved(evidence, provider, host) {
  return evidence.outbound.some((event) =>
    event.host === host &&
    (failedStatus(event.status) || stableTransportFailure(event.transportCategory))) ||
    evidence.errors.some((event) =>
      event.provider === provider &&
      (observedProviderStatusFailure(event) || observedProviderTransportFailure(event)));
}

export function classifyThirdPartyChannel({
  passed,
  routeSelected,
  destinationsSafe,
  identitySafe,
  duplicateOutbound,
  lifecycleHealthy,
  gatewayBehaviorSafe = true,
  implicitRetries = 0,
  stableProviderFailure = false,
  directProbeMatched = false,
}) {
  const gatewaySafe = routeSelected &&
    destinationsSafe &&
    identitySafe &&
    !duplicateOutbound &&
    lifecycleHealthy &&
    gatewayBehaviorSafe;
  if (passed && gatewaySafe && implicitRetries === 0) return "HEALTHY";
  if (!gatewaySafe) return "GATEWAY_DEFECT";
  // A retry or replay makes ownership ambiguous even when the second send was
  // blocked by the harness. It can never be used to blame the provider.
  if (implicitRetries > 0) return "UNVERIFIED";
  if (stableProviderFailure || directProbeMatched) return "EXTERNAL_DEGRADED";
  return "UNVERIFIED";
}

export function classifyOfficialWsCancelOutbounds(outbounds) {
  const responses = outbounds.filter((event) =>
    event.transport === "websocket" && event.path.endsWith("/responses"));
  const generations = responses.filter((event) => event.generate !== false);
  const prewarms = responses.filter((event) => event.generate === false);
  const allOfficialUpgraded = responses.length > 0 && responses.every((event) =>
    event.official && event.status === 101);
  return {
    allOfficialUpgraded,
    generationCount: generations.length,
    prewarmCount: prewarms.length,
    passed: allOfficialUpgraded && generations.length === 1,
  };
}

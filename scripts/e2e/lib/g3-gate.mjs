export function codexAppRunningFromProcessList(processList, candidates) {
  return String(processList ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => candidates.some((candidate) =>
      line === candidate || line.startsWith(`${candidate} `)));
}

const ROUTER_CATALOG_KEYS = new Set([
  "gateway_capability_profile",
  "gateway_capability_profile_reason",
  "gateway_tool_surface",
]);

export function officialSearchPrompt() {
  return [
    "Use the normal first-party web search exactly once for OpenAI Codex web search documentation.",
    "Do not make another search even if the result is incomplete.",
    "Then answer briefly, include one OpenAI source hostname from that search, and finish with OFFICIAL_G3_SEARCH_OK.",
    "Do not use shell, files, MCP, plugins, or write actions.",
  ].join(" ");
}

export function g3BudgetForCase(selectedCase) {
  if (selectedCase === "official")
    return { maxTurns: 2, maxGenerations: 6, maxSearchRequests: 1 };
  if (selectedCase === "official-ws")
    return { maxTurns: 1, maxGenerations: 2, maxSearchRequests: 0 };
  return { maxTurns: 5, maxGenerations: 10, maxSearchRequests: 4 };
}

export function detectRouterStateInModelCache(bytes) {
  const text = Buffer.from(bytes ?? "").toString("utf8");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      detected: null,
      status: "unresolved-invalid-json",
    };
  }
  const visit = (item) => {
    if (!item || typeof item !== "object") return false;
    if (Object.keys(item).some((key) => ROUTER_CATALOG_KEYS.has(key))) return true;
    return Object.values(item).some((child) =>
      Array.isArray(child) ? child.some(visit) : visit(child));
  };
  const detected = visit(value) ||
    /codex-local-router|(?:127\.0\.0\.1|localhost):8788/i.test(text);
  return {
    detected,
    status: detected ? "detected" : "absent",
  };
}

export function evaluateModelCacheBoundary({
  before,
  after,
  authoritativeStateUnchanged,
  processTreeWriteDenied,
}) {
  const modelCacheDrift = before?.files?.modelCache?.sha256 !== after?.files?.modelCache?.sha256;
  const appRefreshObserved = before?.appRunning === true || after?.appRunning === true;
  const routerStateAbsent = after?.files?.modelCache?.routerStateDetected === false;
  const modelCacheDriftAllowed = !modelCacheDrift || (
    appRefreshObserved &&
    processTreeWriteDenied === true &&
    authoritativeStateUnchanged === true &&
    routerStateAbsent
  );
  return {
    modelCacheDrift,
    appRefreshObserved,
    routerStateAbsent,
    modelCacheDriftAllowed,
    passed: !modelCacheDrift || modelCacheDriftAllowed,
  };
}

const finiteNonNegative = (value) => Number.isFinite(value) && value >= 0;
const finitePositive = (value) => Number.isFinite(value) && value > 0;

export function evaluateG3CasePerformance({
  name,
  metrics = {},
  outbound = [],
  lifecycle = {},
  channelVerdict = null,
}) {
  const officialSearch = name === "official-cli-natural-search";
  const officialCancel = name === "official-websocket-close-cancel";
  const thirdPartySearch = name === "feei-sol-app-lite-search";
  const thirdPartyGeneration = name === "opencode-deepseek-cli-image-max";
  const knownProfile = officialSearch || officialCancel || thirdPartySearch || thirdPartyGeneration;
  const externalIncomplete = ["EXTERNAL_DEGRADED", "UNVERIFIED"].includes(channelVerdict);
  const responseAccountingComplete = outbound.length > 0 && outbound.every((event) =>
    finitePositive(event.requestBytes) &&
    finiteNonNegative(event.responseBytes) &&
    finiteNonNegative(event.totalMs));
  const expectedCancelledGeneration = officialCancel && outbound.some((event) =>
    event.transport === "websocket" &&
    event.generate !== false &&
    event.responseComplete === false &&
    event.terminationReason === "socket-close" &&
    finiteNonNegative(event.totalMs));
  const localSetupObserved = officialSearch || officialCancel
    ? finiteNonNegative(metrics.localRelaySetupP95Ms)
    : finiteNonNegative(metrics.localRequestSetupP95Ms);
  const localBreakdownObserved = officialSearch || officialCancel
    ? finiteNonNegative(metrics.localRelayRoutePolicyP95Ms)
    : [
        metrics.localRouteP95Ms,
        metrics.localPolicyP95Ms,
        metrics.localIdentityP95Ms,
        metrics.localHistoryReplayP95Ms,
      ].every(finiteNonNegative);
  const upstreamRequired = !externalIncomplete;
  const checks = {
    knownProfile,
    localSetupObserved,
    localBreakdownObserved,
    requestBytesObserved: finitePositive(metrics.requestBytes),
    responseBytesObserved: finiteNonNegative(metrics.responseBytes),
    toolBytesObserved: finiteNonNegative(metrics.toolBytes),
    totalTimeObserved: finiteNonNegative(metrics.upstreamTotalP95Ms),
    responseAccountingComplete,
    healthTimingObserved: finiteNonNegative(metrics.healthP95Ms),
    eventLoopTimingObserved: finiteNonNegative(metrics.eventLoopDelayP99Ms),
    lifecycleClosed: lifecycle.activeTurns === 0 && lifecycle.websocketConnections === 0,
    reconnectsBounded: Number.isInteger(lifecycle.reconnects) && lifecycle.reconnects < 2,
    upstreamHeadersObserved: !upstreamRequired || officialCancel
      ? true
      : finiteNonNegative(metrics.upstreamHeadersP95Ms),
    firstSubstantiveObserved: !upstreamRequired || officialCancel
      ? true
      : finiteNonNegative(metrics.firstSubstantiveP95Ms),
    firstTextObserved: !upstreamRequired || officialCancel
      ? true
      : finiteNonNegative(metrics.firstTextP95Ms),
    searchTimeObserved: !upstreamRequired || !(officialSearch || thirdPartySearch)
      ? true
      : finiteNonNegative(metrics.searchP95Ms),
    successfulResponsesComplete: !upstreamRequired || officialCancel
      ? true
      : outbound.every((event) => event.responseComplete === true),
    cancelledResponseAccounted: officialCancel ? expectedCancelledGeneration : true,
  };
  const metricAvailability = {
    upstreamHeaders: finiteNonNegative(metrics.upstreamHeadersP95Ms)
      ? "observed"
      : officialCancel && expectedCancelledGeneration
        ? "expected-not-observed:cancelled-after-send"
        : externalIncomplete
          ? `not-observed:${channelVerdict.toLowerCase()}`
          : "missing",
    firstSubstantive: finiteNonNegative(metrics.firstSubstantiveP95Ms)
      ? "observed"
      : officialCancel && expectedCancelledGeneration
        ? "expected-not-observed:cancelled-after-send"
        : externalIncomplete
          ? `not-observed:${channelVerdict.toLowerCase()}`
          : "missing",
    firstText: finiteNonNegative(metrics.firstTextP95Ms)
      ? "observed"
      : officialCancel && expectedCancelledGeneration
        ? "expected-not-observed:cancelled-after-send"
        : externalIncomplete
          ? `not-observed:${channelVerdict.toLowerCase()}`
          : "missing",
    search: finiteNonNegative(metrics.searchP95Ms)
      ? "observed"
      : officialCancel || thirdPartyGeneration
        ? "not-applicable:no-search"
        : externalIncomplete
          ? `not-observed:${channelVerdict.toLowerCase()}`
          : "missing",
    archive: finiteNonNegative(metrics.localArchiveP95Ms)
      ? "observed"
      : officialCancel && expectedCancelledGeneration
        ? "not-applicable:cancelled-before-terminal-observation"
        : externalIncomplete
          ? `not-observed:${channelVerdict.toLowerCase()}`
          : "missing",
  };
  if ((officialSearch || thirdPartySearch || thirdPartyGeneration) && upstreamRequired)
    checks.archiveObserved = finiteNonNegative(metrics.localArchiveP95Ms);
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    metricAvailability,
  };
}

export function gatewayAssertionsPass(assertions = {}) {
  return Object.values(assertions).every(Boolean);
}

export function officialCliGatewayAssertions({
  officialDestinationsOnly,
  officialSearchDestinationOnly,
  officialGenerationDestinationOnly,
  identitySafe,
  lifecycleClean,
}) {
  return {
    officialDestinationsOnly,
    officialSearchDestinationOnly,
    officialGenerationDestinationOnly,
    identitySafe,
    lifecycleClean,
  };
}

export function officialWsGatewayAssertions({
  officialDestinationsOnly,
  atMostOneGenerationWs,
  identitySafe,
  clientCloseCancelledAndCleaned,
}) {
  return {
    officialDestinationsOnly,
    atMostOneGenerationWs,
    identitySafe,
    clientCloseCancelledAndCleaned,
  };
}

export function feeiGatewayAssertions({
  officialSearchDestinationOnly,
  providerGenerationDestinationOnly,
  searchResultObserved,
  searchResultReachedProvider,
  identitySafe,
  credentialsScopedToDestination,
  lifecycleClean,
}) {
  return {
    officialSearchDestinationOnly,
    providerGenerationDestinationOnly,
    completedSearchResultForwarded: !searchResultObserved || searchResultReachedProvider,
    identitySafe,
    credentialsScopedToDestination,
    lifecycleClean,
  };
}

export function openCodeGatewayAssertions({
  providerGenerationDestinationOnly,
  imageForwarded,
  maxReasoningForwarded,
  opencodeSessionPresent,
  searchExplicitlyDisabled,
  catalogTruthful,
  identitySafe,
  providerCredentialScoped,
  lifecycleClean,
}) {
  return {
    providerGenerationDestinationOnly,
    imageForwarded,
    maxReasoningForwarded,
    opencodeSessionPresent,
    searchExplicitlyDisabled,
    catalogTruthful,
    identitySafe,
    providerCredentialScoped,
    lifecycleClean,
  };
}

export function gatewayCorePassed({
  harnessError,
  authoritativeStateUnchanged,
  modelCacheBoundaryPassed,
  performanceHealthy,
  gatewayDefect,
  gatewayInvariantsSafe,
}) {
  return !harnessError &&
    authoritativeStateUnchanged === true &&
    modelCacheBoundaryPassed === true &&
    performanceHealthy === true &&
    gatewayDefect === false &&
    gatewayInvariantsSafe === true;
}

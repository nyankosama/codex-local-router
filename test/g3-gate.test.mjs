import test from "node:test";
import assert from "node:assert/strict";
import {
  codexAppRunningFromProcessList,
  detectRouterStateInModelCache,
  evaluateModelCacheBoundary,
  evaluateG3CasePerformance,
  feeiGatewayAssertions,
  gatewayAssertionsPass,
  gatewayCorePassed,
  g3BudgetForCase,
  officialSearchPrompt,
  officialCliGatewayAssertions,
  officialWsGatewayAssertions,
  openCodeGatewayAssertions,
} from "../scripts/e2e/lib/g3-gate.mjs";

test("G3 official search canary asks for one bounded natural search", () => {
  const prompt = officialSearchPrompt();
  assert.match(prompt, /exactly once/);
  assert.match(prompt, /Do not make another search/);
  assert.match(prompt, /OFFICIAL_G3_SEARCH_OK/);
  assert.match(prompt, /OpenAI source hostname/);
});

test("G3 selected official cases use narrower hard budgets", () => {
  assert.deepEqual(g3BudgetForCase("official"), {
    maxTurns: 2,
    maxGenerations: 6,
    maxSearchRequests: 1,
  });
  assert.deepEqual(g3BudgetForCase("official-ws"), {
    maxTurns: 1,
    maxGenerations: 2,
    maxSearchRequests: 0,
  });
  assert.deepEqual(g3BudgetForCase(null), {
    maxTurns: 5,
    maxGenerations: 10,
    maxSearchRequests: 4,
  });
});

const app = "/Applications/Codex.app/Contents/MacOS/Codex";
const boundary = ({
  cache = "same",
  appRunning = false,
  routerStateDetected = false,
} = {}) => ({
  appRunning,
  files: { modelCache: { sha256: cache, routerStateDetected } },
});

test("G3 App detection accepts executable arguments but not helper names", () => {
  assert.equal(codexAppRunningFromProcessList(`${app} --some-argument\n`, [app]), true);
  assert.equal(codexAppRunningFromProcessList("/Applications/Codex.app/Contents/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper\n", [app]), false);
  assert.equal(codexAppRunningFromProcessList("/Applications/Other.app/Contents/MacOS/Other\n", [app]), false);
});

test("G3 model-cache inspection uses stable Router catalog fields and fails closed", () => {
  const official = detectRouterStateInModelCache(JSON.stringify({
    models: [{ slug: "gpt-official", description: "official" }],
  }));
  assert.deepEqual(official, { detected: false, status: "absent" });
  const customized = detectRouterStateInModelCache(JSON.stringify({
    models: [{
      slug: "renamed-model",
      description: "custom description without product or port names",
      gateway_capability_profile: null,
      gateway_capability_profile_reason: "app-absent",
      gateway_tool_surface: "unchanged",
    }],
  }));
  assert.deepEqual(customized, { detected: true, status: "detected" });
  assert.deepEqual(
    detectRouterStateInModelCache("not-json"),
    { detected: null, status: "unresolved-invalid-json" },
  );
});

test("G3 rejects unexplained model cache drift", () => {
  const result = evaluateModelCacheBoundary({
    before: boundary({ cache: "before" }),
    after: boundary({ cache: "after" }),
    authoritativeStateUnchanged: true,
    processTreeWriteDenied: true,
  });
  assert.equal(result.modelCacheDrift, true);
  assert.equal(result.modelCacheDriftAllowed, false);
  assert.equal(result.passed, false);
});

test("G3 allows App cache refresh only with write denial and clean authority", () => {
  const input = {
    before: boundary({ cache: "before", appRunning: true }),
    after: boundary({ cache: "after", appRunning: true }),
    authoritativeStateUnchanged: true,
    processTreeWriteDenied: true,
  };
  assert.equal(evaluateModelCacheBoundary(input).passed, true);
  assert.equal(evaluateModelCacheBoundary({ ...input, processTreeWriteDenied: false }).passed, false);
  assert.equal(evaluateModelCacheBoundary({ ...input, authoritativeStateUnchanged: false }).passed, false);
  assert.equal(evaluateModelCacheBoundary({
    ...input,
    after: boundary({ cache: "after", appRunning: true, routerStateDetected: true }),
  }).passed, false);
  assert.equal(evaluateModelCacheBoundary({
    ...input,
    after: boundary({ cache: "after", appRunning: true, routerStateDetected: null }),
  }).passed, false);
});

const completeOutbound = (overrides = {}) => ({
  transport: "websocket",
  generate: null,
  requestBytes: 100,
  responseBytes: 200,
  responseHeadersMs: 10,
  totalMs: 30,
  firstSubstantiveMs: 15,
  firstTextMs: 20,
  responseComplete: true,
  terminationReason: "terminal-event",
  ...overrides,
});

const completeMetrics = (overrides = {}) => ({
  localRequestSetupP95Ms: null,
  localRelaySetupP95Ms: 2,
  localRelayRoutePolicyP95Ms: 2,
  localRouteP95Ms: null,
  localPolicyP95Ms: null,
  localIdentityP95Ms: null,
  localHistoryReplayP95Ms: null,
  localArchiveP95Ms: 1,
  upstreamHeadersP95Ms: 10,
  firstSubstantiveP95Ms: 15,
  firstTextP95Ms: 20,
  searchP95Ms: 25,
  upstreamTotalP95Ms: 30,
  requestBytes: 100,
  responseBytes: 200,
  toolBytes: 0,
  healthP95Ms: 1,
  eventLoopDelayP99Ms: 5,
  ...overrides,
});

test("G3.5 official search requires complete local, upstream, archive, byte, and lifecycle evidence", () => {
  const input = {
    name: "official-cli-natural-search",
    metrics: completeMetrics(),
    outbound: [completeOutbound()],
    lifecycle: { activeTurns: 0, websocketConnections: 0, reconnects: 0 },
  };
  assert.equal(evaluateG3CasePerformance(input).passed, true);
  for (const key of [
    "localRelaySetupP95Ms",
    "localRelayRoutePolicyP95Ms",
    "localArchiveP95Ms",
    "upstreamHeadersP95Ms",
    "firstSubstantiveP95Ms",
    "firstTextP95Ms",
    "searchP95Ms",
    "upstreamTotalP95Ms",
  ]) {
    const result = evaluateG3CasePerformance({
      ...input,
      metrics: { ...input.metrics, [key]: null },
    });
    assert.equal(result.passed, false, key);
  }
  assert.equal(evaluateG3CasePerformance({
    ...input,
    outbound: [completeOutbound({ responseBytes: null })],
  }).passed, false);
});

test("G3.5 cancellation permits only an explicitly accounted post-send close", () => {
  const input = {
    name: "official-websocket-close-cancel",
    metrics: completeMetrics({
      localArchiveP95Ms: null,
      upstreamHeadersP95Ms: null,
      firstSubstantiveP95Ms: null,
      firstTextP95Ms: null,
      searchP95Ms: null,
      responseBytes: 0,
    }),
    outbound: [completeOutbound({
      generate: true,
      responseBytes: 0,
      responseHeadersMs: null,
      firstSubstantiveMs: null,
      firstTextMs: null,
      responseComplete: false,
      terminationReason: "socket-close",
    })],
    lifecycle: { activeTurns: 0, websocketConnections: 0, reconnects: 0 },
  };
  const result = evaluateG3CasePerformance(input);
  assert.equal(result.passed, true);
  assert.equal(result.metricAvailability.firstText, "expected-not-observed:cancelled-after-send");
  assert.equal(evaluateG3CasePerformance({
    ...input,
    outbound: [completeOutbound({
      generate: true,
      responseBytes: 0,
      totalMs: null,
      responseComplete: false,
      terminationReason: "socket-close",
    })],
  }).passed, false);
});

test("G3.5 third-party success requires route, policy, identity, history, archive, and upstream metrics", () => {
  const input = {
    name: "feei-sol-app-lite-search",
    metrics: completeMetrics({
      localRequestSetupP95Ms: 6,
      localRelaySetupP95Ms: null,
      localRelayRoutePolicyP95Ms: null,
      localRouteP95Ms: 1,
      localPolicyP95Ms: 1,
      localIdentityP95Ms: 2,
      localHistoryReplayP95Ms: 1,
    }),
    outbound: [completeOutbound()],
    lifecycle: { activeTurns: 0, websocketConnections: 0, reconnects: 0 },
    channelVerdict: "HEALTHY",
  };
  assert.equal(evaluateG3CasePerformance(input).passed, true);
  for (const key of [
    "localRequestSetupP95Ms",
    "localRouteP95Ms",
    "localPolicyP95Ms",
    "localIdentityP95Ms",
    "localHistoryReplayP95Ms",
    "localArchiveP95Ms",
  ]) assert.equal(evaluateG3CasePerformance({
    ...input,
    metrics: { ...input.metrics, [key]: null },
  }).passed, false, key);
});

test("G3.5 attributed external failure requires accounting but does not become a Core failure", () => {
  for (const channelVerdict of ["EXTERNAL_DEGRADED", "UNVERIFIED"]) {
    const input = {
      name: "opencode-deepseek-cli-image-max",
      metrics: completeMetrics({
        localRequestSetupP95Ms: 4,
        localRelaySetupP95Ms: null,
        localRelayRoutePolicyP95Ms: null,
        localRouteP95Ms: 1,
        localPolicyP95Ms: 1,
        localIdentityP95Ms: 1,
        localHistoryReplayP95Ms: 0,
        localArchiveP95Ms: null,
        upstreamHeadersP95Ms: null,
        firstSubstantiveP95Ms: null,
        firstTextP95Ms: null,
        searchP95Ms: null,
        responseBytes: 0,
      }),
      outbound: [completeOutbound({
        responseBytes: 0,
        responseHeadersMs: null,
        firstSubstantiveMs: null,
        firstTextMs: null,
        responseComplete: false,
        terminationReason: "transport-error-before-headers",
      })],
      lifecycle: { activeTurns: 0, websocketConnections: 0, reconnects: 0 },
      channelVerdict,
    };
    assert.equal(evaluateG3CasePerformance(input).passed, true, channelVerdict);
    assert.equal(evaluateG3CasePerformance({
      ...input,
      outbound: [{ ...input.outbound[0], responseBytes: null }],
    }).passed, false, `${channelVerdict} still requires explicit zero-byte accounting`);
  }
});

test("G3 Core fails closed on cache, local assertion, and attribution defects", () => {
  const healthy = {
    harnessError: null,
    authoritativeStateUnchanged: true,
    modelCacheBoundaryPassed: true,
    performanceHealthy: true,
    gatewayDefect: false,
    gatewayInvariantsSafe: true,
  };
  assert.equal(gatewayCorePassed(healthy), true);
  for (const key of [
    "authoritativeStateUnchanged",
    "modelCacheBoundaryPassed",
    "performanceHealthy",
    "gatewayInvariantsSafe",
  ]) assert.equal(gatewayCorePassed({ ...healthy, [key]: false }), false);
  assert.equal(gatewayCorePassed({ ...healthy, gatewayDefect: true }), false);
  assert.equal(gatewayCorePassed({ ...healthy, harnessError: { type: "failure" } }), false);
  assert.equal(gatewayAssertionsPass({ route: true, catalog: true }), true);
  assert.equal(gatewayAssertionsPass({ route: true, catalog: false }), false);
});

test("G3 case-local Gateway assertions freeze every attributable boundary", () => {
  const officialCli = officialCliGatewayAssertions({
    officialDestinationsOnly: true,
    officialSearchDestinationOnly: true,
    officialGenerationDestinationOnly: true,
    identitySafe: true,
    lifecycleClean: true,
  });
  const officialWs = officialWsGatewayAssertions({
    officialDestinationsOnly: true,
    atMostOneGenerationWs: true,
    identitySafe: true,
    clientCloseCancelledAndCleaned: true,
  });
  const feei = feeiGatewayAssertions({
    officialSearchDestinationOnly: true,
    providerGenerationDestinationOnly: true,
    searchResultObserved: true,
    searchResultReachedProvider: true,
    identitySafe: true,
    credentialsScopedToDestination: true,
    lifecycleClean: true,
  });
  const opencode = openCodeGatewayAssertions({
    providerGenerationDestinationOnly: true,
    imageForwarded: true,
    maxReasoningForwarded: true,
    opencodeSessionPresent: true,
    searchExplicitlyDisabled: true,
    catalogTruthful: true,
    identitySafe: true,
    providerCredentialScoped: true,
    lifecycleClean: true,
  });
  for (const assertions of [officialCli, officialWs, feei, opencode]) {
    assert.equal(gatewayAssertionsPass(assertions), true);
    for (const key of Object.keys(assertions))
      assert.equal(gatewayAssertionsPass({ ...assertions, [key]: false }), false, key);
  }
  assert.equal(feeiGatewayAssertions({
    ...feei,
    searchResultObserved: true,
    searchResultReachedProvider: false,
  }).completedSearchResultForwarded, false);
});

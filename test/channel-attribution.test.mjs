import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyOfficialWsCancelOutbounds,
  classifyThirdPartyChannel,
  stableProviderFailureObserved,
} from "../scripts/e2e/lib/channel-attribution.mjs";

const safe = {
  routeSelected: true,
  destinationsSafe: true,
  identitySafe: true,
  duplicateOutbound: false,
  lifecycleHealthy: true,
};

test("G3 channel attribution accepts a complete healthy turn", () => {
  assert.equal(classifyThirdPartyChannel({ ...safe, passed: true }), "HEALTHY");
});

test("G3 channel attribution keeps a 200 truncated stream unverified", () => {
  const evidence = {
    outbound: [{ host: "opencode.ai", status: 200 }],
    errors: [{
      event: "ws_error",
      provider: "opencode-go",
      type: "upstream_stream_incomplete",
      status: 502,
    }],
  };
  assert.equal(stableProviderFailureObserved(evidence, "opencode-go", "opencode.ai"), false);
  assert.equal(classifyThirdPartyChannel({
    ...safe,
    passed: false,
    stableProviderFailure: false,
  }), "UNVERIFIED");
});

test("G3 channel attribution recognizes stable provider status or transport failure", () => {
  assert.equal(stableProviderFailureObserved({
    outbound: [{ host: "ai.feei.cn", status: 429 }],
    errors: [],
  }, "feei", "ai.feei.cn"), true);
  assert.equal(stableProviderFailureObserved({
    outbound: [],
    errors: [{
      event: "provider_error",
      provider: "feei",
      type: "provider_error",
      status: 429,
    }],
  }, "feei", "ai.feei.cn"), true);
  assert.equal(stableProviderFailureObserved({
    outbound: [],
    errors: [{
      event: "upstream_transport_error",
      provider: "feei",
      type: "upstream_timeout",
      transportCategory: "timeout",
    }],
  }, "feei", "ai.feei.cn"), true);
  assert.equal(classifyThirdPartyChannel({
    ...safe,
    passed: false,
    stableProviderFailure: true,
  }), "EXTERNAL_DEGRADED");
});

test("G3 channel attribution does not blame provider for proxy or truncated transport", () => {
  for (const transportCategory of ["proxy_dns", "proxy_connect", "truncated", "other"]) {
    assert.equal(stableProviderFailureObserved({
      outbound: [],
      errors: [{ event: "upstream_transport_error", provider: "feei", transportCategory }],
    }, "feei", "ai.feei.cn"), false);
  }
});

test("G3 channel attribution ignores status and transport fields without upstream provenance", () => {
  for (const event of ["request_error", "ws_error", undefined]) {
    assert.equal(stableProviderFailureObserved({
      outbound: [{ host: "opencode.ai", status: 200 }],
      errors: [{
        event,
        provider: "opencode-go",
        type: "upstream_stream_incomplete",
        status: 502,
        transportCategory: "timeout",
      }],
    }, "opencode-go", "opencode.ai"), false);
  }
});

test("G3 channel attribution never calls an ambiguous retry external degradation", () => {
  assert.equal(classifyThirdPartyChannel({
    ...safe,
    passed: false,
    implicitRetries: 1,
    stableProviderFailure: true,
  }), "UNVERIFIED");
});

test("G3 channel attribution fails Gateway-owned boundary violations", () => {
  assert.equal(classifyThirdPartyChannel({
    ...safe,
    passed: false,
    identitySafe: false,
  }), "GATEWAY_DEFECT");
  assert.equal(classifyThirdPartyChannel({
    ...safe,
    passed: false,
    gatewayBehaviorSafe: false,
    stableProviderFailure: true,
  }), "GATEWAY_DEFECT");
});

test("G3 official cancellation counts one generation independently of prewarm", () => {
  const fixture = [
    { transport: "websocket", path: "/backend-api/codex/responses", official: true, status: 101, generate: false },
    { transport: "websocket", path: "/backend-api/codex/responses", official: true, status: 101, generate: null },
  ];
  assert.deepEqual(classifyOfficialWsCancelOutbounds(fixture), {
    allOfficialUpgraded: true,
    generationCount: 1,
    prewarmCount: 1,
    passed: true,
  });
  assert.equal(classifyOfficialWsCancelOutbounds([...fixture, fixture[1]]).passed, false);
  assert.equal(classifyOfficialWsCancelOutbounds([
    { ...fixture[1], official: false },
  ]).passed, false);
});

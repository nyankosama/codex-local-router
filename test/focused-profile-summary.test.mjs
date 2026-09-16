import test from "node:test";
import assert from "node:assert/strict";
import { summarizeFocusedProfiles } from "../scripts/e2e/lib/focused-profile-summary.mjs";

function liteCase(name, passed = true) {
  return {
    name,
    passed,
    capabilityProfile: "lite-search",
    fullToolCompatibilityClaimed: false,
  };
}

test("focused profile summary never promotes definition preflight to qualification", () => {
  const summary = summarizeFocusedProfiles(
    { passed: true },
    [liteCase("feei-sol-app"), liteCase("feei-astra-app")],
  );
  assert.equal(summary.standardTools.status, "DEFINITION_PREFLIGHT_ONLY");
  assert.equal(summary.standardTools.callResultClosure, false);
  assert.equal(summary.liteSearch.status, "PASS");
  assert.equal(summary.combinedStandardToolsAndSearchClaimed, false);
  assert.equal(summary.fullCapabilityProfileQualification, "NOT_ESTABLISHED");
});

test("focused profile summary fails Lite when an expected case is absent or mismatched", () => {
  const absent = summarizeFocusedProfiles(
    { passed: true },
    [liteCase("feei-sol-app")],
  );
  assert.equal(absent.liteSearch.status, "FAIL");
  assert.equal(absent.liteSearch.observedCases, 1);

  const mismatched = summarizeFocusedProfiles(
    { passed: true },
    [
      liteCase("feei-sol-app"),
      { ...liteCase("feei-astra-app"), capabilityProfile: "standard-tools" },
    ],
  );
  assert.equal(mismatched.liteSearch.status, "FAIL");
});

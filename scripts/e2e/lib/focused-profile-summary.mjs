const EXPECTED_LITE_CASES = Object.freeze([
  "feei-sol-app",
  "feei-astra-app",
]);

export function summarizeFocusedProfiles(toolShape, cases) {
  const byName = new Map(cases.map((entry) => [entry.name, entry]));
  const liteCases = EXPECTED_LITE_CASES.map((name) => byName.get(name));
  const liteComplete = liteCases.every(
    (entry) =>
      entry?.capabilityProfile === "lite-search" &&
      entry.fullToolCompatibilityClaimed === false &&
      entry.passed === true,
  );

  return {
    qualificationScope: "routing-and-channel-canary-only",
    standardTools: toolShape
      ? {
          status: toolShape.passed ? "DEFINITION_PREFLIGHT_ONLY" : "FAIL",
          callResultClosure: false,
        }
      : { status: "NOT_RUN", callResultClosure: false },
    liteSearch: {
      status: liteComplete ? "PASS" : "FAIL",
      expectedCases: EXPECTED_LITE_CASES.length,
      observedCases: liteCases.filter(Boolean).length,
      fullToolCompatibilityClaimed: false,
    },
    combinedStandardToolsAndSearchClaimed: false,
    fullCapabilityProfileQualification: "NOT_ESTABLISHED",
  };
}

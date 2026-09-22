export const RELEASE_QUALIFICATION = Object.freeze({
  schemaVersion: 4,
  type: "codex-local-router-release-qualification",
  cases: Object.freeze({
    profiles: Object.freeze([
      "standard_tools_closure",
      "standard_subscription_bridge",
      "cli_http_path",
      "lite_search_closure",
      "websocket_switch_lifecycle",
      "search_streaming_delivery",
    ]),
    universalSearch: Object.freeze([
      "glm-flash-app-subscription-bridge",
      "feei-sol-cli-subscription-bridge",
      "feei-sol-app-tavily",
    ]),
    officialSearch: Object.freeze([
      "official-cached-natural",
      "official-live-explicit",
    ]),
    historyMigration: Object.freeze([
      "official-fork-glm-flash",
      "official-fork-third-party-gpt",
    ]),
  }),
  budgets: Object.freeze({
    universalSearch: Object.freeze({ turns: 3, generations: 8, searches: 3 }),
    officialSearch: Object.freeze({ turns: 2, generations: 9, searches: 6 }),
    historyMigration: Object.freeze({ turns: 20, generations: 36, searches: 0 }),
    total: Object.freeze({ turns: 25, generations: 53, searches: 9 }),
  }),
});

function exactCases(actual, expected) {
  return actual?.length === expected.length &&
    expected.every((name) => actual.some((entry) => entry.name === name && entry.passed === true));
}

function withinBudget(actual = {}, limit) {
  return actual.turns <= limit.turns &&
    actual.generations <= limit.generations &&
    actual.searchRequests <= limit.searches &&
    actual.blockedGenerations === 0 &&
    actual.blockedSearchRequests === 0 &&
    actual.implicitRetries === 0;
}

export function qualifyReleaseReceipts({ profiles, universalSearch, officialSearch, historyMigration }, commit) {
  const drivers = [profiles?.harness, universalSearch?.driver, officialSearch?.driver, historyMigration?.driver];
  const implementationMatches = [profiles, universalSearch, officialSearch, historyMigration]
    .every((receipt) => receipt?.implementation?.commit === commit);
  const driverMatches = drivers.every((driver) =>
    driver?.sha256 && driver.sha256 === drivers[0]?.sha256,
  );
  const universalBudget = universalSearch?.budget ?? {};
  const officialBudget = officialSearch?.budget ?? {};
  const historyBudget = historyMigration?.budget ?? {};
  const budget = {
    turns: (universalBudget.turns ?? 0) + (officialBudget.turns ?? 0) + (historyBudget.turns ?? 0),
    generations: (universalBudget.generations ?? 0) + (officialBudget.generations ?? 0) + (historyBudget.generations ?? 0),
    searchRequests: (universalBudget.searchRequests ?? 0) + (officialBudget.searchRequests ?? 0),
    blockedGenerations: (universalBudget.blockedGenerations ?? 0) + (officialBudget.blockedGenerations ?? 0) + (historyBudget.blockedGenerations ?? 0),
    blockedSearchRequests: (universalBudget.blockedSearchRequests ?? 0) + (officialBudget.blockedSearchRequests ?? 0),
    implicitRetries: (universalBudget.implicitRetries ?? 0) + (officialBudget.implicitRetries ?? 0) + (historyBudget.implicitRetries ?? 0),
    limits: RELEASE_QUALIFICATION.budgets.total,
  };
  const assertions = {
    implementationMatches,
    driverMatches,
    profilesPassed: profiles?.verdict === "PASS" &&
      exactCases(profiles.cases, RELEASE_QUALIFICATION.cases.profiles) &&
      profiles.performance?.softHealthLinesMet === true,
    universalSearchPassed: universalSearch?.verdict === "PASS" &&
      exactCases(universalSearch.cases, RELEASE_QUALIFICATION.cases.universalSearch) &&
      withinBudget(universalBudget, RELEASE_QUALIFICATION.budgets.universalSearch) &&
      universalSearch.mcpInventories?.some((entry) => entry.toolNames?.includes("tavily_search")),
    officialSearchPassed: officialSearch?.verdict === "PASS" &&
      exactCases(officialSearch.cases, RELEASE_QUALIFICATION.cases.officialSearch) &&
      withinBudget(officialBudget, RELEASE_QUALIFICATION.budgets.officialSearch) &&
      officialSearch.websocketProbe?.passed === true,
    historyMigrationPassed: historyMigration?.verdict === "PASS" &&
      exactCases(historyMigration.cases, RELEASE_QUALIFICATION.cases.historyMigration) &&
      historyMigration.lifecycle?.officialHttpObservationPassed === true &&
      historyMigration.lifecycle?.legacyCheckpointRecoveryPassed === true &&
      historyMigration.lifecycle?.summaryReusePassed === true &&
      historyMigration.lifecycle?.gatewayErrorFree === true &&
      withinBudget(historyBudget, RELEASE_QUALIFICATION.budgets.historyMigration),
    totalBudgetPassed: withinBudget(budget, RELEASE_QUALIFICATION.budgets.total),
  };
  return {
    verdict: Object.values(assertions).every(Boolean) ? "PASS" : "FAIL",
    implementation: profiles?.implementation ?? null,
    driver: drivers[0] ?? null,
    budget,
    assertions,
    stages: [
      {
        name: "profiles",
        verdict: profiles?.verdict ?? "NOT_RUN",
        cases: profiles?.cases ?? [],
        performancePassed: profiles?.performance?.softHealthLinesMet === true,
      },
      {
        name: "universal-search",
        verdict: universalSearch?.verdict ?? "NOT_RUN",
        cases: universalSearch?.cases ?? [],
        budget: universalBudget,
        mcpInventoryPassed: universalSearch?.mcpInventories?.some((entry) =>
          entry.toolNames?.includes("tavily_search"),
        ) === true,
      },
      {
        name: "official-search",
        verdict: officialSearch?.verdict ?? "NOT_RUN",
        cases: officialSearch?.cases ?? [],
        budget: officialBudget,
        websocketProbePassed: officialSearch?.websocketProbe?.passed === true,
      },
      {
        name: "history-migration",
        verdict: historyMigration?.verdict ?? "NOT_RUN",
        cases: historyMigration?.cases ?? [],
        budget: historyBudget,
        lifecyclePassed: historyMigration?.lifecycle?.officialHttpObservationPassed === true &&
          historyMigration?.lifecycle?.legacyCheckpointRecoveryPassed === true &&
          historyMigration?.lifecycle?.summaryReusePassed === true &&
          historyMigration?.lifecycle?.gatewayErrorFree === true,
      },
    ].map((stage) => ({
      ...stage,
      cases: stage.cases.map((entry) => ({ name: entry.name, passed: entry.passed })),
    })),
  };
}

export function validateReleaseQualification(summary, commit) {
  const assertionNames = [
    "implementationMatches", "driverMatches", "profilesPassed",
    "universalSearchPassed", "officialSearchPassed", "historyMigrationPassed", "totalBudgetPassed",
  ];
  if (summary?.schemaVersion !== RELEASE_QUALIFICATION.schemaVersion ||
      summary?.type !== RELEASE_QUALIFICATION.type || summary?.verdict !== "PASS" ||
      summary?.implementation?.commit !== commit ||
      !summary?.driver?.sha256 ||
      !assertionNames.every((name) => summary?.assertions?.[name] === true) ||
      !withinBudget(summary?.budget, RELEASE_QUALIFICATION.budgets.total))
    throw Error("release qualification receipt is incomplete");
  const stageNames = ["profiles", "universal-search", "official-search", "history-migration"];
  for (const [index, expected] of Object.values(RELEASE_QUALIFICATION.cases).entries())
    if (summary.stages?.[index]?.name !== stageNames[index] ||
        !exactCases(summary.stages[index].cases, expected) || summary.stages[index].verdict !== "PASS")
      throw Error("release qualification cases are incomplete");
  if (summary.stages[0].performancePassed !== true ||
      summary.stages[1].mcpInventoryPassed !== true ||
      !withinBudget(summary.stages[1].budget, RELEASE_QUALIFICATION.budgets.universalSearch) ||
      summary.stages[2].websocketProbePassed !== true ||
      !withinBudget(summary.stages[2].budget, RELEASE_QUALIFICATION.budgets.officialSearch) ||
      summary.stages[3].lifecyclePassed !== true ||
      !withinBudget(summary.stages[3].budget, RELEASE_QUALIFICATION.budgets.historyMigration))
    throw Error("release qualification stage evidence is incomplete");
  return summary;
}

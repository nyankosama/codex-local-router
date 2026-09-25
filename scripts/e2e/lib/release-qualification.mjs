export const RELEASE_QUALIFICATION = Object.freeze({
  schemaVersion: 8,
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
    compressionCapability: Object.freeze([
      "deepseek",
      "glm-main",
    ]),
    nativeCompaction: Object.freeze([
      "feei-sol-standard",
      "feei-sol-source-lite",
      "feei-astra-standard",
      "feei-astra-source-lite",
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
      "third-party-cross-channel",
    ]),
    appSmoke: Object.freeze(["official-fork-glm-flash"]),
  }),
  budgets: Object.freeze({
    compressionCapability: Object.freeze({ turns: 10, generations: 12, searches: 0 }),
    nativeCompaction: Object.freeze({ turns: 40, generations: 64, searches: 0 }),
    universalSearch: Object.freeze({ turns: 3, generations: 8, searches: 3 }),
    officialSearch: Object.freeze({ turns: 2, generations: 9, searches: 6 }),
    historyMigration: Object.freeze({ turns: 40, generations: 48, searches: 0 }),
    appSmoke: Object.freeze({ turns: 20, generations: 24, searches: 0 }),
    total: Object.freeze({ turns: 115, generations: 165, searches: 9 }),
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

export function qualifyReleaseReceipts({
  deterministic,
  profiles,
  compressionCapability,
  nativeCompaction,
  universalSearch,
  officialSearch,
  historyMigration,
  appSmoke,
}, commit) {
  const drivers = [
    profiles?.harness,
    compressionCapability?.driver,
    nativeCompaction?.driver,
    universalSearch?.driver,
    officialSearch?.driver,
    historyMigration?.driver,
    appSmoke?.driver,
  ];
  const implementationMatches = [
    deterministic,
    profiles,
    compressionCapability,
    nativeCompaction,
    universalSearch,
    officialSearch,
    historyMigration,
    appSmoke,
  ]
    .every((receipt) => receipt?.implementation?.commit === commit);
  const driverMatches = drivers.every((driver) =>
    driver?.sha256 && driver.sha256 === drivers[0]?.sha256,
  );
  const capabilityBudget = compressionCapability?.budget ?? {};
  const nativeBudget = nativeCompaction?.budget ?? {};
  const universalBudget = universalSearch?.budget ?? {};
  const officialBudget = officialSearch?.budget ?? {};
  const historyBudget = historyMigration?.budget ?? {};
  const appSmokeBudget = appSmoke?.budget ?? {};
  const budget = {
    turns: (capabilityBudget.turns ?? 0) + (nativeBudget.turns ?? 0) +
      (universalBudget.turns ?? 0) +
      (officialBudget.turns ?? 0) + (historyBudget.turns ?? 0) +
      (appSmokeBudget.turns ?? 0),
    generations: (capabilityBudget.generations ?? 0) +
      (nativeBudget.generations ?? 0) + (universalBudget.generations ?? 0) +
      (officialBudget.generations ?? 0) +
      (historyBudget.generations ?? 0) + (appSmokeBudget.generations ?? 0),
    searchRequests: (capabilityBudget.searchRequests ?? 0) +
      (universalBudget.searchRequests ?? 0) + (officialBudget.searchRequests ?? 0) +
      (appSmokeBudget.searchRequests ?? 0),
    blockedGenerations: (capabilityBudget.blockedGenerations ?? 0) +
      (nativeBudget.blockedGenerations ?? 0) +
      (universalBudget.blockedGenerations ?? 0) +
      (officialBudget.blockedGenerations ?? 0) +
      (historyBudget.blockedGenerations ?? 0) +
      (appSmokeBudget.blockedGenerations ?? 0),
    blockedSearchRequests: (capabilityBudget.blockedSearchRequests ?? 0) +
      (nativeBudget.blockedSearchRequests ?? 0) +
      (universalBudget.blockedSearchRequests ?? 0) +
      (officialBudget.blockedSearchRequests ?? 0) +
      (appSmokeBudget.blockedSearchRequests ?? 0),
    implicitRetries: (capabilityBudget.implicitRetries ?? 0) +
      (nativeBudget.implicitRetries ?? 0) +
      (universalBudget.implicitRetries ?? 0) +
      (officialBudget.implicitRetries ?? 0) +
      (historyBudget.implicitRetries ?? 0) +
      (appSmokeBudget.implicitRetries ?? 0),
    limits: RELEASE_QUALIFICATION.budgets.total,
  };
  const assertions = {
    implementationMatches,
    driverMatches,
    deterministicPassed: deterministic?.verdict === "PASS" &&
      Object.values(deterministic.checks ?? {}).length === 4 &&
      Object.values(deterministic.checks).every(Boolean),
    profilesPassed: profiles?.verdict === "PASS" &&
      exactCases(profiles.cases, RELEASE_QUALIFICATION.cases.profiles) &&
      profiles.performance?.softHealthLinesMet === true,
    compressionCapabilityPassed: compressionCapability?.verdict === "PASS" &&
      exactCases(
        compressionCapability.cases,
        RELEASE_QUALIFICATION.cases.compressionCapability,
      ) &&
      compressionCapability.cases.every((entry) =>
        ["supported", "provider-unsupported"].includes(entry.result)) &&
      withinBudget(
        capabilityBudget,
        RELEASE_QUALIFICATION.budgets.compressionCapability,
      ),
    nativeCompactionPassed: nativeCompaction?.verdict === "PASS" &&
      exactCases(nativeCompaction.cases, RELEASE_QUALIFICATION.cases.nativeCompaction) &&
      nativeCompaction.cases.every((entry) =>
        entry.assertions?.nativeCompactionsCompleted === true &&
        entry.assertions?.gatewaySummaryCallsZero === true) &&
      withinBudget(nativeBudget, RELEASE_QUALIFICATION.budgets.nativeCompaction),
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
      historyMigration.lifecycle?.appSmokePassed === true &&
      historyMigration.lifecycle?.legacyCheckpointRecoveryPassed === true &&
      historyMigration.lifecycle?.summaryReusePassed === true &&
      historyMigration.lifecycle?.targetCompressionPassed === true &&
      historyMigration.lifecycle?.imageLifecyclePassed === true &&
      historyMigration.lifecycle?.gatewayErrorFree === true &&
      Object.keys(historyMigration.equivalenceCoverage ?? {}).length === 9 &&
      Object.values(historyMigration.equivalenceCoverage ?? {}).every(Boolean) &&
      withinBudget(historyBudget, RELEASE_QUALIFICATION.budgets.historyMigration),
    appSmokePassed: appSmoke?.verdict === "PASS" &&
      appSmoke.mode === "app-smoke" &&
      exactCases(appSmoke.cases, RELEASE_QUALIFICATION.cases.appSmoke) &&
      appSmoke.lifecycle?.appSmokePassed === true &&
      appSmoke.lifecycle?.targetCompressionPassed === true &&
      appSmoke.lifecycle?.imageLifecyclePassed === true &&
      appSmoke.lifecycle?.gatewayErrorFree === true &&
      withinBudget(appSmokeBudget, RELEASE_QUALIFICATION.budgets.appSmoke),
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
        name: "deterministic",
        verdict: deterministic?.verdict ?? "NOT_RUN",
        cases: [],
        checksPassed: Object.values(deterministic?.checks ?? {}).length === 4 &&
          Object.values(deterministic.checks).every(Boolean),
      },
      {
        name: "profiles",
        verdict: profiles?.verdict ?? "NOT_RUN",
        cases: profiles?.cases ?? [],
        performancePassed: profiles?.performance?.softHealthLinesMet === true,
      },
      {
        name: "compression-capability",
        verdict: compressionCapability?.verdict ?? "NOT_RUN",
        cases: compressionCapability?.cases ?? [],
        budget: capabilityBudget,
        conclusive: compressionCapability?.cases?.every((entry) =>
          ["supported", "provider-unsupported"].includes(entry.result)) === true,
      },
      {
        name: "native-compaction",
        verdict: nativeCompaction?.verdict ?? "NOT_RUN",
        cases: nativeCompaction?.cases ?? [],
        budget: nativeBudget,
        channelOwnedCompactionPassed: nativeCompaction?.cases?.every((entry) =>
          entry.assertions?.nativeCompactionsCompleted === true &&
          entry.assertions?.gatewaySummaryCallsZero === true) === true,
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
          historyMigration?.lifecycle?.appSmokePassed === true &&
          historyMigration?.lifecycle?.legacyCheckpointRecoveryPassed === true &&
          historyMigration?.lifecycle?.summaryReusePassed === true &&
          historyMigration?.lifecycle?.targetCompressionPassed === true &&
          historyMigration?.lifecycle?.imageLifecyclePassed === true &&
          historyMigration?.lifecycle?.gatewayErrorFree === true,
        equivalenceCoveragePassed:
          Object.keys(historyMigration?.equivalenceCoverage ?? {}).length === 9 &&
          Object.values(historyMigration?.equivalenceCoverage ?? {}).every(Boolean),
      },
      {
        name: "app-smoke",
        verdict: appSmoke?.verdict ?? "NOT_RUN",
        cases: appSmoke?.cases ?? [],
        budget: appSmokeBudget,
        lifecyclePassed: appSmoke?.mode === "app-smoke" &&
          appSmoke?.lifecycle?.appSmokePassed === true &&
          appSmoke?.lifecycle?.targetCompressionPassed === true &&
          appSmoke?.lifecycle?.imageLifecyclePassed === true &&
          appSmoke?.lifecycle?.gatewayErrorFree === true,
      },
    ].map((stage) => ({
      ...stage,
      cases: stage.cases.map((entry) => ({ name: entry.name, passed: entry.passed })),
    })),
  };
}

export function validateReleaseQualification(summary, commit) {
  const assertionNames = [
    "implementationMatches", "driverMatches", "deterministicPassed",
    "profilesPassed", "compressionCapabilityPassed",
    "nativeCompactionPassed",
    "universalSearchPassed", "officialSearchPassed", "historyMigrationPassed",
    "appSmokePassed", "totalBudgetPassed",
  ];
  if (summary?.schemaVersion !== RELEASE_QUALIFICATION.schemaVersion ||
      summary?.type !== RELEASE_QUALIFICATION.type || summary?.verdict !== "PASS" ||
      summary?.implementation?.commit !== commit ||
      !summary?.driver?.sha256 ||
      !assertionNames.every((name) => summary?.assertions?.[name] === true) ||
      !withinBudget(summary?.budget, RELEASE_QUALIFICATION.budgets.total))
    throw Error("release qualification receipt is incomplete");
  const stageNames = [
    "deterministic",
    "profiles",
    "compression-capability",
    "native-compaction",
    "universal-search",
    "official-search",
    "history-migration",
    "app-smoke",
  ];
  const expectedStages = [[], ...Object.values(RELEASE_QUALIFICATION.cases)];
  for (const [index, expected] of expectedStages.entries())
    if (summary.stages?.[index]?.name !== stageNames[index] ||
        !exactCases(summary.stages[index].cases, expected) || summary.stages[index].verdict !== "PASS")
      throw Error("release qualification cases are incomplete");
  if (summary.stages[0].checksPassed !== true ||
      summary.stages[1].performancePassed !== true ||
      summary.stages[2].conclusive !== true ||
      !withinBudget(
        summary.stages[2].budget,
        RELEASE_QUALIFICATION.budgets.compressionCapability,
      ) ||
      summary.stages[3].channelOwnedCompactionPassed !== true ||
      !withinBudget(summary.stages[3].budget, RELEASE_QUALIFICATION.budgets.nativeCompaction) ||
      summary.stages[4].mcpInventoryPassed !== true ||
      !withinBudget(summary.stages[4].budget, RELEASE_QUALIFICATION.budgets.universalSearch) ||
      summary.stages[5].websocketProbePassed !== true ||
      !withinBudget(summary.stages[5].budget, RELEASE_QUALIFICATION.budgets.officialSearch) ||
      summary.stages[6].lifecyclePassed !== true ||
      summary.stages[6].equivalenceCoveragePassed !== true ||
      !withinBudget(summary.stages[6].budget, RELEASE_QUALIFICATION.budgets.historyMigration) ||
      summary.stages[7].lifecyclePassed !== true ||
      !withinBudget(summary.stages[7].budget, RELEASE_QUALIFICATION.budgets.appSmoke))
    throw Error("release qualification stage evidence is incomplete");
  return summary;
}

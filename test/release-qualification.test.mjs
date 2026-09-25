import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  RELEASE_QUALIFICATION,
  qualifyReleaseReceipts,
  validateReleaseQualification,
} from "../scripts/e2e/lib/release-qualification.mjs";

const exec = promisify(execFile);
const commit = "a".repeat(40);
const driver = { version: "codex-cli fixture", sha256: "b".repeat(64) };
const cases = (names) => names.map((name) => ({ name, passed: true }));

function receipts() {
  return {
    deterministic: {
      verdict: "PASS",
      implementation: { commit },
      checks: { cleanWorktree: true, diffCheck: true, npmTest: true, packageAudit: true },
    },
    profiles: {
      verdict: "PASS",
      implementation: { commit },
      harness: driver,
      performance: { softHealthLinesMet: true },
      cases: cases(RELEASE_QUALIFICATION.cases.profiles),
    },
    compressionCapability: {
      verdict: "PASS",
      implementation: { commit },
      driver,
      budget: {
        turns: 6, generations: 6, searchRequests: 0,
        blockedGenerations: 0, blockedSearchRequests: 0, implicitRetries: 0,
      },
      cases: RELEASE_QUALIFICATION.cases.compressionCapability.map((name) => ({
        name,
        target: name,
        result: "provider-unsupported",
        passed: true,
      })),
    },
    nativeCompaction: {
      verdict: "PASS",
      implementation: { commit },
      driver,
      budget: {
        turns: 32, generations: 56, searchRequests: 0,
        blockedGenerations: 0, blockedSearchRequests: 0, implicitRetries: 0,
      },
      cases: RELEASE_QUALIFICATION.cases.nativeCompaction.map((name) => ({
        name,
        passed: true,
        assertions: {
          nativeCompactionsCompleted: true,
          gatewaySummaryCallsZero: true,
        },
      })),
    },
    universalSearch: {
      verdict: "PASS",
      implementation: { commit },
      driver,
      budget: {
        turns: 3, generations: 8, searchRequests: 3,
        blockedGenerations: 0, blockedSearchRequests: 0, implicitRetries: 0,
      },
      cases: cases(RELEASE_QUALIFICATION.cases.universalSearch),
      mcpInventories: [{ toolNames: ["tavily_search"] }],
    },
    officialSearch: {
      verdict: "PASS",
      implementation: { commit },
      driver,
      budget: {
        turns: 2, generations: 9, searchRequests: 6,
        blockedGenerations: 0, blockedSearchRequests: 0, implicitRetries: 0,
      },
      websocketProbe: { passed: true },
      cases: cases(RELEASE_QUALIFICATION.cases.officialSearch),
    },
    historyMigration: {
      verdict: "PASS",
      implementation: { commit },
      driver,
      budget: {
        turns: 30, generations: 30, searchRequests: 0,
        blockedGenerations: 0, blockedSearchRequests: 0, implicitRetries: 0,
      },
      cases: cases(RELEASE_QUALIFICATION.cases.historyMigration),
      lifecycle: {
        officialHttpObservationPassed: true,
        appSmokePassed: true,
        legacyCheckpointRecoveryPassed: true,
        summaryReusePassed: true,
        targetCompressionPassed: true,
        imageLifecyclePassed: true,
        gatewayErrorFree: true,
      },
      equivalenceCoverage: Object.fromEntries([
        "O->O", "O->G", "O->R", "G->O", "G->G",
        "G->R", "R->O", "R->G", "R->R",
      ].map((name) => [name, true])),
    },
    appSmoke: {
      verdict: "PASS",
      mode: "app-smoke",
      implementation: { commit },
      driver,
      budget: {
        turns: 12, generations: 14, searchRequests: 0,
        blockedGenerations: 0, blockedSearchRequests: 0, implicitRetries: 0,
      },
      cases: cases(RELEASE_QUALIFICATION.cases.appSmoke),
      lifecycle: {
        appSmokePassed: true,
        targetCompressionPassed: true,
        imageLifecyclePassed: true,
        gatewayErrorFree: true,
      },
    },
  };
}

test("release qualification covers the bounded equivalence classes", () => {
  const qualified = qualifyReleaseReceipts(receipts(), commit);
  const summary = {
    schemaVersion: RELEASE_QUALIFICATION.schemaVersion,
    type: RELEASE_QUALIFICATION.type,
    ...qualified,
  };
  assert.equal(summary.verdict, "PASS");
  assert.deepEqual(summary.budget, {
    turns: 85,
    generations: 123,
    searchRequests: 9,
    blockedGenerations: 0,
    blockedSearchRequests: 0,
    implicitRetries: 0,
    limits: RELEASE_QUALIFICATION.budgets.total,
  });
  assert.equal(validateReleaseQualification(summary, commit), summary);

  const missingDeterministic = receipts();
  missingDeterministic.deterministic.checks.npmTest = false;
  assert.equal(qualifyReleaseReceipts(missingDeterministic, commit).verdict, "FAIL");
  const missingAppSmoke = receipts();
  missingAppSmoke.appSmoke.lifecycle.appSmokePassed = false;
  assert.equal(qualifyReleaseReceipts(missingAppSmoke, commit).verdict, "FAIL");
  const overBudget = receipts();
  overBudget.universalSearch.budget.generations = 9;
  assert.equal(qualifyReleaseReceipts(overBudget, commit).verdict, "FAIL");
  const officialOverBudget = receipts();
  officialOverBudget.officialSearch.budget.generations = 10;
  assert.equal(qualifyReleaseReceipts(officialOverBudget, commit).verdict, "FAIL");
  const capabilityOverBudget = receipts();
  capabilityOverBudget.compressionCapability.budget.generations = 13;
  assert.equal(qualifyReleaseReceipts(capabilityOverBudget, commit).verdict, "FAIL");
  const inconclusiveCapability = receipts();
  inconclusiveCapability.compressionCapability.cases[0].result = "inconclusive";
  assert.equal(qualifyReleaseReceipts(inconclusiveCapability, commit).verdict, "FAIL");
  const nativeOverBudget = receipts();
  nativeOverBudget.nativeCompaction.budget.generations = 65;
  assert.equal(qualifyReleaseReceipts(nativeOverBudget, commit).verdict, "FAIL");
  const nativeSummaryFallback = receipts();
  nativeSummaryFallback.nativeCompaction.cases[0].assertions.gatewaySummaryCallsZero = false;
  assert.equal(qualifyReleaseReceipts(nativeSummaryFallback, commit).verdict, "FAIL");
  const historyOverBudget = receipts();
  historyOverBudget.historyMigration.budget.generations = 49;
  assert.equal(qualifyReleaseReceipts(historyOverBudget, commit).verdict, "FAIL");
  const missingLifecycle = receipts();
  missingLifecycle.historyMigration.lifecycle.summaryReusePassed = false;
  assert.equal(qualifyReleaseReceipts(missingLifecycle, commit).verdict, "FAIL");
  const missingCase = receipts();
  missingCase.universalSearch.cases.pop();
  assert.equal(qualifyReleaseReceipts(missingCase, commit).verdict, "FAIL");
});

test("release qualification requires explicit live authorization", async () => {
  await assert.rejects(
    exec(process.execPath, [resolve("scripts/e2e/release-qualification.mjs")]),
    /makes bounded real GLM, ai\.feei, OpenAI and Tavily requests/,
  );
});

test("GitHub Release is blocked on deterministic and protected live qualification", async () => {
  const workflow = await readFile(resolve(".github/workflows/release.yml"), "utf8");
  assert.match(workflow, /live-e2e:\n\s+needs: deterministic/);
  assert.match(workflow, /runs-on: \[self-hosted, macOS, codex-local-router-release\]/);
  assert.match(workflow, /environment: release-live/);
  assert.match(workflow, /npm run e2e:release -- --run/);
  assert.match(workflow, /release:\n\s+needs: \[deterministic, live-e2e\]/);
});

test("release Tavily MCP is pre-approved without weakening user configuration", async () => {
  const harness = await readFile(resolve("scripts/e2e/universal-search-acceptance.mjs"), "utf8");
  assert.match(harness, /default_tools_approval_mode = "approve"/);
  assert.doesNotMatch(harness, /\n\s*'approval_mode = "approve"'/);
});

test("official qualification proves WebSocket through the real search cases", async () => {
  const harness = await readFile(resolve("scripts/e2e/official-search-acceptance.mjs"), "utf8");
  assert.match(harness, /officialWebSocketCompleted/);
  assert.match(harness, /source: "official-search-cases"/);
  assert.doesNotMatch(harness, /OfficialWebSocketSession/);
});

test("release qualification includes bounded compaction, fork and restart migration chains", async () => {
  const harness = await readFile(resolve("scripts/e2e/history-migration-acceptance.mjs"), "utf8");
  assert.match(harness, /thread\/compact\/start/);
  assert.match(harness, /thread\/fork/);
  assert.match(harness, /thread\/resume/);
  assert.match(harness, /maxTurns[^\n]+40/);
  assert.match(harness, /maxGenerations[^\n]+48/);
  assert.match(harness, /nativeMigrationSummary: true/);
  assert.doesNotMatch(harness, /mode: "summary", nativeMigrationSummary/);
  assert.match(harness, /appTransportObserved/);
  assert.match(harness, /officialCompactionObserved/);
  assert.match(harness, /legacyCheckpointRecovered/);
  assert.match(harness, /summaryReusePassed/);
  assert.match(harness, /targetCompressionPassed/);
  assert.match(harness, /imageLifecyclePassed/);
  assert.match(harness, /equivalenceCoverage/);
  assert.match(harness, /third-party-cross-channel/);
  assert.match(harness, /type: "localImage"/);
  assert.match(harness, /capability-receipt/);
  assert.match(harness, /targetId === "deepseek" && deepseekCapability !== "supported"/);
  assert.match(harness, /execFileAsync\("\/bin\/cat"/);
  assert.match(harness, /type: "function_call"/);
  assert.match(harness, /type: "function_call_output"/);
  assert.match(harness, /toolEvidence\?\.executions === 1/);
  assert.match(harness, /commands\.length === 0/);
  assert.match(harness, /entry\.model === targets\[targetId\]\.model/);
  assert.match(harness, /\["request_error", "ws_error"\]\.includes\(entry\.event\)/);
  const sharedHarness = await readFile(resolve("scripts/e2e/lib/harness.mjs"), "utf8");
  assert.match(sharedHarness, /input: input \?\? \[\{ type: "text"/);
  assert.match(harness, /gatewayErrorFree/);
  assert.match(harness, /noReconnectRetries/);
  assert.match(harness, /transport: "websocket"/);
  assert.match(harness, /runHttpObservation/);
  assert.match(harness, /officialHttpTurn/);
  assert.match(harness, /include: \["reasoning\.encrypted_content"\]/);
  assert.match(harness, /reasoning: \{ effort: "low", summary: "auto" \}/);
  assert.match(harness, /"x-codex-turn-metadata": JSON\.stringify\(turnMetadata\)/);
  assert.match(harness, /\.\.\.\(seedTurn\.output \?\? \[\]\)/);
  assert.match(harness, /type: "compaction_trigger"/);
  assert.match(harness, /migrationSummariesAfterReuse === 1/);
  assert.match(harness, /officialHttpObservationPassed/);
  assert.match(harness, /hydrate: true/);
  assert.match(harness, /persistedCheckpoints > 0/);
  assert.match(harness, /failures: failures\.map/);
  assert.match(harness, /targetId: "glm-flash",[\s\S]+legacyCheckpoint: false,[\s\S]+transport: "websocket"/);
  assert.match(harness, /targetId: "feei-sol",[\s\S]+legacyCheckpoint: true,[\s\S]+transport: "websocket"/);
  assert.match(harness, /supportsWebsockets/);
  assert.match(harness, /gateway_http/);
  const releaseHarness = await readFile(resolve("scripts/e2e/release-qualification.mjs"), "utf8");
  assert.match(releaseHarness, /history-migration-acceptance\.mjs/);
  assert.match(releaseHarness, /compression-capability\.mjs/);
});

test("compression capability probe is bounded, isolated and conclusive-only", async () => {
  const harness = await readFile(resolve("scripts/e2e/compression-capability.mjs"), "utf8");
  assert.match(harness, /maxGenerations[^\n]+12/);
  assert.match(harness, /maxTurns[^\n]+10/);
  assert.match(harness, /mode: "native"/);
  assert.match(harness, /provider-unsupported/);
  assert.match(harness, /previous_response_id: normalTurn\.body\?\.id/);
  assert.match(harness, /State the exact synthetic fact from the previous response and end with CONTINUE_OK/);
  assert.match(harness, /providerEndpoint\(provider, "responses"\)/);
  assert.match(harness, /typeof item\?\.content === "string"/);
  assert.match(harness, /\[400, 404, 405, 422, 501\]/);
  assert.match(harness, /compaction_unsupported/);
  assert.match(harness, /no502/);
  assert.match(harness, /\/v1\/responses/);
  assert.match(harness, /gateway-defect/);
  assert.match(harness, /inconclusive/);
  assert.match(harness, /CONTINUE_OK/);
  assert.match(harness, /implicitRetries/);
  assert.match(harness, /post-restart-continuation/);
  assert.match(harness, /transportCode/);
  assert.match(harness, /error\?\.cause\?\.code/);
  assert.match(harness, /summary_started/);
  assert.match(harness, /previous_response_id/);
  assert.match(harness, /gateway\.archive\.history/);
  assert.match(harness, /restartHistoryFactPreserved/);
  assert.match(harness, /responseLineageContinued/);
  assert.doesNotMatch(harness, /archivePath, seed \+ 100/);
  assert.match(harness, /startIsolatedGateway/);
  assert.doesNotMatch(harness, /writeConfigTransaction|beginSpaceSwitch|gracefulRestart/);
  const budget = await readFile(resolve("scripts/e2e/lib/focused-budget.mjs"), "utf8");
  assert.match(budget, /responses\/compact/);
});

test("native compaction qualification is bounded and rejects Gateway summaries", async () => {
  const harness = await readFile(resolve("scripts/e2e/native-compaction-acceptance.mjs"), "utf8");
  assert.match(harness, /maxGenerations[^\n]+64/);
  assert.match(harness, /maxTurns[^\n]+40/);
  assert.match(harness, /mode: "native"/);
  assert.match(harness, /thread\/compact\/start/);
  assert.match(harness, /thread\/resume/);
  assert.match(harness, /model_auto_compact_token_limit = 10000/);
  assert.match(harness, /automaticCompactionObserved/);
  assert.match(harness, /automaticCompactionReachedProvider/);
  assert.match(harness, /automaticFactPreserved/);
  assert.match(harness, /gatewaySummaryCallsZero/);
  assert.match(harness, /compactionFingerprints/);
  assert.match(harness, /source-lite/);
  assert.match(harness, /standard/);
  assert.doesNotMatch(harness, /mode: "summary"/);
});

test("reported fault-history gate uses only isolated rollout and archive copies", async () => {
  const harness = await readFile(resolve("scripts/e2e/native-continuation-fault-acceptance.mjs"), "utf8");
  assert.match(harness, /snapshotArchiveScope/);
  assert.match(harness, /DatabaseSync\(sourcePath, \{ readOnly: true \}\)/);
  assert.match(harness, /sourceArchive\.exec\("BEGIN"\)/);
  assert.match(harness, /referencedHistory/);
  assert.match(harness, /version<=\?/);
  assert.match(harness, /copyRollouts/);
  assert.match(harness, /archived_sessions/);
  assert.match(harness, /rollout_source_outside_history_roots/);
  assert.match(harness, /applyRolloutRecovery/);
  assert.match(harness, /history_observation_incomplete/);
  assert.match(harness, /native_migration_summary_reused/);
  assert.match(harness, /thread-first-migration/);
  assert.match(harness, /native_migration_summary_completed/);
  assert.match(harness, /portableBudgetApplied/);
  assert.match(harness, /completedMigrationPersisted/);
  assert.match(harness, /sourceWriteOperations: 0/);
  assert.match(harness, /sourceArchiveAccess: "sqlite-read-only-scope-snapshot"/);
  assert.doesNotMatch(harness, /mode: "summary"/);
});

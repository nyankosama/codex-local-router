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
    profiles: {
      verdict: "PASS",
      implementation: { commit },
      harness: driver,
      performance: { softHealthLinesMet: true },
      cases: cases(RELEASE_QUALIFICATION.cases.profiles),
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
    turns: 5,
    generations: 17,
    searchRequests: 9,
    blockedGenerations: 0,
    blockedSearchRequests: 0,
    implicitRetries: 0,
    limits: RELEASE_QUALIFICATION.budgets.total,
  });
  assert.equal(validateReleaseQualification(summary, commit), summary);

  const overBudget = receipts();
  overBudget.universalSearch.budget.generations = 9;
  assert.equal(qualifyReleaseReceipts(overBudget, commit).verdict, "FAIL");
  const officialOverBudget = receipts();
  officialOverBudget.officialSearch.budget.generations = 10;
  assert.equal(qualifyReleaseReceipts(officialOverBudget, commit).verdict, "FAIL");
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

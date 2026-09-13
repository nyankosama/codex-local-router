import test from "node:test";
import assert from "node:assert/strict";
import { FocusedAcceptanceBudget } from "../scripts/e2e/lib/focused-budget.mjs";

test("A10 focused acceptance enforces turn and sent-generation hard limits", () => {
  const budget = new FocusedAcceptanceBudget({ maxTurns: 5, maxGenerations: 10 });
  for (let turn = 0; turn < 5; turn++) budget.beginTurn();
  assert.throws(() => budget.beginTurn(), (error) => error.code === "turn_budget_exhausted");

  for (let generation = 0; generation < 10; generation++)
    budget.beforeOutbound({ path: "/v1/responses", model: "fixture" });
  let aborted = 0;
  budget.activeAbort = () => aborted++;
  assert.throws(
    () => budget.beforeOutbound({ path: "/v1/responses", model: "fixture" }),
    (error) => error.code === "generation_budget_exhausted",
  );
  assert.deepEqual(budget.snapshot(), {
    turns: 5,
    maxTurns: 5,
    generations: 10,
    maxGenerations: 10,
    generationAttempts: 11,
    blockedGenerations: 1,
    implicitRetries: 0,
    searchRequests: 0,
    maxSearchRequests: null,
    blockedSearchRequests: 0,
  });
  assert.equal(aborted, 1);
});

test("A10 focused acceptance stops before sending an identical model retry", () => {
  const budget = new FocusedAcceptanceBudget();
  budget.beforeOutbound({
    path: "/v1/responses",
    generate: true,
    requestFingerprint: "same-request",
  });
  let aborted = 0;
  budget.activeAbort = () => aborted++;
  assert.throws(
    () => budget.beforeOutbound({
      path: "/v1/responses",
      generate: true,
      requestFingerprint: "same-request",
    }),
    (error) => error.code === "implicit_model_retry_detected",
  );
  assert.equal(budget.generations, 1);
  assert.equal(budget.generationAttempts, 2);
  assert.equal(budget.blockedGenerations, 1);
  assert.equal(budget.implicitRetries, 1);
  assert.equal(aborted, 1);
});

test("A10 focused acceptance enforces the independent search hard limit", () => {
  const budget = new FocusedAcceptanceBudget({ maxSearchRequests: 2 });
  budget.beforeOutbound({ path: "/codex/alpha/search", official: true });
  budget.beforeOutbound({ path: "/codex/alpha/search", official: true });
  let aborted = 0;
  budget.activeAbort = () => aborted++;
  assert.throws(
    () => budget.beforeOutbound({ path: "/codex/alpha/search", official: true }),
    (error) => error.code === "search_budget_exhausted",
  );
  assert.equal(budget.searchRequests, 2);
  assert.equal(budget.blockedSearchRequests, 1);
  assert.equal(aborted, 1);
});

test("A10 focused acceptance permits official search only and ignores non-generation relay calls", () => {
  const budget = new FocusedAcceptanceBudget();
  budget.beforeOutbound({ path: "/codex/models", official: true });
  budget.beforeOutbound({ path: "/codex/alpha/search", official: true });
  assert.equal(budget.searchRequests, 1);
  assert.equal(budget.generations, 0);
  assert.throws(
    () => budget.beforeOutbound({ path: "/v1/alpha/search", official: false }),
    (error) => error.code === "search_destination_rejected",
  );
  assert.equal(budget.searchRequests, 1);
});

test("A10 focused acceptance counts compressed official Responses without decoded model metadata", () => {
  const budget = new FocusedAcceptanceBudget();
  budget.beforeOutbound({ path: "/backend-api/codex/responses", official: true });
  budget.beforeOutbound({
    path: "/backend-api/codex/responses",
    official: true,
    generate: false,
  });
  assert.equal(budget.generations, 1);
});

import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, loadThresholds, verdict, identityHash } from "../scripts/e2e/lib/criteria.mjs";
import { classifyTurnRepeats, attributeReconnects } from "../scripts/e2e/lib/harness.mjs";
import { parseNodeTestSummary } from "../scripts/e2e/lib/process-output.mjs";

const loaded = await loadThresholds();
const T = loaded.thresholds;

test("Node test summaries accept both legacy and current reporters", () => {
  assert.deepEqual(
    parseNodeTestSummary("# tests 149\n# pass 149\n# fail 0\n"),
    { total: "149", passed: "149", failed: "0" },
  );
  assert.deepEqual(
    parseNodeTestSummary("ℹ tests 149\nℹ pass 149\nℹ fail 0\n"),
    { total: "149", passed: "149", failed: "0" },
  );
});

const base = (over = {}) => ({
  case: "E2E-X",
  runId: "run-1",
  startedAt: 1700000000000,
  entry: { kind: "B", binary: "/tmp/core", sha256: "a".repeat(64), version: "codex-cli 0.0.0" },
  gateway: { url: "http://127.0.0.1:1234", version: "0.2.1" },
  result: "PASS",
  terminal: [{ type: "response.completed" }],
  streams: [
    [
      { type: "response.created", sequence_number: 0 },
      { type: "response.completed", sequence_number: 1 },
    ],
  ],
  clientEvents: [
    { type: "response.created", sequence_number: 0 },
    { type: "response.completed", sequence_number: 1 },
  ],
  truncated: [],
  repeatUpstreamCalls: 0,
  phasesByItemArray: [{}],
  historyWrites: [{ inserted: true, responseIdHash: "r1" }],
  historyWritesAvailable: true,
  completedResponses: 1,
  extraTerminals: [],
  phases: { firstSubstantiveMs: 100, firstTextMs: 200, maxEventGapMs: 10, progressObserved: true },
  toolCalls: [],
  toolResults: [],
  gatewayLogs: [],
  outbound: [],
  health: [{ ms: 10 }],
  errors: [],
  ...over,
});

const pick = (results, id) => results.find((x) => x.id === id);

test("thresholds file is the single source and is hashed", async () => {
  assert.match(loaded.sha256, /^[0-9a-f]{64}$/);
  assert.equal(typeof T.firstTextMs.default, "number");
  assert.equal(typeof T.reconnects.anomalyAt, "number");
  assert.equal(typeof T.healthP95Ms, "number");
});

test("a healthy observation passes every criterion", () => {
  const results = evaluate(base(), T);
  assert.equal(results.length, 10);
  assert.deepEqual(results.filter((x) => x.status !== "pass"), []);
  assert.equal(verdict(results), "PASS");
});

test("H1 rejects a second terminal event in one stream", () => {
  const results = evaluate(
    base({
      streams: [
        [
          { type: "response.created", sequence_number: 0 },
          { type: "response.completed", sequence_number: 1 },
          { type: "response.completed", sequence_number: 2 },
        ],
      ],
    }),
    T,
  );
  assert.equal(pick(results, "H1").status, "fail");
  assert.equal(verdict(results), "FAIL");
});

test("H1 accepts exactly one expected failing terminal", () => {
  const results = evaluate(
    base({
      expectedFailure: true,
      streams: [[{ type: "response.created", sequence_number: 0 }, { type: "error", sequence_number: 1 }]],
      errors: [{ category: "context_length_exceeded" }],
    }),
    T,
  );
  assert.equal(pick(results, "H1").status, "pass");
  assert.equal(pick(results, "H9").status, "pass");
});

test("H2 raises an attributed anomaly for a slow first token", () => {
  const results = evaluate(
    base({
      phases: { firstSubstantiveMs: 1200, firstTextMs: T.firstTextMs.default + 1, maxEventGapMs: 10, progressObserved: true },
      attribution: "upstream_connection_error",
    }),
    T,
  );
  const h2 = pick(results, "H2");
  assert.equal(h2.status, "anomaly");
  assert.match(h2.detail, /upstream_connection_error/);
  assert.equal(verdict(results), "ANOMALY");
});

test("H2 applies the large-request tripwire only above the configured input size", () => {
  const phases = { firstSubstantiveMs: 60000, firstTextMs: 60000, maxEventGapMs: 10, progressObserved: true };
  assert.equal(pick(evaluate(base({ phases }), T), "H2").status, "anomaly");
  assert.equal(
    pick(evaluate(base({ phases, requestBytes: T.firstSubstantiveEventMs.largeInputBytes + 1 }), T), "H2").status,
    "pass",
  );
});

test("H2 without attribution degrades the case to FAIL", () => {
  const results = evaluate(
    base({ phases: { firstSubstantiveMs: 10, firstTextMs: T.firstTextMs.default + 1, maxEventGapMs: 10, progressObserved: true } }),
    T,
  );
  assert.equal(pick(results, "H2").status, "anomaly");
  assert.equal(verdict(results), "FAIL");
});

test("H3 records one repeat and flags two", () => {
  const once = evaluate(base({ repeatUpstreamCalls: 1 }), T);
  assert.equal(pick(once, "H3").status, "record");
  assert.equal(verdict(once), "PASS");
  const twice = evaluate(base({ repeatUpstreamCalls: 2, attribution: "client_retry" }), T);
  assert.equal(pick(twice, "H3").status, "anomaly");
  assert.equal(pick(twice, "H7").status, "pass");
});

test("H3 excludes tool continuations but keeps true re-sends", () => {
  const route = (turn, items) => ({ event: "route", thread: "th", turn, request_kind: "turn", input_items: items });
  const continuation = classifyTurnRepeats([route("t1", 7), route("t1", 10)]);
  assert.equal(continuation.reconnects.length, 0);
  assert.equal(continuation.continuations.length, 1);
  const resend = classifyTurnRepeats([route("t2", 7), route("t2", 7)]);
  assert.equal(resend.reconnects.length, 1);
  assert.equal(resend.continuations.length, 0);
  const shrunk = classifyTurnRepeats([route("t3", 9), route("t3", 4)]);
  assert.equal(shrunk.reconnects.length, 1);
  const results = evaluate(base({ repeatUpstreamCalls: 0, continuationRequests: 2, reconnectDetail: [], continuationDetail: [{ key: "k" }] }), T);
  assert.equal(pick(results, "H3").status, "pass");
  assert.match(pick(results, "H3").detail, /continuation/);
  assert.equal(verdict(results), "PASS");
});

test("H4 rejects duplicate tool execution and orphaned calls", () => {
  const duplicate = evaluate(
    base({
      toolCalls: [{ call_id: "c1", status: "completed" }, { call_id: "c1", status: "completed" }],
      toolResults: [{ call_id: "c1" }],
    }),
    T,
  );
  assert.equal(pick(duplicate, "H4").status, "fail");
  const orphan = evaluate(
    base({ toolCalls: [{ call_id: "c2", status: "completed" }], toolsExecutedLocally: true }),
    T,
  );
  assert.equal(pick(orphan, "H4").status, "fail");
});

test("H5 rejects sequence gaps and unstable phases", () => {
  const gap = evaluate(
    base({
      streams: [
        [
          { type: "response.created", sequence_number: 0 },
          { type: "response.output_text.delta", sequence_number: 2 },
        ],
      ],
    }),
    T,
  );
  assert.equal(pick(gap, "H5").status, "fail");
  const phase = evaluate(base({ phasesByItemArray: [{ m1: { added: "final_answer", done: "commentary" } }] }), T);
  assert.equal(pick(phase, "H5").status, "fail");
});

test("H5 evaluates every stream independently", () => {
  const results = evaluate(
    base({
      streams: [
        [
          { type: "response.created", sequence_number: 0 },
          { type: "response.completed", sequence_number: 1 },
        ],
        [
          { type: "response.created", sequence_number: 0 },
          { type: "response.completed", sequence_number: 1 },
        ],
      ],
    }),
    T,
  );
  assert.equal(pick(results, "H5").status, "pass");
  const broken = evaluate(
    base({
      streams: [
        [
          { type: "response.created", sequence_number: 0 },
          { type: "response.completed", sequence_number: 1 },
        ],
        [
          { type: "response.created", sequence_number: 0 },
          { type: "response.output_text.delta", sequence_number: 5 },
        ],
      ],
    }),
    T,
  );
  assert.equal(pick(broken, "H5").status, "fail");
});

test("H1 accepts labelled client terminals only when successful", () => {
  const pass = evaluate(base({ extraTerminals: ["app:completed", "probe:completed"] }), T);
  assert.equal(pick(pass, "H1").status, "pass");
  const fail = evaluate(base({ extraTerminals: ["app:completed", "app:failed"], attribution: "client_error" }), T);
  assert.equal(pick(fail, "H1").status, "fail");
  assert.equal(verdict(fail), "FAIL");
});

test("H3 attribution is derived only from a prior transport error on the same turn", () => {
  const reconnect = { key: "th:turn:turn" };
  const explained = evaluate(
    base({
      repeatUpstreamCalls: 2,
      attributionByCriterion: {
        H3: attributeReconnects({
          reconnects: [reconnect],
          logs: [{ event: "ws_error", thread: "th", turn: "turn", transport_category: "truncated" }],
        }),
      },
    }),
    T,
  );
  assert.equal(pick(explained, "H3").status, "anomaly");
  assert.match(pick(explained, "H3").detail, /upstream_truncated_then_client_retry/);
  assert.equal(verdict(explained), "ANOMALY");
  const unexplained = evaluate(base({ repeatUpstreamCalls: 2 }), T);
  assert.equal(pick(unexplained, "H3").status, "anomaly");
  assert.equal(verdict(unexplained), "FAIL");
  assert.equal(
    attributeReconnects({ reconnects: [reconnect], logs: [{ event: "ws_error", thread: "other", turn: "turn" }] }),
    undefined,
  );
});

test("H8 anomaly attribution is per criterion and cannot leak to other criteria", () => {
  const results = evaluate(
    base({
      health: [{ ms: T.healthP95Ms + 1 }],
      repeatUpstreamCalls: 2,
      attributionByCriterion: { H3: "upstream_truncated_then_client_retry" },
    }),
    T,
  );
  assert.equal(pick(results, "H8").status, "anomaly");
  assert.match(pick(results, "H8").detail, /unattributed/);
  assert.equal(pick(results, "H3").status, "anomaly");
  assert.match(pick(results, "H3").detail, /truncated/);
  assert.equal(verdict(results), "FAIL");
});

test("H5 is n/a only with a recorded delegation reason", () => {
  const delegated = evaluate(
    base({ streams: [], extraTerminals: ["completed"], sequenceEvidence: "covered by E2E-1/2/3" }),
    T,
  );
  assert.equal(pick(delegated, "H5").status, "n/a");
  assert.equal(verdict(delegated), "PASS");
  const missing = evaluate(base({ streams: [] }), T);
  assert.equal(pick(missing, "H5").status, "fail");
  assert.equal(verdict(missing), "FAIL");
});

test("H6 blocks subscription credentials crossing to a third party", () => {
  const results = evaluate(
    base({
      outbound: [
        { host: "opencode.ai", official: false, subscriptionBearer: true, accountHeader: false },
      ],
    }),
    T,
  );
  assert.equal(pick(results, "H6").status, "fail");
  assert.equal(verdict(results), "FAIL");
});

test("H6 blocks sensitive values inside the artifact payload", () => {
  const results = evaluate(base({ note: "SECRET_MARKER_VALUE_123456" }), T, ["SECRET_MARKER_VALUE_123456"]);
  assert.equal(pick(results, "H6").status, "fail");
});

test("H7 rejects a duplicated history write for the same response", () => {
  const results = evaluate(
    base({
      historyWrites: [
        { inserted: true, responseIdHash: "r1" },
        { inserted: true, responseIdHash: "r1" },
      ],
      completedResponses: 1,
    }),
    T,
  );
  assert.equal(pick(results, "H7").status, "fail");
  assert.equal(verdict(results), "FAIL");
});

test("H7 rejects a missing history write for a completed response", () => {
  const results = evaluate(base({ historyWrites: [], completedResponses: 2 }), T);
  assert.equal(pick(results, "H7").status, "fail");
});

test("H7 ignores reconnects but accepts multiple distinct responses", () => {
  const results = evaluate(
    base({
      repeatUpstreamCalls: 1,
      historyWrites: [
        { inserted: true, responseIdHash: "r1" },
        { inserted: true, responseIdHash: "r2" },
        { inserted: false, responseIdHash: "r2" },
      ],
      completedResponses: 2,
    }),
    T,
  );
  assert.equal(pick(results, "H7").status, "pass");
  assert.equal(pick(results, "H3").status, "record");
});

test("H8 flags degraded health and unattributed resource anomalies", () => {
  const results = evaluate(
    base({ health: [{ ms: T.healthP95Ms + 1 }], attribution: "sqlite_main_thread" }),
    T,
  );
  assert.equal(pick(results, "H8").status, "anomaly");
  assert.equal(verdict(results), "ANOMALY");
  const idle = evaluate(base({ activeTurnsIdle: false, attribution: "drain_stuck" }), T);
  assert.equal(pick(idle, "H8").status, "anomaly");
});

test("H9 rejects vague error categories", () => {
  const results = evaluate(base({ errors: [{ category: "other" }] }), T);
  assert.equal(pick(results, "H9").status, "fail");
  assert.equal(
    pick(evaluate(base({ errors: [{ category: "upstream_timeout" }] }), T), "H9").status,
    "pass",
  );
});

test("H10 rejects an incomplete artifact", () => {
  const results = evaluate(base({ entry: { kind: "B" }, gateway: {} }), T);
  assert.equal(pick(results, "H10").status, "fail");
});

test("identity hashing matches the gateway correlation field", () => {
  assert.equal(identityHash("thread-1"), identityHash("thread-1"));
  assert.equal(identityHash("thread-1").length, 20);
  assert.notEqual(identityHash("thread-1"), identityHash("thread-2"));
});

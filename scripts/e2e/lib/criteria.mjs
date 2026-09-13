// H1-H10 横向判据求值器。只读 docs/e2e/thresholds.json，不内嵌任何阈值数字。
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const THRESHOLDS_PATH = join(here, "..", "..", "..", "docs", "e2e", "thresholds.json");

export const identityHash = (value) =>
  createHash("sha256").update(value).digest("hex").slice(0, 20);

export async function loadThresholds(path = THRESHOLDS_PATH) {
  const raw = await readFile(path);
  return { thresholds: JSON.parse(raw.toString("utf8")), sha256: createHash("sha256").update(raw).digest("hex") };
}

const bytesOf = (observation) => observation.requestBytes ?? 0;
const isLarge = (observation, thresholds) =>
  bytesOf(observation) > thresholds.firstSubstantiveEventMs.largeInputBytes;

const TERMINAL = ["response.completed", "response.incomplete", "response.failed", "error"];
const SUBSTANTIVE = (event) =>
  typeof event?.type === "string" &&
  !["response.created", "response.in_progress", "response.queued", "response.completed", "response.incomplete", "response.failed", "error", "ping"].includes(event.type);

const status = (id, verdict, detail, extra = {}) => ({ id, status: verdict, detail, ...extra });
// ANOMALY 必须归因到具体分类；未归因的越界按 FAIL 处理。
const anomaly = (id, detail, observation) => {
  // 逐判据归因优先：不同 H 判据的异常可能来自不同层。
  const attribution = observation.attributionByCriterion?.[id] ?? observation.attribution;
  return status(id, "anomaly", `${detail} [${attribution ?? "unattributed"}]`, {
    attributed: typeof attribution === "string" && attribution.trim().length > 0,
  });
};

// H1 完成性：终态唯一且为 completed，无 error/failed。
function h1(observation) {
  const streams = observation.streams ?? [];
  const extraTerminals = observation.extraTerminals ?? [];
  for (const [index, events] of streams.entries()) {
    const terminals = events.filter((x) => TERMINAL.includes(x.type));
    if (observation.expectedFailure) {
      const failures = terminals.filter((x) => x.type !== "response.completed");
      if (failures.length !== 1 || terminals.length !== 1)
        return status("H1", "fail", `stream ${index}: expected exactly one failing terminal, saw ${JSON.stringify(terminals.map((x) => x.type))}`);
      continue;
    }
    const failures = terminals.filter((x) => x.type !== "response.completed");
    if (failures.length) return status("H1", "fail", `stream ${index}: non-success terminal ${failures.map((x) => x.type).join(",")}`);
    const completed = terminals.filter((x) => x.type === "response.completed");
    if (completed.length !== 1) return status("H1", "fail", `stream ${index}: expected exactly 1 completed terminal, saw ${completed.length}`);
  }
  const terminalValue = (x) => (String(x).includes(":") ? String(x).slice(String(x).lastIndexOf(":") + 1) : String(x));
  const badTerminals = extraTerminals.filter((x) => terminalValue(x) !== "completed");
  if (badTerminals.length) return status("H1", "fail", `non-success client terminal: ${badTerminals.join(",")}`);
  if (!streams.length && !extraTerminals.length) return status("H1", "fail", "no client terminal observed");
  if ((observation.truncated ?? []).length) return status("H1", "fail", `unexpected stream truncation: ${observation.truncated.join(",")}`);
  return status("H1", "pass", `${streams.length} stream(s) + ${extraTerminals.length} client terminal(s) completed`);
}

// H2 前进性：首实质事件 / 首文本 / 相邻事件间隔。
function h2(observation, thresholds) {
  const phase = observation.phases ?? {};
  const first = phase.firstSubstantiveMs;
  const firstText = phase.firstTextMs;
  const limit = isLarge(observation, thresholds)
    ? { substantive: thresholds.firstSubstantiveEventMs.large, text: thresholds.firstTextMs.large }
    : { substantive: thresholds.firstSubstantiveEventMs.default, text: thresholds.firstTextMs.default };
  const breach = [];
  if (typeof first === "number" && first > limit.substantive)
    breach.push(`firstSubstantive ${first}ms > ${limit.substantive}ms`);
  if (typeof firstText === "number" && firstText > limit.text)
    breach.push(`firstText ${firstText}ms > ${limit.text}ms`);
  const gap = phase.maxEventGapMs;
  if (typeof gap === "number" && gap > thresholds.maxEventGapMs)
    breach.push(`event gap ${gap}ms > ${thresholds.maxEventGapMs}ms`);
  if (phase.progressObserved === false) breach.push("no progress observed");
  return breach.length
    ? anomaly("H2", breach.join("; "), observation)
    : status("H2", "pass", `first ${first ?? "n/a"}ms / text ${firstText ?? "n/a"}ms / gap ${gap ?? "n/a"}ms`);
}

// H3 重连：同 turn 被重发（输入未增长）的次数；工具续跑（输入增长）不计入。
function h3(observation, thresholds) {
  let excess = observation.repeatUpstreamCalls;
  if (excess == null) {
    const groups = new Map();
    for (const event of observation.gatewayLogs ?? []) {
      if (event.event !== "route" || !event.turn) continue;
      const key = `${event.turn}:${event.request_kind ?? "turn"}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(event);
    }
    excess = 0;
    for (const rows of groups.values())
      for (let i = 1; i < rows.length; i += 1) {
        const previous = rows[i - 1].input_items ?? rows[i - 1].payload_bytes ?? 0;
        const current = rows[i].input_items ?? rows[i].payload_bytes ?? 0;
        if (current <= previous) excess += 1;
      }
  }
  const continuations = observation.continuationRequests ?? 0;
  const suffix = continuations ? `; ${continuations} tool continuation(s) excluded` : "";
  if (excess >= thresholds.reconnects.anomalyAt)
    return anomaly("H3", `${excess} repeat request(s) for the same turn${suffix}`, observation);
  if (excess >= thresholds.reconnects.recordAt)
    return status("H3", "record", `${excess} repeat request for the same turn${suffix}`);
  return status("H3", "pass", `no repeat upstream request per turn${suffix}`);
}

// H4 工具完整性：每个 call 有 result，无 error 状态，call_id 唯一且不重复执行。
function h4(observation) {
  const calls = observation.toolCalls ?? [];
  const results = observation.toolResults ?? [];
  const ids = calls.map((x) => x.call_id).filter(Boolean);
  const duplicated = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicated.length) return status("H4", "fail", `repeated tool execution: ${[...new Set(duplicated)].join(",")}`);
  const executed = new Set(results.map((x) => x.call_id));
  const orphan = ids.filter((id) => !executed.has(id));
  if (observation.toolsExecutedLocally && orphan.length)
    return status("H4", "fail", `tool call without result: ${orphan.join(",")}`);
  const errored = calls.filter((x) => x.status && x.status !== "completed");
  if (errored.length) return status("H4", "fail", `tool error status: ${errored.map((x) => `${x.call_id}:${x.status}`).join(",")}`);
  return status("H4", "pass", `${calls.length} call(s), ${results.length} result(s), no duplicate execution`);
}

// H5 协议契约：每个请求流的 sequence_number 从 0 连续；phase 与 done 一致；事件类型已知。
// 无序列帧时仅在已记录委派理由（同构建的其他用例覆盖）的前提下记为 n/a。
function h5(observation) {
  const streams = observation.streams ?? [];
  const total = streams.reduce((sum, events) => sum + events.length, 0);
  if (!total && observation.sequenceEvidence) return status("H5", "n/a", observation.sequenceEvidence);
  if (!total) return status("H5", "fail", "no client events observed");
  for (const [index, events] of streams.entries()) {
    for (let i = 0; i < events.length; i++) {
      if (events[i].sequence_number !== i)
        return status("H5", "fail", `stream ${index} sequence gap at index ${i}: ${events[i].sequence_number}`);
    }
    const phases = observation.phasesByItemArray?.[index] ?? {};
    for (const [item, value] of Object.entries(phases))
      if (value.added !== value.done) return status("H5", "fail", `stream ${index} unstable phase for ${item}: ${value.added} -> ${value.done}`);
  }
  const unknown = observation.unknownEventTypes ?? [];
  if (unknown.length) return status("H5", "fail", `unknown event types: ${unknown.join(",")}`);
  return status("H5", "pass", `${total} sequenced event(s) across ${streams.length} stream(s), phases stable`);
}

// H6 隔离隐私：第三方出站不含订阅凭证/账号头；artifact 无正文与 token。
function h6(observation, sensitive = []) {
  const outbound = observation.outbound ?? [];
  const offenders = outbound.filter((x) => x.official === false && (x.subscriptionBearer || x.accountHeader));
  if (offenders.length)
    return status("H6", "fail", `subscription credential sent to ${offenders.map((x) => x.host).join(",")}`);
  const expected = observation.expectedOfficialHosts ?? [];
  const leaked = outbound.filter((x) => x.subscriptionBearer && !expected.includes(x.host));
  if (leaked.length) return status("H6", "fail", `unnamed official host: ${leaked.map((x) => x.host).join(",")}`);
  const text = JSON.stringify(observation);
  const hits = sensitive.filter((needle) => needle && needle.length > 8 && text.includes(needle));
  if (hits.length) return status("H6", "fail", `${hits.length} sensitive value(s) found in artifact payload`);
  return status("H6", "pass", `${outbound.length} outbound request(s) checked, no credential crossing`);
}

// H7 幂等副作用：同 turn 重试不新增历史版本、不产生重复上游副作用。
// H7 幂等副作用：每个响应只写入一次历史；不因重复请求而重复写入。
function h7(observation) {
  const writes = observation.historyWrites ?? [];
  const ids = writes.map((x) => x.responseIdHash);
  const distinct = new Set(ids.filter((x) => x != null));
  if (observation.historyWritesAvailable) {
    const inserted = writes.filter((x) => x.inserted);
    if (inserted.length !== distinct.size && distinct.size)
      return status("H7", "fail", `duplicate history write for the same response (${inserted.length} inserts / ${distinct.size} responses)`);
    const completed = observation.completedResponses ?? 0;
    if (completed && inserted.length < completed)
      return status("H7", "fail", `history writes missing for ${completed - inserted.length} completed response(s)`);
  }
  return status("H7", "pass", `${writes.length} history write(s), ${distinct.size} distinct response(s), no duplicate side effects`);
}

// H8 资源可用：健康检查 p95、event-loop p99、结束后 activeTurns 归零。
function h8(observation, thresholds) {
  const samples = (observation.health ?? []).map((x) => x.ms).filter((x) => typeof x === "number").sort((a, b) => a - b);
  const p95 = samples.length ? samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)] : undefined;
  const breach = [];
  if (p95 != null && p95 > thresholds.healthP95Ms) breach.push(`health p95 ${p95}ms > ${thresholds.healthP95Ms}ms`);
  const loop = observation.eventLoopDelayP99Ms;
  if (loop != null && loop > thresholds.eventLoopP99Ms) breach.push(`event-loop p99 ${loop}ms > ${thresholds.eventLoopP99Ms}ms`);
  if (observation.activeTurnsIdle === false) breach.push(`activeTurns did not return to 0 within ${thresholds.activeTurnsIdleMs}ms`);
  return breach.length
    ? anomaly("H8", breach.join("; "), observation)
    : status("H8", "pass", `health p95 ${p95 ?? "n/a"}ms, loop p99 ${loop ?? "n/a(external)"}ms`);
}

// H9 可归因：任何非成功路径必须落到具体错误分类。
function h9(observation) {
  const errors = observation.errors ?? [];
  const vague = errors.filter((x) => !x.category || ["other", "gateway_error", "unknown"].includes(x.category));
  if (vague.length) return status("H9", "fail", `${vague.length} unclassified error(s)`);
  if (observation.expectedFailure && !errors.length)
    return status("H9", "fail", "expected a classified failure but none was recorded");
  return status("H9", "pass", errors.length ? errors.map((x) => x.category).join(",") : "no error path");
}

// H10 证据完整：artifact 必备字段。
function h10(observation) {
  const required = ["case", "runId", "startedAt", "entry", "gateway", "result"];
  const missing = required.filter((key) => observation[key] == null);
  const entryMissing = ["kind", "binary", "sha256", "version"].filter((key) => observation.entry?.[key] == null);
  const gatewayMissing = ["url", "version"].filter((key) => observation.gateway?.[key] == null);
  if (missing.length || entryMissing.length || gatewayMissing.length)
    return status("H10", "fail", `missing ${[...missing, ...entryMissing.map((k) => `entry.${k}`), ...gatewayMissing.map((k) => `gateway.${k}`)].join(",")}`);
  return status("H10", "pass", "artifact schema complete");
}

export function evaluate(observation, thresholds, sensitive = []) {
  return [
    h1(observation),
    h2(observation, thresholds),
    h3(observation, thresholds),
    h4(observation),
    h5(observation),
    h6(observation, sensitive),
    h7(observation),
    h8(observation, thresholds),
    h9(observation),
    h10(observation),
  ];
}

const HARD = ["H1", "H4", "H5", "H6", "H7", "H9", "H10"];

export function verdict(results) {
  const value = (x) => (x.status === "n/a" && String(x.detail ?? "").trim().length > 0 ? "pass" : x.status);
  const hard = results.filter((x) => HARD.includes(x.id));
  if (hard.some((x) => ["fail", "anomaly"].includes(value(x)))) return "FAIL";
  const soft = results.filter((x) => !HARD.includes(x.id));
  if (soft.some((x) => value(x) === "fail")) return "FAIL";
  const anomalies = soft.filter((x) => value(x) === "anomaly");
  if (anomalies.length) return anomalies.every((x) => x.attributed === true) ? "ANOMALY" : "FAIL";
  return "PASS";
}

export const helpers = { SUBSTANTIVE, TERMINAL, identityHash };

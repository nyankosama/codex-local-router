import { createReadStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fail } from "./errors.mjs";
import { isCompaction } from "./history.mjs";
import { threadOwner } from "./state.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const recoveryError = (type, message) => fail(type, 409, message ?? type);

async function *records(path) {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let number = 0;
  try {
    for await (const line of lines) {
      number++;
      if (!line.trim()) continue;
      try {
        yield { record: JSON.parse(line), line, number };
      } catch {
        throw recoveryError(
          "rollout_history_incomplete",
          `Invalid rollout JSON at line ${number}`,
        );
      }
    }
  } finally {
    lines.close();
  }
}

async function fileDigest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function rolloutMeta(path, expectedThread) {
  for await (const { record } of records(path)) {
    if (record.type !== "session_meta") continue;
    if (
      !record.payload?.id ||
      (expectedThread && record.payload.id !== expectedThread)
    )
      throw recoveryError(
        "rollout_lineage_conflict",
        "Rollout metadata does not match the requested thread",
      );
    return record.payload;
  }
  throw recoveryError("rollout_history_incomplete", "Rollout session metadata is missing");
}

const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function rolloutBounds(path) {
  let first = Infinity, last = -1;
  for await (const { record } of records(path)) {
    if (!Number.isSafeInteger(record.ordinal)) continue;
    first = Math.min(first, record.ordinal);
    last = Math.max(last, record.ordinal);
  }
  return { first, last };
}

async function rolloutPaths(sessionsRoot) {
  const paths = [];
  for (const root of [sessionsRoot, join(dirname(sessionsRoot), "archived_sessions")]) {
    try {
      paths.push(...(await readdir(root, { recursive: true })).map((name) => join(root, name)));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return paths;
}

async function locateInitialRollout(sessionsRoot, thread) {
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(thread))
    throw recoveryError("rollout_lineage_conflict", "Invalid rollout thread id");
  const pattern = new RegExp(`-${escaped(thread)}(?:_|\\.jsonl$)`);
  const candidates = (await rolloutPaths(sessionsRoot))
    .filter((path) => pattern.test(basename(path)));
  const matches = [];
  for (const path of candidates) {
    const meta = await rolloutMeta(path);
    if (meta.id !== thread) continue;
    matches.push({ path, ...(await rolloutBounds(path)) });
  }
  if (matches.length === 0)
    throw recoveryError(
      "rollout_history_base_missing",
      `Rollout source for ${thread} was not found`,
    );
  const latest = Math.max(...matches.map((match) => match.last));
  const selected = matches.filter((match) => match.last === latest);
  if (selected.length !== 1)
    throw recoveryError(
      "rollout_lineage_conflict",
      `Multiple rollout sources match ${thread}`,
    );
  return selected[0].path;
}

async function locateBaseRollout(sessionsRoot, reference, limit, exclude) {
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(reference))
    throw recoveryError("rollout_lineage_conflict", "Invalid rollout base reference");
  const pattern = new RegExp(`(?:-|_)${escaped(reference)}\\.jsonl$`);
  const candidates = (await rolloutPaths(sessionsRoot))
    .filter((path) => pattern.test(basename(path)))
    .filter((path) => resolve(path) !== resolve(exclude));
  const matches = [];
  for (const path of candidates) {
    const bounds = await rolloutBounds(path);
    if (bounds.first < limit && bounds.last >= limit - 1)
      matches.push(path);
  }
  if (!matches.length && candidates.length)
    throw recoveryError(
      "rollout_lineage_conflict",
      `Rollout base ${reference} does not reach ordinal ${limit}`,
    );
  if (!matches.length)
    throw recoveryError(
      "rollout_history_base_missing",
      `Rollout base ${reference} ending at ordinal ${limit} was not found`,
    );
  if (matches.length !== 1)
    throw recoveryError(
      "rollout_lineage_conflict",
      `Multiple rollout sources match base ${reference}`,
    );
  return matches[0];
}

function parentReference(meta) {
  const base = meta.history_base;
  const reference = base?.thread_id ?? meta.forked_from_id;
  const limit = base?.end_ordinal_exclusive ?? meta.forked_from_ordinal_exclusive;
  if (reference == null && limit == null) return null;
  if (
    typeof reference !== "string" ||
    !reference ||
    !Number.isSafeInteger(limit) ||
    limit <= 0
  )
    throw recoveryError(
      "rollout_lineage_conflict",
      "Rollout parent boundary is missing or invalid",
    );
  return { reference, limit };
}

async function rolloutChain({ thread, source, sessionsRoot, maxDepth = 16 }) {
  const chain = [];
  const seen = new Set();
  let currentPath = source ? resolve(source) : await locateInitialRollout(sessionsRoot, thread);
  let limit = Infinity;
  for (let depth = 0; depth < maxDepth; depth++) {
    const marker = `${resolve(currentPath)}\0${limit}`;
    if (seen.has(marker))
      throw recoveryError("rollout_lineage_conflict", "Rollout lineage contains a cycle");
    seen.add(marker);
    const meta = await rolloutMeta(currentPath, depth === 0 ? thread : undefined);
    chain.push({ path: currentPath, meta, limit });
    const parent = parentReference(meta);
    if (!parent) return chain.reverse();
    limit = parent.limit;
    currentPath = await locateBaseRollout(
      sessionsRoot,
      parent.reference,
      parent.limit,
      currentPath,
    );
  }
  throw recoveryError("rollout_lineage_conflict", "Rollout lineage exceeds 16 levels");
}

function updateToolPairs(item, pending, completed) {
  const call = ["function_call", "custom_tool_call", "tool_search_call"].includes(item?.type);
  const output = ["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(item?.type);
  if (!call && !output) return;
  const id = item.call_id;
  // Codex application events may use custom_tool_call_output without a call id.
  if (!id && item.type === "custom_tool_call_output") return;
  if (typeof id !== "string" || !id || (call && (pending.has(id) || completed.has(id))))
    throw recoveryError("rollout_history_incomplete", "Rollout tool history is malformed");
  if (call) return void pending.add(id);
  if (!pending.delete(id) || completed.has(id))
    throw recoveryError("rollout_history_incomplete", "Rollout tool result has no matching call");
  completed.add(id);
}

function preserveAbortedToolCalls(original, pending) {
  if (!pending.size) return;
  const uncertain = [];
  for (let index = original.length - 1; index >= 0; index--) {
    const item = original[index];
    if (
      ["function_call", "custom_tool_call", "tool_search_call"].includes(item?.type) &&
      pending.has(item.call_id)
    ) {
      uncertain.unshift({
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text:
              `[Interrupted tool call ${item.name ?? item.type} ` +
              `(${item.call_id}); execution result is unknown and must not be assumed or repeated automatically.]`,
          },
        ],
      });
      original.splice(index, 1);
    }
  }
  original.push(...uncertain);
  pending.clear();
}

export function checkpointScope(account, thread, branch = thread) {
  const auth = sha256(account);
  return {
    keyOwner: threadOwner(auth, thread),
    scope: { owner: account, thread, branch },
  };
}

export async function planRolloutRecovery({
  thread,
  source,
  sessionsRoot,
  checkpointTargets = {},
  maxDepth = 16,
}) {
  const chain = await rolloutChain({ thread, source, sessionsRoot, maxDepth });
  const sourceHash = createHash("sha256");
  const original = [];
  const pending = new Set();
  const completed = new Set();
  const checkpoints = [];
  let model = null;
  let relevantRecords = 0;

  for (const entry of chain) {
    let previousOrdinal = -1;
    let lastIncludedOrdinal = -1;
    const inheritedBoundary = parentReference(entry.meta)?.limit;
    for await (const { record, line } of records(entry.path)) {
      const effectiveOrdinal =
        record.type === "session_meta" &&
        Number.isSafeInteger(inheritedBoundary) &&
        record.ordinal < inheritedBoundary
          ? inheritedBoundary - 1
          : record.ordinal;
      if (
        !Number.isSafeInteger(effectiveOrdinal) ||
        effectiveOrdinal <= previousOrdinal ||
        (previousOrdinal >= 0 && effectiveOrdinal !== previousOrdinal + 1)
      )
        throw recoveryError(
          "rollout_history_incomplete",
          "Rollout ordinals are missing or non-monotonic",
        );
      previousOrdinal = effectiveOrdinal;
      if (record.ordinal >= entry.limit) continue;
      lastIncludedOrdinal = record.ordinal;
      sourceHash.update(line).update("\n");
      relevantRecords++;
      if (record.type === "event_msg" && record.payload?.type === "turn_aborted")
        preserveAbortedToolCalls(original, pending);
      if (record.type === "turn_context" && typeof record.payload?.model === "string")
        model = record.payload.model;
      if (record.type === "response_item" && record.payload) {
        if (record.payload.type !== "compaction_trigger") {
          updateToolPairs(record.payload, pending, completed);
          original.push(record.payload);
        }
        continue;
      }
      if (record.type !== "compacted") continue;
      const replacement = record.payload?.replacement_history;
      const compacted = Array.isArray(replacement)
        ? replacement.filter(isCompaction)
        : [];
      if (
        !original.length ||
        pending.size ||
        record.payload?.retained_context?.incomplete === true ||
        compacted.length !== 1 ||
        typeof compacted[0].encrypted_content !== "string" ||
        !compacted[0].encrypted_content ||
        compacted[0].encrypted_content.startsWith("gateway-checkpoint-")
      )
        throw recoveryError(
          "rollout_history_incomplete",
          "Compacted rollout history cannot be reconstructed losslessly",
        );
      const checkpointModel = model ?? entry.meta.model;
      const mappedTarget = checkpointTargets[checkpointModel];
      if (
        mappedTarget &&
        (!["provider", "model", "targetId"].every((key) =>
          typeof mappedTarget[key] === "string" && mappedTarget[key]))
      )
        throw recoveryError(
          "rollout_target_mapping_invalid",
          "Rollout checkpoint target mapping is invalid",
        );
      checkpoints.push({
        thread,
        branch: thread,
        item: compacted[0],
        sourceHash: sourceHash.copy().digest("hex"),
        checkpoint: {
          provider: mappedTarget?.provider ?? "chatgpt-subscription",
          model: mappedTarget?.model ?? checkpointModel ?? null,
          targetId: mappedTarget?.targetId ??
            (checkpointModel ? `official:${checkpointModel}` : null),
          original: original.slice(),
          view: replacement.slice(),
          completeness: "complete_original",
          virtual: false,
        },
      });
    }
    if (Number.isFinite(entry.limit) && lastIncludedOrdinal !== entry.limit - 1)
      throw recoveryError(
        "rollout_lineage_conflict",
        "Rollout fork boundary does not match the parent source",
      );
    entry.sourceHash = await fileDigest(entry.path);
  }
  if (!checkpoints.length)
    throw recoveryError(
      "rollout_history_incomplete",
      "Rollout contains no recoverable compaction checkpoint",
    );
  return {
    thread,
    files: chain.map((entry) => ({
      thread: entry.meta.id,
      path: entry.path,
      sourceHash: entry.sourceHash,
    })),
    sourceHash: sourceHash.digest("hex"),
    relevantRecords,
    checkpoints,
  };
}

export async function verifyRolloutRecoverySources(plan) {
  for (const file of plan.files)
    if ((await fileDigest(file.path)) !== file.sourceHash)
      throw recoveryError(
        "rollout_source_changed",
        "A rollout source changed after recovery planning",
      );
  return true;
}

const sameCheckpoint = (left, right) =>
  left?.provider === right.provider &&
  left?.model === right.model &&
  left?.targetId === right.targetId &&
  left?.virtual === right.virtual &&
  JSON.stringify(left?.original ?? left?.portable) === JSON.stringify(right.original) &&
  JSON.stringify(left?.view ?? left?.portable) === JSON.stringify(right.view);

const canEnrichCheckpoint = (current, recovered) =>
  current?.provider === recovered.provider &&
  current?.model === recovered.model &&
  current?.targetId === recovered.targetId &&
  current?.virtual === recovered.virtual &&
  !Array.isArray(current.original ?? current.portable) &&
  (!current.view || JSON.stringify(current.view) === JSON.stringify(recovered.view));

export function applyRolloutRecovery(archive, plan, { account, apply = false } = {}) {
  const writes = [];
  let existing = 0, enriched = 0;
  for (const recovery of plan.checkpoints) {
    const { keyOwner, scope } = checkpointScope(account, recovery.thread, recovery.branch);
    const key = `checkpoint:${keyOwner}:${sha256(recovery.item.encrypted_content)}`;
    const current = archive.getState(key);
    if (current) {
      if (sameCheckpoint(current, recovery.checkpoint)) {
        existing++;
        continue;
      }
      if (!canEnrichCheckpoint(current, recovery.checkpoint))
        throw recoveryError(
          "rollout_lineage_conflict",
          "A different checkpoint already exists for this compaction",
        );
      enriched++;
    }
    writes.push({ key, scope, recovery });
  }
  if (apply) {
    const entries = writes.map(({ key, scope, recovery }) => ({
      key,
      scope,
      value: {
        ...recovery.checkpoint,
        recovery: {
          sourceHash: recovery.sourceHash,
          recoveredAt: Date.now(),
        },
      },
    }));
    if (archive.setRecoveredCheckpoints)
      archive.setRecoveredCheckpoints(entries);
    else archive.setStates(entries);
  }
  return {
    applied: apply,
    thread: plan.thread,
    sourceHash: plan.sourceHash,
    files: plan.files.length,
    relevantRecords: plan.relevantRecords,
    checkpoints: plan.checkpoints.length,
    existing,
    enriched,
    written: apply ? writes.length : 0,
    wouldWrite: apply ? 0 : writes.length,
    events: apply && writes.length
      ? [{ event: "rollout_checkpoint_recovered", count: writes.length }]
      : [],
  };
}

export async function readRollout(path, expectedThread) {
  const lines = (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean);
  let meta;
  const events = [];
  const timeline = [];
  for (const [index, line] of lines.entries()) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw fail(
        "rollout_invalid_json",
        400,
        `Invalid rollout JSON at line ${index + 1}`,
      );
    }
    if (record.type === "session_meta") meta = record.payload;
    if (record.type === "response_item" && record.payload) {
      events.push(record.payload);
      timeline.push({ kind: "item", item: record.payload });
    }
    if (record.type === "compacted" && Array.isArray(record.payload?.replacement_history))
      timeline.push({
        kind: "compacted",
        replacement: record.payload.replacement_history,
        responseId: record.payload.compaction_response_id,
      });
  }
  if (!meta?.id) throw fail("rollout_session_missing", 400);
  if (expectedThread && meta.id !== expectedThread)
    throw fail(
      "rollout_thread_mismatch",
      409,
      `Rollout belongs to ${meta.id}, not ${expectedThread}`,
    );
  if (!events.length) throw fail("rollout_history_missing", 409);
  return {
    id: meta.id,
    meta,
    events,
    timeline,
    sourceHash: createHash("sha256")
      .update(lines.join("\n"))
      .digest("hex"),
  };
}

export function importRollout(archive, rollout, { owner, branch }) {
  const snapshots = [];
  const original = [];
  let view = [];
  const calls = new Set();
  let gap = false;
  let compactedWithoutOriginal = false;
  for (const record of rollout.timeline ?? rollout.events.map((item) => ({ kind: "item", item }))) {
    if (record.kind === "compacted") {
      compactedWithoutOriginal ||= original.length === 0;
      view = [...record.replacement];
      continue;
    }
    const event = record.item;
    original.push(event);
    view.push(event);
    if (["function_call", "custom_tool_call"].includes(event.type))
      calls.add(event.call_id);
    if (
      ["function_call_output", "custom_tool_call_output"].includes(event.type) &&
      event.call_id &&
      !calls.has(event.call_id)
    )
      gap = true;
    if (
      (event.type === "message" && event.role === "assistant") ||
      ["compaction", "compaction_summary", "context_compaction"].includes(
        event.type,
      )
    )
      snapshots.push({ original: [...original], view: [...view] });
  }
  if (!snapshots.length || snapshots.at(-1).original.length !== original.length)
    snapshots.push({ original: [...original], view: [...view] });
  let version;
  for (const [index, snapshot] of snapshots.entries())
    version = archive.appendHistory({
      owner,
      thread: rollout.id,
      branch: branch ?? rollout.id,
      target: {
        id: "rollout-import",
        provider: rollout.meta.model_provider ?? null,
        model: rollout.meta.model ?? null,
      },
      responseId: `import:${rollout.sourceHash}:${index}`,
      status: gap
        ? "gap_present"
        : compactedWithoutOriginal
          ? "summary_only"
          : "complete_original",
      original: snapshot.original,
      view: snapshot.view,
      parent: (rollout.meta.parent_thread_id ?? rollout.meta.forked_from_thread_id)
        ? {
            thread:
              rollout.meta.parent_thread_id ?? rollout.meta.forked_from_thread_id,
            branch:
              rollout.meta.parent_thread_id ?? rollout.meta.forked_from_thread_id,
          }
        : undefined,
    });
  return { versions: snapshots.length, latestVersion: version };
}

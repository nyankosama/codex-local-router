import { createReadStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { basename, join, resolve } from "node:path";
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

async function rolloutMeta(path, expectedThread) {
  for await (const { record } of records(path)) {
    if (record.type !== "session_meta") continue;
    if (!record.payload?.id || record.payload.id !== expectedThread)
      throw recoveryError(
        "rollout_lineage_conflict",
        "Rollout metadata does not match the requested thread",
      );
    return record.payload;
  }
  throw recoveryError("rollout_history_incomplete", "Rollout session metadata is missing");
}

async function locateRollout(sessionsRoot, thread) {
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(thread))
    throw recoveryError("rollout_lineage_conflict", "Invalid rollout thread id");
  let names;
  try {
    names = await readdir(sessionsRoot, { recursive: true });
  } catch (error) {
    if (error.code === "ENOENT") names = [];
    else throw error;
  }
  const suffix = `-${thread}.jsonl`;
  const matches = names
    .filter((name) => basename(name).endsWith(suffix))
    .map((name) => join(sessionsRoot, name));
  if (matches.length === 0)
    throw recoveryError(
      "rollout_history_base_missing",
      `Rollout source for ${thread} was not found`,
    );
  if (matches.length !== 1)
    throw recoveryError(
      "rollout_lineage_conflict",
      `Multiple rollout sources match ${thread}`,
    );
  return matches[0];
}

function parentReference(meta) {
  const ids = [meta.history_base?.thread_id, meta.forked_from_id]
    .filter((value) => typeof value === "string" && value);
  const uniqueIds = [...new Set(ids)];
  const ordinals = [
    meta.history_base?.end_ordinal_exclusive,
    meta.forked_from_ordinal_exclusive,
  ].filter((value) => value != null);
  const uniqueOrdinals = [...new Set(ordinals)];
  if (uniqueIds.length > 1 || uniqueOrdinals.length > 1)
    throw recoveryError(
      "rollout_lineage_conflict",
      "Rollout parent metadata conflicts",
    );
  if (!uniqueIds.length) {
    if (uniqueOrdinals.length)
      throw recoveryError(
        "rollout_lineage_conflict",
        "Rollout has a fork boundary without a parent",
      );
    return null;
  }
  if (
    uniqueOrdinals.length !== 1 ||
    !Number.isSafeInteger(uniqueOrdinals[0]) ||
    uniqueOrdinals[0] <= 0
  )
    throw recoveryError(
      "rollout_lineage_conflict",
      "Rollout parent boundary is missing or invalid",
    );
  return { thread: uniqueIds[0], limit: uniqueOrdinals[0] };
}

async function rolloutChain({ thread, source, sessionsRoot, maxDepth = 16 }) {
  const chain = [];
  const seen = new Set();
  let currentThread = thread;
  let currentPath = source ? resolve(source) : await locateRollout(sessionsRoot, thread);
  let limit = Infinity;
  for (let depth = 0; depth < maxDepth; depth++) {
    if (seen.has(currentThread))
      throw recoveryError("rollout_lineage_conflict", "Rollout lineage contains a cycle");
    seen.add(currentThread);
    const meta = await rolloutMeta(currentPath, currentThread);
    chain.push({ path: currentPath, meta, limit });
    const parent = parentReference(meta);
    if (!parent) return chain.reverse();
    currentThread = parent.thread;
    limit = parent.limit;
    currentPath = await locateRollout(sessionsRoot, currentThread);
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
    const fileHash = createHash("sha256");
    for await (const { record, line } of records(entry.path)) {
      fileHash.update(line).update("\n");
      if (!Number.isSafeInteger(record.ordinal) || record.ordinal <= previousOrdinal)
        throw recoveryError(
          "rollout_history_incomplete",
          "Rollout ordinals are missing or non-monotonic",
        );
      previousOrdinal = record.ordinal;
      if (record.ordinal >= entry.limit) continue;
      lastIncludedOrdinal = record.ordinal;
      sourceHash.update(line).update("\n");
      relevantRecords++;
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
      checkpoints.push({
        thread: entry.meta.id,
        branch: entry.meta.id,
        item: compacted[0],
        sourceHash: sourceHash.copy().digest("hex"),
        checkpoint: {
          provider: "chatgpt-subscription",
          model: checkpointModel ?? null,
          targetId: checkpointModel ? `official:${checkpointModel}` : null,
          original: structuredClone(original),
          view: structuredClone(replacement),
          virtual: false,
        },
      });
    }
    if (Number.isFinite(entry.limit) && lastIncludedOrdinal !== entry.limit - 1)
      throw recoveryError(
        "rollout_lineage_conflict",
        "Rollout fork boundary does not match the parent source",
      );
    entry.sourceHash = fileHash.digest("hex");
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
      sourceHash: entry.sourceHash,
    })),
    sourceHash: sourceHash.digest("hex"),
    relevantRecords,
    checkpoints,
  };
}

const sameCheckpoint = (left, right) =>
  left?.provider === right.provider &&
  left?.model === right.model &&
  left?.targetId === right.targetId &&
  left?.virtual === right.virtual &&
  JSON.stringify(left?.original ?? left?.portable) === JSON.stringify(right.original) &&
  JSON.stringify(left?.view ?? left?.portable) === JSON.stringify(right.view);

export function applyRolloutRecovery(archive, plan, { account, apply = false } = {}) {
  const writes = [];
  let existing = 0;
  for (const recovery of plan.checkpoints) {
    const { keyOwner, scope } = checkpointScope(account, recovery.thread, recovery.branch);
    const key = `checkpoint:${keyOwner}:${sha256(recovery.item.encrypted_content)}`;
    const current = archive.getState(key);
    if (current) {
      if (!sameCheckpoint(current, recovery.checkpoint))
        throw recoveryError(
          "rollout_lineage_conflict",
          "A different checkpoint already exists for this compaction",
        );
      existing++;
      continue;
    }
    writes.push({ key, scope, recovery });
  }
  if (apply) {
    archive.setStates(writes.map(({ key, scope, recovery }) => ({
      key,
      scope,
      value: {
        ...recovery.checkpoint,
        recovery: {
          sourceHash: recovery.sourceHash,
          recoveredAt: Date.now(),
        },
      },
    })));
  }
  return {
    applied: apply,
    thread: plan.thread,
    sourceHash: plan.sourceHash,
    files: plan.files.length,
    relevantRecords: plan.relevantRecords,
    checkpoints: plan.checkpoints.length,
    existing,
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

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fail } from "./errors.mjs";

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

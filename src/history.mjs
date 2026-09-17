import { createHash } from "node:crypto";
import { fail } from "./errors.mjs";
import { threadOwner } from "./state.mjs";

export const isCompaction = (item) =>
  ["compaction", "compaction_summary", "context_compaction"].includes(
    item.type,
  );
const digest = (value) => createHash("sha256").update(value).digest("hex");
export const TOOL_SEARCH_HISTORY_MARKER =
  "[Dynamic tool discovery occurred on the previous provider. Provider-specific discovery metadata and tool schemas were omitted during migration; subsequent tool calls and results remain in history.]";

const incompleteToolSearchHistory = () =>
  fail(
    "tool_search_history_incomplete",
    409,
    "Dynamic tool discovery history is incomplete or malformed; continue on the source provider or start a new task",
  );

const toolSearchMarker = () => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text: TOOL_SEARCH_HISTORY_MARKER }],
});

export function canonicalizeToolSearchHistory(input, diagnostics) {
  const calls = new Map();
  const outputs = new Set();
  for (const [index, item] of input.entries()) {
    if (!["tool_search_call", "tool_search_output"].includes(item?.type))
      continue;
    if (typeof item.call_id !== "string" || !item.call_id.trim())
      throw incompleteToolSearchHistory();
    if (item.type === "tool_search_call") {
      if (calls.has(item.call_id) || outputs.has(item.call_id))
        throw incompleteToolSearchHistory();
      calls.set(item.call_id, index);
      continue;
    }
    if (outputs.has(item.call_id) || !calls.has(item.call_id))
      throw incompleteToolSearchHistory();
    outputs.add(item.call_id);
  }
  if ([...calls.keys()].some((callId) => !outputs.has(callId)))
    throw incompleteToolSearchHistory();
  if (diagnostics) diagnostics.toolSearchPairs = calls.size;
  if (!calls.size) return input;
  return input.flatMap((item) => {
    if (item?.type === "tool_search_call") return [toolSearchMarker()];
    if (item?.type === "tool_search_output") return [];
    return [item];
  });
}

const key = (ctx, item) => {
  if (typeof item.encrypted_content !== "string" || !item.encrypted_content)
    throw fail("invalid_compaction_item", 400);
  return "checkpoint:" + ctx.owner + ":" + digest(item.encrypted_content);
};

// Item ids and Codex-only message metadata can change when the client rebuilds history.
const fingerprint = (item) => {
  if (item.type === "message" || item.role) {
    const content =
      typeof item.content === "string"
        ? item.content
        : (item.content ?? []).map((x) => x.text ?? JSON.stringify(x)).join("");
    return digest(JSON.stringify([item.role, content]));
  }
  return digest(JSON.stringify(item));
};

export function saveCheckpoint(state, ctx, item, checkpoint) {
  state.set(key(ctx, item), checkpoint, ctx);
}

const portableSource = (checkpoint) =>
  checkpoint?.original ?? checkpoint?.portable;

function checkpointFor(state, ctx, item, diagnostics) {
  const currentKey = key(ctx, item);
  const current = state.get(currentKey);
  if (portableSource(current) || !ctx.parentThread)
    return { checkpoint: current, parentReason: null };

  const parent = state.get(
    key({ ...ctx, owner: threadOwner(ctx.auth, ctx.parentThread) }, item),
  );
  if (!Array.isArray(portableSource(parent)) || !portableSource(parent).length) {
    const reason = parent ? "portable_source_missing" : "not_found";
    diagnostics?.({
      event: "checkpoint_parent_unavailable",
      reason,
    });
    return { checkpoint: current, parentReason: reason };
  }
  state.set(currentKey, parent, ctx);
  diagnostics?.({ event: "checkpoint_inherited_from_parent" });
  return { checkpoint: parent, parentReason: null };
}

export function expandCheckpoints(
  state,
  ctx,
  input,
  target,
  { portable = false, diagnostics } = {},
) {
  let expanded = [],
    count = 0,
    source;
  for (const item of input) {
    if (!isCompaction(item)) {
      expanded.push(item);
      continue;
    }
    const resolved = checkpointFor(state, ctx, item, diagnostics);
    const checkpoint = resolved.checkpoint;
    // Official encrypted state is validated by the authenticated official backend.
    // Local cache loss must not block native continuation. Never send our virtual
    // checkpoint handles to that backend or opaque official state to another provider.
    if (!checkpoint && !portable && target.provider === "chatgpt-subscription" &&
        typeof item.encrypted_content === "string" &&
        !item.encrypted_content.startsWith("gateway-checkpoint-")) {
      expanded.push(item);
      continue;
    }
    const original = checkpoint?.original ?? checkpoint?.portable;
    const view = checkpoint?.view ?? checkpoint?.portable;
    if (!checkpoint || (portable && !original)) {
      const sourceExists = checkpoint || resolved.parentReason === "portable_source_missing";
      throw fail(
        "compaction_history_unavailable",
        409,
        sourceExists
          ? "Compacted history checkpoint exists but has no portable original history; try explicit rollout recovery or continue on the official model"
          : "Compacted history checkpoint was not found for this thread or its declared parent; try explicit rollout recovery before switching providers",
      );
    }
    const nativeCompatible =
      checkpoint.provider === target.provider &&
      (target.provider === "chatgpt-subscription" ||
        checkpoint.targetId === target.id ||
        target.compression?.compatibility?.targets?.includes(
          checkpoint.targetId,
        ));
    if (!portable && !checkpoint.virtual && nativeCompatible) {
      expanded.push(item);
      continue;
    }
    // Codex retains user/system/developer messages before its compaction item. The
    // exact checkpoint already includes these; reinjected, changed instructions stay.
    const replacement = portable
      ? original
      : checkpoint.virtual && checkpoint.targetId === target.id
        ? view
        : original;
    if (!replacement)
      throw fail("compaction_history_unavailable", 409, "Compacted history has no portable source; restore full history before switching providers");
    // Remove only the exact positional prefix already captured by the
    // checkpoint. Content-based set subtraction loses legitimate repeated
    // messages and tool results.
    let covered = 0;
    while (
      covered < expanded.length &&
      covered < original.length &&
      fingerprint(expanded[covered]) === fingerprint(original[covered])
    ) covered++;
    expanded = [...replacement, ...expanded.slice(covered)];
    source = {
      id: checkpoint.targetId,
      provider: checkpoint.provider,
      model: checkpoint.model,
    };
    count++;
  }
  return { input: expanded, count, source };
}

export function portableItems(input, options = {}) {
  return canonicalizeToolSearchHistory(input, options.diagnostics).flatMap((item) => {
    // Responses Lite carries current tool declarations as an input item. These
    // are regenerated by Codex for the selected model, not conversation history.
    if (item.type === "compaction_trigger") return [];
    if (item.type === "additional_tools")
      return options.preserveAdditionalTools ? [item] : [];
    if (isCompaction(item)) {
      if (options.preserveCompaction) return [item];
      throw fail("compaction_history_unavailable", 409);
    }
    if (item.type === "reasoning") {
      const text = (item.summary ?? []).map((x) => x.text ?? "").join("\n");
      if (!text && item.encrypted_content)
        return [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "[Provider-private reasoning state was not portable; visible messages and tool results are preserved.]",
              },
            ],
          },
        ];
      return text
        ? [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text }],
            },
          ]
        : [];
  }
    if (item.type === "message" || item.role) {
      const content =
        typeof item.content === "string"
          ? [
              {
                type: item.role === "assistant" ? "output_text" : "input_text",
                text: item.content,
              },
            ]
          : item.content;
      if (
        !Array.isArray(content) ||
        content.some(
          (x) =>
            !["input_text", "output_text", "input_image", "image_url"].includes(
              x.type,
            ),
        )
      )
        throw fail(
          "history_incompatible",
          400,
          "Only text history can migrate between providers",
        );
      return [
        {
          type: "message",
          role: item.role,
          content: content.map((x) =>
            Object.fromEntries(
              ["type", "text", "image_url", "file_id", "detail"]
                .filter((key) => x[key] !== undefined)
                .map((key) => [key, x[key]]),
            ),
          ),
        },
      ];
    }
    if (
      [
        "function_call",
        "function_call_output",
        "custom_tool_call",
        "custom_tool_call_output",
      ].includes(item.type)
    ) {
      // call_id is the portable association. Provider-generated item ids have
      // incompatible prefixes and must not be replayed to another provider.
      const allowed = [
        "type",
        "call_id",
        "name",
        "arguments",
        "input",
        "output",
        "status",
      ];
      return [
        Object.fromEntries(
          allowed.filter((k) => item[k] !== undefined).map((k) => [k, item[k]]),
        ),
      ];
    }
    throw fail(
      "history_incompatible",
      400,
      "This provider-specific history item cannot migrate safely",
    );
  });
}

export function hasPendingTools(input) {
  canonicalizeToolSearchHistory(input);
  const outputs = new Set(
    input
      .filter((x) =>
        ["function_call_output", "custom_tool_call_output"].includes(x.type),
      )
      .map((x) => x.call_id),
  );
  return input.some(
    (x) =>
      ["function_call", "custom_tool_call"].includes(x.type) &&
      !outputs.has(x.call_id),
  );
}

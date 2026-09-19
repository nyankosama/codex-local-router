import { createHash } from "node:crypto";
import { fail } from "./errors.mjs";
import { threadOwner } from "./state.mjs";
import { estimateRequestTokens, inputBudget } from "./context.mjs";

export const isCompaction = (item) =>
  ["compaction", "compaction_summary", "context_compaction"].includes(
    item.type,
  );
export const compactionWindow = (view, item) => {
  if (!Array.isArray(view)) return undefined;
  const index = view.findIndex(
    (candidate) =>
      isCompaction(candidate) &&
      candidate.encrypted_content === item.encrypted_content,
  );
  return index < 0 ? undefined : view.slice(0, index + 1);
};
export const hasGatewayProjectedHistory = (input) =>
  input.some(
    (item) =>
      typeof item?.id === "string" && item.id.startsWith("item_gateway_"),
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

export const checkpointKey = (ctx, item) => {
  if (typeof item.encrypted_content !== "string" || !item.encrypted_content)
    throw fail("invalid_compaction_item", 400);
  return "checkpoint:" + ctx.owner + ":" + digest(item.encrypted_content);
};
const checkpointLineageKey = (ctx, item) =>
  "checkpoint-lineage:" + ctx.auth + ":" + digest(item.encrypted_content);

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

export function saveCheckpoint(
  state,
  ctx,
  item,
  checkpoint,
  historyRef,
) {
  const storageKey = checkpointKey(ctx, item);
  if (historyRef && state.archive) {
    const stored = {
      ...checkpoint,
      original: undefined,
      view: undefined,
      checkpointView: checkpoint.view,
      historyRef,
      historyKind: "checkpoint",
    };
    state.set(storageKey, stored, ctx);
    state.setMemory(storageKey, { ...checkpoint, historyRef });
    state.set(checkpointLineageKey(ctx, item), { owner: ctx.owner }, ctx);
    return;
  }
  state.set(storageKey, checkpoint, ctx);
  state.set(checkpointLineageKey(ctx, item), { owner: ctx.owner }, ctx);
}

const portableSource = (checkpoint) =>
  checkpoint?.original ?? checkpoint?.portable;

export function checkpointFor(state, ctx, item, diagnostics) {
  const currentKey = checkpointKey(ctx, item);
  const current = state.get(currentKey);
  if (portableSource(current))
    return { checkpoint: current, parentReason: null, sourceKey: currentKey };
  let parent;
  let parentKey;
  let parentReason = null;
  if (ctx.parentThread) {
    parentKey = checkpointKey(
      { ...ctx, owner: threadOwner(ctx.auth, ctx.parentThread) },
      item,
    );
    parent = state.get(parentKey);
    if (Array.isArray(portableSource(parent)) && portableSource(parent).length) {
      saveCheckpoint(state, ctx, item, parent, parent.historyRef);
      diagnostics?.({ event: "checkpoint_inherited_from_parent" });
      return { checkpoint: parent, parentReason: null, sourceKey: parentKey };
    }
    parentReason = parent ? "portable_source_missing" : "not_found";
    diagnostics?.({ event: "checkpoint_parent_unavailable", reason: parentReason });
  }
  const lineage = state.get(checkpointLineageKey(ctx, item));
  if (typeof lineage?.owner === "string" && lineage.owner !== ctx.owner) {
    const inheritedKey = checkpointKey({ ...ctx, owner: lineage.owner }, item);
    const inherited = state.get(inheritedKey);
    if (inherited) {
      if (
        inherited.historyRef ||
        [inherited.original, inherited.portable, inherited.view].some(Array.isArray)
      ) saveCheckpoint(state, ctx, item, inherited, inherited.historyRef);
      diagnostics?.({ event: "checkpoint_inherited_from_account_lineage" });
      return { checkpoint: inherited, parentReason: null, sourceKey: inheritedKey };
    }
  }
  return {
    checkpoint: current ?? parent,
    parentReason,
    sourceKey: current ? currentKey : parentKey,
  };
}

const matches = (left, right) =>
  left.length === right.length &&
  left.every((item, index) => fingerprint(item) === fingerprint(right[index]));

const migrationView = (checkpoint, target) => {
  const migration = checkpoint?.migration;
  return target.compression?.nativeMigrationSummary === true &&
    migration?.targetId === target.id &&
    migration?.status === "completed" &&
    Array.isArray(migration.view)
    ? migration.view
    : undefined;
};

export function checkpointTargetStatus(checkpoint, target) {
  if (!checkpoint)
    return { compatible: false, needsSummary: false, reason: "checkpoint_missing" };
  if (["gap_present", "observing"].includes(checkpoint.completeness))
    return {
      compatible: false,
      needsSummary: false,
      reason: checkpoint.completeness,
    };
  const native =
    checkpoint.provider === target.provider &&
    (target.provider === "chatgpt-subscription" ||
      checkpoint.targetId === target.id ||
      target.compression?.compatibility?.targets?.includes(checkpoint.targetId));
  if (native) return { compatible: true, needsSummary: false, reason: "native" };
  if (migrationView(checkpoint, target))
    return { compatible: true, needsSummary: false, reason: "migration_summary" };

  let projected;
  if (
    Array.isArray(checkpoint.original) &&
    checkpoint.completeness !== "opaque_source_only"
  ) {
    try {
      projected = portableItems(checkpoint.original);
    } catch (error) {
      if (error.type !== "history_incompatible") throw error;
    }
  }
  if (projected) {
    const budget = inputBudget(target);
    if (budget == null || estimateRequestTokens({ input: projected }) <= budget)
      return { compatible: true, needsSummary: false, reason: "portable_original" };
  }
  const canSummarize =
    target.compression?.nativeMigrationSummary === true &&
    checkpoint.provider === "chatgpt-subscription" &&
    Array.isArray(checkpoint.view) &&
    checkpoint.view.some(isCompaction);
  if (canSummarize)
    return {
      compatible: false,
      needsSummary: true,
      reason: projected ? "target_context_exceeded" : "opaque_source_window",
    };
  return {
    compatible: false,
    needsSummary: false,
    reason: projected ? "target_context_exceeded" : "portable_source_missing",
  };
}

export function expandCheckpoints(
  state,
  ctx,
  input,
  target,
  { portable = false, omitCompactedHistory = false, diagnostics } = {},
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
    if (!omitCompactedHistory && !portable && !checkpoint.virtual && nativeCompatible) {
      expanded.push(item);
      continue;
    }
    // Codex retains user/system/developer messages before its compaction item. The
    // exact checkpoint already includes these; reinjected, changed instructions stay.
    const replacement = omitCompactedHistory
      ? []
      : portable
        ? original
        : migrationView(checkpoint, target) ??
          (checkpoint.virtual && checkpoint.targetId === target.id
            ? view
            : original);
    if (!replacement)
      throw fail("compaction_history_unavailable", 409, "Compacted history has no portable source; restore full history before switching providers");
    // Remove only the exact positional prefix already captured by the
    // checkpoint. Content-based set subtraction loses legitimate repeated
    // messages and tool results.
    const retained = Array.isArray(view)
      ? view.filter((candidate) => !isCompaction(candidate))
      : [];
    if (
      retained.length > 0 &&
      retained.length <= expanded.length &&
      matches(expanded.slice(expanded.length - retained.length), retained)
    )
      expanded = expanded.slice(0, expanded.length - retained.length);
    else {
      let covered = 0;
      while (
        Array.isArray(original) &&
        covered < expanded.length &&
        covered < original.length &&
        fingerprint(expanded[covered]) === fingerprint(original[covered])
      ) covered++;
      expanded = expanded.slice(covered);
    }
    expanded = [...replacement, ...expanded];
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
    if (item.type === "agent_message") {
      const content = Array.isArray(item.content) ? item.content : [];
      const visible = [
        ...(typeof item.text === "string" ? [item.text] : []),
        ...content
          .filter((part) => ["input_text", "output_text"].includes(part?.type))
          .map((part) => part.text),
      ].filter((text) => typeof text === "string" && text.length);
      const privateState =
        typeof item.encrypted_content === "string" ||
        content.some((part) => part?.type === "encrypted_content");
      if (!visible.length && !privateState) return [];
      return [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: [
                ...visible,
                ...(privateState
                  ? ["[Provider-private agent state was not portable.]"]
                  : []),
              ].join("\n"),
            },
          ],
        },
      ];
    }
    if (item.type === "web_search_call") {
      if (item.status && item.status !== "completed")
        throw fail(
          "history_incompatible",
          409,
          "Incomplete web search history cannot be migrated",
        );
      const candidates = [
        ...(Array.isArray(item.sources) ? item.sources : []),
        ...(Array.isArray(item.results) ? item.results : []),
        ...(Array.isArray(item.action?.sources) ? item.action.sources : []),
      ];
      const sources = candidates
        .map((source) => ({
          title:
            typeof source?.title === "string" ? source.title.trim() : "",
          url: typeof source?.url === "string" ? source.url.trim() : "",
        }))
        .filter((source) => source.title || source.url)
        .slice(0, 20);
      return [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text:
                "[A web search completed on the source provider; it must not be repeated automatically.]" +
                (sources.length
                  ? "\nSources:\n" +
                    sources
                      .map((source) =>
                        `- ${source.title || "Source"}${source.url ? ` — ${source.url}` : ""}`,
                      )
                      .join("\n")
                  : ""),
            },
          ],
        },
      ];
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
      if (
        ["function_call_output", "custom_tool_call_output"].includes(item.type) &&
        (typeof item.call_id !== "string" || !item.call_id)
      )
        return item.output == null
          ? []
          : [
              {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text:
                      typeof item.output === "string"
                        ? item.output
                        : JSON.stringify(item.output),
                  },
                ],
              },
            ];
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

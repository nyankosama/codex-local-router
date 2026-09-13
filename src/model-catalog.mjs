const defaultReasoningLevels = ["low", "medium", "high", "xhigh"].map((effort) => ({
  effort,
  description: `${effort} reasoning effort`,
}));

function reasoningLevels(levels = defaultReasoningLevels) {
  return levels.map((level) =>
    typeof level === "string"
      ? { effort: level, description: `${level} reasoning effort` }
      : { ...level },
  );
}

function legacyTarget(options = {}) {
  const model = options.slug ?? "deepseek-v4.1-flash";
  return {
    id: "deepseek",
    model,
    contextWindow: 400000,
    maxContextWindow: 400000,
    effectiveContextWindowPercent: 95,
    inputModalities:
      options.inputModalities ??
      (model === "deepseek-v4.1-flash" ? ["text", "image"] : ["text"]),
    capabilities: { toolCalling: true, nativeWebSearch: false },
    app: {
      enabled: true,
      modelId: model,
      displayName: options.displayName ?? "DeepSeek V4.1 Flash (custom)",
      reasoningLevels:
        model === "deepseek-v4.1-flash"
          ? ["low", "medium", "high", "xhigh", "max"]
          : undefined,
    },
  };
}

function customModel(target, source) {
  const highestPriority = Math.max(
    1,
    ...source.models.map((model) => Number(model.priority ?? 1)),
  );
  return {
    slug: target.app.modelId,
    display_name: target.app.displayName ?? `${target.model} (custom)`,
    description: target.app.description ?? `${target.model} via Codex Local Router`,
    default_reasoning_level: target.app.defaultReasoningLevel ?? "medium",
    supported_reasoning_levels: reasoningLevels(target.app.reasoningLevels),
    shell_type: target.app.shellType ?? "unified_exec",
    visibility: "list",
    supported_in_api: true,
    priority: target.app.priority ?? Math.max(1, highestPriority - 1),
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    base_instructions: target.app.baseInstructions ?? "",
    model_messages: target.app.modelMessages ?? null,
    supports_reasoning_summaries: target.app.supportsReasoningSummaries ?? true,
    default_reasoning_summary: target.app.defaultReasoningSummary ?? "auto",
    support_verbosity: target.app.supportVerbosity ?? false,
    default_verbosity: target.app.defaultVerbosity ?? null,
    apply_patch_tool_type:
      target.app.applyPatchToolType ??
      (target.capabilities?.freeformTools ? "freeform" : null),
    web_search_tool_type: "text",
    truncation_policy: target.app.truncationPolicy ?? { mode: "tokens", limit: 10000 },
    supports_parallel_tool_calls: target.app.supportsParallelToolCalls ?? true,
    supports_image_detail_original: target.inputModalities.includes("image"),
    context_window: target.contextWindow,
    max_context_window: target.maxContextWindow,
    effective_context_window_percent: target.effectiveContextWindowPercent,
    experimental_supported_tools: [],
    input_modalities: target.inputModalities,
    supports_search_tool:
      target.app.supportsSearchTool ??
      (target.capabilities?.nativeWebSearch === true),
    use_responses_lite: target.app.useResponsesLite ?? false,
  };
}

// Preserve the official catalog byte-for-byte and append configured App targets.
export function buildModelCatalog(source, configOrOptions = {}) {
  if (!Array.isArray(source.models) || !source.models.length)
    throw Error("model catalog is empty");
  const targets = configOrOptions.targets
    ? Object.values(configOrOptions.targets).filter((x) => x.app?.enabled)
    : [legacyTarget(configOrOptions)];
  const official = new Set(source.models.map((x) => x.slug));
  for (const target of targets)
    if (official.has(target.app.modelId))
      throw Error(`custom model conflicts with official model ${target.app.modelId}`);
  return {
    ...source,
    models: [...source.models, ...targets.map((x) => customModel(x, source))],
  };
}

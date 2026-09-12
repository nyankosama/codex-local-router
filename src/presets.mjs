const PRESETS = Object.freeze({
  "opencode-go/deepseek-v4.1-flash": Object.freeze({
    provider: {
      adapter: "opencode-go",
      responsesMessagePhasePolicy: "defer_until_done",
    },
    target: {
      model: "deepseek-v4.1-flash",
      wireApi: "responses",
      contextWindow: 400000,
      maxContextWindow: 400000,
      effectiveContextWindowPercent: 95,
      outputReserveTokens: 16384,
      inputModalities: ["text", "image"],
      compression: { mode: "summary" },
      capabilities: {
        responses: true,
        toolCalling: true,
        freeformTools: true,
        streaming: true,
        nativeWebSearch: false,
      },
      app: {
        enabled: true,
        modelId: "deepseek-v4.1-flash",
        displayName: "DeepSeek V4.1 Flash (custom)",
        reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
      },
    },
  }),
});

const mergeDefaults = (value, defaults) => {
  if (value == null) return structuredClone(defaults);
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof defaults !== "object" ||
    Array.isArray(defaults)
  )
    return value;
  const result = structuredClone(value);
  for (const [key, fallback] of Object.entries(defaults))
    result[key] = mergeDefaults(result[key], fallback);
  return result;
};

export function preset(id) {
  const found = PRESETS[id];
  if (!found) throw Error(`unknown model preset ${id}`);
  return structuredClone(found);
}

export function applyPreset(target, provider) {
  if (!target.preset) return { target, provider };
  const defaults = preset(target.preset);
  return {
    target: mergeDefaults(target, defaults.target),
    provider: mergeDefaults(provider, defaults.provider),
  };
}

export function listPresets() {
  return Object.keys(PRESETS);
}

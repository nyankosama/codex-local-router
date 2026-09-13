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
  "feei/gpt-5.6-sol": Object.freeze({
    provider: {
      adapter: "openai-compatible",
      baseUrl: "https://ai.feei.cn/v1",
      responsesMessagePhasePolicy: "passthrough",
    },
    target: {
      model: "gpt-5.6-sol",
      modelFamily: "openai-gpt",
      wireApi: "responses",
      contextWindow: 272000,
      maxContextWindow: 272000,
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
        modelId: "feei-gpt-5.6-sol",
        displayName: "GPT 5.6 Sol via ai.feei",
        description: "GPT 5.6 Sol through the configured ai.feei provider",
        providerLabel: "ai.feei",
        reasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
        useResponsesLite: true,
      },
    },
  }),
  "feei/gpt-6-astra": Object.freeze({
    provider: {
      adapter: "openai-compatible",
      baseUrl: "https://ai.feei.cn/v1",
      responsesMessagePhasePolicy: "passthrough",
    },
    target: {
      model: "gpt-6-astra",
      modelFamily: "openai-gpt",
      wireApi: "responses",
      contextWindow: 272000,
      maxContextWindow: 272000,
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
        modelId: "feei-gpt-6-astra",
        displayName: "GPT 6 Astra via ai.feei",
        description: "GPT 6 Astra through the configured ai.feei provider",
        providerLabel: "ai.feei",
        reasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
        useResponsesLite: true,
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

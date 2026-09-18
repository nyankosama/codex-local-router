import { readFile } from "node:fs/promises";
import { applyPreset, presetSupportsThirdPartyTemplate } from "./presets.mjs";
import { CONFIG_SCHEMA_VERSION, runtimePaths } from "./product.mjs";
import {
  effectiveThirdPartyGptAllowlist,
  normalizePluginPolicy,
} from "./tool-policy.mjs";
import {
  normalizeProviderSearchEndpoint,
  resolveStandaloneSearchPolicy,
  validateStandaloneSearchSource,
} from "./standalone-search.mjs";
import {
  resolveAppCapabilityProfile,
  validateAppCapabilityProfile,
  validateResolvedAppCapabilityProfile,
} from "./app-capability-profile.mjs";
import { PROMPT_CACHE_AFFINITIES } from "./prompt-cache-affinity.mjs";
import { validateInstructionSource } from "./instruction-source.mjs";
import { validateMultiAgentSource } from "./multi-agent-source.mjs";
import { validateInstructionDelivery } from "./instruction-delivery.mjs";
import {
  assertThirdPartyTemplateCompatible,
  validateThirdPartyTemplate,
} from "./third-party-template.mjs";
import {
  resolveSubscriptionSearchPolicy,
  validateSubscriptionSearchDelivery,
} from "./subscription-search.mjs";
const loopback = (h) => ["127.0.0.1", "localhost", "[::1]"].includes(h);
const conditions = new Set([
  "modelID",
  "thinkLevel",
  "stream",
  "hasTools",
  "tool",
  "routeHeader",
]);
const providerAdapters = new Set(["opencode-go", "openai-compatible"]);
const responsesMessagePhasePolicies = new Set([
  "passthrough",
  "defer_until_done",
]);
const compressionModes = new Set(["native", "summary", "unsupported"]);
const wireApis = new Set(["responses", "chat_completions"]);
const modelFamilies = new Set(["openai-gpt", "other"]);
const reasoningEfforts = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const endpointKeys = new Set(["responses", "chatCompletions"]);
function freeze(x) {
  if (x && typeof x === "object") {
    Object.values(x).forEach(freeze);
    Object.freeze(x);
  }
  return x;
}
export async function loadConfig(path) {
  const raw = JSON.parse(await readFile(path, "utf8"));
  const c = runtimeCompatibleConfig(raw);
  if (c.subscription?.catalogPath) {
    const catalog = JSON.parse(
      await readFile(c.subscription.catalogPath, "utf8"),
    );
    c.subscription.models = catalog.models
      .filter((x) => x.slug?.startsWith("gpt-"))
      .map((x) => x.slug);
  }
  return validate(c);
}

function runtimeCompatibleConfig(input) {
  const next = structuredClone(input);
  const sourceSchema = next.schemaVersion ?? 1;
  if (sourceSchema >= CONFIG_SCHEMA_VERSION) return next;
  for (const target of Object.values(next.targets ?? {})) {
    const provider = next.providers?.[target.provider];
    if (
      target.model !== "deepseek-v4.1-flash" ||
      !(
        provider?.adapter === "opencode-go" ||
        target.provider === "opencode-go"
      )
    ) continue;
    target.preset ??= "opencode-go/deepseek-v4.1-flash";
    if ([null, undefined, 131072].includes(target.contextWindow)) {
      delete target.contextWindow;
      delete target.maxContextWindow;
    }
    if (
      Array.isArray(target.inputModalities) &&
      target.inputModalities.length === 1 &&
      target.inputModalities[0] === "text"
    ) delete target.inputModalities;
  }
  return next;
}
export function validate(input) {
  const c = structuredClone(input);
  c.schemaVersion ??= 1;
  c.mode ??= "rules";
  if (!["rules", "fixed", "passthrough"].includes(c.mode))
    throw Error("invalid route mode");
  if (!c.providers || !c.targets || !c.defaultTarget)
    throw Error("config requires providers, targets and defaultTarget");
  c.pluginTools ??= {};
  c.pluginTools.thirdPartyGpt ??= {
    additionalAllowedPlugins: [],
    excludedDefaultPlugins: [],
  };
  for (const key of ["additionalAllowedPlugins", "excludedDefaultPlugins"]) {
    c.pluginTools.thirdPartyGpt[key] ??= [];
    if (
      !Array.isArray(c.pluginTools.thirdPartyGpt[key]) ||
      c.pluginTools.thirdPartyGpt[key].some(
        (name) => typeof name !== "string" || !name.trim(),
      )
    )
      throw Error(`invalid pluginTools.thirdPartyGpt.${key}`);
  }
  // Also validates alias-normalized add/remove conflicts.
  effectiveThirdPartyGptAllowlist(c);
  if (c.thirdPartyDefaults != null) {
    if (!c.thirdPartyDefaults || typeof c.thirdPartyDefaults !== "object" || Array.isArray(c.thirdPartyDefaults) ||
        Object.keys(c.thirdPartyDefaults).some((key) => key !== "template"))
      throw Error("invalid thirdPartyDefaults configuration");
    validateThirdPartyTemplate(c.thirdPartyDefaults.template);
  }
  if (c.standaloneSearch != null) {
    if (
      !c.standaloneSearch ||
      typeof c.standaloneSearch !== "object" ||
      Array.isArray(c.standaloneSearch) ||
      Object.keys(c.standaloneSearch).some((key) => key !== "thirdPartyGpt") ||
      !c.standaloneSearch.thirdPartyGpt ||
      typeof c.standaloneSearch.thirdPartyGpt !== "object" ||
      Array.isArray(c.standaloneSearch.thirdPartyGpt) ||
      Object.keys(c.standaloneSearch.thirdPartyGpt).some(
        (key) => key !== "defaultSource",
      )
    ) throw Error("invalid standaloneSearch configuration");
    validateStandaloneSearchSource(
      c.standaloneSearch.thirdPartyGpt.defaultSource,
      "standaloneSearch.thirdPartyGpt.defaultSource",
    );
  }
  for (const [id, target] of Object.entries(c.targets)) {
    const provider = c.providers[target.provider];
    if (!provider) continue;
    const applied = applyPreset(target, provider);
    c.targets[id] = applied.target;
    c.providers[target.provider] = applied.provider;
  }
  if (c.listen?.host && !loopback(c.listen.host))
    throw Error("listener must use loopback");
  if (
    c.listen?.port != null &&
    (!Number.isInteger(c.listen.port) ||
      c.listen.port < 0 ||
      c.listen.port > 65535)
  )
    throw Error("invalid port");
  for (const [name, p] of Object.entries(c.providers)) {
    p.adapter ??= name === "opencode-go" ? "opencode-go" : "openai-compatible";
    if (!providerAdapters.has(p.adapter))
      throw Error(`invalid provider adapter ${p.adapter}`);
    p.responsesMessagePhasePolicy ??=
      p.adapter === "opencode-go" ? "defer_until_done" : "passthrough";
    if (!responsesMessagePhasePolicies.has(p.responsesMessagePhasePolicy))
      throw Error(
        `invalid Responses message phase policy ${p.responsesMessagePhasePolicy}`,
      );
    const u = new URL(p.baseUrl);
    if (
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      !["http:", "https:"].includes(u.protocol) ||
      (u.protocol === "http:" && !loopback(u.hostname))
    )
      throw Error("invalid provider address");
    if (p.apiKey || p.token || p.authorization)
      throw Error("inline credentials forbidden");
    if (p.keychain && (!p.keychain.service || !p.keychain.account))
      throw Error("invalid keychain reference");
    if (p.promptCaching != null) {
      if (
        !p.promptCaching ||
        typeof p.promptCaching !== "object" ||
        Array.isArray(p.promptCaching) ||
        Object.keys(p.promptCaching).some((key) => key !== "affinity") ||
        !PROMPT_CACHE_AFFINITIES.has(p.promptCaching.affinity)
      ) throw Error(`invalid prompt cache affinity for provider ${name}`);
    }
    if (p.standaloneSearch != null) {
      if (
        !p.standaloneSearch ||
        typeof p.standaloneSearch !== "object" ||
        Array.isArray(p.standaloneSearch) ||
        Object.keys(p.standaloneSearch).some((key) => key !== "endpoint")
      ) throw Error(`invalid standalone search configuration for provider ${name}`);
      p.standaloneSearch.endpoint = normalizeProviderSearchEndpoint(
        p.standaloneSearch.endpoint,
      );
    }
    p.endpoints ??= {};
    if (Object.keys(p.endpoints).some((key) => !endpointKeys.has(key)))
      throw Error(`invalid endpoint key for provider ${name}`);
    for (const [key, path] of Object.entries(p.endpoints)) {
      if (typeof path !== "string" || !path.startsWith("/") || path.includes("?"))
        throw Error(`invalid ${key} endpoint for provider ${name}`);
    }
    p.concurrency ??= 4;
    if (!Number.isInteger(p.concurrency) || p.concurrency <= 0)
      throw Error(`invalid concurrency for provider ${name}`);
  }
  for (const [name, t] of Object.entries(c.targets)) {
    if (!c.providers[t.provider])
      throw Error(`target ${name} references unknown provider`);
    if (!t.model || !wireApis.has(t.wireApi))
      throw Error(`target ${name} requires model and wireApi`);
    t.id = name;
    t.contextWindow ??= null;
    t.maxContextWindow ??= t.contextWindow;
    t.effectiveContextWindowPercent ??= 95;
    t.outputReserveTokens ??= 16384;
    t.inputModalities ??= ["text"];
    t.compression ??= { mode: "unsupported" };
    if (t.modelFamily != null && !modelFamilies.has(t.modelFamily))
      throw Error(`invalid model family for target ${name}`);
    if (t.pluginToolPolicy != null)
      t.pluginToolPolicy = normalizePluginPolicy(t.pluginToolPolicy);
    if (c.schemaVersion >= 2 && !t.contextWindow)
      throw Error(`target ${name} requires an explicit context window`);
    if (!compressionModes.has(t.compression.mode))
      throw Error(`invalid compression mode for target ${name}`);
    if (t.compression.mode === "native") {
      const compatibility = t.compression.compatibility;
      if (
        !compatibility ||
        compatibility.accountScope !== "same" ||
        !Array.isArray(compatibility.targets) ||
        !compatibility.targets.includes(name)
      )
        throw Error(
          `native compression for target ${name} requires an explicit same-account compatibility target set`,
        );
    }
    for (const [key, value] of Object.entries({
      contextWindow: t.contextWindow,
      maxContextWindow: t.maxContextWindow,
      outputReserveTokens: t.outputReserveTokens,
    }))
      if (value != null && (!Number.isInteger(value) || value <= 0))
        throw Error(`invalid ${key} for target ${name}`);
    if (
      !Number.isInteger(t.effectiveContextWindowPercent) ||
      t.effectiveContextWindowPercent < 1 ||
      t.effectiveContextWindowPercent > 100
    )
      throw Error(`invalid effective context percentage for target ${name}`);
    if (
      !Array.isArray(t.inputModalities) ||
      !t.inputModalities.length ||
      t.inputModalities.some((x) => !["text", "image"].includes(x))
    )
      throw Error(`invalid input modalities for target ${name}`);
    if (t.wireApi === "chat_completions" && t.inputModalities.includes("image"))
      throw Error(`chat_completions image input is not implemented for target ${name}`);
    if (
      c.providers[t.provider].models &&
      !c.providers[t.provider].models.includes(t.model)
    )
      throw Error("target model absent from provider model list");
    if (t.capabilities?.responses && t.wireApi !== "responses")
      throw Error("responses capability conflicts with wireApi");
    if (t.capabilities?.nativeWebSearch && t.wireApi !== "responses")
      throw Error("native search requires responses");
    for (const v of Object.values(t.capabilities ?? {}))
      if (typeof v !== "boolean") throw Error("capabilities must be boolean");
    validateInstructionSource(t);
    validateMultiAgentSource(t);
    const genericTemplateQualified = presetSupportsThirdPartyTemplate(
      t.preset,
      "codex-general-v1",
    );
    if (t.app?.multiAgent != null && !genericTemplateQualified)
      throw Error(`App multi-agent is not qualified for preset ${t.preset}`);
    let appReasoningLevels;
    if (t.app?.reasoningLevels != null) {
      if (!Array.isArray(t.app.reasoningLevels) || !t.app.reasoningLevels.length)
        throw Error(`target ${name} requires non-empty App reasoning levels`);
      const levels = t.app.reasoningLevels.map((level) =>
        typeof level === "string" ? level : level?.effort,
      );
      if (
        levels.some((level) => !reasoningEfforts.has(level)) ||
        t.app.reasoningLevels.some(
          (level) =>
            typeof level !== "string" &&
            (!level ||
              typeof level !== "object" ||
              typeof level.description !== "string" ||
              !level.description),
        )
      )
        throw Error(`invalid App reasoning levels for target ${name}`);
      if (new Set(levels).size !== levels.length)
        throw Error(`duplicate App reasoning levels for target ${name}`);
      appReasoningLevels = levels;
    }
    if (
      t.app?.defaultReasoningLevel != null &&
      (!reasoningEfforts.has(t.app.defaultReasoningLevel) ||
        !(appReasoningLevels ?? ["low", "medium", "high", "xhigh"]).includes(
          t.app.defaultReasoningLevel,
        ))
    )
      throw Error(
        `default App reasoning level is unsupported for target ${name}`,
      );
    if (
      t.app?.shellType != null &&
      !["shell_command", "unified_exec"].includes(t.app.shellType)
    ) throw Error(`invalid App shell type for target ${name}`);
    const applyPatch = t.app?.applyPatchToolType;
    if (applyPatch != null && applyPatch !== "freeform")
      throw Error(`invalid App apply patch tool type for target ${name}`);
    if (
      (applyPatch ?? (t.capabilities?.freeformTools ? "freeform" : null)) === "freeform" &&
      t.capabilities?.freeformTools !== true
    )
      throw Error(`target ${name} declares freeform apply patch without freeform tool support`);
    if (
      t.app?.supportsSearchTool != null &&
      typeof t.app.supportsSearchTool !== "boolean"
    )
      throw Error(`invalid App search tool support for target ${name}`);
    if (
      t.app?.useResponsesLite != null &&
      typeof t.app.useResponsesLite !== "boolean"
    )
      throw Error(`invalid App Responses Lite flag for target ${name}`);
    if (t.app?.thirdPartyTemplate != null && (
      t.provider === "chatgpt-subscription" ||
      t.app.thirdPartyTemplate?.id !== "codex-general-v1" ||
      t.app.thirdPartyTemplate?.version !== 1 ||
      Object.keys(t.app.thirdPartyTemplate).some((key) => !["id", "version"].includes(key))
    )) throw Error(`invalid third-party template marker for target ${name}`);
    if (t.app?.thirdPartyTemplate?.id)
      assertThirdPartyTemplateCompatible(t, t.app.thirdPartyTemplate.id);
    if (t.app?.toolMode != null) {
      if (t.app.toolMode !== "code_mode_only")
        throw Error(`invalid App tool mode for target ${name}`);
      if (!genericTemplateQualified)
        throw Error(`App code mode is not qualified for preset ${t.preset}`);
      if (t.provider === "chatgpt-subscription" ||
          t.app.enabled !== true || t.wireApi !== "responses" ||
          t.capabilities?.freeformTools !== true || t.capabilities?.toolCalling !== true)
        throw Error(`App code mode requires a third-party App-enabled Responses target with freeform tool support: ${name}`);
    }
    if (t.app?.capabilityProfile != null) {
      if (!genericTemplateQualified)
        throw Error(`App capability profile is not qualified for preset ${t.preset}`);
      validateAppCapabilityProfile(
        t.app.capabilityProfile,
        `App capability profile for target ${name}`,
      );
      if (t.app.enabled !== true)
        throw Error(
          `App capability profile requires an App-enabled target ${name}`,
        );
      if (t.wireApi !== "responses")
        throw Error(`App capability profile requires Responses target ${name}`);
    }
    if (t.standaloneSearch != null) {
      if (
        !t.standaloneSearch ||
        typeof t.standaloneSearch !== "object" ||
        Array.isArray(t.standaloneSearch) ||
        Object.keys(t.standaloneSearch).some((key) => key !== "source")
      ) throw Error(`invalid standalone search configuration for target ${name}`);
      validateStandaloneSearchSource(
        t.standaloneSearch.source,
        `standalone search source for target ${name}`,
      );
      if (t.app?.supportsSearchTool != null) {
        const legacy = t.app.supportsSearchTool ? "subscription" : "disabled";
        if (legacy !== t.standaloneSearch.source)
          throw Error(`conflicting standalone search policy for target ${name}`);
      }
    }
    if (t.subscriptionSearch != null) {
      if (
        !t.subscriptionSearch ||
        typeof t.subscriptionSearch !== "object" ||
        Array.isArray(t.subscriptionSearch) ||
        Object.keys(t.subscriptionSearch).some((key) => key !== "delivery")
      ) throw Error(`invalid subscription search configuration for target ${name}`);
      validateSubscriptionSearchDelivery(
        t.subscriptionSearch.delivery,
        `subscription search delivery for target ${name}`,
      );
    }
    const explicitProfile = t.app?.capabilityProfile;
    if (
      (explicitProfile === "standard-tools" ||
        (explicitProfile == null &&
          t.modelFamily === "openai-gpt" &&
          t.app?.enabled === true &&
          t.wireApi === "responses" &&
          t.app.useResponsesLite !== true &&
          c.standaloneSearch?.thirdPartyGpt?.defaultSource == null)) &&
      t.standaloneSearch == null &&
      t.app.supportsSearchTool == null
    )
      t.standaloneSearch = { source: "disabled" };
    const search = resolveStandaloneSearchPolicy(c, t);
    const subscriptionSearch = resolveSubscriptionSearchPolicy(t);
    if (subscriptionSearch.delivery === "standard-tool") {
      if (
        t.provider === "chatgpt-subscription" ||
        t.app?.enabled !== true ||
        t.capabilities?.toolCalling !== true
      ) throw Error(
        `subscription search standard tool requires a third-party App-enabled target with tool calling: ${name}`,
      );
      if (
        t.app?.useResponsesLite === true ||
        ["subscription", "provider"].includes(search.source) ||
        t.capabilities?.nativeWebSearch === true
      ) throw Error(`conflicting subscription search delivery for target ${name}`);
    }
    if (explicitProfile === "standard-tools") {
      if (t.app.useResponsesLite == null) t.app.useResponsesLite = false;
    } else if (explicitProfile === "lite-search") {
      if (t.app.useResponsesLite == null) t.app.useResponsesLite = true;
    } else {
      const requiresStandaloneLite =
        search.advertised && search.reason !== "legacy-native-search-compatibility";
      if (requiresStandaloneLite && t.app?.enabled === true) {
        if (t.app.useResponsesLite === false)
          throw Error(`standalone search requires Responses Lite for target ${name}`);
        t.app.useResponsesLite ??= true;
      }
    }
    // Validate the effective profile, including profiles inferred from legacy
    // transport/search fields.  A derived profile must never bypass the same
    // transport and search invariants enforced for an explicit profile.
    validateResolvedAppCapabilityProfile(
      t,
      resolveAppCapabilityProfile(c, t),
      name,
    );
    validateInstructionDelivery(t);
    if (search.source === "provider") {
      if (t.wireApi !== "responses" || t.app?.enabled !== true)
        throw Error(`provider standalone search requires an App-enabled Responses target ${name}`);
      if (!c.providers[t.provider].standaloneSearch?.endpoint)
        throw Error(`provider standalone search endpoint is missing for target ${name}`);
    }
  }
  const target = (x) => !!c.targets[x];
  if (c.defaultTarget === "passthrough") {
    if (!target(c.passthroughTarget)) throw Error("passthroughTarget required");
  } else if (!target(c.defaultTarget))
    throw Error("defaultTarget does not exist");
  if (c.mode === "fixed" && !target(c.fixedTarget))
    throw Error("fixedTarget does not exist");
  if (
    c.mode === "passthrough" &&
    !target(c.passthroughTarget ?? c.defaultTarget)
  )
    throw Error("passthrough target missing");
  if (c.fallbackTarget && !target(c.fallbackTarget))
    throw Error("fallbackTarget does not exist");
  for (const r of c.rules ?? []) {
    if (
      !r.name ||
      !target(r.target) ||
      !r.match ||
      Object.keys(r.match).some((x) => !conditions.has(x))
    )
      throw Error("invalid routing rule");
  }
  if (c.subscription?.enabled) {
    const models = c.subscription.models;
    const catalogPath = c.subscription.catalogPath;
    if (
      (models != null && (
        !Array.isArray(models) ||
        !models.length ||
        models.some((x) => typeof x !== "string" || !x.startsWith("gpt-"))
      )) ||
      (models == null && (typeof catalogPath !== "string" || !catalogPath))
    )
      throw Error("subscription requires explicit GPT catalog");
    for (const [model, id] of Object.entries(c.subscription.customModels ?? {})) {
      if (!target(id))
        throw Error("invalid subscription custom model");
      c.targets[id].app ??= { enabled: true, modelId: model };
      if (c.targets[id].app.modelId && c.targets[id].app.modelId !== model)
        throw Error("conflicting custom model mapping");
    }
    const customModels = {};
    for (const [id, t] of Object.entries(c.targets)) {
      if (!t.app?.enabled) continue;
      const modelId = t.app.modelId ?? t.model;
      if (!modelId || typeof modelId !== "string" || modelId.startsWith("gpt-"))
        throw Error(`invalid App model ID for target ${id}`);
      if (customModels[modelId]) throw Error(`duplicate App model ID ${modelId}`);
      customModels[modelId] = id;
      t.app.modelId = modelId;
    }
    c.subscription.customModels = customModels;
  }
  for (const key of ["timeoutMs", "maxBodyBytes", "maxConnections"])
    if (c[key] != null && (!Number.isFinite(c[key]) || c[key] <= 0))
      throw Error(`invalid ${key}`);
  for (const key of ["maxBytes", "ttlMs", "observationWaitMs"])
    if (
      c.history?.[key] != null &&
      (!Number.isFinite(c.history[key]) || c.history[key] <= 0)
    )
      throw Error(`invalid history ${key}`);
  c.history ??= {};
  c.history.persistent ??= { enabled: false };
  if (typeof c.history.persistent.enabled !== "boolean")
    throw Error("invalid persistent history setting");
  for (const key of ["diskMaxBytes", "warningPercent"])
    if (
      c.history.persistent[key] != null &&
      (!Number.isFinite(c.history.persistent[key]) || c.history.persistent[key] <= 0)
    )
      throw Error(`invalid persistent history ${key}`);
  if (
    c.history.persistent.warningPercent != null &&
    c.history.persistent.warningPercent > 100
  )
    throw Error("persistent history warningPercent must not exceed 100");
  if (c.webSearch) {
    if (!["fake", "tavily", "exa"].includes(c.webSearch.backend))
      throw Error("unknown search adapter");
    if (c.webSearch.apiKey)
      throw Error("inline web search credentials forbidden");
    c.webSearch.maxRounds ??= 3;
    c.webSearch.maxExtractCharacters ??= 20000;
    if (
      !Number.isInteger(c.webSearch.maxRounds) ||
      c.webSearch.maxRounds < 1 ||
      c.webSearch.maxRounds > 10
    )
      throw Error("invalid web search maxRounds");
    if (
      !Number.isInteger(c.webSearch.maxExtractCharacters) ||
      c.webSearch.maxExtractCharacters < 1000 ||
      c.webSearch.maxExtractCharacters > 100000
    )
      throw Error("invalid web search maxExtractCharacters");
    for (const key of ["baseUrl", "extractUrl", "contentsUrl"]) {
      if (!c.webSearch[key]) continue;
      const url = new URL(c.webSearch[key]);
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !["http:", "https:"].includes(url.protocol) ||
        (url.protocol === "http:" && !loopback(url.hostname))
      )
        throw Error(`invalid web search ${key}`);
      }
  }
  c.access ??= { required: false };
  if (typeof c.access.required !== "boolean")
    throw Error("invalid local access policy");
  if (c.access.required && !c.access.tokenEnv && !c.access.keychain && !c.access.tokenFile)
    throw Error("local access requires tokenEnv, tokenFile or keychain reference");
  return freeze(c);
}

export function upgradeConfig(input) {
  const next = structuredClone(input);
  const changes = [];
  const sourceSchema = next.schemaVersion ?? 1;
  if ((next.schemaVersion ?? 1) < CONFIG_SCHEMA_VERSION) {
    next.schemaVersion = CONFIG_SCHEMA_VERSION;
    changes.push(`schemaVersion=${CONFIG_SCHEMA_VERSION}`);
  }
  for (const [id, target] of Object.entries(next.targets ?? {})) {
    const provider = next.providers?.[target.provider];
    if (
      !target.preset &&
      target.model === "deepseek-v4.1-flash" &&
      (provider?.adapter === "opencode-go" || target.provider === "opencode-go")
    ) {
      target.preset = "opencode-go/deepseek-v4.1-flash";
      changes.push(`targets.${id}.preset=${target.preset}`);
    }
    if (sourceSchema < 3 && target.preset === "opencode-go/deepseek-v4.1-flash") {
      if ([null, undefined, 131072].includes(target.contextWindow)) {
        delete target.contextWindow;
        delete target.maxContextWindow;
        changes.push(`targets.${id}.contextWindow=preset`);
      }
      if (
        Array.isArray(target.inputModalities) &&
        target.inputModalities.length === 1 &&
        target.inputModalities[0] === "text"
      ) {
        delete target.inputModalities;
        changes.push(`targets.${id}.inputModalities=preset`);
      }
    }
    if (target.preset) {
      const applied = applyPreset(target, provider ?? {});
      next.targets[id] = applied.target;
      if (provider) next.providers[target.provider] = applied.provider;
    }
  }
  for (const [name, provider] of Object.entries(next.providers ?? {})) {
    if (!provider.adapter) {
      provider.adapter =
        name === "opencode-go" ? "opencode-go" : "openai-compatible";
      changes.push(`providers.${name}.adapter=${provider.adapter}`);
    }
    if (!provider.responsesMessagePhasePolicy) {
      provider.responsesMessagePhasePolicy =
        provider.adapter === "opencode-go"
          ? "defer_until_done"
          : "passthrough";
      changes.push(
        `providers.${name}.responsesMessagePhasePolicy=${provider.responsesMessagePhasePolicy}`,
      );
    }
    if (provider.concurrency == null) {
      provider.concurrency = 4;
      changes.push(`providers.${name}.concurrency=4`);
    }
    provider.endpoints ??= {};
  }
  for (const [id, target] of Object.entries(next.targets ?? {})) {
    const set = (key, value) => {
      if (target[key] !== undefined) return;
      target[key] = value;
      changes.push(`targets.${id}.${key}`);
    };
    set("effectiveContextWindowPercent", 95);
    set("outputReserveTokens", 16384);
    set("inputModalities", ["text"]);
    set("compression", { mode: "unsupported" });
    if (target.contextWindow == null) {
      // Preserve the old gateway's conservative implicit capacity as an
      // explicit migration value. This is not a channel capability verdict;
      // live acceptance remains separate.
      target.contextWindow = 131072;
      target.maxContextWindow = 131072;
      changes.push(`targets.${id}.contextWindow=131072 (legacy default)`);
      changes.push(`targets.${id}.maxContextWindow=131072 (legacy default)`);
    } else
      set("maxContextWindow", target.contextWindow);
  }
  for (const [modelId, targetId] of Object.entries(
    next.subscription?.customModels ?? {},
  )) {
    const target = next.targets?.[targetId];
    if (!target) throw Error(`custom model ${modelId} references ${targetId}`);
    target.app ??= {};
    if (target.app.modelId && target.app.modelId !== modelId)
      throw Error(`custom model conflict for ${targetId}`);
    target.app.enabled = true;
    target.app.modelId = modelId;
    changes.push(`targets.${targetId}.app`);
  }
  if (next.subscription?.customModels) {
    delete next.subscription.customModels;
    changes.push("subscription.customModels derived from targets");
  }
  if (!next.access) {
    next.access = { required: true, tokenFile: runtimePaths().accessToken };
    changes.push("access.localToken");
  }
  next.history ??= {};
  if (!next.history.persistent) {
    next.history.persistent = {
      enabled: true,
      diskMaxBytes: 10 * 1024 ** 3,
      warningPercent: 80,
    };
    changes.push("history.persistent");
  }
  const candidate = structuredClone(next);
  if (
    candidate.subscription?.enabled &&
    candidate.subscription.catalogPath &&
    !candidate.subscription.models
  )
    candidate.subscription.models = ["gpt-catalog-placeholder"];
  validate(candidate);
  return { config: next, changes };
}

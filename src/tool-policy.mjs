import { fail } from "./errors.mjs";

export const DEFAULT_THIRD_PARTY_GPT_PLUGINS = Object.freeze([
  "github",
  "figma",
  "sites",
  "connected_documents",
]);

const pluginAliases = new Map([
  ["spreadsheets", "connected_documents"],
  ["connected_documents", "connected_documents"],
  ["codex_document_control", "connected_documents"],
]);

const corePrefixes = ["mcp__codex_app__", "mcp__cua_repl__"];
const internalToolNames = new Set([
  "gateway_web_search",
  "gateway_subscription_web_search",
  "gateway_web_fetch",
]);
// Names emitted by the current Codex App core in ordinary function form. Unknown
// future built-ins are still passed through, but these trusted names avoid
// misreporting the normal Codex surface as an uncertain source.
const coreToolNames = new Set([
  "apply_patch",
  "exec_command",
  "image_gen",
  "list_mcp_resource_templates",
  "list_mcp_resources",
  "multi_agent_v1",
  "read_mcp_resource",
  "request_plugin_install",
  "request_user_input",
  "view_image",
  "write_stdin",
]);

export const canonicalPluginName = (name) => {
  const normalized = String(name ?? "").trim().toLowerCase().replace(/-/g, "_");
  return pluginAliases.get(normalized) ?? normalized;
};

const normalizedList = (values = []) =>
  [...new Set(values.map(canonicalPluginName).filter(Boolean))];

export function effectiveThirdPartyGptAllowlist(config) {
  const extension = config.pluginTools?.thirdPartyGpt ?? {};
  const additional = normalizedList(extension.additionalAllowedPlugins);
  const excluded = normalizedList(extension.excludedDefaultPlugins);
  const conflict = additional.find((name) => excluded.includes(name));
  if (conflict)
    throw Error(`plugin allowlist extension both adds and excludes ${conflict}`);
  return normalizedList([
    ...DEFAULT_THIRD_PARTY_GPT_PLUGINS,
    ...additional,
  ]).filter((name) => !excluded.includes(name));
}

export function normalizePluginPolicy(policy) {
  if (policy == null) return undefined;
  if (["passthrough", "third-party-gpt-default"].includes(policy)) return policy;
  if (
    !policy ||
    typeof policy !== "object" ||
    Array.isArray(policy) ||
    policy.mode !== "allowlist" ||
    !Array.isArray(policy.allowedPlugins) ||
    policy.allowedPlugins.some((name) => typeof name !== "string" || !name.trim())
  )
    throw Error("invalid plugin tool policy");
  return {
    mode: "allowlist",
    allowedPlugins: normalizedList(policy.allowedPlugins),
  };
}

export function resolvePluginToolPolicy(config, target) {
  if (target.provider === "chatgpt-subscription")
    return {
      mode: "passthrough",
      reason: "official-subscription",
      allowedPlugins: [],
    };
  const explicit = normalizePluginPolicy(target.pluginToolPolicy);
  if (explicit === "passthrough")
    return { mode: "passthrough", reason: "explicit", allowedPlugins: [] };
  if (explicit === "third-party-gpt-default")
    return {
      mode: "allowlist",
      reason: "explicit-third-party-gpt-default",
      allowedPlugins: effectiveThirdPartyGptAllowlist(config),
    };
  if (explicit?.mode === "allowlist")
    return {
      mode: "allowlist",
      reason: "explicit-allowlist",
      allowedPlugins: explicit.allowedPlugins,
    };
  if (target.modelFamily === "openai-gpt")
    return {
      mode: "allowlist",
      reason: "third-party-openai-gpt-default",
      allowedPlugins: effectiveThirdPartyGptAllowlist(config),
    };
  return {
    mode: "passthrough",
    reason: target.modelFamily === "other" ? "non-gpt-default" : "legacy-default",
    allowedPlugins: [],
  };
}

function toolName(tool) {
  return tool?.name ?? tool?.function?.name ?? "";
}

function sourceLabels(tool) {
  return [tool?.namespace, tool?.server_label]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
}

function registeredMcpSource(value, registry) {
  const label = String(value ?? "").trim();
  const candidate = label.replace(/^mcp__/, "");
  if (!candidate) return null;
  const user = registry?.userMcpServers?.has(candidate);
  const plugin = registry?.pluginMcpServers?.has(candidate);
  if (!user && !plugin) return null;
  return { server: candidate, user, plugin };
}

function appSource(name, registry) {
  if (!name.startsWith("mcp__codex_apps__")) return null;
  const suffix = name.slice("mcp__codex_apps__".length);
  return [...(registry?.pluginApps ?? [])]
    .sort((a, b) => b.length - a.length)
    .find((candidate) => suffix === candidate || suffix.startsWith(`${candidate}_`));
}

export function classifyTool(tool, registry = {}) {
  const name = toolName(tool);
  const labels = sourceLabels(tool);
  if ((name === "collaboration" || labels.includes("collaboration")) &&
      (registry?.userMcpServers?.has("collaboration") || registry?.pluginMcpServers?.has("collaboration")))
    return { kind: "collision", name, source: "collaboration" };
  if (
    internalToolNames.has(name) ||
    coreToolNames.has(name) ||
    corePrefixes.some((prefix) => name.startsWith(prefix)) ||
    labels.some((label) => registry?.coreNamespaces?.has(label))
  )
    return { kind: "core", name };

  const app = appSource(name, registry) ?? labels.find((label) => registry?.pluginApps?.has(label));
  if (app) {
    const collides =
      (name.startsWith("mcp__codex_apps__") && registry?.userMcpServers?.has("codex_apps")) ||
      (labels.includes(app) && registry?.userMcpServers?.has(app));
    if (collides) return { kind: "collision", name, source: app };
    return {
      kind: "plugin",
      name,
      source: app,
      plugin: canonicalPluginName(app),
    };
  }

  if (tool?.type === "namespace") {
    const namespace = name.replace(/^mcp__codex_apps__/, "");
    if (registry?.coreNamespaces?.has(namespace))
      return { kind: "core", name, source: namespace };
    if (registry?.pluginApps?.has(namespace))
      return {
        kind: "plugin",
        name,
        source: namespace,
        plugin: canonicalPluginName(namespace),
      };
    const registered = registeredMcpSource(name, registry);
    if (registered) {
      if (registered.user && registered.plugin)
        return { kind: "collision", name, source: registered.server };
      if (registered.user)
        return { kind: "user-mcp", name, source: registered.server };
      return {
        kind: "plugin",
        name,
        source: registered.server,
        plugin: canonicalPluginName(
          registry.pluginMcpOwners?.get(registered.server) ?? registered.server,
        ),
      };
    }
  }

  for (const label of labels) {
    const registered = registeredMcpSource(label, registry);
    if (!registered) continue;
    if (registered.user && registered.plugin)
      return { kind: "collision", name, source: registered.server };
    if (registered.user)
      return { kind: "user-mcp", name, source: registered.server };
    return {
      kind: "plugin",
      name,
      source: registered.server,
      plugin: canonicalPluginName(
        registry.pluginMcpOwners?.get(registered.server) ?? registered.server,
      ),
    };
  }

  const servers = [
    ...(registry?.userMcpServers ?? []),
    ...(registry?.pluginMcpServers ?? []),
  ].sort((a, b) => b.length - a.length);
  const server = servers.find(
    (candidate) =>
      name.startsWith(`mcp__${candidate}__`) || labels.includes(candidate),
  );
  if (server) {
    const user = registry?.userMcpServers?.has(server);
    const plugin = registry?.pluginMcpServers?.has(server);
    if (user && plugin) return { kind: "collision", name, source: server };
    if (user) return { kind: "user-mcp", name, source: server };
    if (plugin)
      return {
        kind: "plugin",
        name,
        source: server,
        plugin: canonicalPluginName(registry.pluginMcpOwners?.get(server) ?? server),
      };
  }
  return { kind: "unknown", name };
}

function allowed(classification, allowlist) {
  return classification.kind !== "plugin" || allowlist.has(classification.plugin);
}

const sourceCountKey = (classification, allowlist) => {
  if (classification.kind === "plugin")
    return allowlist.has(classification.plugin) ? "allowed_plugin" : "removed_plugin";
  if (classification.kind === "user-mcp") return "user_mcp";
  return classification.kind;
};

function filterTools(tools, registry, allowlist, diagnostics, inheritedSource) {
  if (!Array.isArray(tools)) return tools;
  const filtered = [];
  for (const tool of tools) {
    const direct = classifyTool(tool, registry);
    const inherited =
      direct.kind === "unknown" && inheritedSource && inheritedSource.kind !== "unknown";
    const classification = inherited
      ? { ...inheritedSource, name: direct.name, inherited: true }
      : direct;
    diagnostics.sourceCounts[sourceCountKey(classification, allowlist)]++;
    if (inherited) diagnostics.inheritedSourceCount++;
    if (!allowed(classification, allowlist)) {
      diagnostics.removed.push(classification);
      continue;
    }
    if (["unknown", "collision"].includes(classification.kind))
      diagnostics.passedUncertain.push(classification);
    if (tool?.type === "namespace" && Array.isArray(tool.tools)) {
      const nested = filterTools(
        tool.tools,
        registry,
        allowlist,
        diagnostics,
        classification,
      );
      if (!nested.length) {
        diagnostics.removed.push({ ...classification, reason: "empty-namespace" });
        continue;
      }
      filtered.push(nested === tool.tools ? tool : { ...tool, tools: nested });
    } else filtered.push(tool);
  }
  return filtered.length === tools.length && filtered.every((tool, index) => tool === tools[index])
    ? tools
    : filtered;
}

function explicitToolChoices(choice) {
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return [];
  if (choice.type === "allowed_tools")
    return Array.isArray(choice.tools) ? choice.tools : [];
  if (["required", "auto", "none"].includes(choice.type)) return [];
  return choice.name
    ? [{ type: choice.type, name: choice.name, server_label: choice.server_label }]
    : choice.function?.name
      ? [{ type: choice.type ?? "function", name: choice.function.name }]
      : [];
}

export function applyPluginToolPolicy(body, policy, registry = {}) {
  if (policy.mode === "passthrough")
    return {
      body,
      diagnostics: { removed: [], passedUncertain: [] },
    };
  const allowlist = new Set(policy.allowedPlugins);
  const diagnostics = {
    removed: [],
    passedUncertain: [],
    sourceCounts: {
      core: 0,
      user_mcp: 0,
      allowed_plugin: 0,
      removed_plugin: 0,
      unknown: 0,
      collision: 0,
    },
    inheritedSourceCount: 0,
  };
  const tools = filterTools(body.tools, registry, allowlist, diagnostics);
  const input = Array.isArray(body.input)
    ? body.input.flatMap((item) => {
        if (item?.type !== "additional_tools" || !Array.isArray(item.tools)) return [item];
        const additional = filterTools(item.tools, registry, allowlist, diagnostics);
        return additional.length ? [{ ...item, tools: additional }] : [];
      })
    : body.input;
  for (const choice of explicitToolChoices(body.tool_choice)) {
    const classification = classifyTool(choice, registry);
    if (!allowed(classification, allowlist))
      throw fail(
        "tool_policy_conflict",
        400,
        `tool_choice selects disallowed Plugin ${classification.plugin}`,
      );
  }
  return {
    body:
      tools === body.tools && input === body.input
        ? body
        : { ...body, ...(tools === undefined ? {} : { tools }), input },
    diagnostics,
  };
}

function outputItems(event) {
  const candidates = [];
  if (event?.item) candidates.push(event.item);
  if (Array.isArray(event?.output)) candidates.push(...event.output);
  if (Array.isArray(event?.response?.output)) candidates.push(...event.response.output);
  if (event?.type === "function_call" || event?.type === "custom_tool_call")
    candidates.push(event);
  return candidates;
}

export function assertAllowedPluginToolCalls(event, policy, registry = {}) {
  if (policy.mode === "passthrough") return;
  const allowlist = new Set(policy.allowedPlugins);
  for (const item of outputItems(event)) {
    if (!["function_call", "custom_tool_call", "mcp_call"].includes(item?.type)) continue;
    const classification = classifyTool(item, registry);
    if (!allowed(classification, allowlist))
      throw fail(
        "disallowed_plugin_tool_call",
        502,
        `upstream attempted disallowed Plugin ${classification.plugin}`,
      );
  }
}

export function toolSourceStatus(registry = {}) {
  return {
    status: registry.status ?? "unavailable",
    pluginApps: registry.pluginApps?.size ?? 0,
    pluginMcpServers: registry.pluginMcpServers?.size ?? 0,
    userMcpServers: registry.userMcpServers?.size ?? 0,
    collisions: [...(registry.pluginMcpServers ?? [])].filter((name) =>
      registry.userMcpServers?.has(name),
    ).length,
  };
}

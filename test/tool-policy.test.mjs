import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_THIRD_PARTY_GPT_PLUGINS,
  applyPluginToolPolicy,
  assertAllowedPluginToolCalls,
  canonicalPluginName,
  classifyTool,
  effectiveThirdPartyGptAllowlist,
  resolvePluginToolPolicy,
} from "../src/tool-policy.mjs";
import { discoverToolSources } from "../src/tool-sources.mjs";

const registry = {
  status: "fixture",
  pluginApps: new Set([
    "github",
    "figma",
    "sites",
    "codex_document_control",
    "safety_settings",
    "gmail",
  ]),
  pluginMcpServers: new Set(["plugin_server", "collision"]),
  pluginMcpOwners: new Map([
    ["plugin_server", "gmail"],
    ["collision", "gmail"],
  ]),
  userMcpServers: new Set(["node_repl", "collision"]),
  coreNamespaces: new Set(["codex_app", "cua_repl"]),
};

const config = (extension = {}) => ({
  pluginTools: {
    thirdPartyGpt: {
      additionalAllowedPlugins: [],
      excludedDefaultPlugins: [],
      ...extension,
    },
  },
});

test("code mode leaves embedded exec documentation opaque while filtering structured Plugins", () => {
  const policy = resolvePluginToolPolicy(config(), { provider: "vendor", modelFamily: "openai-gpt" });
  const exec = { type: "custom", name: "exec", description: "SYNTHETIC tools.mcp__plugin_server__read(args)" };
  const blocked = { type: "function", name: "mcp__plugin_server__read" };
  for (const lite of [false, true]) {
    const tools = [{ type: "namespace", name: "functions", tools: [exec] }, blocked];
    const body = lite
      ? { input: [{ type: "additional_tools", tools }, { role: "user", content: "UNCHANGED" }] }
      : { tools, input: [{ role: "user", content: "UNCHANGED" }] };
    const snapshot = structuredClone(body);
    const result = applyPluginToolPolicy(body, policy, registry).body;
    assert.deepEqual(body, snapshot);
    assert.deepEqual(lite ? result.input[0].tools : result.tools, [tools[0]]);
    assert.deepEqual(applyPluginToolPolicy(result, policy, registry).body, result);
    assert.deepEqual(result.input.at(-1), body.input.at(-1));
    assert.doesNotThrow(() => assertAllowedPluginToolCalls({
      type: "custom_tool_call", name: "exec", input: "tools.mcp__plugin_server__read({})",
    }, policy, registry), "the existing policy is not a JavaScript execution sandbox");
  }
});

test("A1 resolves official, GPT, non-GPT, legacy and explicit policy precedence", () => {
  const c = config();
  assert.equal(
    resolvePluginToolPolicy(c, { provider: "chatgpt-subscription", modelFamily: "openai-gpt" }).reason,
    "official-subscription",
  );
  assert.equal(
    resolvePluginToolPolicy(c, { provider: "vendor", modelFamily: "openai-gpt" }).reason,
    "third-party-openai-gpt-default",
  );
  assert.equal(
    resolvePluginToolPolicy(c, { provider: "vendor", modelFamily: "other" }).reason,
    "non-gpt-default",
  );
  assert.equal(
    resolvePluginToolPolicy(c, { provider: "vendor" }).reason,
    "legacy-default",
  );
  assert.equal(
    resolvePluginToolPolicy(c, {
      provider: "vendor",
      modelFamily: "openai-gpt",
      pluginToolPolicy: "passthrough",
    }).reason,
    "explicit",
  );
  assert.deepEqual(
    resolvePluginToolPolicy(c, {
      provider: "vendor",
      modelFamily: "other",
      pluginToolPolicy: { mode: "allowlist", allowedPlugins: ["gmail"] },
    }).allowedPlugins,
    ["gmail"],
  );
});

test("A1 normalizes allowlist aliases and rejects add/exclude conflicts", () => {
  assert.deepEqual(DEFAULT_THIRD_PARTY_GPT_PLUGINS, [
    "github",
    "figma",
    "sites",
    "connected_documents",
  ]);
  assert.equal(canonicalPluginName("spreadsheets"), "connected_documents");
  assert.equal(canonicalPluginName("codex-document-control"), "connected_documents");
  assert.deepEqual(
    effectiveThirdPartyGptAllowlist(config({
      additionalAllowedPlugins: ["gmail", "spreadsheets"],
      excludedDefaultPlugins: ["figma"],
    })),
    ["github", "sites", "connected_documents", "gmail"],
  );
  assert.throws(
    () => effectiveThirdPartyGptAllowlist(config({
      additionalAllowedPlugins: ["spreadsheets"],
      excludedDefaultPlugins: ["codex_document_control"],
    })),
    /both adds and excludes connected_documents/,
  );
});

test("A2 identifies core, user MCP, plugin, alias, unknown and collision sources", () => {
  assert.equal(classifyTool({ name: "mcp__codex_app__open_in_codex" }, registry).kind, "core");
  assert.equal(classifyTool({ name: "mcp__cua_repl__js" }, registry).kind, "core");
  assert.equal(classifyTool({ name: "gateway_web_search" }, registry).kind, "core");
  assert.equal(classifyTool({ name: "mcp__node_repl__execute" }, registry).kind, "user-mcp");
  assert.equal(classifyTool({ name: "mcp__plugin_server__read" }, registry).plugin, "gmail");
  assert.equal(classifyTool({ name: "mcp__codex_apps__codex_document_control" }, registry).plugin, "connected_documents");
  assert.equal(classifyTool({ name: "mcp__codex_apps__safety_settings" }, registry).plugin, "safety_settings");
  assert.equal(classifyTool({ name: "exec_command" }, registry).kind, "core");
  assert.equal(
    classifyTool({ type: "function", name: "read", server_label: "plugin_server" }, registry).plugin,
    "gmail",
  );
  assert.equal(
    classifyTool({ type: "function", name: "read", server_label: "node_repl" }, registry).kind,
    "user-mcp",
  );
  assert.equal(classifyTool({ name: "mcp__unregistered__read" }, registry).kind, "unknown");
  assert.equal(classifyTool({ name: "mcp__codex_apps__hotline" }, registry).kind, "unknown");
  assert.equal(classifyTool({ name: "mcp__collision__read" }, registry).kind, "collision");
  assert.equal(
    classifyTool(
      { name: "mcp__codex_apps__gmail" },
      { ...registry, userMcpServers: new Set([...registry.userMcpServers, "codex_apps"]) },
    ).kind,
    "collision",
  );
});

test("A2 identifies current Codex namespace carriers for Plugin and user MCP sources", () => {
  const registry = {
    pluginApps: new Set(),
    pluginMcpServers: new Set(["acceptance_github", "acceptance_gmail"]),
    pluginMcpOwners: new Map([
      ["acceptance_github", "github"],
      ["acceptance_gmail", "gmail"],
    ]),
    userMcpServers: new Set(["router_acceptance"]),
    coreNamespaces: new Set(),
  };
  assert.deepEqual(
    classifyTool({ type: "namespace", name: "mcp__acceptance_github", tools: [] }, registry),
    { kind: "plugin", name: "mcp__acceptance_github", source: "acceptance_github", plugin: "github" },
  );
  assert.deepEqual(
    classifyTool({ type: "namespace", name: "mcp__acceptance_gmail", tools: [] }, registry),
    { kind: "plugin", name: "mcp__acceptance_gmail", source: "acceptance_gmail", plugin: "gmail" },
  );
  assert.deepEqual(
    classifyTool({ type: "namespace", name: "mcp__router_acceptance", tools: [] }, registry),
    { kind: "user-mcp", name: "mcp__router_acceptance", source: "router_acceptance" },
  );
  assert.equal(
    classifyTool({ type: "function_call", namespace: "mcp__acceptance_gmail", name: "read" }, registry).plugin,
    "gmail",
  );
});

test("A3 filters function, namespace and additional_tools carriers without changing content", () => {
  const body = {
    model: "fixture",
    instructions: "keep exactly",
    tools: [
      { type: "function", name: "exec_command", description: "built in" },
      { type: "namespace", name: "mcp__codex_apps__github", schema: { keep: true } },
      { type: "namespace", name: "mcp__codex_apps__gmail", schema: { secret: "fixture" } },
      { type: "namespace", name: "mcp__codex_apps__codex_document_control" },
      { type: "function", name: "mcp__node_repl__execute" },
      { type: "function", name: "mcp__unregistered__read" },
      { type: "function", name: "mcp__collision__read" },
    ],
    input: [
      { role: "user", content: "do not rewrite" },
      {
        type: "additional_tools",
        tools: [
          { type: "namespace", name: "mcp__codex_apps__figma" },
          { type: "namespace", name: "mcp__codex_apps__safety_settings" },
        ],
      },
    ],
  };
  const policy = { mode: "allowlist", allowedPlugins: [...DEFAULT_THIRD_PARTY_GPT_PLUGINS] };
  const filtered = applyPluginToolPolicy(body, policy, registry);
  assert.deepEqual(filtered.body.tools.map((tool) => tool.name), [
    "exec_command",
    "mcp__codex_apps__github",
    "mcp__codex_apps__codex_document_control",
    "mcp__node_repl__execute",
    "mcp__unregistered__read",
    "mcp__collision__read",
  ]);
  assert.deepEqual(filtered.body.input[1].tools.map((tool) => tool.name), [
    "mcp__codex_apps__figma",
  ]);
  assert.equal(filtered.body.instructions, body.instructions);
  assert.equal(filtered.body.input[0], body.input[0]);
  assert.equal(filtered.diagnostics.removed.length, 2);
  assert.deepEqual(
    applyPluginToolPolicy(filtered.body, policy, registry).body,
    filtered.body,
  );
});

test("A2/A3 inherits namespace provenance for diagnostics without changing filtering", () => {
  const body = {
    input: [{
      type: "additional_tools",
      tools: [
        { type: "namespace", name: "codex_app", tools: [{ type: "function", name: "future_core" }] },
        { type: "namespace", name: "mcp__codex_apps__github", tools: [{ type: "function", name: "search" }] },
        { type: "namespace", name: "mcp__node_repl", tools: [{ type: "function", name: "execute" }] },
        { type: "namespace", name: "mcp__collision", tools: [{ type: "function", name: "inspect" }] },
        { type: "namespace", name: "future_namespace", tools: [{ type: "function", name: "mystery" }] },
        { type: "namespace", name: "mcp__codex_apps__gmail", tools: [{ type: "function", name: "read" }] },
      ],
    }],
  };
  const filtered = applyPluginToolPolicy(
    body,
    { mode: "allowlist", allowedPlugins: ["github"] },
    registry,
  );
  assert.deepEqual(filtered.body.input[0].tools.map((tool) => tool.name), [
    "codex_app",
    "mcp__codex_apps__github",
    "mcp__node_repl",
    "mcp__collision",
    "future_namespace",
  ]);
  assert.deepEqual(filtered.diagnostics.sourceCounts, {
    core: 2,
    user_mcp: 2,
    allowed_plugin: 2,
    removed_plugin: 1,
    unknown: 2,
    collision: 2,
  });
  assert.equal(filtered.diagnostics.inheritedSourceCount, 4);
  assert.equal(filtered.diagnostics.passedUncertain.length, 4);
});

test("A3 removes empty additional_tools and rejects an explicit removed tool_choice", () => {
  const policy = { mode: "allowlist", allowedPlugins: ["github"] };
  const body = {
    input: [{ type: "additional_tools", tools: [{ type: "namespace", name: "mcp__codex_apps__gmail" }] }],
  };
  assert.deepEqual(applyPluginToolPolicy(body, policy, registry).body.input, []);
  assert.throws(
    () => applyPluginToolPolicy({
      ...body,
      tool_choice: { type: "namespace", name: "mcp__codex_apps__gmail" },
    }, policy, registry),
    (error) => error.type === "tool_policy_conflict" && error.status === 400,
  );
  assert.throws(
    () => applyPluginToolPolicy({
      ...body,
      tool_choice: {
        type: "allowed_tools",
        mode: "auto",
        tools: [{ type: "namespace", name: "mcp__codex_apps__gmail" }],
      },
    }, policy, registry),
    (error) => error.type === "tool_policy_conflict" && error.status === 400,
  );
});

test("A4 blocks confirmed disallowed direct calls but preserves allowed and uncertain calls", () => {
  const policy = { mode: "allowlist", allowedPlugins: ["github"] };
  assert.doesNotThrow(() => assertAllowedPluginToolCalls({
    type: "response.completed",
    response: {
      output: [
        { type: "function_call", name: "mcp__codex_apps__github", call_id: "1" },
        { type: "function_call", name: "mcp__node_repl__execute", call_id: "2" },
        { type: "function_call", name: "mcp__unregistered__read", call_id: "3" },
      ],
    },
  }, policy, registry));
  assert.throws(
    () => assertAllowedPluginToolCalls({
      type: "response.output_item.done",
      item: { type: "function_call", name: "mcp__codex_apps__gmail", call_id: "4" },
    }, policy, registry),
    (error) => error.type === "disallowed_plugin_tool_call" && error.status === 502,
  );
});

test("A2 discovers enabled Plugin manifests and user MCP config without executing them", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "router-tool-sources-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plugin = join(root, "plugins", "cache", "fixture-market", "fixture-plugin", "1.0.0");
  await mkdir(plugin, { recursive: true });
  await writeFile(join(root, "config.toml"), [
    '[plugins."fixture-plugin@fixture-market"]',
    "enabled = true",
    "[mcp_servers.user_tools]",
    'command = "never-executed"',
    "",
  ].join("\n"));
  await writeFile(join(plugin, ".app.json"), JSON.stringify({
    apps: { fixture_app: { id: "fixture" } },
  }));
  await writeFile(join(plugin, ".mcp.json"), JSON.stringify({
    mcpServers: { fixture_plugin_mcp: { command: "never-executed" } },
  }));
  const found = await discoverToolSources({ codexHome: root });
  assert.equal(found.status, "loaded");
  assert.equal(found.pluginApps.has("fixture_app"), true);
  assert.equal(found.pluginApps.has("plugin_management"), true);
  assert.equal(found.pluginApps.has("gmail"), true);
  assert.equal(found.pluginMcpServers.has("fixture_plugin_mcp"), true);
  assert.equal(found.userMcpServers.has("user_tools"), true);
});

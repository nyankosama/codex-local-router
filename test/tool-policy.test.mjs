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
  assert.equal(classifyTool({ name: "mcp__collision__read" }, registry).kind, "collision");
  assert.equal(
    classifyTool(
      { name: "mcp__codex_apps__gmail" },
      { ...registry, userMcpServers: new Set([...registry.userMcpServers, "codex_apps"]) },
    ).kind,
    "collision",
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
  assert.equal(found.pluginMcpServers.has("fixture_plugin_mcp"), true);
  assert.equal(found.userMcpServers.has("user_tools"), true);
});

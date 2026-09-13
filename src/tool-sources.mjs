import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";

const readJSON = async (path) => JSON.parse(await readFile(path, "utf8"));

function parseCodexConfig(text) {
  const enabledPlugins = [];
  const userMcpServers = new Set();
  let currentPlugin;
  for (const line of text.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/)?.[1];
    if (section) {
      const plugin = section.match(/^plugins\."([^"]+)"$/)?.[1];
      currentPlugin = plugin ?? null;
      const server = section.match(/^mcp_servers\.([^.\]]+)/)?.[1];
      if (server) userMcpServers.add(server.replace(/^"|"$/g, ""));
      continue;
    }
    if (currentPlugin && /^\s*enabled\s*=\s*true\s*(?:#.*)?$/.test(line))
      enabledPlugins.push(currentPlugin);
  }
  return { enabledPlugins, userMcpServers };
}

async function versionDirectories(root) {
  return (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name));
}

export async function discoverToolSources(options = {}) {
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const configPath = options.configPath ?? join(codexHome, "config.toml");
  const pluginApps = new Set([
    "github",
    "figma",
    "sites",
    "connected_documents",
    "codex_document_control",
    "spreadsheets",
    "safety_settings",
  ]);
  const pluginMcpServers = new Set();
  const pluginMcpOwners = new Map();
  const coreNamespaces = new Set(["codex_app", "cua_repl"]);
  try {
    const parsed = parseCodexConfig(await readFile(configPath, "utf8"));
    for (const identifier of parsed.enabledPlugins) {
      const split = identifier.lastIndexOf("@");
      if (split <= 0) continue;
      const name = identifier.slice(0, split);
      const provider = identifier.slice(split + 1);
      const root = join(codexHome, "plugins", "cache", provider, name);
      let versions = [];
      try { versions = await versionDirectories(root); } catch { continue; }
      for (const version of versions) {
        try {
          const app = await readJSON(join(version, ".app.json"));
          for (const key of Object.keys(app.apps ?? {})) pluginApps.add(key);
        } catch {}
        try {
          const mcp = await readJSON(join(version, ".mcp.json"));
          for (const server of Object.keys(mcp.mcpServers ?? {})) {
            if (["codex_app", "cua_repl"].includes(server)) {
              coreNamespaces.add(server);
              continue;
            }
            pluginMcpServers.add(server);
            pluginMcpOwners.set(server, name);
          }
        } catch {}
      }
    }
    return {
      status: "loaded",
      pluginApps,
      pluginMcpServers,
      pluginMcpOwners,
      userMcpServers: parsed.userMcpServers,
      coreNamespaces,
    };
  } catch {
    return {
      status: "config-unavailable",
      pluginApps,
      pluginMcpServers,
      pluginMcpOwners,
      userMcpServers: new Set(),
      coreNamespaces,
    };
  }
}

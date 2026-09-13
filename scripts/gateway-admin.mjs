#!/usr/bin/env node
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, upgradeConfig, validate } from "../src/config.mjs";
import { buildModelCatalog } from "../src/model-catalog.mjs";
import { readRollout, importRollout } from "../src/rollout.mjs";
import { loadCodexAuth } from "../src/local-identity.mjs";
import { configDiff, createConfig, rawConfig, writeConfigTransaction } from "../src/config-store.mjs";
import {
  appIsRunning,
  discoverCodex,
  disableIntegration,
  integrationStatus,
  syncIntegration,
} from "../src/integration.mjs";
import {
  gracefulRestart,
  installService,
  serviceStatus,
  stopService,
  uninstallSpaceSwitcher,
  uninstallService,
} from "../src/service-manager.mjs";
import {
  createHistoryPayload,
  decryptHistoryPayload,
  encryptHistoryPayload,
  historyResumePrompt,
} from "../src/history-package.mjs";
import { atomicJSON, atomicWrite, withFileLock } from "../src/files.mjs";
import { PACKAGE_VERSION, PRODUCT_NAME, runtimePaths } from "../src/product.mjs";
import { credential } from "../src/providers.mjs";
import {
  resolvePluginToolPolicy,
  toolSourceStatus,
} from "../src/tool-policy.mjs";
import { discoverToolSources } from "../src/tool-sources.mjs";
import {
  DEFAULT_SPACE,
  OFFICIAL_SPACE,
  SPACE_CONFIG_KEYS,
  appendSpaceRevision,
  availableCodexModels,
  captureRouterSpace,
  commitSpaceActivation,
  composeRuntimeConfig,
  createSpace,
  detectSpaceDrift,
  diffSpaceRevisions,
  initializeSpaces,
  listConfigurationSpaces,
  materializeRuntimeConfig,
  parseSpaceRef,
  readSpaceIndex,
  readSpaceTransaction,
  resolveSpace,
  spaceHistory,
} from "../src/config-spaces.mjs";
import {
  beginSpaceSwitch,
  cancelSpaceSwitch,
  configurationSpaceStatus,
  resumeSpaceSwitch,
} from "../src/space-switch.mjs";

const args = process.argv.slice(2);
const positional = [];
for (let index = 0; index < args.length; index++) {
  if (args[index].startsWith("--")) {
    if (index + 1 < args.length && !args[index + 1].startsWith("--")) index++;
  } else positional.push(args[index]);
}
const group = positional[0], command = positional[1];
const value = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const flag = (name) => args.includes(`--${name}`);
const env = process.env;
const paths = runtimePaths(env);
const configPath = resolve(value("config") ?? paths.config);
const jsonMode = flag("json");

function requestedPluginPolicy(current) {
  const mode = value("plugin-policy");
  if (!mode) return current;
  if (["passthrough", "third-party-gpt-default"].includes(mode)) return mode;
  if (mode !== "allowlist")
    throw Object.assign(Error("--plugin-policy must be passthrough, third-party-gpt-default or allowlist"), { code: "usage_error" });
  const allowed = value("allowed-plugins");
  if (allowed == null)
    throw Object.assign(Error("allowlist policy requires --allowed-plugins"), { code: "usage_error" });
  return {
    mode: "allowlist",
    allowedPlugins: allowed.split(",").map((item) => item.trim()).filter(Boolean),
  };
}

function emit(value, human) {
  console.log(jsonMode || !human ? JSON.stringify(value, null, 2) : human(value));
}

async function confirm(summary) {
  if (flag("yes")) return true;
  console.error(summary);
  if (!process.stdin.isTTY) return false;
  const io = createInterface({ input: process.stdin, output: process.stderr });
  try { return /^y(es)?$/i.test((await io.question("Apply these changes? [y/N] ")).trim()); }
  finally { io.close(); }
}

async function passphrase() {
  const name = value("passphrase-env");
  if (name && env[name]) return env[name];
  if (!process.stdin.isTTY)
    throw Object.assign(Error("use --passphrase-env ENV for encrypted history packages"), { code: "history_passphrase_required" });
  return hiddenQuestion("History package passphrase: ");
}

async function hiddenQuestion(prompt) {
  if (!process.stdin.isTTY)
    throw Object.assign(Error("hidden input requires an interactive terminal; use stdin or an environment reference"), { code: "hidden_input_unavailable" });
  const muted = spawnSync("/bin/stty", ["-echo"], { stdio: ["inherit", "ignore", "inherit"] });
  if (muted.status !== 0)
    throw Object.assign(Error("failed to disable terminal echo"), { code: "hidden_input_unavailable" });
  const io = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await io.question(prompt);
    process.stderr.write("\n");
    return answer;
  } finally {
    io.close();
    spawnSync("/bin/stty", ["echo"], { stdio: ["inherit", "ignore", "inherit"] });
  }
}

async function localAccount() {
  const { auth } = await loadCodexAuth();
  if (!auth?.tokens?.account_id)
    throw Object.assign(Error("trusted Codex account is unavailable"), { code: "trusted_subscription_identity_unavailable" });
  return `chatgpt:${auth.tokens.account_id}`;
}

async function archiveContext() {
  const config = await loadConfig(configPath);
  if (!config.history?.persistent?.enabled)
    throw Object.assign(Error("persistent history is disabled"), { code: "history_disabled" });
  const { openArchive } = await import("../src/archive.mjs");
  return { config, archive: await openArchive(config.history.persistent) };
}

async function storeKeychain(service, account, secret) {
  await new Promise((done, reject) => {
    const child = spawn("/usr/bin/security", ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? done() : reject(Object.assign(Error("failed to store Keychain credential"), { code: "keychain_write_failed", detail: stderr })));
    child.stdin.end(`add-generic-password -U -s ${JSON.stringify(service)} -a ${JSON.stringify(account)} -w ${JSON.stringify(secret)}\n`);
  });
}

async function readStdin() {
  let body = "";
  for await (const chunk of process.stdin) body += chunk;
  return body.replace(/\r?\n$/, "");
}

async function requestedCredential() {
  if (flag("credential-stdin")) return readStdin();
  if (flag("credential-prompt")) return hiddenQuestion("Provider credential: ");
  return null;
}

async function inspectCredentials(config) {
  const providers = [];
  for (const [id, provider] of Object.entries(config.providers)) {
    let available = false;
    try { available = typeof (await credential(provider)) === "string"; } catch {}
    const source = provider.keychain ? "keychain" : provider.apiKeyEnv ? "environment" : "none";
    providers.push({
      id,
      configured: source !== "none",
      available,
      source,
      launchAgentReady: provider.keychain ? available : source === "none" ? true : false,
      ...(provider.apiKeyEnv ? { environmentVariable: provider.apiKeyEnv } : {}),
    });
  }
  let subscription = { available: false, store: null };
  try {
    const loaded = await loadCodexAuth();
    subscription = {
      available: typeof loaded.auth?.tokens?.access_token === "string" &&
        typeof loaded.auth?.tokens?.account_id === "string",
      store: loaded.store,
    };
  } catch {}
  return { providers, subscription };
}

function baseConfig(discovery) {
  const providerId = value("provider-id") ?? "opencode-go";
  const targetId = value("target-id") ?? "deepseek";
  return {
    schemaVersion: 3,
    listen: { host: "127.0.0.1", port: Number(value("port") ?? 8788) },
    access: { required: true, tokenFile: paths.accessToken },
    mode: "rules",
    defaultTarget: targetId,
    providers: {
      [providerId]: {
        adapter: value("adapter") ?? "opencode-go",
        baseUrl: value("base-url") ?? "https://opencode.ai/zen/go",
        apiKeyEnv: value("api-key-env") ?? "OPENCODE_GO_API_KEY",
        concurrency: Number(value("concurrency") ?? 4),
      },
    },
    targets: {
      [targetId]: { provider: providerId, preset: value("preset") ?? "opencode-go/deepseek-v4.1-flash" },
    },
    rules: [],
    history: {
      maxBytes: 128 * 1024 * 1024,
      ttlMs: 30 * 60 * 1000,
      persistent: { enabled: true, diskMaxBytes: 10 * 1024 ** 3, warningPercent: 80 },
    },
    maxBodyBytes: 20 * 1024 * 1024,
    maxConnections: 64,
    timeoutMs: 180000,
    subscription: { enabled: true, catalogPath: discovery.catalogSource, models: ["gpt-catalog-placeholder"] },
  };
}

const describeDiff = (diff) => diff
  .map((item) => `${item.path}: ${JSON.stringify(item.before)} -> ${JSON.stringify(item.after)}`)
  .join("\n");

async function routerSpaceContext(explicit = value("space")) {
  const index = await readSpaceIndex(env);
  if (!index)
    throw Object.assign(Error("configuration spaces are not initialized; run `space init` or `setup`"), {
      code: "spaces_not_initialized",
    });
  const name = explicit ?? index.active?.space;
  if (name === OFFICIAL_SPACE)
    throw Object.assign(Error("official is not a Router space; specify --space NAME"), {
      code: "official_space_read_only",
    });
  const parsed = parseSpaceRef(name);
  if (parsed.revision != null)
    throw Object.assign(Error("space edits target the latest revision; omit @REV"), {
      code: "space_revision_read_only",
    });
  const entry = index.spaces[parsed.space];
  if (!entry || entry.kind !== "router")
    throw Object.assign(Error(`Router space does not exist: ${parsed.space}`), {
      code: "space_not_found",
    });
  const revision = await resolveSpace(`${parsed.space}@${entry.latestRevision}`, env);
  const global = await rawConfig(configPath);
  return {
    index,
    name: parsed.space,
    revision,
    config: await materializeRuntimeConfig(global, revision),
  };
}

async function loadCommandConfig() {
  const index = await readSpaceIndex(env);
  if (!index) return loadConfig(configPath);
  return (await routerSpaceContext()).config;
}

async function mutateSpaceConfig(mutator, label, options = {}) {
  const context = await routerSpaceContext();
  if (context.index.active?.space === context.name) {
    const pending = await readSpaceTransaction(env);
    if (pending)
      throw Object.assign(Error(`a switch to ${pending.target.space}@${pending.target.revision} is already pending`), {
        code: "space_switch_pending",
      });
    const drift = await detectSpaceDrift({ env, configPath });
    if (drift.drift)
      throw Object.assign(Error("the active Router config has drift; run `space capture` first"), {
        code: "space_config_drift",
      });
  }
  const after = structuredClone(context.config);
  await mutator(after);
  const normalized = structuredClone(validate(after));
  const diff = configDiff(context.config, normalized);
  const nextDefaultModel = options.defaultCodexModel ?? context.revision.defaultCodexModel;
  if (nextDefaultModel !== context.revision.defaultCodexModel)
    diff.unshift({
      path: "defaultCodexModel",
      before: context.revision.defaultCodexModel,
      after: nextDefaultModel,
    });
  const apply = await confirm(`${label}:\n${describeDiff(diff)}`);
  if (!apply)
    return emit({ changed: diff.length > 0, applied: false, diff }, () =>
      `${label} preview only; re-run with --yes to apply.`);
  await options.beforeApply?.();
  const appended = await appendSpaceRevision(context.name, {
    kind: "router",
    source: options.source ?? label,
    config: normalized,
    defaultCodexModel: nextDefaultModel,
  }, { env, expectedLatestRevision: context.revision.revision });
  let switching = null;
  if (appended.changed && context.index.active?.space === context.name)
    switching = await beginSpaceSwitch(
      `${context.name}@${appended.revision.revision}`,
      { env, configPath },
    );
  const result = {
    changed: appended.changed,
    applied: true,
    diff,
    space: context.name,
    revision: appended.revision.revision,
    switch: switching,
  };
  emit(result, (x) => x.switch?.pending
    ? `${label} saved as ${x.space}@${x.revision}; activation is pending Codex App quit.`
    : x.changed
      ? `${label} saved as ${x.space}@${x.revision}.`
      : `${label} made no content change.`);
  return result;
}

async function upgradeSpaceConfig() {
  const context = await routerSpaceContext();
  const upgraded = upgradeConfig(context.config);
  if (!upgraded.changes.length)
    return emit({ applied: false, changes: [], space: context.name }, () =>
      "Configuration space is already current.");
  const diff = configDiff(context.config, upgraded.config);
  if (!flag("apply"))
    return emit({ applied: false, changes: upgraded.changes, diff, space: context.name }, () =>
      "Configuration space upgrade preview only; add --apply --yes to apply.");
  const apply = await confirm(`Upgrade ${context.name}:\n${describeDiff(diff)}`);
  if (!apply) return emit({ applied: false, changes: upgraded.changes, diff }, () => "No changes applied.");

  const currentRaw = await rawConfig(configPath);
  const managed = new Set(SPACE_CONFIG_KEYS);
  const globalAfter = structuredClone(currentRaw);
  for (const [key, next] of Object.entries(upgraded.config)) {
    if (managed.has(key) || key === "subscription") continue;
    globalAfter[key] = structuredClone(next);
  }
  globalAfter.subscription ??= {};
  if (upgraded.config.subscription?.catalogPath)
    globalAfter.subscription.catalogPath = upgraded.config.subscription.catalogPath;
  if (JSON.stringify(currentRaw) !== JSON.stringify(globalAfter))
    await writeConfigTransaction(configPath, currentRaw, globalAfter, { apply: true, env });

  const appended = await appendSpaceRevision(context.name, {
    kind: "router",
    source: "config-upgrade",
    config: upgraded.config,
    defaultCodexModel: context.revision.defaultCodexModel,
  }, { env });
  let switching = null;
  if (appended.changed && context.index.active.space === context.name)
    switching = await beginSpaceSwitch(`${context.name}@${appended.revision.revision}`, {
      env,
      configPath,
    });
  return emit({
    applied: true,
    changes: upgraded.changes,
    diff,
    space: context.name,
    revision: appended.revision.revision,
    switch: switching,
  }, (x) => x.switch?.pending
    ? `Configuration upgraded as ${x.space}@${x.revision}; activation is pending App quit.`
    : `Configuration upgraded as ${x.space}@${x.revision}.`);
}

async function setup() {
  const discovery = await discoverCodex(env);
  if (!discovery.configExists || !discovery.catalogSourceExists)
    throw Object.assign(Error("Codex config or model catalog was not found"), { code: "codex_not_found" });
  let before = null;
  try { before = await rawConfig(configPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (await readSpaceIndex(env))
    throw Object.assign(Error("configuration spaces are already initialized; use space and config commands"), {
      code: "spaces_already_initialized",
    });
  const after = before ? upgradeConfig(before).config : baseConfig(discovery);
  if (!before) validate(after);
  const preview = before
    ? await writeConfigTransaction(configPath, before, after)
    : await createConfig(configPath, after);
  const apply = await confirm(`Configuration changes:\n${describeDiff(preview.diff)}`);
  if (!apply)
    return emit({ applied: false, discovery, diff: preview.diff }, () => "No changes applied. Re-run with --yes after reviewing the diff.");
  if (!before) await createConfig(configPath, after, { apply: true });
  else await writeConfigTransaction(configPath, before, after, { apply: true });
  if (after.access?.required && after.access.tokenFile) {
    const token = await readFile(after.access.tokenFile, "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return "";
    });
    if (!token.trim())
      await atomicWrite(after.access.tokenFile, randomBytes(32).toString("hex") + "\n");
  }
  const suppliedCredential = await requestedCredential();
  if (suppliedCredential != null) {
    if (!suppliedCredential)
      throw Object.assign(Error("provider credential cannot be empty"), { code: "provider_credential_missing" });
    const providerId = value("provider-id") ?? "opencode-go";
    const service = value("keychain-service") ?? "codex-local-router-provider";
    const account = value("keychain-account") ?? providerId;
    await storeKeychain(service, account, suppliedCredential);
    const latest = await rawConfig(configPath);
    const revised = structuredClone(latest);
    revised.providers[providerId].keychain = { service, account };
    delete revised.providers[providerId].apiKeyEnv;
    await writeConfigTransaction(configPath, latest, revised, { apply: true });
  }
  const config = await loadConfig(configPath);
  const spaces = await initializeSpaces({ env, config, configPath, codexHome: discovery.home });
  const activation = await beginSpaceSwitch(`${DEFAULT_SPACE}@1`, { env, configPath });
  const integration = {
    pending: activation.pending === true,
    active: activation.pending !== true,
    transaction: activation.transaction ?? null,
  };
  const service = await serviceStatus(configPath, env);
  const credentials = await inspectCredentials(config);
  emit({ applied: true, discovery, spaces, activation, integration, service, credentials }, (result) => [
    result.integration.pending
      ? "Configuration space saved; activation is pending Codex App quit."
      : "Codex Local Router is configured, integrated, and started.",
    result.credentials.providers.some((provider) => !provider.launchAgentReady)
      ? "Store environment-only provider credentials in Keychain before using the LaunchAgent."
      : null,
  ].filter(Boolean).join(" "));
}

async function mutateConfig(mutator, label, options = {}) {
  return mutateSpaceConfig(mutator, label, options);
}

async function providerCommand() {
  const id = value("id") ?? positional[2];
  if (command === "list") {
    const config = await loadCommandConfig();
    return emit(Object.entries(config.providers).map(([name, provider]) => ({ id: name, ...provider })),
      (rows) => rows.map((row) => `${row.id}\t${row.adapter}\t${row.baseUrl}`).join("\n"));
  }
  if (!["add", "edit", "remove"].includes(command) || !id)
    throw Object.assign(Error("provider add|edit|remove requires --id"), { code: "usage_error" });
  const suppliedCredential = await requestedCredential();
  const keychain = suppliedCredential == null ? null : {
    service: value("keychain-service") ?? "codex-local-router-provider",
    account: value("keychain-account") ?? id,
  };
  if (suppliedCredential != null && !suppliedCredential)
    throw Object.assign(Error("provider credential cannot be empty"), { code: "provider_credential_missing" });
  await mutateConfig(async (config) => {
    config.providers ??= {};
    if (command === "add" && config.providers[id]) throw Object.assign(Error(`provider already exists: ${id}`), { code: "provider_exists" });
    if (command !== "add" && !config.providers[id]) throw Object.assign(Error(`provider does not exist: ${id}`), { code: "provider_not_found" });
    if (command === "remove") {
      const used = Object.entries(config.targets ?? {}).filter(([, target]) => target.provider === id).map(([target]) => target);
      if (used.length) throw Object.assign(Error(`provider is used by targets: ${used.join(", ")}`), { code: "provider_in_use" });
      delete config.providers[id];
      return;
    }
    const current = config.providers[id] ?? {};
    config.providers[id] = {
      ...current,
      adapter: value("adapter") ?? current.adapter ?? "openai-compatible",
      baseUrl: value("base-url") ?? current.baseUrl,
      apiKeyEnv: value("api-key-env") ?? current.apiKeyEnv,
      concurrency: Number(value("concurrency") ?? current.concurrency ?? 4),
    };
    if (!config.providers[id].baseUrl) throw Object.assign(Error("--base-url is required"), { code: "usage_error" });
    if (value("responses-endpoint")) (config.providers[id].endpoints ??= {}).responses = value("responses-endpoint");
    if (value("chat-endpoint")) (config.providers[id].endpoints ??= {}).chatCompletions = value("chat-endpoint");
    if (keychain) {
      config.providers[id].keychain = keychain;
      delete config.providers[id].apiKeyEnv;
    }
  }, `provider ${command} ${id}`, {
    beforeApply: keychain
      ? () => storeKeychain(keychain.service, keychain.account, suppliedCredential)
      : undefined,
  });
}

async function modelCommand() {
  const id = value("id") ?? positional[2];
  if (command === "list") {
    const config = await loadCommandConfig();
    const registry = await discoverToolSources();
    return emit(Object.values(config.targets).map((target) => ({
      id: target.id, provider: target.provider, model: target.model,
      protocol: target.wireApi, contextWindow: target.contextWindow,
      modalities: target.inputModalities, compression: target.compression.mode,
      reasoningLevels: target.app?.reasoningLevels ?? [],
      modelFamily: target.modelFamily ?? null,
      pluginToolPolicy: resolvePluginToolPolicy(config, target),
      toolSourceRecognition: toolSourceStatus(registry),
    })), (rows) => rows.map((row) => `${row.id}\t${row.provider}\t${row.model}\t${row.contextWindow}`).join("\n"));
  }
  if (command === "probe") {
    if (!id) throw Object.assign(Error("model probe requires --id"), { code: "usage_error" });
    const config = await loadCommandConfig(), target = config.targets[id];
    if (!target) throw Object.assign(Error(`model does not exist: ${id}`), { code: "model_not_found" });
    const registry = await discoverToolSources();
    const configured = {
      id,
      provider: target.provider,
      protocol: target.wireApi,
      capabilities: target.capabilities,
      modelFamily: target.modelFamily ?? null,
      pluginToolPolicy: resolvePluginToolPolicy(config, target),
      toolSourceRecognition: toolSourceStatus(registry),
      live: false,
    };
    if (!flag("live")) return emit(configured, () => `Model ${id} configuration is valid. Use --live to spend model quota on an end-to-end probe.`);
    const { auth } = await loadCodexAuth();
    const model = target.app?.modelId;
    if (!model) throw Object.assign(Error("live probe requires an App-enabled model"), { code: "model_probe_unavailable" });
    const base = `http://${config.listen?.host ?? "127.0.0.1"}:${config.listen?.port ?? 8788}/subscription/v1`;
    const response = await fetch(`${base}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${auth.tokens.access_token}`, "chatgpt-account-id": auth.tokens.account_id },
      body: JSON.stringify({ model, input: "Reply with OK.", stream: false, max_output_tokens: 16 }),
      signal: AbortSignal.timeout(60000),
    });
    const body = await response.json();
    if (!response.ok || body.status !== "completed") throw Object.assign(Error("live model probe failed"), { code: "model_probe_failed", status: response.status });
    return emit({ ...configured, live: true, status: body.status, responseId: body.id }, () => `Model ${id} live probe completed.`);
  }
  if (!["add", "edit", "remove"].includes(command) || !id)
    throw Object.assign(Error("model add|edit|remove requires --id"), { code: "usage_error" });
  await mutateConfig((config) => {
    config.targets ??= {};
    if (command === "add" && config.targets[id]) throw Object.assign(Error(`model already exists: ${id}`), { code: "model_exists" });
    if (command !== "add" && !config.targets[id]) throw Object.assign(Error(`model does not exist: ${id}`), { code: "model_not_found" });
    if (command === "remove") {
      if (config.defaultTarget === id || config.fixedTarget === id || config.passthroughTarget === id)
        throw Object.assign(Error("model is selected by routing configuration"), { code: "model_in_use" });
      delete config.targets[id];
      return;
    }
    const current = config.targets[id] ?? {};
    if (value("preset")) {
      config.targets[id] = { ...current, provider: value("provider") ?? current.provider, preset: value("preset") };
      return;
    }
    config.targets[id] = {
      ...current,
      provider: value("provider") ?? current.provider,
      model: value("upstream-model") ?? current.model,
      wireApi: value("protocol") ?? current.wireApi ?? "responses",
      contextWindow: Number(value("context-window") ?? current.contextWindow),
      maxContextWindow: Number(value("max-context-window") ?? value("context-window") ?? current.maxContextWindow ?? current.contextWindow),
      inputModalities: (value("input-modalities") ?? current.inputModalities?.join(",") ?? "text").split(","),
      compression: { mode: value("compression") ?? current.compression?.mode ?? "unsupported" },
      modelFamily: value("model-family") ?? current.modelFamily,
      pluginToolPolicy: requestedPluginPolicy(current.pluginToolPolicy),
      capabilities: {
        ...current.capabilities,
        responses: (value("protocol") ?? current.wireApi) === "responses",
        streaming: !flag("no-streaming"),
        toolCalling: !flag("no-tools"),
        freeformTools: flag("freeform-tools") || current.capabilities?.freeformTools === true,
        nativeWebSearch: flag("native-search") || current.capabilities?.nativeWebSearch === true,
      },
      app: flag("no-app") ? undefined : {
        ...current.app,
        enabled: true,
        modelId: value("app-model") ?? current.app?.modelId ?? value("upstream-model"),
        displayName: value("display-name") ?? current.app?.displayName,
        reasoningLevels: (value("reasoning-levels") ?? current.app?.reasoningLevels?.join(",") ?? "low,medium,high,xhigh").split(","),
        supportsSearchTool: flag("supports-search-tool")
          ? true
          : flag("no-supports-search-tool")
            ? false
            : current.app?.supportsSearchTool,
        useResponsesLite: flag("responses-lite")
          ? true
          : flag("no-responses-lite")
            ? false
            : (current.app?.useResponsesLite ?? false),
      },
    };
  }, `model ${command} ${id}`);
}

async function modelsLegacy() {
  if (command === "check") {
    const config = await loadCommandConfig();
    let catalog = null;
    if (config.subscription?.catalogPath) {
      const source = JSON.parse(await readFile(config.subscription.catalogPath, "utf8"));
      const generated = buildModelCatalog(source, config);
      catalog = { sourceModels: source.models.length, generatedModels: generated.models.length, officialUnchanged: source.models.every((model, index) => JSON.stringify(model) === JSON.stringify(generated.models[index])) };
    }
    return emit({ ok: true, config: configPath, targets: Object.values(config.targets), catalog }, () => `Configuration is valid. ${Object.keys(config.targets).length} target(s) configured.`);
  }
  if (command === "catalog") {
    const output = value("output");
    if (!output) throw Object.assign(Error("models catalog requires --output PATH"), { code: "usage_error" });
    const config = await loadCommandConfig();
    const source = JSON.parse(await readFile(config.subscription.catalogPath, "utf8"));
    await atomicWrite(resolve(output), JSON.stringify(buildModelCatalog(source, config), null, 2) + "\n");
    return emit({ ok: true, output: resolve(output) }, (x) => `Catalog written: ${x.output}`);
  }
  throw Object.assign(Error("use models check|catalog"), { code: "usage_error" });
}

async function spaceCommand() {
  if (command === "init") {
    const result = await initializeSpaces({ env, configPath });
    return emit(result, (x) => x.changed
      ? `Initialized official@1 and default@1; active is ${x.index.active.space}@${x.index.active.revision}.`
      : "Configuration spaces are already initialized.");
  }
  const index = await readSpaceIndex(env);
  if (!index)
    throw Object.assign(Error("configuration spaces are not initialized"), {
      code: "spaces_not_initialized",
    });
  if (command === "list") {
    const rows = await listConfigurationSpaces(env);
    return emit(rows, (items) => items.map((item) =>
      `${item.active ? "*" : " "} ${item.name}@${item.latestRevision}\t${item.kind}\t${item.defaultCodexModel ?? "-"}`,
    ).join("\n"));
  }
  if (command === "current") {
    const status = await configurationSpaceStatus({ env, configPath });
    const active = status.active ? await resolveSpace(
      `${status.active.space}@${status.active.revision}`,
      env,
    ) : null;
    const result = {
      ...status,
      defaultCodexModel: active?.defaultCodexModel ?? null,
      latestRevision: active ? index.spaces[active.space].latestRevision : null,
    };
    return emit(result, (x) =>
      `Current: ${x.active.space}@${x.active.revision}; default model ${x.defaultCodexModel ?? "-"}; drift ${x.drift ? "yes" : "no"}.`);
  }
  if (command === "show") {
    const input = positional[2] ?? `${index.active.space}@${index.active.revision}`;
    const revision = await resolveSpace(input, env);
    return emit(revision, (x) =>
      `${x.space}@${x.revision} (${x.kind}), default model ${x.defaultCodexModel ?? "-"}, ${x.contentHash}`);
  }
  if (command === "history") {
    const name = positional[2];
    if (!name) throw Object.assign(Error("space history requires NAME"), { code: "usage_error" });
    const rows = await spaceHistory(name, env);
    return emit(rows, (items) => items.map((item) =>
      `${item.space}@${item.revision}\t${item.source}\t${item.defaultCodexModel ?? "-"}`,
    ).join("\n"));
  }
  if (command === "diff") {
    const leftInput = positional[2], rightInput = positional[3];
    if (!leftInput || !rightInput)
      throw Object.assign(Error("space diff requires LEFT RIGHT"), { code: "usage_error" });
    const left = await resolveSpace(leftInput, env);
    const right = await resolveSpace(rightInput, env);
    const changes = diffSpaceRevisions(left, right);
    return emit({ left: `${left.space}@${left.revision}`, right: `${right.space}@${right.revision}`, changes },
      (x) => x.changes.length ? describeDiff(x.changes) : "No differences.");
  }
  if (command === "create") {
    const name = positional[2];
    const from = value("from") ?? (index.active.space === OFFICIAL_SPACE
      ? DEFAULT_SPACE
      : `${index.active.space}@${index.active.revision}`);
    if (!name) throw Object.assign(Error("space create requires NAME"), { code: "usage_error" });
    const apply = await confirm(`Create configuration space ${name} from ${from}.`);
    if (!apply) return emit({ applied: false }, () => "No space created.");
    const result = await createSpace(name, from, { env });
    return emit({ applied: true, ...result }, () => `Created ${name}@1.`);
  }
  if (command === "capture") {
    const name = positional[2] ?? index.active.space;
    if (name === OFFICIAL_SPACE)
      throw Object.assign(Error("official revisions are captured automatically when leaving official"), {
        code: "official_space_read_only",
      });
    const entry = index.spaces[name];
    if (!entry || entry.kind !== "router")
      throw Object.assign(Error(`Router space does not exist: ${name}`), { code: "space_not_found" });
    const captureRevision = index.active.space === name
      ? index.active.revision
      : entry.latestRevision;
    const currentRevision = await resolveSpace(`${name}@${captureRevision}`, env);
    const current = await rawConfig(configPath);
    const proposed = structuredClone(validate(current));
    const diff = configDiff(
      composeRuntimeConfig(current, currentRevision),
      proposed,
    );
    const apply = await confirm(`Capture current Router-owned fields into ${name}:\n${describeDiff(diff)}`);
    if (!apply) return emit({ applied: false, diff }, () => "Capture preview only.");
    const result = await captureRouterSpace(name, {
      env,
      configPath,
      config: current,
      defaultCodexModel: currentRevision.defaultCodexModel,
      expectedLatestRevision: entry.latestRevision,
    });
    if (
      index.active.space === name &&
      index.active.revision !== result.revision.revision
    )
      await commitSpaceActivation({ space: name, revision: result.revision.revision }, {
        env,
        expectedActive: index.active,
      });
    return emit({ applied: true, ...result }, (x) => x.changed
      ? `Captured ${name}@${x.revision.revision}.`
      : `${name} already matches its latest revision.`);
  }
  if (command === "set-default-model") {
    const model = positional[2] ?? value("model");
    if (!model)
      throw Object.assign(Error("space set-default-model requires MODEL"), { code: "usage_error" });
    const context = await routerSpaceContext();
    if (!availableCodexModels(context.config).has(model))
      throw Object.assign(Error(`model is not available in ${context.name}: ${model}`), {
        code: "space_default_model_unavailable",
      });
    return mutateSpaceConfig(() => {}, `set default model ${model}`, {
      defaultCodexModel: model,
      source: "default-model-edit",
    });
  }
  if (command === "use") {
    const target = positional[2];
    if (!target) throw Object.assign(Error("space use requires NAME[@REV]"), { code: "usage_error" });
    const revision = await resolveSpace(target, env);
    const apply = await confirm(`Switch from ${index.active.space}@${index.active.revision} to ${revision.space}@${revision.revision}.`);
    if (!apply) return emit({ applied: false }, () => "No switch started.");
    const result = await beginSpaceSwitch(`${revision.space}@${revision.revision}`, { env, configPath });
    return emit({ applied: true, ...result }, (x) => x.pending
      ? `Switch to ${revision.space}@${revision.revision} is pending Codex App quit.`
      : `Active configuration space is ${revision.space}@${revision.revision}.`);
  }
  if (command === "rollback") {
    if (!index.previous)
      throw Object.assign(Error("there is no previous successful activation"), {
        code: "space_rollback_unavailable",
      });
    const target = `${index.previous.space}@${index.previous.revision}`;
    const apply = await confirm(`Roll back to the previous successful activation ${target}.`);
    if (!apply) return emit({ applied: false }, () => "No rollback started.");
    const result = await beginSpaceSwitch(target, { env, configPath });
    return emit({ applied: true, target, ...result }, (x) => x.pending
      ? `Rollback to ${target} is pending Codex App quit.`
      : `Rolled back to ${target}.`);
  }
  if (command === "resume") {
    const result = await resumeSpaceSwitch({
      env,
      configPath,
      coordinator: flag("coordinator"),
    });
    return emit(result, (x) => x.pending
      ? "Space switch is still pending Codex App quit."
      : x.changed ? `Space switch completed: ${x.active.space}@${x.active.revision}.` : "No switch is pending.");
  }
  if (command === "cancel") {
    const pending = await readSpaceTransaction(env);
    if (!pending) return emit({ changed: false }, () => "No switch is pending.");
    const apply = await confirm(`Cancel pending switch to ${pending.target.space}@${pending.target.revision}.`);
    if (!apply) return emit({ applied: false }, () => "Pending switch retained.");
    return emit(await cancelSpaceSwitch({ env }), () => "Pending switch cancelled.");
  }
  throw Object.assign(Error("use space init|list|current|show|history|diff|create|capture|set-default-model|use|rollback|resume|cancel"), {
    code: "usage_error",
  });
}

async function integrationCommand() {
  const config = await loadConfig(configPath);
  const spaceStatus = await configurationSpaceStatus({ env, configPath });
  if (command === "status") {
    const integration = await integrationStatus(config, { env });
    return emit({ ...integration, space: spaceStatus }, (s) =>
      `Integration: ${s.space.pending ? "space switch pending" : s.active ? "active" : "inactive"}; space ${s.space.active?.space ?? "uninitialized"}.`);
  }
  if (["enable", "sync", "upgrade"].includes(command)) {
    if (spaceStatus.pending) {
      const result = await resumeSpaceSwitch({ env, configPath });
      return emit(result, (x) => x.pending
        ? "Integration activation is pending Codex App quit."
        : "Pending configuration space activation completed.");
    }
    const index = await readSpaceIndex(env);
    let target = index.active?.space !== OFFICIAL_SPACE ? index.active : index.previous;
    if (!target || index.spaces[target.space]?.kind !== "router")
      target = { space: DEFAULT_SPACE, revision: index.spaces[DEFAULT_SPACE].latestRevision };
    let result;
    if (index.active.space === target.space && index.active.revision === target.revision) {
      const activeRevision = await resolveSpace(`${target.space}@${target.revision}`, env);
      const activeConfig = await materializeRuntimeConfig(
        await rawConfig(configPath),
        activeRevision,
      );
      result = await syncIntegration(activeConfig, {
        env,
        gatewayConfigPath: configPath,
        selectedModel: activeRevision.defaultCodexModel,
        spaceRef: `${target.space}@${target.revision}`,
        force: flag("force"),
      });
    } else {
      result = await beginSpaceSwitch(`${target.space}@${target.revision}`, { env, configPath });
    }
    return emit(result, (x) => x.pending
      ? "Integration activation is pending Codex App quit."
      : x.changed ? "Integration synchronized." : "Integration already current.");
  }
  if (["disable", "restore"].includes(command)) {
    const index = await readSpaceIndex(env);
    const target = `official@${index.spaces.official.latestRevision}`;
    const apply = await confirm(`Switch to ${target} and restore its exact official settings.`);
    if (!apply) return emit({ applied: false }, () => "No changes applied. Re-run with --yes after reviewing.");
    const result = await beginSpaceSwitch(target, { env, configPath });
    return emit(result, (x) => x.pending
      ? `Switch to ${target} is pending Codex App quit.`
      : `Integration disabled through ${target}; unrelated Codex settings were preserved.`);
  }
  throw Object.assign(Error("use integration enable|sync|status|disable"), { code: "usage_error" });
}

async function historyCommand() {
  const { archive, config } = await archiveContext();
  try {
    const owner = value("account") ?? (await localAccount());
    const thread = value("thread");
    if (!thread && command !== "import") throw Object.assign(Error(`history ${command} requires --thread ID`), { code: "usage_error" });
    const branch = value("branch") ?? thread;
    if (command === "inspect") {
      const latest = archive.history({ owner, thread, branch });
      return emit({ found: !!latest, latest: latest ? { ...latest, original: undefined, view: undefined, originalItems: latest.original.length, viewItems: latest.view.length } : null, versions: archive.listHistory({ owner, thread, branch }), archive: archive.stats() },
        (x) => x.found ? `History ${thread}: ${x.versions.length} version(s), latest ${x.latest.originalItems} original / ${x.latest.viewItems} view items.` : `History not found: ${thread}`);
    }
    if (command === "export") {
      const output = value("output");
      if (!output) throw Object.assign(Error("history export requires --output PATH"), { code: "usage_error" });
      const versions = archive.listHistory({ owner, thread, branch, limit: 100000 }).map((row) => archive.history({ owner, thread, branch, version: row.version })).sort((a, b) => a.version - b.version);
      const payload = createHistoryPayload({ owner, thread, branch, versions });
      const body = flag("plaintext") ? payload : await encryptHistoryPayload(payload, await passphrase());
      await atomicJSON(resolve(output), body);
      return emit({ ok: true, output: resolve(output), encrypted: !flag("plaintext"), versions: versions.length }, (x) => `Exported ${x.versions} history version(s) to ${x.output}.`);
    }
    if (command === "import" && value("package")) {
      const envelope = JSON.parse(await readFile(resolve(value("package")), "utf8"));
      const payload = await decryptHistoryPayload(envelope, envelope.product === "codex-local-router-encrypted-history" ? await passphrase() : undefined);
      const destinationThread = thread ?? value("new-thread") ?? payload.thread;
      const destinationBranch = value("branch") ?? destinationThread;
      let imported = 0;
      for (const version of payload.versions) {
        archive.appendHistory({ owner, thread: destinationThread, branch: destinationBranch, target: version.target, responseId: version.responseId, status: version.status, original: version.original, view: version.view });
        imported++;
      }
      return emit({ ok: true, thread: destinationThread, branch: destinationBranch, imported }, (x) => `Imported ${x.imported} history version(s) into ${x.thread}.`);
    }
    if (command === "import") {
      const source = value("source");
      if (!source || !thread) throw Object.assign(Error("rollout import requires --source and --thread"), { code: "usage_error" });
      const rollout = await readRollout(resolve(source), thread);
      return emit({ ok: true, thread, branch, ...importRollout(archive, rollout, { owner, branch }) }, () => `Rollout imported into ${thread}.`);
    }
    if (command === "resume") {
      const latest = archive.history({ owner, thread, branch });
      if (!latest) throw Object.assign(Error("history was not found"), { code: "history_not_found" });
      const prompt = historyResumePrompt(latest);
      const output = value("prompt-output");
      if (output) await atomicWrite(resolve(output), prompt, 0o600);
      const apply = await confirm(`Create a new Codex session from archived history ${thread}. Tool calls will be installed as completed facts.`);
      if (!apply) return emit({ created: false, promptOutput: output ? resolve(output) : null, promptBytes: Buffer.byteLength(prompt) }, () => "Resume preview created. Re-run with --yes to start a new Codex session.");
      const model = value("model") ?? config.targets[latest.target?.id]?.app?.modelId ?? latest.target?.model;
      let promptArgument = prompt, temporary;
      if (Buffer.byteLength(prompt) > 64 * 1024) {
        temporary = resolve(paths.runtime, `resume-${randomUUID()}.md`);
        await atomicWrite(temporary, prompt, 0o600);
        promptArgument = `Read the archived continuation context from ${temporary}. Treat its tool calls as already completed facts, do not replay them, then wait for my next instruction.`;
      }
      try {
        const child = spawn(value("codex-path") ?? "codex", [...(model ? ["--model", model] : []), promptArgument], { stdio: "inherit" });
        const code = await new Promise((done, reject) => { child.once("error", reject); child.once("close", done); });
        if (code !== 0) throw Object.assign(Error(`Codex exited with ${code}`), { code: "history_resume_failed" });
      } finally {
        if (temporary) await rm(temporary, { force: true });
      }
      return;
    }
    if (command === "prune") {
      const before = value("before-version");
      const apply = flag("apply") && await confirm(`Prune history for exact scope ${owner}/${thread}/${branch}.`);
      return emit(archive.prune({ owner, thread, branch, beforeVersion: before == null ? undefined : Number(before), dryRun: !apply }), (x) => `${x.dryRun ? "Would prune" : "Pruned"} ${x.count} version(s).`);
    }
    throw Object.assign(Error("use history inspect|export|import|resume|prune"), { code: "usage_error" });
  } finally { archive.close(); }
}

async function doctor() {
  const discovery = await discoverCodex(env);
  let config = null, configError = null;
  try { config = await loadConfig(configPath); } catch (error) { configError = error.message; }
  const credentials = config ? await inspectCredentials(config) : { providers: [], subscription: { available: false, store: null } };
  const warnings = credentials.providers
    .filter((provider) => provider.source === "environment" && provider.available && !provider.launchAgentReady)
    .map((provider) => `${provider.id}: the current shell has ${provider.environmentVariable}, but the managed LaunchAgent does not import shell environment variables; store this credential in Keychain`);
  const issues = credentials.providers
    .filter((provider) => provider.configured && !provider.available)
    .map((provider) => `${provider.id}: configured provider credential is unavailable`);
  if (!credentials.subscription.available)
    issues.push("ChatGPT subscription credential is unavailable from the configured Codex credential store");
  const checks = {
    codex: discovery,
    config: { path: configPath, valid: !!config, error: configError },
    service: await serviceStatus(configPath, env),
    integration: config ? await integrationStatus(config, { env }) : null,
    configurationSpace: await configurationSpaceStatus({ env, configPath }),
    credentials,
    warnings,
    issues,
    liveModelCalls: 0,
  };
  const ok = discovery.configExists && !!config && issues.length === 0;
  emit({ ok, ...checks }, (x) => `Doctor: ${x.ok ? "OK" : `${x.issues.length} issue(s) found`}${x.warnings.length ? `, ${x.warnings.length} warning(s)` : ""}. No model calls were made.`);
  if (!ok) process.exitCode = 1;
}

async function status() {
  const config = await loadConfig(configPath);
  const configurationSpace = await configurationSpaceStatus({ env, configPath });
  let defaultModel = null, latestRevision = null;
  if (configurationSpace.active) {
    const active = await resolveSpace(
      `${configurationSpace.active.space}@${configurationSpace.active.revision}`,
      env,
    );
    defaultModel = active.defaultCodexModel;
    latestRevision = (await readSpaceIndex(env)).spaces[active.space].latestRevision;
  }
  emit({
    product: PRODUCT_NAME,
    cliVersion: PACKAGE_VERSION,
    configPath,
    configVersion: config.schemaVersion,
    service: await serviceStatus(configPath, env),
    integration: await integrationStatus(config, { env }),
    configurationSpace: { ...configurationSpace, defaultModel, latestRevision },
    targets: Object.keys(config.targets),
  },
  (x) => `${PRODUCT_NAME} ${x.cliVersion}\nService: ${x.service.running ? "running" : "stopped"}\nIntegration: ${x.integration.pending ? "pending App quit" : x.integration.active ? "active" : "inactive"}\nSpace: ${x.configurationSpace.active ? `${x.configurationSpace.active.space}@${x.configurationSpace.active.revision}` : "uninitialized"}\nModels: ${x.targets.join(", ")}`);
}

async function requireRouterServiceSpace() {
  const index = await readSpaceIndex(env);
  if (index?.active?.space === OFFICIAL_SPACE)
    throw Object.assign(Error("Router service cannot start while the official space is active"), {
      code: "official_space_service_dormant",
    });
  return index;
}

async function serviceCommand() {
  if (command === "start") {
    await requireRouterServiceSpace();
    const current = await serviceStatus(configPath, env);
    return emit(current.running ? current : await installService(configPath, { env }), (x) => x.running ? "Service is already running." : "Service start requested.");
  }
  if (command === "restart") {
    await requireRouterServiceSpace();
    return emit(await gracefulRestart(configPath, { env }), (x) => x.upgraded ? "Service restarted after draining active turns." : "Service restart deferred because active turns did not finish.");
  }
  if (command === "stop") return emit(await stopService({ env, ignoreMissing: true }), () => "Service stopped.");
  if (command === "status") return emit(await serviceStatus(configPath, env), (x) => x.running ? `Service running (${x.health.version}, ${x.health.activeTurns} active turn(s)).` : "Service stopped.");
  throw Object.assign(Error("use service start|stop|restart|status"), { code: "usage_error" });
}

async function main() {
  if (flag("version") || group === "version") return console.log(`${PRODUCT_NAME} ${PACKAGE_VERSION}`);
  if (!group || flag("help") || group === "help") return console.log("Usage: codex-local-router <command> [subcommand] [options]\n\nCommands: setup, status, space, provider, model, models, integration, doctor, logs, service, upgrade, rescue, history, uninstall");
  if (group === "setup") return setup();
  if (group === "status") return status();
  if (group === "provider") return providerCommand();
  if (group === "model") return modelCommand();
  if (group === "models") return modelsLegacy();
  if (group === "space") return spaceCommand();
  if (group === "integration") return integrationCommand();
  if (group === "doctor") return doctor();
  if (group === "service") return serviceCommand();
  if (group === "logs") {
    const lines = Number(value("lines") ?? 100);
    const body = await readFile(paths.serviceLog, "utf8").catch(() => "");
    const result = body.trim().split(/\r?\n/).filter(Boolean).slice(-lines);
    return emit({ path: paths.serviceLog, lines: result }, (x) => x.lines.join("\n"));
  }
  if (group === "upgrade") {
    await requireRouterServiceSpace();
    const result = await gracefulRestart(configPath, { env, waitMs: Number(value("wait-seconds") ?? 300) * 1000, serverPath: value("server") });
    return emit(result, (x) => x.upgraded ? "Gateway upgraded after candidate health and drain checks." : "Gateway upgrade deferred because active turns did not finish before the timeout.");
  }
  if (group === "rescue" && flag("subscription")) {
    const apply = await confirm("Restore Codex official subscription direct settings without contacting the Gateway.");
    if (!apply) return emit({ applied: false }, () => "Rescue preview only; re-run with --yes to apply.");
    const result = await withFileLock(paths.spaceTransactionLock, async () => {
      if (await appIsRunning(env))
        throw Object.assign(Error("quit Codex App before using the subscription rescue path"), {
          code: "app_running",
        });
      const index = await readSpaceIndex(env);
      if (!index)
        throw Object.assign(Error("configuration spaces are not initialized"), {
          code: "spaces_not_initialized",
        });
      const official = await resolveSpace("official@1", env);
      await disableIntegration({
        env,
        force: flag("force"),
        applyWhileRunning: true,
        officialBaseline: official.codexBaseline,
        officialSpaceRef: "official@1",
      });
      await uninstallService({ env });
      await rm(paths.spaceTransaction, { force: true });
      await uninstallSpaceSwitcher({ env }).catch(() => {});
      await commitSpaceActivation({ space: OFFICIAL_SPACE, revision: 1 }, { env });
      return { applied: true, active: { space: OFFICIAL_SPACE, revision: 1 } };
    });
    return emit(result, () =>
      "Protected official@1 was restored and the Router service was stopped.");
  }
  if (group === "history") return historyCommand();
  if (group === "config" && command === "upgrade") {
    if (await readSpaceIndex(env)) {
      if (!flag("apply")) {
        const context = await routerSpaceContext();
        const upgraded = upgradeConfig(context.config);
        return emit({
          applied: false,
          changes: upgraded.changes,
          diff: configDiff(context.config, upgraded.config),
          space: context.name,
        }, () => upgraded.changes.length
          ? "Configuration space upgrade preview only; add --apply --yes to apply."
          : "Configuration space is already current.");
      }
      return mutateSpaceConfig((config) => {
        const upgraded = upgradeConfig(config);
        for (const key of Object.keys(config)) delete config[key];
        Object.assign(config, upgraded.config);
      }, "upgrade configuration space", { source: "config-upgrade" });
    }
    const before = await rawConfig(configPath), upgraded = upgradeConfig(before);
    if (!upgraded.changes.length) return emit({ applied: false, changes: [] }, () => "Configuration is already current.");
    const apply = flag("apply") && await confirm(`Upgrade configuration:\n${upgraded.changes.join("\n")}`);
    const result = await writeConfigTransaction(configPath, before, upgraded.config, { apply });
    return emit({ ...result, changes: upgraded.changes }, (x) => x.applied ? "Configuration upgraded." : "Configuration upgrade preview only.");
  }
  if (group === "uninstall") {
    const apply = await confirm("Remove Codex integration and LaunchAgent. History and credentials will be retained.");
    if (!apply) return emit({ applied: false }, () => "Uninstall preview only; re-run with --yes to apply.");
    const index = await readSpaceIndex(env);
    if (index && index.active?.space !== OFFICIAL_SPACE && await appIsRunning(env))
      throw Object.assign(Error("quit Codex App before uninstalling an active Router space"), {
        code: "app_running",
      });
    await cancelSpaceSwitch({ env });
    await uninstallSpaceSwitcher({ env });
    let active = index?.active ?? null;
    if (index && index.active?.space !== OFFICIAL_SPACE) {
      const target = `official@${index.spaces.official.latestRevision}`;
      const switched = await beginSpaceSwitch(target, { env, configPath });
      if (switched.pending)
        throw Object.assign(Error("uninstall cannot remain pending after Codex App is closed"), {
          code: "space_switch_pending",
        });
      active = switched.active;
    }
    await disableIntegration({ env, force: flag("force") }).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await uninstallService({ env });
    return emit({ applied: true, active, historyRetained: true, credentialsRetained: true }, () => "Integration and service removed. History and credentials were retained.");
  }
  throw Object.assign(Error("unknown command"), { code: "usage_error" });
}

try { await main(); }
catch (error) {
  const correlationId = randomUUID();
  const code = /^[a-z][a-z0-9_]+$/.test(error.code ?? "") ? error.code : error.type ?? "command_failed";
  const result = {
    ok: false, code, correlationId, message: error.message,
    impact: error.impact ?? "requested operation was not completed",
    next: error.next ?? (code === "integration_conflict" ? "codex-local-router integration status --json" : "codex-local-router doctor --json"),
  };
  console.error(jsonMode ? JSON.stringify(result, null, 2) : `[${code}] ${error.message}\ncorrelation: ${correlationId}\nimpact: ${result.impact}\nnext: ${result.next}`);
  process.exitCode = 1;
}

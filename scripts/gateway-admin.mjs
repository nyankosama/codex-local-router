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
import { createConfig, rawConfig, writeConfigTransaction } from "../src/config-store.mjs";
import {
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
  uninstallService,
} from "../src/service-manager.mjs";
import {
  createHistoryPayload,
  decryptHistoryPayload,
  encryptHistoryPayload,
  historyResumePrompt,
} from "../src/history-package.mjs";
import { atomicJSON, atomicWrite } from "../src/files.mjs";
import { PACKAGE_VERSION, PRODUCT_NAME, runtimePaths } from "../src/product.mjs";
import { credential } from "../src/providers.mjs";

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

async function setup() {
  const discovery = await discoverCodex(env);
  if (!discovery.configExists || !discovery.catalogSourceExists)
    throw Object.assign(Error("Codex config or model catalog was not found"), { code: "codex_not_found" });
  let before = null;
  try { before = await rawConfig(configPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
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
  const integration = await syncIntegration(config, { env, gatewayConfigPath: configPath });
  const currentService = await serviceStatus(configPath, env);
  const service = currentService.running
    ? await gracefulRestart(configPath, { env })
    : await installService(configPath, { env });
  const credentials = await inspectCredentials(config);
  emit({ applied: true, discovery, integration, service, credentials }, (result) => [
    result.integration.pending
      ? "Configuration saved and service started. Codex App integration is prepared and pending App quit."
      : "Codex Local Router is configured, integrated, and started.",
    result.credentials.providers.some((provider) => !provider.launchAgentReady)
      ? "Store environment-only provider credentials in Keychain before using the LaunchAgent."
      : null,
  ].filter(Boolean).join(" "));
}

async function mutateConfig(mutator, label, options = {}) {
  const before = await rawConfig(configPath);
  const after = structuredClone(before);
  await mutator(after);
  const preview = await writeConfigTransaction(configPath, before, after);
  const apply = await confirm(`${label}:\n${describeDiff(preview.diff)}`);
  let result = preview;
  if (apply) {
    await options.beforeApply?.();
    result = await writeConfigTransaction(configPath, before, after, { apply: true });
  }
  emit(result, (x) => x.applied ? `${label} applied.` : `${label} preview only; re-run with --yes to apply.`);
  return result;
}

async function providerCommand() {
  const id = value("id") ?? positional[2];
  if (command === "list") {
    const config = await loadConfig(configPath);
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
    const config = await loadConfig(configPath);
    return emit(Object.values(config.targets).map((target) => ({
      id: target.id, provider: target.provider, model: target.model,
      protocol: target.wireApi, contextWindow: target.contextWindow,
      modalities: target.inputModalities, compression: target.compression.mode,
      reasoningLevels: target.app?.reasoningLevels ?? [],
    })), (rows) => rows.map((row) => `${row.id}\t${row.provider}\t${row.model}\t${row.contextWindow}`).join("\n"));
  }
  if (command === "probe") {
    if (!id) throw Object.assign(Error("model probe requires --id"), { code: "usage_error" });
    const config = await loadConfig(configPath), target = config.targets[id];
    if (!target) throw Object.assign(Error(`model does not exist: ${id}`), { code: "model_not_found" });
    const configured = { id, provider: target.provider, protocol: target.wireApi, capabilities: target.capabilities, live: false };
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
      },
    };
  }, `model ${command} ${id}`);
}

async function modelsLegacy() {
  if (command === "check") {
    const config = await loadConfig(configPath);
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
    const config = await loadConfig(configPath);
    const source = JSON.parse(await readFile(config.subscription.catalogPath, "utf8"));
    await atomicWrite(resolve(output), JSON.stringify(buildModelCatalog(source, config), null, 2) + "\n");
    return emit({ ok: true, output: resolve(output) }, (x) => `Catalog written: ${x.output}`);
  }
  throw Object.assign(Error("use models check|catalog"), { code: "usage_error" });
}

async function integrationCommand() {
  const config = await loadConfig(configPath);
  if (command === "status") return emit(await integrationStatus(config, { env }), (s) => `Integration: ${s.pending ? "pending App quit" : s.active ? "active" : "inactive"}; catalog ${s.catalogCurrent ? "current" : "not current"}.`);
  if (["enable", "sync", "upgrade"].includes(command)) {
    const result = await syncIntegration(config, { env, gatewayConfigPath: configPath, force: flag("force") });
    return emit(result, (x) => x.pending ? "Integration prepared; quit Codex App and run integration sync again." : x.changed ? "Integration synchronized." : "Integration already current.");
  }
  if (["disable", "restore"].includes(command)) {
    const apply = await confirm("Remove Codex Local Router managed integration fields and restore their baseline values.");
    if (!apply) return emit({ applied: false }, () => "No changes applied. Re-run with --yes after reviewing.");
    return emit(await disableIntegration({ env, force: flag("force") }), () => "Integration disabled; unrelated Codex settings were preserved.");
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
  emit({ product: PRODUCT_NAME, cliVersion: PACKAGE_VERSION, configPath, configVersion: config.schemaVersion, service: await serviceStatus(configPath, env), integration: await integrationStatus(config, { env }), targets: Object.keys(config.targets) },
    (x) => `${PRODUCT_NAME} ${x.cliVersion}\nService: ${x.service.running ? "running" : "stopped"}\nIntegration: ${x.integration.pending ? "pending App quit" : x.integration.active ? "active" : "inactive"}\nModels: ${x.targets.join(", ")}`);
}

async function serviceCommand() {
  if (command === "start") {
    const current = await serviceStatus(configPath, env);
    return emit(current.running ? current : await installService(configPath, { env }), (x) => x.running ? "Service is already running." : "Service start requested.");
  }
  if (command === "restart") return emit(await gracefulRestart(configPath, { env }), (x) => x.upgraded ? "Service restarted after draining active turns." : "Service restart deferred because active turns did not finish.");
  if (command === "stop") return emit(await stopService({ env, ignoreMissing: true }), () => "Service stopped.");
  if (command === "status") return emit(await serviceStatus(configPath, env), (x) => x.running ? `Service running (${x.health.version}, ${x.health.activeTurns} active turn(s)).` : "Service stopped.");
  throw Object.assign(Error("use service start|stop|restart|status"), { code: "usage_error" });
}

async function main() {
  if (flag("version") || group === "version") return console.log(`${PRODUCT_NAME} ${PACKAGE_VERSION}`);
  if (!group || flag("help") || group === "help") return console.log("Usage: llm-auto-gateway <command> [subcommand] [options]\n\nCommands: setup, status, provider, model, models, integration, doctor, logs, service, upgrade, rescue, history, uninstall");
  if (group === "setup") return setup();
  if (group === "status") return status();
  if (group === "provider") return providerCommand();
  if (group === "model") return modelCommand();
  if (group === "models") return modelsLegacy();
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
    const result = await gracefulRestart(configPath, { env, waitMs: Number(value("wait-seconds") ?? 300) * 1000, serverPath: value("server") });
    return emit(result, (x) => x.upgraded ? "Gateway upgraded after candidate health and drain checks." : "Gateway upgrade deferred because active turns did not finish before the timeout.");
  }
  if (group === "rescue" && flag("subscription")) {
    const apply = await confirm("Restore Codex official subscription direct settings without contacting the Gateway.");
    if (!apply) return emit({ applied: false }, () => "Rescue preview only; re-run with --yes to apply.");
    await disableIntegration({ env, force: flag("force") });
    return emit({ applied: true }, () => "Official subscription baseline restored for new Codex sessions.");
  }
  if (group === "history") return historyCommand();
  if (group === "config" && command === "upgrade") {
    const before = await rawConfig(configPath), upgraded = upgradeConfig(before);
    if (!upgraded.changes.length) return emit({ applied: false, changes: [] }, () => "Configuration is already current.");
    const apply = flag("apply") && await confirm(`Upgrade configuration:\n${upgraded.changes.join("\n")}`);
    const result = await writeConfigTransaction(configPath, before, upgraded.config, { apply });
    return emit({ ...result, changes: upgraded.changes }, (x) => x.applied ? "Configuration upgraded." : "Configuration upgrade preview only.");
  }
  if (group === "uninstall") {
    const apply = await confirm("Remove Codex integration and LaunchAgent. History and credentials will be retained.");
    if (!apply) return emit({ applied: false }, () => "Uninstall preview only; re-run with --yes to apply.");
    await disableIntegration({ env, force: flag("force") }).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await uninstallService({ env });
    return emit({ applied: true, historyRetained: true, credentialsRetained: true }, () => "Integration and service removed. History and credentials were retained.");
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
    next: error.next ?? (code === "integration_conflict" ? "llm-auto-gateway integration status --json" : "llm-auto-gateway doctor --json"),
  };
  console.error(jsonMode ? JSON.stringify(result, null, 2) : `[${code}] ${error.message}\ncorrelation: ${correlationId}\nimpact: ${result.impact}\nnext: ${result.next}`);
  process.exitCode = 1;
}

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { composeRuntimeConfig, resolveSpace } from "../src/config-spaces.mjs";

const exec = promisify(execFile);
const cli = resolve("scripts/gateway-admin.mjs");

test("CLI reports the public command and package version", async () => {
  const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  assert.equal((await exec(process.execPath, [cli, "--version"])).stdout.trim(), `Codex Local Router ${manifest.version}`);
  assert.match((await exec(process.execPath, [cli, "--help"])).stdout, /^Usage: codex-local-router /);
});

test("CLI distinguishes an app-absent legacy target from an explicitly disabled App target", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "router-cli-app-absent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "codex");
  const data = join(root, "router");
  const configPath = join(data, "config.json");
  await mkdir(home, { recursive: true });
  await mkdir(data, { recursive: true });
  const config = JSON.parse(await readFile(resolve("config/gateway.example.json"), "utf8"));
  config.defaultTarget = "legacy-gpt";
  config.providers = {
    vendor: {
      adapter: "openai-compatible",
      baseUrl: "https://provider.example/v1",
      concurrency: 1,
    },
  };
  config.targets = {
    "legacy-gpt": {
      provider: "vendor",
      model: "legacy-gpt-upstream",
      modelFamily: "openai-gpt",
      wireApi: "responses",
      contextWindow: 100000,
      maxContextWindow: 100000,
      inputModalities: ["text"],
      compression: { mode: "summary" },
      capabilities: { responses: true, streaming: true, toolCalling: true },
    },
  };
  config.subscription = { enabled: false };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const environment = {
    ...process.env,
    HOME: root,
    CODEX_HOME: home,
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    CODEX_LOCAL_ROUTER_HOME: data,
    CODEX_LOCAL_ROUTER_CONFIG: configPath,
  };

  const rows = JSON.parse((await exec(
    process.execPath,
    [cli, "model", "list", "--json"],
    { env: environment },
  )).stdout);
  assert.equal(rows[0].appCapabilityProfile.reason, "app-absent");
  assert.equal(rows[0].appCapabilityProfile.profile, null);
  assert.equal(rows[0].standaloneSearch.reason, "space-default");
  const human = (await exec(
    process.execPath,
    [cli, "model", "list"],
    { env: environment },
  )).stdout;
  assert.match(human, /legacy-gpt.*profile=unchanged \(app-absent; unchanged\)/);
});

test("setup reports pending App integration and core query commands are JSON-safe", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "router-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "codex"), data = join(root, "data");
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "config.toml"), 'model = "gpt-5.5"\n');
  await writeFile(join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-5.5", priority: 10 }] }));
  await writeFile(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "test", account_id: "account" } }));
  const config = join(data, "config.json");
  const environment = {
    ...process.env,
    CODEX_HOME: home,
    CODEX_LOCAL_ROUTER_HOME: data,
    CODEX_LOCAL_ROUTER_CONFIG: config,
    CODEX_LOCAL_ROUTER_LAUNCH_AGENT: join(root, "LaunchAgents", "router.plist"),
    CODEX_LOCAL_ROUTER_TEST_LAUNCHCTL: "1",
    CODEX_APP_RUNNING: "1",
    OPENCODE_GO_API_KEY: "test",
    FEEI_API_KEY: "test-feei",
  };
  const setup = JSON.parse((await exec(process.execPath, [cli, "setup", "--yes", "--json", "--port", "58991"], { env: environment })).stdout);
  assert.equal(setup.applied, true);
  assert.equal(setup.integration.pending, true);
  assert.equal(JSON.parse(await readFile(config, "utf8")).schemaVersion, 3);
  assert.doesNotMatch(await readFile(join(home, "config.toml"), "utf8"), /codex-local-router/);
  const synced = JSON.parse((await exec(process.execPath, [cli, "integration", "sync", "--json"], { env: { ...environment, CODEX_APP_RUNNING: "0" } })).stdout);
  assert.equal(synced.pending, false);
  const stoppedEnvironment = { ...environment, CODEX_APP_RUNNING: "0" };
  assert.match(await readFile(join(home, "config.toml"), "utf8"), /codex-local-router managed settings/);
  const status = JSON.parse((await exec(process.execPath, [cli, "status", "--json"], { env: { ...environment, CODEX_APP_RUNNING: "0" } })).stdout);
  assert.equal(status.product, "Codex Local Router");
  assert.deepEqual(status.targets, ["deepseek"]);
  const doctor = JSON.parse((await exec(process.execPath, [cli, "doctor", "--json"], { env: { ...environment, CODEX_APP_RUNNING: "0" } })).stdout);
  assert.equal(doctor.liveModelCalls, 0);
  assert.equal(doctor.credentials.providers[0].available, true);
  assert.equal(doctor.credentials.subscription.available, true);
  assert.equal(doctor.warnings.length, 1);
  const providers = JSON.parse((await exec(process.execPath, [cli, "provider", "list", "--json"], { env: environment })).stdout);
  assert.equal(providers[0].id, "opencode-go");
  await exec(process.execPath, [
    cli, "provider", "add", "--id", "feei", "--base-url", "https://ai.feei.cn/v1",
    "--api-key-env", "FEEI_API_KEY", "--standalone-search-endpoint", "alpha/search",
    "--yes", "--json",
  ], { env: stoppedEnvironment });
  await exec(process.execPath, [
    cli, "model", "add", "--id", "feei-sol", "--provider", "feei",
    "--preset", "feei/gpt-5.6-sol", "--yes", "--json",
  ], { env: stoppedEnvironment });
  const modelList = JSON.parse((await exec(
    process.execPath,
    [cli, "model", "list", "--json"],
    { env: stoppedEnvironment },
  )).stdout);
  const feei = modelList.find((model) => model.id === "feei-sol");
  assert.equal(feei.modelFamily, "openai-gpt");
  assert.equal(feei.pluginToolPolicy.reason, "third-party-openai-gpt-default");
  assert.equal(feei.standaloneSearch.source, "disabled");
  assert.equal(feei.standaloneSearch.reason, "target-explicit");
  assert.equal(feei.standaloneSearch.advertised, false);
  assert.equal(feei.standaloneSearch.credentialReady, false);
  assert.equal(feei.appCapabilityProfile.profile, "standard-tools");
  assert.equal(feei.appCapabilityProfile.reason, "target-explicit");
  assert.equal(feei.appCapabilityProfile.toolSurface, "policy-filtered-standard");
  assert.deepEqual(feei.pluginToolPolicy.allowedPlugins, [
    "github", "figma", "sites", "connected_documents",
  ]);
  assert.equal(typeof feei.toolSourceRecognition.status, "string");
  const probe = JSON.parse((await exec(
    process.execPath,
    [cli, "model", "probe", "--id", "feei-sol", "--json"],
    { env: stoppedEnvironment },
  )).stdout);
  assert.equal(probe.live, false);
  assert.equal(probe.pluginToolPolicy.reason, "third-party-openai-gpt-default");
  assert.equal(probe.standaloneSearch.source, "disabled");
  assert.equal(probe.appCapabilityProfile.profile, "standard-tools");
  const humanModelList = (await exec(
    process.execPath,
    [cli, "model", "list"],
    { env: stoppedEnvironment },
  )).stdout;
  assert.match(humanModelList, /feei-sol.*profile=standard-tools \(target-explicit; policy-filtered-standard\)/);
  const humanProbe = (await exec(
    process.execPath,
    [cli, "model", "probe", "--id", "feei-sol"],
    { env: stoppedEnvironment },
  )).stdout;
  assert.match(humanProbe, /Profile: standard-tools \(target-explicit; policy-filtered-standard\)/);

  await exec(process.execPath, [
    cli, "model", "add", "--id", "generic-gpt", "--provider", "feei",
    "--upstream-model", "gpt-5.6-sol", "--protocol", "responses",
    "--context-window", "272000", "--compression", "summary",
    "--model-family", "openai-gpt", "--app-model", "generic-gpt",
    "--yes", "--json",
  ], { env: stoppedEnvironment });
  assert.equal(
    JSON.parse(await readFile(config, "utf8")).targets["generic-gpt"].app.useResponsesLite,
    false,
  );
  assert.equal(
    JSON.parse(await readFile(config, "utf8")).targets["generic-gpt"].app.capabilityProfile,
    "standard-tools",
  );
  await exec(process.execPath, [
    cli, "model", "edit", "--id", "generic-gpt", "--app-profile", "lite-search",
    "--yes", "--json",
  ], { env: stoppedEnvironment });
  let generic = JSON.parse((await exec(
    process.execPath,
    [cli, "model", "list", "--json"],
    { env: stoppedEnvironment },
  )).stdout).find((model) => model.id === "generic-gpt");
  assert.equal(generic.appCapabilityProfile.profile, "lite-search");
  assert.equal(generic.standaloneSearch.source, "subscription");
  await assert.rejects(
    exec(process.execPath, [
      cli, "model", "edit", "--id", "generic-gpt",
      "--app-profile", "standard-tools", "--search-source", "subscription",
      "--yes", "--json",
    ], { env: stoppedEnvironment }),
    (error) => JSON.parse(error.stderr).code === "usage_error",
  );
  await exec(process.execPath, [
    cli, "model", "edit", "--id", "generic-gpt",
    "--app-profile", "standard-tools", "--yes", "--json",
  ], { env: stoppedEnvironment });

  await assert.rejects(
    exec(process.execPath, [
      cli, "model", "edit", "--id", "feei-sol", "--search-source", "provider",
      "--supports-search-tool", "--yes", "--json",
    ], { env: stoppedEnvironment }),
    (error) => JSON.parse(error.stderr).code === "usage_error",
  );
  await exec(process.execPath, [
    cli, "model", "edit", "--id", "feei-sol", "--no-supports-search-tool",
    "--yes", "--json",
  ], { env: stoppedEnvironment });
  let aliasModel = JSON.parse((await exec(
    process.execPath,
    [cli, "model", "list", "--json"],
    { env: stoppedEnvironment },
  )).stdout).find((model) => model.id === "feei-sol");
  assert.equal(aliasModel.standaloneSearch.source, "disabled");
  const searchStatus = JSON.parse((await exec(
    process.execPath,
    [cli, "status", "--json"],
    { env: stoppedEnvironment },
  )).stdout);
  assert.equal(
    searchStatus.standaloneSearch.find((search) => search.target === "feei-sol").source,
    "disabled",
  );
  assert.equal(
    searchStatus.appCapabilityProfiles.find((profile) => profile.target === "feei-sol").profile,
    "standard-tools",
  );
  const searchDoctor = JSON.parse((await exec(
    process.execPath,
    [cli, "doctor", "--json"],
    { env: stoppedEnvironment },
  )).stdout);
  assert.equal(
    searchDoctor.standaloneSearch.find((search) => search.target === "feei-sol").reason,
    "target-explicit",
  );
  assert.equal(
    searchDoctor.appCapabilityProfiles.find((profile) => profile.target === "feei-sol").toolSurface,
    "policy-filtered-standard",
  );
  const humanStatus = (await exec(
    process.execPath,
    [cli, "status"],
    { env: stoppedEnvironment },
  )).stdout;
  assert.match(humanStatus, /Profiles: .*feei-sol=standard-tools \(target-explicit; policy-filtered-standard\)/);
  const humanDoctor = (await exec(
    process.execPath,
    [cli, "doctor"],
    { env: stoppedEnvironment },
  )).stdout;
  assert.match(humanDoctor, /Profiles: .*feei-sol=standard-tools \(target-explicit; policy-filtered-standard\)/);

  await exec(process.execPath, [
    cli, "model", "add", "--id", "vendor-chat", "--provider", "feei",
    "--upstream-model", "vendor-chat", "--protocol", "chat_completions",
    "--context-window", "32000", "--compression", "unsupported",
    "--model-family", "openai-gpt", "--app-model", "vendor-chat-app",
    "--yes", "--json",
  ], { env: stoppedEnvironment });
  let rawConfig = JSON.parse(await readFile(config, "utf8"));
  assert.equal(rawConfig.targets["vendor-chat"].app.capabilityProfile, undefined);
  const chatModel = JSON.parse((await exec(
    process.execPath,
    [cli, "model", "list", "--json"],
    { env: stoppedEnvironment },
  )).stdout).find((model) => model.id === "vendor-chat");
  assert.equal(chatModel.appCapabilityProfile.profile, null);
  assert.equal(chatModel.appCapabilityProfile.reason, "non-responses-unchanged");

  await exec(process.execPath, [
    cli, "model", "add", "--id", "feei-hidden", "--provider", "feei",
    "--upstream-model", "gpt-5.6-sol", "--protocol", "responses",
    "--context-window", "272000", "--compression", "summary",
    "--model-family", "openai-gpt", "--app-model", "feei-hidden-app",
    "--yes", "--json",
  ], { env: stoppedEnvironment });
  await exec(process.execPath, [
    cli, "model", "edit", "--id", "feei-hidden",
    "--app-profile", "lite-search", "--search-source", "provider",
    "--yes", "--json",
  ], { env: stoppedEnvironment });
  await exec(process.execPath, [
    cli, "model", "edit", "--id", "feei-hidden",
    "--preset", "feei/gpt-5.6-sol", "--no-app", "--yes", "--json",
  ], { env: stoppedEnvironment });
  rawConfig = JSON.parse(await readFile(config, "utf8"));
  assert.equal(rawConfig.targets["feei-hidden"].app.enabled, false);
  assert.equal(rawConfig.targets["feei-hidden"].app.capabilityProfile, undefined);
  assert.equal(rawConfig.targets["feei-hidden"].app.supportsSearchTool, undefined);
  assert.equal(rawConfig.targets["feei-hidden"].app.useResponsesLite, false);
  assert.equal(rawConfig.targets["feei-hidden"].standaloneSearch, undefined);

  await exec(process.execPath, [
    cli, "model", "add", "--id", "feei-hidden-subscription", "--provider", "feei",
    "--upstream-model", "gpt-5.6-sol", "--protocol", "responses",
    "--context-window", "272000", "--compression", "summary",
    "--model-family", "openai-gpt", "--app-model", "feei-hidden-subscription-app",
    "--yes", "--json",
  ], { env: stoppedEnvironment });
  await exec(process.execPath, [
    cli, "model", "edit", "--id", "feei-hidden-subscription",
    "--app-profile", "lite-search", "--search-source", "subscription",
    "--yes", "--json",
  ], { env: stoppedEnvironment });
  await exec(process.execPath, [
    cli, "model", "edit", "--id", "feei-hidden-subscription",
    "--no-app", "--yes", "--json",
  ], { env: stoppedEnvironment });
  rawConfig = JSON.parse(await readFile(config, "utf8"));
  assert.equal(rawConfig.targets["feei-hidden-subscription"].app.enabled, false);
  assert.equal(rawConfig.targets["feei-hidden-subscription"].app.useResponsesLite, false);
  assert.equal(rawConfig.targets["feei-hidden-subscription"].app.capabilityProfile, undefined);
  assert.equal(rawConfig.targets["feei-hidden-subscription"].app.supportsSearchTool, undefined);
  assert.equal(rawConfig.targets["feei-hidden-subscription"].standaloneSearch, undefined);
  await assert.rejects(
    exec(process.execPath, [
      cli, "model", "edit", "--id", "feei-hidden-subscription",
      "--no-app", "--search-source", "subscription", "--yes", "--json",
    ], { env: stoppedEnvironment }),
    (error) => JSON.parse(error.stderr).code === "usage_error",
  );

  const spaces = JSON.parse((await exec(process.execPath, [cli, "space", "list", "--json"], { env: stoppedEnvironment })).stdout);
  assert.deepEqual(spaces.map((space) => space.name).sort(), ["default", "official"]);
  const current = JSON.parse((await exec(process.execPath, [cli, "space", "current", "--json"], { env: stoppedEnvironment })).stdout);
  assert.equal(current.active.space, "default");
  assert.equal(current.drift, false);
  await exec(process.execPath, [cli, "space", "create", "alternate", "--from", "default", "--yes", "--json"], { env: stoppedEnvironment });
  await exec(process.execPath, [
    cli, "space", "set-search-source", "disabled", "--space", "alternate", "--yes", "--json",
  ], { env: stoppedEnvironment });
  await exec(process.execPath, [
    cli, "model", "edit", "--id", "feei-sol", "--space", "alternate",
    "--search-source", "provider", "--yes", "--json",
  ], { env: stoppedEnvironment });
  const defaultChanged = JSON.parse((await exec(process.execPath, [
    cli, "space", "set-default-model", "feei-gpt-5.6-sol", "--space", "alternate", "--yes", "--json",
  ], { env: stoppedEnvironment })).stdout);
  assert.equal(defaultChanged.space, "alternate");
  assert.equal(defaultChanged.switch, null);
  const alternate = JSON.parse((await exec(process.execPath, [cli, "space", "show", "alternate", "--json"], { env: stoppedEnvironment })).stdout);
  assert.equal(alternate.defaultCodexModel, "feei-gpt-5.6-sol");
  assert.equal(alternate.config.standaloneSearch.thirdPartyGpt.defaultSource, "disabled");
  assert.equal(alternate.config.targets["feei-sol"].standaloneSearch.source, "provider");
  assert.equal(alternate.config.targets["feei-sol"].app.capabilityProfile, "lite-search");
  assert.equal(alternate.config.targets["feei-sol"].app.supportsSearchTool, undefined);
  const history = JSON.parse((await exec(process.execPath, [cli, "space", "history", "default", "--json"], { env: stoppedEnvironment })).stdout);
  assert.ok(history.length >= 3);
  const diff = JSON.parse((await exec(process.execPath, [cli, "space", "diff", "default@1", `default@${history[0].revision}`, "--json"], { env: stoppedEnvironment })).stdout);
  assert.ok(diff.changes.length > 0);
  await exec(process.execPath, [cli, "space", "use", "default@1", "--yes", "--json"], { env: stoppedEnvironment });
  await exec(process.execPath, [cli, "integration", "sync", "--json"], { env: stoppedEnvironment });
  const historicalState = JSON.parse(await readFile(join(data, "integration", "codex.json"), "utf8"));
  assert.equal(historicalState.materializedSpaceRef, "default@1");
  assert.doesNotMatch(
    await readFile(join(home, "model-catalogs", "codex-local-router.json"), "utf8"),
    /feei-gpt-5\.6-sol/,
  );
  const latestDefault = await resolveSpace(`default@${history[0].revision}`, stoppedEnvironment);
  const historicalRuntime = JSON.parse(await readFile(config, "utf8"));
  await writeFile(config, JSON.stringify(composeRuntimeConfig(historicalRuntime, latestDefault)));
  const capturedLatest = JSON.parse((await exec(
    process.execPath,
    [cli, "space", "capture", "default", "--yes", "--json"],
    { env: stoppedEnvironment },
  )).stdout);
  assert.equal(capturedLatest.changed, false);
  assert.equal(JSON.parse((await exec(
    process.execPath,
    [cli, "space", "current", "--json"],
    { env: stoppedEnvironment },
  )).stdout).active.revision, history[0].revision);
  const pendingOfficial = JSON.parse((await exec(process.execPath, [cli, "space", "use", "official@1", "--yes", "--json"], { env: environment })).stdout);
  assert.equal(pendingOfficial.pending, true);
  await exec(process.execPath, [cli, "space", "cancel", "--yes", "--json"], { env: environment });
  assert.match(await readFile(join(data, "state", "access-token"), "utf8"), /^[a-f0-9]{64}\n$/);

  const transactionLock = join(data, "transactions", ".space-switch.lock");
  await mkdir(join(data, "transactions"), { recursive: true });
  await writeFile(transactionLock, "active switch");
  await assert.rejects(
    exec(process.execPath, [cli, "rescue", "--subscription", "--yes", "--json"], { env: stoppedEnvironment }),
    (error) => JSON.parse(error.stderr).code === "operation_locked",
  );
  assert.match(await readFile(join(home, "config.toml"), "utf8"), /codex-local-router managed settings/);
  assert.equal(JSON.parse((await exec(
    process.execPath,
    [cli, "space", "current", "--json"],
    { env: stoppedEnvironment },
  )).stdout).active.space, "default");
  await rm(transactionLock);

  await exec(process.execPath, [cli, "space", "use", "official@1", "--yes", "--json"], { env: stoppedEnvironment });
  await assert.rejects(readFile(join(root, "LaunchAgents", "router.plist")), (error) => error.code === "ENOENT");
  for (const command of [["service", "start"], ["service", "restart"], ["upgrade"]]) {
    await assert.rejects(
      exec(process.execPath, [cli, ...command, "--json"], { env: stoppedEnvironment }),
      (error) => JSON.parse(error.stderr).code === "official_space_service_dormant",
    );
  }

  await exec(process.execPath, [cli, "space", "use", "default@1", "--yes", "--json"], { env: stoppedEnvironment });
  assert.match(await readFile(join(home, "config.toml"), "utf8"), /codex-local-router managed settings/);
  const rescued = JSON.parse((await exec(
    process.execPath,
    [cli, "rescue", "--subscription", "--yes", "--json"],
    { env: stoppedEnvironment },
  )).stdout);
  assert.deepEqual(rescued, { applied: true, active: { space: "official", revision: 1 } });
  assert.doesNotMatch(await readFile(join(home, "config.toml"), "utf8"), /codex-local-router managed settings/);
  assert.equal(JSON.parse((await exec(
    process.execPath,
    [cli, "space", "current", "--json"],
    { env: stoppedEnvironment },
  )).stdout).active.space, "official");
  await assert.rejects(readFile(join(root, "LaunchAgents", "router.plist")), (error) => error.code === "ENOENT");
  await assert.rejects(readFile(join(data, "transactions", "space-switch.json")), (error) => error.code === "ENOENT");

  const pendingRouter = JSON.parse((await exec(
    process.execPath,
    [cli, "space", "use", "default", "--yes", "--json"],
    { env: environment },
  )).stdout);
  assert.equal(pendingRouter.pending, true);
  await exec(process.execPath, [cli, "uninstall", "--yes", "--json"], { env: environment });
  await assert.rejects(readFile(join(data, "transactions", "space-switch.json")), (error) => error.code === "ENOENT");
  await assert.rejects(readFile(join(root, "LaunchAgents", "switcher.plist")), (error) => error.code === "ENOENT");
  const resumed = JSON.parse((await exec(
    process.execPath,
    [cli, "space", "resume", "--coordinator", "--json"],
    { env: stoppedEnvironment },
  )).stdout);
  assert.equal(resumed.changed, false);
  const afterUninstall = JSON.parse((await exec(
    process.execPath,
    [cli, "space", "current", "--json"],
    { env: stoppedEnvironment },
  )).stdout);
  assert.equal(afterUninstall.active.space, "official");

  const reactivated = JSON.parse((await exec(
    process.execPath,
    [cli, "space", "use", "default", "--yes", "--json"],
    { env: stoppedEnvironment },
  )).stdout);
  assert.equal(reactivated.active.space, "default");
  const uninstalledRouter = JSON.parse((await exec(
    process.execPath,
    [cli, "uninstall", "--yes", "--json"],
    { env: stoppedEnvironment },
  )).stdout);
  assert.equal(uninstalledRouter.active.space, "official");
  const restoredAfterUninstall = JSON.parse((await exec(
    process.execPath,
    [cli, "space", "use", "default", "--yes", "--json"],
    { env: stoppedEnvironment },
  )).stdout);
  assert.equal(restoredAfterUninstall.changed, true);
  assert.equal(restoredAfterUninstall.active.space, "default");
});

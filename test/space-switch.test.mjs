import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.mjs";
import {
  appendSpaceRevision,
  composeRuntimeConfig,
  createSpace,
  initializeSpaces,
  readSpaceIndex,
  readSpaceTransaction,
  resolveSpace,
} from "../src/config-spaces.mjs";
import {
  beginSpaceSwitch,
  cancelSpaceSwitch,
  resumeSpaceSwitch,
} from "../src/space-switch.mjs";
import { disableIntegration, readIntegrationState, syncIntegration } from "../src/integration.mjs";

function runtimeConfig(catalogPath, concurrency = 4) {
  return {
    schemaVersion: 3,
    listen: { host: "127.0.0.1", port: 0 },
    access: { required: false },
    mode: "rules",
    defaultTarget: "custom",
    providers: {
      provider: {
        adapter: "openai-compatible",
        baseUrl: "https://example.com/v1",
        apiKeyEnv: "TEST_PROVIDER_KEY",
        concurrency,
      },
    },
    targets: {
      custom: {
        provider: "provider",
        model: "upstream-model",
        modelFamily: "other",
        wireApi: "responses",
        contextWindow: 100000,
        app: { enabled: true, modelId: "custom-model" },
      },
    },
    rules: [],
    history: { persistent: { enabled: false } },
    maxBodyBytes: 1024,
    maxConnections: 4,
    timeoutMs: 1000,
    subscription: { enabled: true, catalogPath, models: ["gpt-5.5"] },
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "router-space-switch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "codex"), data = join(root, "data");
  await mkdir(home, { recursive: true });
  const catalog = join(home, "models_cache.json");
  await writeFile(catalog, JSON.stringify({ models: [{ slug: "gpt-5.5" }] }));
  const userConfig = 'model = "gpt-5.5"\nmodel_provider = "openai"\n\n[mcp_servers.user]\ncommand = "safe"\n';
  await writeFile(join(home, "config.toml"), userConfig);
  await writeFile(join(home, "auth.json"), JSON.stringify({
    tokens: { access_token: "test-subscription-token", account_id: "test-account" },
  }));
  const config = runtimeConfig(catalog);
  const configPath = join(data, "config.json");
  await mkdir(data, { recursive: true });
  await writeFile(configPath, JSON.stringify(config));
  const env = {
    ...process.env,
    CODEX_HOME: home,
    CODEX_LOCAL_ROUTER_HOME: data,
    CODEX_LOCAL_ROUTER_CONFIG: configPath,
    CODEX_CONFIG_PATH: join(home, "config.toml"),
    CODEX_MODEL_CATALOG_SOURCE: catalog,
    CODEX_LOCAL_ROUTER_LAUNCH_AGENT: join(root, "LaunchAgents", "router.plist"),
    CODEX_LOCAL_ROUTER_SPACE_SWITCHER_LAUNCH_AGENT: join(root, "LaunchAgents", "switcher.plist"),
    CODEX_LOCAL_ROUTER_TEST_LAUNCHCTL: "1",
  };
  const integrationState = {
    schemaVersion: 4,
    status: "disabled",
    managed: {
      model_provider: "openai",
      model: "custom-model",
      openai_base_url: "http://127.0.0.1:8788/subscription/v1",
      model_catalog_json: join(home, "model-catalogs", "codex-local-router.json"),
    },
    baseline: {
      model: 'model = "gpt-5.5"',
      model_provider: 'model_provider = "openai"',
    },
  };
  await initializeSpaces({ env, config, configPath, codexHome: home, integrationState });
  let appRunning = false;
  let serviceRunning = false;
  let switcherInstalled = false;
  let preflights = 0;
  const operations = {
    env,
    configPath,
    appRunning: async () => appRunning,
    verifyCredentials: async () => {},
    preflight: async () => { preflights++; },
    installSwitcher: async () => { switcherInstalled = true; },
    uninstallSwitcher: async () => { switcherInstalled = false; },
    drain: async () => ({ drained: true, wasRunning: serviceRunning }),
    installService: async () => { serviceRunning = true; return { running: true }; },
    stopService: async () => { serviceRunning = false; return { stopped: true }; },
    serviceStatus: async () => ({ running: serviceRunning }),
  };
  return {
    root, home, data, catalog, config, configPath, env, userConfig, operations,
    setAppRunning: (value) => { appRunning = value; },
    switcherInstalled: () => switcherInstalled,
    preflights: () => preflights,
  };
}

test("App-running switch persists once, then activates Router without changing user MCP", async (t) => {
  const f = await fixture(t);
  f.setAppRunning(true);
  const pending = await beginSpaceSwitch("default", f.operations);
  assert.equal(pending.pending, true);
  assert.equal(f.preflights(), 1);
  assert.equal(f.switcherInstalled(), true);
  assert.deepEqual((await readSpaceIndex(f.env)).active, { space: "official", revision: 1 });
  assert.equal(await readFile(join(f.home, "config.toml"), "utf8"), f.userConfig);

  f.setAppRunning(false);
  const applied = await resumeSpaceSwitch(f.operations);
  assert.deepEqual(applied.active, { space: "default", revision: 1 });
  assert.deepEqual(applied.previous, { space: "official", revision: 1 });
  assert.equal(f.switcherInstalled(), false);
  const codex = await readFile(join(f.home, "config.toml"), "utf8");
  assert.match(codex, /codex-local-router managed settings/);
  assert.match(codex, /\[mcp_servers\.user\]\ncommand = "safe"/);
  assert.equal((await resumeSpaceSwitch(f.operations)).changed, false);
  assert.equal(await readSpaceTransaction(f.env), null);
});

test("Router spaces switch across revisions and rollback target is prior activation", async (t) => {
  const f = await fixture(t);
  await beginSpaceSwitch("default", f.operations);
  await createSpace("alternate", "default", { env: f.env });
  const changed = runtimeConfig(f.catalog, 2);
  await appendSpaceRevision("alternate", {
    kind: "router",
    source: "test-edit",
    config: changed,
    defaultCodexModel: "custom-model",
  }, { env: f.env });
  await beginSpaceSwitch("alternate@2", f.operations);
  let index = await readSpaceIndex(f.env);
  assert.deepEqual(index.active, { space: "alternate", revision: 2 });
  assert.deepEqual(index.previous, { space: "default", revision: 1 });
  assert.equal(JSON.parse(await readFile(f.configPath, "utf8")).providers.provider.concurrency, 2);
  await beginSpaceSwitch("default@1", f.operations);
  index = await readSpaceIndex(f.env);
  assert.deepEqual(index.previous, { space: "alternate", revision: 2 });
});

test("official captures a changed default before leaving and restores exact protected versions", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.home, "config.toml"), f.userConfig.replace("gpt-5.5", "gpt-6-astra"));
  await beginSpaceSwitch("default", f.operations);
  let index = await readSpaceIndex(f.env);
  assert.equal(index.spaces.official.latestRevision, 2);
  assert.deepEqual(index.previous, { space: "official", revision: 2 });
  await beginSpaceSwitch("official@1", f.operations);
  index = await readSpaceIndex(f.env);
  assert.deepEqual(index.active, { space: "official", revision: 1 });
  const codex = await readFile(join(f.home, "config.toml"), "utf8");
  assert.match(codex, /^model = "gpt-5\.5"/m);
  assert.doesNotMatch(codex, /codex-local-router managed settings/);
  await beginSpaceSwitch("official@2", {
    ...f.operations,
    installService: async () => { throw Error("official never starts Router"); },
  });
  assert.deepEqual((await readSpaceIndex(f.env)).active, {
    space: "official",
    revision: 2,
  });
  assert.match(await readFile(join(f.home, "config.toml"), "utf8"), /^model = "gpt-6-astra"/m);

  await rm(join(f.data, "integration", "codex.json"), { force: true });
  await beginSpaceSwitch("official@1", f.operations);
  assert.deepEqual((await readSpaceIndex(f.env)).active, {
    space: "official",
    revision: 1,
  });
  assert.match(await readFile(join(f.home, "config.toml"), "utf8"), /^model = "gpt-5\.5"/m);
});

test("a captured official catalog can switch back to the same Router space", async (t) => {
  const f = await fixture(t);
  await beginSpaceSwitch("default", f.operations);
  await beginSpaceSwitch("official@1", f.operations);
  const restored = await beginSpaceSwitch("default", f.operations);
  assert.deepEqual(restored.active, { space: "default", revision: 1 });
  assert.equal((await readIntegrationState(f.env)).materializedSpaceRef, "default@1");
});

test("hash conflicts fail closed and do not overwrite concurrent edits", async (t) => {
  const f = await fixture(t);
  f.setAppRunning(true);
  await beginSpaceSwitch("default", f.operations);
  const concurrent = { ...f.config, timeoutMs: 9999 };
  await writeFile(f.configPath, JSON.stringify(concurrent));
  f.setAppRunning(false);
  await assert.rejects(resumeSpaceSwitch(f.operations), /source files changed/);
  assert.equal(JSON.parse(await readFile(f.configPath, "utf8")).timeoutMs, 9999);
  const transaction = await readSpaceTransaction(f.env);
  assert.equal(transaction.stage, "failed");
  assert.equal(transaction.recovered, false);
  await assert.rejects(cancelSpaceSwitch(f.operations), /requires recovery/);
});

test("source changes made during drain are detected before materialization", async (t) => {
  const f = await fixture(t);
  await beginSpaceSwitch("default", f.operations);
  await createSpace("alternate", "default", { env: f.env });
  const currentCodex = await readFile(join(f.home, "config.toml"), "utf8");
  const changedCodex = currentCodex.replace("custom-model", "gpt-6-astra");
  let resumes = 0;
  await assert.rejects(beginSpaceSwitch("alternate", {
    ...f.operations,
    drain: async () => {
      await writeFile(join(f.home, "config.toml"), changedCodex);
      return { drained: true, wasRunning: true, before: { health: { pid: 4242 } } };
    },
    resumeService: async (pid) => { assert.equal(pid, 4242); resumes++; },
  }), /source files changed/);
  assert.equal(await readFile(join(f.home, "config.toml"), "utf8"), changedCodex);
  assert.equal(resumes, 1);
  const transaction = await readSpaceTransaction(f.env);
  assert.equal(transaction.recovered, false);
});

test("official source activation skips the dormant Router drain path", async (t) => {
  const f = await fixture(t);
  let drains = 0;
  const result = await beginSpaceSwitch("default", {
    ...f.operations,
    drain: async () => { drains++; return { drained: false }; },
  });
  assert.equal(drains, 0);
  assert.deepEqual(result.active, { space: "default", revision: 1 });
  assert.equal(await readSpaceTransaction(f.env), null);
});

test("official settings changed during candidate preflight are preserved and rejected", async (t) => {
  const f = await fixture(t);
  const codexPath = join(f.home, "config.toml");
  const concurrent = f.userConfig.replace("gpt-5.5", "gpt-6-astra");
  await assert.rejects(beginSpaceSwitch("default", {
    ...f.operations,
    preflight: async () => { await writeFile(codexPath, concurrent); },
  }), (error) => error.code === "space_source_changed");
  assert.equal(await readFile(codexPath, "utf8"), concurrent);
  assert.equal((await readSpaceIndex(f.env)).spaces.official.latestRevision, 1);
  assert.equal(await readSpaceTransaction(f.env), null);
});

test("active-turn timeout in a Router space does not rewrite integration or restart the live service", async (t) => {
  const f = await fixture(t);
  await beginSpaceSwitch("default", f.operations);
  await createSpace("alternate", "default", { env: f.env });
  let syncs = 0, installs = 0;
  await assert.rejects(beginSpaceSwitch("alternate", {
    ...f.operations,
    drain: async () => ({ drained: false, wasRunning: true, reason: "active_turn_timeout" }),
    syncIntegration: async () => { syncs++; },
    installService: async () => { installs++; },
  }), /active Gateway turns/);
  assert.equal(syncs, 0);
  assert.equal(installs, 0);
  const transaction = await readSpaceTransaction(f.env);
  assert.equal(transaction.stage, "failed");
  assert.equal(transaction.recovered, true);
});

test("App reopening after a successful drain resumes source Router traffic", async (t) => {
  const f = await fixture(t);
  await beginSpaceSwitch("default", f.operations);
  await createSpace("alternate", "default", { env: f.env });
  let appChecks = 0, draining = false, resumes = 0;
  await assert.rejects(beginSpaceSwitch("alternate", {
    ...f.operations,
    appRunning: async () => ++appChecks >= 3,
    drain: async () => {
      draining = true;
      return {
        drained: true,
        wasRunning: true,
        before: { health: { pid: 4242 } },
      };
    },
    resumeService: async (pid) => {
      assert.equal(pid, 4242);
      draining = false;
      resumes++;
    },
  }), /App reopened/);
  assert.equal(draining, false);
  assert.equal(resumes, 1);
  const transaction = await readSpaceTransaction(f.env);
  assert.equal(transaction.stage, "failed");
  assert.equal(transaction.recovered, true);
});

test("different pending targets are rejected while an identical target resumes idempotently", async (t) => {
  const f = await fixture(t);
  await createSpace("alternate", "default", { env: f.env });
  f.setAppRunning(true);
  await beginSpaceSwitch("default", f.operations);
  assert.equal((await beginSpaceSwitch("default", f.operations)).pending, true);
  await assert.rejects(beginSpaceSwitch("alternate", f.operations), /another space switch/);
});

test("concurrent begin calls cannot both create pending transactions", async (t) => {
  const f = await fixture(t);
  await createSpace("alternate", "default", { env: f.env });
  f.setAppRunning(true);
  let releasePreflight;
  let reportPreflight;
  const preflightEntered = new Promise((resolve) => { reportPreflight = resolve; });
  const preflightReleased = new Promise((resolve) => { releasePreflight = resolve; });
  const first = beginSpaceSwitch("default", {
    ...f.operations,
    preflight: async () => {
      reportPreflight();
      await preflightReleased;
    },
  });
  await preflightEntered;
  await assert.rejects(
    beginSpaceSwitch("alternate", f.operations),
    (error) => error.code === "operation_locked",
  );
  releasePreflight();
  assert.equal((await first).pending, true);
  assert.equal((await readSpaceTransaction(f.env)).target.space, "default");
});

test("interrupted apply waits for App exit before any recovery mutation", async (t) => {
  const f = await fixture(t);
  f.setAppRunning(true);
  await beginSpaceSwitch("default", f.operations);
  const transaction = await readSpaceTransaction(f.env);
  transaction.stage = "applying";
  await writeFile(
    join(f.data, "transactions", "space-switch.json"),
    JSON.stringify(transaction),
  );
  let syncs = 0, installs = 0, stops = 0;
  const result = await resumeSpaceSwitch({
    ...f.operations,
    syncIntegration: async () => { syncs++; },
    installService: async () => { installs++; },
    stopService: async () => { stops++; },
  });
  assert.equal(result.pending, true);
  assert.equal(syncs, 0);
  assert.equal(installs, 0);
  assert.equal(stops, 0);
  assert.equal((await readSpaceTransaction(f.env)).stage, "applying");
});

test("interrupted Gateway materialization is recognized and restores the exact source bytes", async (t) => {
  const f = await fixture(t);
  await beginSpaceSwitch("default", f.operations);
  await createSpace("alternate", "default", { env: f.env });
  const changed = runtimeConfig(f.catalog, 2);
  await appendSpaceRevision("alternate", {
    kind: "router",
    source: "fault-injection",
    config: changed,
    defaultCodexModel: "custom-model",
  }, { env: f.env });
  const sourceBytes = await readFile(f.configPath);
  f.setAppRunning(true);
  await beginSpaceSwitch("alternate@2", f.operations);
  const transaction = await readSpaceTransaction(f.env);
  transaction.stage = "applying";
  await writeFile(
    join(f.data, "transactions", "space-switch.json"),
    JSON.stringify(transaction),
  );
  const target = await resolveSpace("alternate@2", f.env);
  const targetConfig = composeRuntimeConfig(JSON.parse(sourceBytes), target);
  await writeFile(f.configPath, JSON.stringify(targetConfig, null, 2) + "\n");
  f.setAppRunning(false);
  let drains = 0;
  await assert.rejects(resumeSpaceSwitch({
    ...f.operations,
    drain: async () => ++drains === 1
      ? { drained: true, wasRunning: true }
      : { drained: false, wasRunning: true },
  }), /active Gateway turns/);
  const recovered = await readSpaceTransaction(f.env);
  assert.equal(recovered.stage, "failed");
  assert.equal(recovered.recovered, true);
  assert.deepEqual(await readFile(f.configPath), sourceBytes);
  const completed = await resumeSpaceSwitch(f.operations);
  assert.deepEqual(completed.active, { space: "alternate", revision: 2 });
});

test("coordinator polling does not hold the transaction lock and a pending switch can be cancelled", async (t) => {
  const f = await fixture(t);
  f.setAppRunning(true);
  await beginSpaceSwitch("default", f.operations);
  const coordinator = resumeSpaceSwitch({
    ...f.operations,
    coordinator: true,
    coordinatorWaitMs: 1000,
    appPollMs: 5,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await cancelSpaceSwitch(f.operations)).changed, true);
  f.setAppRunning(false);
  assert.equal((await coordinator).changed, false);
  assert.equal(await readSpaceTransaction(f.env), null);
});

test("a verified switch cannot be cancelled before its active pointer is committed", async (t) => {
  const f = await fixture(t);
  f.setAppRunning(true);
  await beginSpaceSwitch("default", f.operations);
  const transaction = await readSpaceTransaction(f.env);
  transaction.stage = "verified";
  await writeFile(
    join(f.data, "transactions", "space-switch.json"),
    JSON.stringify(transaction),
  );
  await assert.rejects(
    cancelSpaceSwitch(f.operations),
    (error) => error.code === "space_switch_recovery_required",
  );
  assert.equal((await readSpaceTransaction(f.env)).stage, "verified");
});

test("verified recovery rechecks materialized files after verification", async (t) => {
  const f = await fixture(t);
  f.setAppRunning(true);
  await beginSpaceSwitch("default", f.operations);
  const transaction = await readSpaceTransaction(f.env);
  transaction.stage = "verified";
  transaction.expectedFiles = {
    gatewayConfigHash: transaction.sourceFiles.gatewayConfigHash,
    codexConfigHash: transaction.sourceFiles.codexConfigHash,
    catalogHash: transaction.sourceFiles.catalogHash,
  };
  transaction.appliedFiles = { ...transaction.expectedFiles };
  await writeFile(
    join(f.data, "transactions", "space-switch.json"),
    JSON.stringify(transaction),
  );
  f.setAppRunning(false);
  await assert.rejects(resumeSpaceSwitch({
    ...f.operations,
    integrationStatus: async () => ({
      active: true,
      pending: false,
      configCurrent: true,
      catalogCurrent: true,
    }),
    serviceStatus: async () => {
      const changed = JSON.parse(await readFile(f.configPath, "utf8"));
      changed.providers.provider.concurrency = 99;
      await writeFile(f.configPath, JSON.stringify(changed));
      return { running: true };
    },
  }), /materialized files changed/);
  assert.deepEqual((await readSpaceIndex(f.env)).active, {
    space: "official",
    revision: 1,
  });
  assert.equal(JSON.parse(await readFile(f.configPath, "utf8")).providers.provider.concurrency, 99);
  assert.equal((await readSpaceTransaction(f.env)).stage, "verified");
});

test("a superseded begin cannot uninstall the newer pending transaction coordinator", async (t) => {
  const f = await fixture(t);
  await createSpace("alternate", "default", { env: f.env });
  f.setAppRunning(true);
  const events = [];
  let reportOldInstall;
  let releaseOldInstall;
  const oldInstallEntered = new Promise((resolve) => { reportOldInstall = resolve; });
  const oldInstallReleased = new Promise((resolve) => { releaseOldInstall = resolve; });
  const first = beginSpaceSwitch("default", {
    ...f.operations,
    installSwitcher: async () => {
      reportOldInstall();
      await oldInstallReleased;
      events.push("old-installed");
    },
    uninstallSwitcher: async () => { events.push("old-uninstalled"); },
  });
  await oldInstallEntered;
  await cancelSpaceSwitch(f.operations);
  const second = await beginSpaceSwitch("alternate", {
    ...f.operations,
    installSwitcher: async () => { events.push("new-installed"); },
  });
  assert.equal(second.pending, true);
  releaseOldInstall();
  await assert.rejects(first, (error) => error.code === "space_switch_superseded");
  assert.deepEqual(events, ["new-installed", "old-installed"]);
  assert.equal((await readSpaceTransaction(f.env)).target.space, "alternate");
});

test("a coordinator that completes during installation is reported as success", async (t) => {
  const f = await fixture(t);
  f.setAppRunning(true);
  const result = await beginSpaceSwitch("default", {
    ...f.operations,
    installSwitcher: async () => {
      f.setAppRunning(false);
      await resumeSpaceSwitch(f.operations);
    },
  });
  assert.equal(result.pending, false);
  assert.equal(result.completedByCoordinator, true);
  assert.deepEqual(result.active, { space: "default", revision: 1 });
  assert.equal(await readSpaceTransaction(f.env), null);
});

test("resume reports success when its coordinator completes during installation", async (t) => {
  const f = await fixture(t);
  f.setAppRunning(true);
  await beginSpaceSwitch("default", f.operations);
  const result = await resumeSpaceSwitch({
    ...f.operations,
    installSwitcher: async () => {
      f.setAppRunning(false);
      await resumeSpaceSwitch(f.operations);
    },
  });
  assert.equal(result.pending, false);
  assert.equal(result.completedByCoordinator, true);
  assert.deepEqual(result.active, { space: "default", revision: 1 });
  assert.equal(await readSpaceTransaction(f.env), null);
});

test("missing credentials and failed candidates stop before creating a transaction", async (t) => {
  const missing = await fixture(t);
  await assert.rejects(beginSpaceSwitch("default", {
    ...missing.operations,
    verifyCredentials: async () => {
      throw Object.assign(Error("credential unavailable"), {
        code: "provider_credential_missing",
      });
    },
  }), /credential unavailable/);
  assert.equal(await readSpaceTransaction(missing.env), null);

  const candidate = await fixture(t);
  await assert.rejects(beginSpaceSwitch("default", {
    ...candidate.operations,
    preflight: async () => { throw Error("candidate failed"); },
  }), /candidate failed/);
  assert.equal(await readSpaceTransaction(candidate.env), null);
});

test("service activation failure restores the prior Router space", async (t) => {
  const f = await fixture(t);
  await beginSpaceSwitch("default", f.operations);
  await createSpace("alternate", "default", { env: f.env });
  let installs = 0;
  await assert.rejects(beginSpaceSwitch("alternate", {
    ...f.operations,
    installService: async () => {
      installs++;
      if (installs === 1) throw Error("service activation failed");
      return { running: true };
    },
  }), /service activation failed/);
  assert.deepEqual((await readSpaceIndex(f.env)).active, {
    space: "default",
    revision: 1,
  });
  const transaction = await readSpaceTransaction(f.env);
  assert.equal(transaction.stage, "failed");
  assert.equal(transaction.recovered, true);
  assert.equal(installs, 2);
  const resumed = await resumeSpaceSwitch(f.operations);
  assert.deepEqual(resumed.active, { space: "alternate", revision: 1 });
});

test("a runtime edit during service activation blocks the active pointer commit", async (t) => {
  const f = await fixture(t);
  await beginSpaceSwitch("default", f.operations);
  await createSpace("alternate", "default", { env: f.env });
  await assert.rejects(beginSpaceSwitch("alternate", {
    ...f.operations,
    installService: async () => {
      const concurrent = JSON.parse(await readFile(f.configPath, "utf8"));
      concurrent.providers.provider.concurrency = 99;
      await writeFile(f.configPath, JSON.stringify(concurrent));
      return { running: true };
    },
    serviceStatus: async () => ({ running: true }),
  }), /materialized files changed/);
  assert.deepEqual((await readSpaceIndex(f.env)).active, {
    space: "default",
    revision: 1,
  });
  assert.equal(JSON.parse(await readFile(f.configPath, "utf8")).providers.provider.concurrency, 99);
  assert.equal((await readSpaceTransaction(f.env)).recovered, false);
});

test("official stop failure restores a Router catalog when the applied checkpoint records its deletion", async (t) => {
  const f = await fixture(t);
  await beginSpaceSwitch("default", f.operations);
  await assert.rejects(beginSpaceSwitch("official@1", {
    ...f.operations,
    stopService: async () => { throw Error("official stop failed"); },
  }), /official stop failed/);
  assert.deepEqual((await readSpaceIndex(f.env)).active, {
    space: "default",
    revision: 1,
  });
  const transaction = await readSpaceTransaction(f.env);
  assert.equal(transaction.stage, "failed");
  assert.equal(transaction.recovered, true);
  assert.equal(transaction.recoveryFailure, undefined);
  assert.match(
    await readFile(join(f.home, "model-catalogs", "codex-local-router.json"), "utf8"),
    /custom-model/,
  );
  assert.equal((await readIntegrationState(f.env)).materializedSpaceRef, "default@1");
});

test("a post-write integration failure is checkpointed and rolls back to the source space", async (t) => {
  const f = await fixture(t);
  await beginSpaceSwitch("default", f.operations);
  await createSpace("alternate", "default", { env: f.env });
  let syncs = 0;
  await assert.rejects(beginSpaceSwitch("alternate", {
    ...f.operations,
    syncIntegration: async (config, options) => {
      syncs++;
      const result = await syncIntegration(config, { ...options, env: f.env });
      if (syncs === 1) throw Error("integration failed after writing");
      return result;
    },
  }), /integration failed after writing/);
  const transaction = await readSpaceTransaction(f.env);
  assert.equal(transaction.recovered, true);
  assert.equal(transaction.appliedFiles, undefined);
  assert.equal((await readIntegrationState(f.env)).materializedSpaceRef, "default@1");
  assert.match(await readFile(join(f.home, "config.toml"), "utf8"), /\[mcp_servers\.user\]/);
});

test("an integration conflict never checkpoints or overwrites a concurrent Codex edit", async (t) => {
  const f = await fixture(t);
  await beginSpaceSwitch("default", f.operations);
  await createSpace("alternate", "default", { env: f.env });
  const codexPath = join(f.home, "config.toml");
  const concurrentBaseUrl = "https://concurrent-user.example/v1";
  await assert.rejects(beginSpaceSwitch("alternate", {
    ...f.operations,
    syncIntegration: async (config, options) => {
      const current = await readFile(codexPath, "utf8");
      await writeFile(
        codexPath,
        current.replace(
          /openai_base_url = \"[^\"]+\"/,
          `openai_base_url = "${concurrentBaseUrl}"`,
        ),
      );
      return syncIntegration(config, { ...options, env: f.env });
    },
  }), (error) => error.code === "integration_conflict");
  assert.match(await readFile(codexPath, "utf8"), new RegExp(concurrentBaseUrl));
  const transaction = await readSpaceTransaction(f.env);
  assert.equal(transaction.stage, "failed");
  assert.equal(transaction.recovered, false);
  assert.equal(Object.hasOwn(transaction.appliedFiles, "codexConfigHash"), false);
});

test("an official switch never removes a concurrently changed Codex catalog", async (t) => {
  const f = await fixture(t);
  await beginSpaceSwitch("default", f.operations);
  const catalogPath = join(f.home, "model-catalogs", "codex-local-router.json");
  const concurrentCatalog = '{"models":[{"slug":"user-concurrent"}]}\n';
  await assert.rejects(beginSpaceSwitch("official@1", {
    ...f.operations,
    disableIntegration: async (options) => {
      await writeFile(catalogPath, concurrentCatalog);
      return disableIntegration({ ...options, env: f.env });
    },
  }), (error) => error.code === "integration_catalog_conflict");
  assert.equal(await readFile(catalogPath, "utf8"), concurrentCatalog);
  const transaction = await readSpaceTransaction(f.env);
  assert.equal(transaction.stage, "failed");
  assert.equal(transaction.recovered, false);
});

test("stale disabled integration state cannot skip rollback of partially written Router files", async (t) => {
  const f = await fixture(t);
  const official = await resolveSpace("official@1", f.env);
  await syncIntegration(await loadConfig(f.configPath), {
    env: f.env,
    selectedModel: "custom-model",
    officialBaseline: official.codexBaseline,
    officialSpaceRef: "official@1",
    spaceRef: "default@1",
    gatewayConfigPath: f.configPath,
    applyWhileRunning: true,
  });
  await disableIntegration({
    env: f.env,
    officialBaseline: official.codexBaseline,
    officialSpaceRef: "official@1",
    applyWhileRunning: true,
  });
  const stale = await readIntegrationState(f.env);
  f.setAppRunning(true);
  await beginSpaceSwitch("default", f.operations);
  f.setAppRunning(false);
  await assert.rejects(resumeSpaceSwitch({
    ...f.operations,
    syncIntegration: async (config, options) => {
      await syncIntegration(config, { ...options, env: f.env });
      await writeFile(
        join(f.data, "integration", "codex.json"),
        JSON.stringify(stale),
      );
      throw Error("integration state commit interrupted");
    },
  }), /integration state commit interrupted/);
  const transaction = await readSpaceTransaction(f.env);
  assert.equal(transaction.recovered, true);
  assert.doesNotMatch(
    await readFile(join(f.home, "config.toml"), "utf8"),
    /codex-local-router managed settings/,
  );
  assert.equal((await readIntegrationState(f.env)).materializedSpaceRef, "official@1");
});

test("space revisions and transactions never copy Codex auth or user MCP bodies", async (t) => {
  const f = await fixture(t);
  f.setAppRunning(true);
  await beginSpaceSwitch("default", f.operations);
  const revision = JSON.stringify(await resolveSpace("default", f.env));
  const transaction = JSON.stringify(await readSpaceTransaction(f.env));
  for (const body of [revision, transaction]) {
    assert.doesNotMatch(body, /test-subscription-token/);
    assert.doesNotMatch(body, /mcp_servers/);
    assert.doesNotMatch(body, /command = \\"safe\\"/);
  }
});

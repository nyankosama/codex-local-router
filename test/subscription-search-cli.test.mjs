import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validate } from "../src/config.mjs";
import { applyThirdPartyTemplate } from "../src/third-party-template.mjs";
import {
  initializeSpaces,
  readSpaceIndex,
  resolveSpace,
} from "../src/config-spaces.mjs";

const exec = promisify(execFile);
const cli = resolve("test/support/gateway-admin-test-driver.mjs");

test("CLI versions subscription search atomically and rejects conflicting carriers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "subscription-search-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "codex"), router = join(root, "router");
  const configPath = join(router, "config.json");
  const catalogPath = join(home, "models_cache.json");
  await mkdir(home); await mkdir(router);
  await writeFile(catalogPath, JSON.stringify({ models: [{ slug: "gpt-fixture" }] }));
  await writeFile(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture", account_id: "fixture" } }));
  await writeFile(join(home, "config.toml"), 'model_provider = "openai"\nmodel = "gpt-fixture"\ncli_auth_credentials_store = "file"\n');
  const config = validate({
    schemaVersion: 3,
    defaultTarget: "glm",
    providers: { vendor: { baseUrl: "https://provider.example/v1" } },
    targets: {
      glm: applyThirdPartyTemplate({
        provider: "vendor",
        model: "glm-5.3-flash",
        modelFamily: "other",
        wireApi: "responses",
        contextWindow: 200000,
        maxContextWindow: 200000,
        inputModalities: ["text"],
        compression: { mode: "summary" },
        capabilities: {
          responses: true,
          streaming: true,
          toolCalling: true,
          freeformTools: true,
        },
        standaloneSearch: { source: "disabled" },
        app: {
          enabled: true,
          modelId: "fixture-glm",
          capabilityProfile: "standard-tools",
          useResponsesLite: false,
        },
      }, "codex-general-v1"),
    },
    subscription: { enabled: true, models: ["gpt-fixture"], catalogPath },
  });
  await writeFile(configPath, JSON.stringify(config));
  const env = {
    ...process.env,
    HOME: root,
    CODEX_HOME: home,
    CODEX_LOCAL_ROUTER_HOME: router,
    CODEX_LOCAL_ROUTER_CONFIG: configPath,
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    CODEX_LOCAL_ROUTER_TEST_DRIVER_APP_STATE: "running",
    CODEX_LOCAL_ROUTER_TEST_DRIVER_LAUNCHCTL: "1",
  };
  await initializeSpaces({
    env,
    config,
    configPath,
    integrationState: {
      schemaVersion: 3,
      status: "disabled",
      baseline: {
        model: 'model = "gpt-fixture"',
        model_provider: 'model_provider = "openai"',
      },
    },
  });
  const run = async (...args) => JSON.parse((await exec(
    process.execPath,
    [cli, ...args, "--space", "default", "--json"],
    { env },
  )).stdout);

  const enabled = await run(
    "model", "edit", "--id", "glm",
    "--subscription-search", "standard-tool", "--yes",
  );
  assert.equal(enabled.revision, 2);
  const target = (await resolveSpace("default@2", env)).config.targets.glm;
  assert.deepEqual(target.subscriptionSearch, { delivery: "standard-tool" });
  assert.equal(target.app.capabilityProfile, "standard-tools");
  assert.equal(target.app.useResponsesLite, false);
  assert.deepEqual(target.standaloneSearch, { source: "disabled" });
  assert.equal(
    (await run("model", "edit", "--id", "glm", "--subscription-search", "standard-tool", "--yes")).changed,
    false,
  );
  await assert.rejects(
    exec(process.execPath, [
      cli, "model", "edit", "--id", "glm", "--space", "default",
      "--subscription-search", "standard-tool", "--responses-lite", "--yes", "--json",
    ], { env }),
    (error) => JSON.parse(error.stderr).code === "usage_error",
  );
  assert.equal((await readSpaceIndex(env)).spaces.default.latestRevision, 2);
  assert.equal((await resolveSpace("default@1", env)).config.targets.glm.subscriptionSearch, undefined);

  const normalized = await run(
    "model", "edit", "--id", "glm",
    "--template", "legacy",
    "--app-profile", "standard-tools",
    "--no-responses-lite",
    "--tool-mode", "default",
    "--multi-agent-version", "client-default",
    "--no-freeform-tools",
    "--shell-type", "shell_command",
    "--reasoning-levels", "low,high,max",
    "--default-reasoning-level", "max",
    "--subscription-search", "standard-tool",
    "--yes",
  );
  assert.equal(normalized.revision, 3);
  const normalizedTarget = (await resolveSpace("default@3", env)).config.targets.glm;
  assert.equal(normalizedTarget.app.thirdPartyTemplate, undefined);
  assert.equal(normalizedTarget.app.toolMode, undefined);
  assert.equal(normalizedTarget.app.multiAgent, undefined);
  assert.equal(normalizedTarget.capabilities.freeformTools, false);
  assert.equal(normalizedTarget.app.shellType, "shell_command");
  assert.deepEqual(normalizedTarget.app.reasoningLevels, ["low", "high", "max"]);
  assert.equal(normalizedTarget.app.defaultReasoningLevel, "max");
  assert.deepEqual(normalizedTarget.subscriptionSearch, { delivery: "standard-tool" });
});

test("universal search live acceptance requires explicit confirmation", async () => {
  await assert.rejects(
    exec(process.execPath, [resolve("scripts/e2e/universal-search-acceptance.mjs")]),
    /makes real GLM, ai\.feei, OpenAI and Tavily requests/,
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const exec = promisify(execFile);
const cli = resolve("scripts/gateway-admin.mjs");

test("CLI reports the public command and package version", async () => {
  const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  assert.equal((await exec(process.execPath, [cli, "--version"])).stdout.trim(), `Codex Local Router ${manifest.version}`);
  assert.match((await exec(process.execPath, [cli, "--help"])).stdout, /^Usage: codex-local-router /);
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
  };
  const setup = JSON.parse((await exec(process.execPath, [cli, "setup", "--yes", "--json", "--port", "58991"], { env: environment })).stdout);
  assert.equal(setup.applied, true);
  assert.equal(setup.integration.pending, true);
  assert.equal(JSON.parse(await readFile(config, "utf8")).schemaVersion, 3);
  assert.doesNotMatch(await readFile(join(home, "config.toml"), "utf8"), /codex-local-router/);
  const synced = JSON.parse((await exec(process.execPath, [cli, "integration", "sync", "--json"], { env: { ...environment, CODEX_APP_RUNNING: "0" } })).stdout);
  assert.equal(synced.pending, false);
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

  const legacy = JSON.parse(await readFile(config, "utf8"));
  legacy.schemaVersion = 2;
  delete legacy.access;
  delete legacy.subscription.models;
  await writeFile(config, JSON.stringify(legacy));
  await rm(join(data, "state", "access-token"), { force: true });
  await exec(process.execPath, [cli, "setup", "--yes", "--json"], { env: environment });
  const migrated = JSON.parse(await readFile(config, "utf8"));
  assert.equal(migrated.access.required, true);
  assert.match(await readFile(migrated.access.tokenFile, "utf8"), /^[a-f0-9]{64}\n$/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { captureWebSocketProxy, classifyMcpToolFailure, collectToolNames, finalizeTransportFailure, hasCompactionEvidence, isolatedChildEnv, isolatedCodexHome, persistCaseVerdict, runCliExec, writeDeterministicCodexInputs } from "../scripts/e2e/lib/harness.mjs";

test("A10 compaction accepts the current item signal and legacy notification", () => {
  const threadId = "thread";
  assert.equal(hasCompactionEvidence([
    { method: "item/completed", threadId, itemType: "contextCompaction" },
  ], threadId), true);
  assert.equal(hasCompactionEvidence([
    { method: "thread/compacted", threadId },
  ], threadId), true);
  assert.equal(hasCompactionEvidence([
    { method: "item/completed", threadId, itemType: "agentMessage" },
  ], threadId), false);
});

test("A10 pre-header transport failures finalize zero response bytes and total time", () => {
  const metadata = { at: 1000, requestBytes: 64 };
  assert.deepEqual(finalizeTransportFailure(metadata, { type: "connect_timeout" }, 1025), {
    at: 1000,
    requestBytes: 64,
    error: "connect_timeout",
    responseBytes: 0,
    responseComplete: false,
    terminationReason: "transport-error-before-headers",
    totalMs: 25,
  });
});

test("A10 CLI harness places one-run search flags before the exec subcommand", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "router-cli-harness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const core = join(root, "codex-fixture");
  await writeFile(core, [
    "#!/usr/bin/env node",
    "console.log(JSON.stringify({ type: 'argv', argv: process.argv.slice(2) }));",
    "",
  ].join("\n"), { mode: 0o700 });
  await chmod(core, 0o700);

  const run = await runCliExec({
    corePath: core,
    home: join(root, "codex-home"),
    cwd: root,
    globalArgs: ["--search"],
    args: ["--ephemeral"],
    prompt: "fixture prompt",
    // Full-suite process scheduling can exceed five seconds on a busy host;
    // this fixture has no network or service dependency, so use the same loose
    // health-line philosophy as the acceptance harness instead of a flaky
    // performance assertion.
    timeoutMs: 20000,
  });
  assert.equal(run.code, 0);
  assert.deepEqual(run.rows[0].argv, [
    "--search",
    "exec",
    "--json",
    "--ephemeral",
    "fixture prompt",
  ]);
});

test("A10 CLI harness exposes structured events before process completion", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "router-cli-events-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const core = join(root, "codex-fixture");
  await writeFile(core, [
    "#!/usr/bin/env node",
    "console.log(JSON.stringify({ type: 'turn.started' }));",
    "setTimeout(() => { console.log(JSON.stringify({ type: 'turn.completed' })); }, 25);",
    "",
  ].join("\n"), { mode: 0o700 });
  await chmod(core, 0o700);
  const observed = [];
  const run = await runCliExec({
    corePath: core,
    home: join(root, "codex-home"),
    cwd: root,
    args: ["--ephemeral"],
    prompt: "fixture prompt",
    timeoutMs: 5000,
    onEvent: (row) => observed.push(row.type),
  });
  assert.equal(run.code, 0);
  assert.deepEqual(observed, ["turn.started", "turn.completed"]);
  assert.deepEqual(run.rows.map((row) => row.type), observed);
});

test("A10 focused image turns terminate variadic image arguments before the prompt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "router-cli-image-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const core = join(root, "codex-fixture");
  await writeFile(core, [
    "#!/usr/bin/env node",
    "console.log(JSON.stringify({ argv: process.argv.slice(2) }));",
    "",
  ].join("\n"), { mode: 0o700 });
  await chmod(core, 0o700);
  const run = await runCliExec({
    corePath: core,
    home: join(root, "codex-home"),
    cwd: root,
    args: ["--ephemeral", "-i", join(root, "synthetic.png"), "--"],
    prompt: "image prompt",
    timeoutMs: 5000,
  });
  assert.equal(run.code, 0);
  assert.deepEqual(run.rows[0].argv, [
    "exec", "--json", "--ephemeral", "-i", join(root, "synthetic.png"), "--", "image prompt",
  ]);
});

test("A10 tool evidence recursively names nested additional_tools without retaining schemas", () => {
  assert.deepEqual(
    collectToolNames({
      type: "namespace",
      name: "functions",
      tools: [
        { type: "function", name: "mcp__codex_apps__github", schema: { secret: "fixture" } },
        { type: "namespace", namespace: "router_acceptance", functions: [{ name: "read_marker" }] },
      ],
    }),
    ["functions", "mcp__codex_apps__github", "router_acceptance", "read_marker"],
  );
});

test("A10 MCP failures are reduced to safe diagnostic categories", () => {
  assert.equal(classifyMcpToolFailure({ message: "max_results must be at least 5" }), "invalid-arguments");
  assert.equal(classifyMcpToolFailure({ message: "unable to verify certificate" }), "tls");
  assert.equal(classifyMcpToolFailure({ message: "private query text" }), "other");
  assert.equal(classifyMcpToolFailure(null), null);
});

test("A10 isolated official-search home can preserve the Codex default search mode", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "router-search-home-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const auth = join(root, "auth-source.json");
  const home = join(root, "codex-home");
  await writeFile(auth, "{}", { mode: 0o600 });
  await isolatedCodexHome({
    home,
    baseUrl: "http://127.0.0.1:32123/subscription/v1",
    catalogPath: join(root, "models.json"),
    authSource: auth,
    model: "gpt-fixture",
    webSearch: null,
    extra: "[features]\nfixture = true\n",
  });
  const config = await readFile(join(home, "config.toml"), "utf8");
  assert.doesNotMatch(config, /^web_search\s*=/m);
  assert.ok(config.indexOf("openai_base_url") < config.indexOf("[features]"));
});

test("A10 isolated custom provider can force Responses HTTP transport", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "router-http-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const auth = join(root, "auth-source.json");
  const home = join(root, "codex-home");
  await writeFile(auth, "{}", { mode: 0o600 });
  await isolatedCodexHome({
    home,
    baseUrl: "http://127.0.0.1:32123/subscription/v1",
    catalogPath: join(root, "models.json"),
    authSource: auth,
    model: "gpt-fixture",
    modelProvider: "gateway_http",
    supportsWebsockets: false,
  });
  const config = await readFile(join(home, "config.toml"), "utf8");
  assert.match(config, /^model_provider = "gateway_http"$/m);
  assert.match(config, /^\[model_providers\.gateway_http\]$/m);
  assert.match(config, /^requires_openai_auth = true$/m);
  assert.match(config, /^supports_websockets = false$/m);
  assert.doesNotMatch(config, /^openai_base_url\s*=/m);
});

test("A10 CLI child isolates HOME together with CODEX_HOME", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "router-home-isolation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const core = join(root, "codex-fixture");
  await writeFile(core, [
    "#!/usr/bin/env node",
    "console.log(JSON.stringify({ home: process.env.HOME, codexHome: process.env.CODEX_HOME }));",
    "",
  ].join("\n"), { mode: 0o700 });
  await chmod(core, 0o700);

  const home = join(root, "codex-home");
  const run = await runCliExec({
    corePath: core,
    home,
    cwd: root,
    args: ["--ephemeral"],
    prompt: "fixture prompt",
    timeoutMs: 5000,
  });
  assert.equal(run.code, 0);
  assert.deepEqual(run.rows[0], { home, codexHome: home });
});

test("A10 isolated auth is a private copy, never a symlink to the source", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "router-auth-isolation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source-auth.json");
  const home = join(root, "codex-home");
  const contents = JSON.stringify({ tokens: { access_token: "fixture-token" } });
  await writeFile(source, contents, { mode: 0o600 });
  await isolatedCodexHome({
    home,
    baseUrl: "http://127.0.0.1:32123/subscription/v1",
    catalogPath: join(root, "models.json"),
    authSource: source,
    model: "gpt-fixture",
  });
  const authPath = join(home, "auth.json");
  assert.equal((await lstat(authPath)).isSymbolicLink(), false);
  assert.equal(await readFile(authPath, "utf8"), contents);
  assert.equal((await stat(authPath)).mode & 0o777, 0o600);
  assert.equal(await readFile(source, "utf8"), contents);
});

test("A10 deterministic Codex inputs are self-contained private fixtures", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "router-deterministic-inputs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputs = await writeDeterministicCodexInputs(root);
  const auth = JSON.parse(await readFile(inputs.authPath, "utf8"));
  const catalog = JSON.parse(await readFile(inputs.catalogPath, "utf8"));
  assert.equal(auth.tokens.access_token.split(".").length, 3);
  assert.equal(auth.tokens.id_token.split(".").length, 3);
  assert.equal(auth.tokens.refresh_token, "deterministic-refresh-token");
  assert.equal(auth.tokens.account_id, "deterministic-subscription-account");
  assert.deepEqual(catalog.models.map((model) => model.slug), ["gpt-5.6-sol"]);
  assert.equal((await stat(inputs.authPath)).mode & 0o777, 0o600);
  assert.equal((await stat(inputs.catalogPath)).mode & 0o777, 0o600);
});

test("A10 child environment strips credentials and forces isolated roots", () => {
  const env = isolatedChildEnv("/tmp/router-isolated", {
    HOME: "/tmp/real-home",
    CODEX_HOME: "/tmp/real-codex",
    FEEI_API_KEY: "fixture-secret",
    OPENAI_API_KEY: "fixture-secret",
    ROUTER_TEST_FEEI_KEY: "fixture-secret",
    LOCAL_PROXY_KEY: "fixture-secret",
    SSH_AUTH_SOCK: "/tmp/fixture-agent.sock",
    CODEX_APP_TOOLS_PIPE_PATH: "/tmp/fixture-tools.sock",
    NODE_EXTRA_CA_CERTS: "/tmp/fixture-ca.pem",
    XDG_STATE_HOME: "/tmp/real-xdg-state",
    XDG_RUNTIME_DIR: "/tmp/real-xdg-runtime",
    CODEX_LOCAL_ROUTER_HOME: "/tmp/real-router",
    CODEX_LOCAL_ROUTER_CONFIG: "/tmp/real-router/config.json",
    GATEWAY_STATE_PATH: "/tmp/real-router/gateway.json",
    GATEWAY_INSTANCE_ID: "real-instance",
    HTTP_PROXY: "http://127.0.0.1:65535",
    https_proxy: "http://127.0.0.1:65535",
    NO_PROXY: "fixture.invalid",
    SAFE_FIXTURE_VALUE: "kept",
    TERM_PROGRAM: "pi-agent-board",
    TERM_PROGRAM_VERSION: "1.0",
    LC_TERMINAL: "fixture-terminal",
    PI_SESSION_ID: "fixture-session",
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "fixture-originator",
  });
  for (const name of ["TERM_PROGRAM", "TERM_PROGRAM_VERSION", "LC_TERMINAL", "PI_SESSION_ID", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"])
    assert.equal(name in env, false, name);
  assert.equal(env.HOME, "/tmp/router-isolated");
  assert.equal(env.CODEX_HOME, "/tmp/router-isolated");
  assert.equal(env.SAFE_FIXTURE_VALUE, "kept");
  assert.equal("FEEI_API_KEY" in env, false);
  assert.equal("OPENAI_API_KEY" in env, false);
  assert.equal("ROUTER_TEST_FEEI_KEY" in env, false);
  assert.equal("LOCAL_PROXY_KEY" in env, false);
  assert.equal("SSH_AUTH_SOCK" in env, false);
  assert.equal("CODEX_APP_TOOLS_PIPE_PATH" in env, false);
  assert.equal("NODE_EXTRA_CA_CERTS" in env, false);
  assert.equal("HTTP_PROXY" in env, false);
  assert.equal("https_proxy" in env, false);
  assert.equal("NO_PROXY" in env, false);
  assert.equal(env.XDG_CONFIG_HOME, "/tmp/router-isolated/xdg-config");
  assert.equal(env.XDG_STATE_HOME, "/tmp/router-isolated/xdg-state");
  assert.equal(env.XDG_RUNTIME_DIR, "/tmp/router-isolated/xdg-runtime");
  assert.equal(env.CODEX_LOCAL_ROUTER_HOME, "/tmp/router-isolated/router-home");
  assert.equal(env.CODEX_LOCAL_ROUTER_CONFIG, "/tmp/router-isolated/router-home/config.json");
  assert.equal(env.GATEWAY_STATE_PATH, "/tmp/router-isolated/router-home/state/gateway.json");
  assert.match(env.GATEWAY_INSTANCE_ID, /^acceptance-[a-f0-9]{16}$/);
});

test("A10 persisted observation follows the evaluated case verdict", () => {
  const observation = { result: "PASS", terminal: [{ type: "error" }] };
  const persisted = persistCaseVerdict(observation, "FAIL");
  assert.equal(persisted.result, "FAIL");
  assert.equal(observation.result, "PASS");
});

test("A10 WebSocket capture proxy forwards messages and records structural frames", async (t) => {
  const upstream = new WebSocketServer({ port: 0 });
  t.after(() => upstream.close());
  await new Promise((resolve) => upstream.once("listening", resolve));
  upstream.on("connection", (socket) => {
    socket.on("message", () => socket.send(JSON.stringify({
      type: "response.completed",
      sequence_number: 7,
      item: { phase: "final_answer" },
    })));
  });
  const proxy = await captureWebSocketProxy({ target: `http://127.0.0.1:${upstream.address().port}` });
  t.after(() => proxy.close());
  const client = new WebSocket(`${proxy.url}/subscription/v1/responses`, {
    headers: { authorization: "Bearer fixture-token" },
  });
  await new Promise((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  const received = new Promise((resolve, reject) => {
    client.once("message", (data) => resolve(JSON.parse(data.toString("utf8"))));
    client.once("error", reject);
  });
  client.send(JSON.stringify({ type: "response.create", model: "fixture" }));
  assert.deepEqual(await received, {
    type: "response.completed",
    sequence_number: 7,
    item: { phase: "final_answer" },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(proxy.frames.map(({ type, sequence_number, phase }) => ({ type, sequence_number, phase })), [
    { type: "response.completed", sequence_number: 7, phase: "final_answer" },
  ]);
  client.close();
});

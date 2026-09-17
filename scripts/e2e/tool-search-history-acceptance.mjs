#!/usr/bin/env node
// Deterministic app-server qualification for cross-provider tool-search history.
// All homes, credentials, history and upstreams are synthetic and loopback-only.
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { TOOL_SEARCH_HISTORY_MARKER } from "../../src/history.mjs";
import { request } from "../../src/transport.mjs";
import {
  isolatedCodexHome,
  resolveCore,
  startAppServer,
  startIsolatedGateway,
  verifyAcceptanceRevision,
  writeCatalog,
  writeDeterministicCodexInputs,
  writeImmutableJson,
} from "./lib/harness.mjs";

const projectRoot = resolve(import.meta.dirname, "..", "..");
const argv = process.argv.slice(2);
const value = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? undefined : argv[index + 1];
};
const output = value("out") ? resolve(value("out")) : null;
const root = await mkdtemp(join(tmpdir(), "codex-router-tool-search-"));
const workspace = join(root, "workspace");
const home = join(root, "codex-home");
const fixtureInputs = await writeDeterministicCodexInputs(join(root, "inputs"));
const secret = {
  query: `QUERY_SECRET_${randomUUID()}`,
  schema: `SCHEMA_SECRET_${randomUUID()}`,
  tool: `PRIVATE_TOOL_${randomUUID()}`,
  callItem: `provider_call_${randomUUID()}`,
  outputItem: `provider_output_${randomUUID()}`,
};
const callId = `tool-search-${randomUUID()}`;
const sourceText = `SOURCE_TURN_${randomUUID()}`;
const officialText = `OFFICIAL_TURN_${randomUUID()}`;

const toolSearchCall = {
  type: "tool_search_call",
  id: secret.callItem,
  call_id: callId,
  arguments: secret.query,
  execution: { opaque: "provider-private-execution" },
  status: "completed",
};
const toolSearchOutput = {
  type: "tool_search_output",
  id: secret.outputItem,
  call_id: callId,
  execution: { opaque: "provider-private-output" },
  status: "completed",
  tools: [{
    type: "function",
    name: secret.tool,
    description: "Synthetic private discovery result",
    parameters: { type: "object", properties: { [secret.schema]: { type: "string" } } },
  }],
};

const message = (text) => ({
  id: `msg_${randomUUID().replaceAll("-", "")}`,
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});
const completedResponse = (model, items) => ({
  id: `resp_${randomUUID().replaceAll("-", "")}`,
  object: "response",
  created_at: Math.floor(Date.now() / 1000),
  model,
  status: "completed",
  output: items,
  usage: { input_tokens: 16, output_tokens: 8, total_tokens: 24 },
});
const jsonResponse = (body) => {
  const bytes = Buffer.from(JSON.stringify(body));
  return {
    status: 200,
    ok: true,
    headers: new Headers({
      "content-type": "application/json",
      "content-length": String(bytes.length),
    }),
    rawHeaders: [
      ["content-type", "application/json"],
      ["content-length", String(bytes.length)],
    ],
    body: Readable.from([bytes]),
  };
};
const sha = (item) => createHash("sha256").update(JSON.stringify(item)).digest("hex");

async function gatewayTurn(gatewayInstance, body) {
  const response = await fetch(`${gatewayInstance.url}/subscription/v1/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${gatewayInstance.subscriptionToken}`,
      "chatgpt-account-id": gatewayInstance.subscriptionAccountId,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok)
    throw Error(`isolated Gateway request failed: ${response.status}:${payload.error?.type ?? "unknown"}`);
  return payload;
}

async function waitForIdle(url, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let health;
  while (Date.now() < deadline) {
    health = await (await fetch(`${url}/healthz`)).json();
    if (health.activeTurns === 0 && health.websocketConnections === 0) return health;
    await new Promise((done) => setTimeout(done, 25));
  }
  return health;
}

async function createFixtureProvider() {
  const observations = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
    observations.push({
      path: new URL(req.url ?? "/", "http://fixture.invalid").pathname,
      model: body.model ?? null,
      inputTypes: (body.input ?? []).map((item) => item?.type ?? item?.role ?? null),
    });
    const response = completedResponse(
      body.model ?? "fixture-history",
      [toolSearchCall, toolSearchOutput, message(sourceText)],
    );
    const bytes = Buffer.from(JSON.stringify(response));
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(bytes.length),
    });
    res.end(bytes);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    observations,
    close: () => new Promise((done) => server.close(done)),
  };
}

function mutateConfig(config, providerUrl, catalogPath) {
  config.subscription = {
    enabled: true,
    catalogPath,
    models: ["gpt-5.6-sol"],
  };
  config.providers = {
    fixture: {
      adapter: "openai-compatible",
      baseUrl: providerUrl,
      apiKeyEnv: "TOOL_SEARCH_FIXTURE_KEY",
      concurrency: 2,
    },
  };
  config.targets = {
    "fixture-history": {
      provider: "fixture",
      model: "fixture-history",
      modelFamily: "openai-gpt",
      wireApi: "responses",
      contextWindow: 32000,
      maxContextWindow: 32000,
      inputModalities: ["text"],
      compression: { mode: "summary" },
      capabilities: {
        responses: true,
        toolCalling: true,
        freeformTools: true,
        streaming: true,
        nativeWebSearch: false,
      },
      app: {
        enabled: true,
        modelId: "fixture-history",
        displayName: "Fixture History",
        capabilityProfile: "standard-tools",
        useResponsesLite: false,
      },
      standaloneSearch: { source: "disabled" },
    },
  };
  config.defaultTarget = "fixture-history";
  config.rules = [];
  config.webSearch = undefined;
}

let provider;
let gateway;
let app;
let result;
let error;
const officialObservations = [];
const startedAt = Date.now();
try {
  const implementation = await verifyAcceptanceRevision(
    projectRoot,
    process.env.ACCEPTANCE_COMMIT,
  );
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  process.env.TOOL_SEARCH_FIXTURE_KEY = "synthetic-loopback-key";
  provider = await createFixtureProvider();
  const configPath = join(root, "gateway.json");
  const config = JSON.parse(await readFile(join(projectRoot, "config", "gateway.example.json"), "utf8"));
  mutateConfig(config, provider.url, fixtureInputs.catalogPath);
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });

  gateway = await startIsolatedGateway({
    configPath,
    authSource: fixtureInputs.authPath,
    tokenFile: join(root, "access-token"),
    archivePath: join(root, "history.sqlite"),
    archiveKey: createHash("sha256").update("tool-search-history-acceptance").digest(),
    toolCodexHome: home,
    sendRequest: async (url, options) => {
      const parsed = new URL(url);
      if (parsed.hostname === "127.0.0.1") return request(url, options);
      if (parsed.hostname !== "chatgpt.com")
        throw Error(`unexpected outbound host: ${parsed.hostname}`);
      const serialized = JSON.stringify(options.body ?? {});
      officialObservations.push({
        path: parsed.pathname,
        model: options.body?.model ?? null,
        inputTypes: (options.body?.input ?? []).map((item) => item?.type ?? item?.role ?? null),
        markerCount: (serialized.match(new RegExp(
          TOOL_SEARCH_HISTORY_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          "g",
        )) ?? []).length,
        containsSecret: Object.values(secret).some((item) => serialized.includes(item)),
        containsToolSearchItem: (options.body?.input ?? []).some((item) =>
          ["tool_search_call", "tool_search_output"].includes(item?.type)),
      });
      return jsonResponse(completedResponse("gpt-5.6-sol", [message(officialText)]));
    },
    officialRequest: async () => {
      throw Error("official opaque relay was not expected during migrated history replay");
    },
  });
  if (new URL(gateway.url).port === "8788") throw Error("isolated Gateway selected forbidden port 8788");

  const catalogPath = join(home, "models.json");
  await isolatedCodexHome({
    home,
    baseUrl: `${gateway.url}/subscription/v1`,
    catalogPath,
    authSource: fixtureInputs.authPath,
    model: "fixture-history",
    reasoningEffort: "low",
    webSearch: "disabled",
    extra: "[features]\nresponses_websockets = false\nresponses_websockets_v2 = false\n",
  });
  await writeCatalog({
    sourceCatalogPath: fixtureInputs.catalogPath,
    config: gateway.config,
    targetPath: catalogPath,
  });

  const core = await resolveCore();
  app = startAppServer({ corePath: core.path, home, cwd: workspace });
  await app.initialize("codex_local_router_tool_search_history");
  const started = await app.rpc("thread/start", {
    model: "fixture-history",
    modelProvider: "openai",
    cwd: workspace,
    // Persist only inside the disposable CODEX_HOME so the second turn follows
    // the same retained-history path as an older App task.
    ephemeral: false,
    sandbox: "read-only",
    approvalPolicy: "never",
  });
  const threadId = started.thread.id;
  const sourceTurn = await app.request(
    threadId,
    "fixture-history",
    "Return the synthetic source response without invoking tools.",
    { timeoutMs: 90000 },
  );
  if (sourceTurn.status !== "completed" || !sourceTurn.text.includes(sourceText))
    throw Error("source app-server turn did not complete with the fixture response");
  const officialTurn = await app.request(
    threadId,
    "gpt-5.6-sol",
    "Continue this task on the official fixture model.",
    { timeoutMs: 90000 },
  );
  if (officialTurn.status !== "completed" || !officialTurn.text.includes(officialText))
    throw Error("official app-server turn did not complete after migration");

  // Current app-server canonicalizes a newly observed tool-search response out
  // of its own retained message history. Reproduce the affected older-session
  // path separately through the real Gateway HTTP/identity/archive boundary:
  // a retained response ID restores the Gateway's untouched original history.
  const retainedThread = `retained-${randomUUID()}`;
  const metadata = (turnId) => ({
    "x-codex-turn-metadata": JSON.stringify({
      thread_id: retainedThread,
      turn_id: turnId,
    }),
  });
  const retainedSource = await gatewayTurn(gateway, {
    model: "fixture-history",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "synthetic retained source" }] }],
    client_metadata: metadata(`turn-${randomUUID()}`),
    stream: false,
  });
  await gatewayTurn(gateway, {
    model: "gpt-5.6-sol",
    previous_response_id: retainedSource.id,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "synthetic retained migration" }] }],
    client_metadata: metadata(`turn-${randomUUID()}`),
    stream: false,
  });

  const canonicalized = gateway.logs.filter((event) =>
    event.event === "tool_search_history_canonicalized");
  const official = officialObservations.at(-1);
  if (!official || official.markerCount !== 1 || official.containsSecret || official.containsToolSearchItem)
    throw Error(
      "official destination did not receive exactly one safe history marker " +
      JSON.stringify({
        observations: officialObservations.length,
        markerCount: official?.markerCount ?? null,
        containsSecret: official?.containsSecret ?? null,
        containsToolSearchItem: official?.containsToolSearchItem ?? null,
        inputTypes: official?.inputTypes ?? [],
        canonicalized: canonicalized.map((event) => event.pairs),
        gatewayEvents: gateway.logs.map((event) => event.event),
      }),
    );
  if (canonicalized.length !== 1 || canonicalized[0].pairs !== 1)
    throw Error("Gateway did not record exactly one canonicalized tool-search pair");

  const archived = gateway.archive.history({
    owner: "chatgpt:deterministic-subscription-account",
    thread: retainedThread,
    branch: retainedThread,
  });
  if (!archived) throw Error("isolated archive did not contain the retained fixture thread");
  const archivedCall = archived.original.find((item) => item.type === "tool_search_call");
  const archivedOutput = archived.original.find((item) => item.type === "tool_search_output");
  if (sha(archivedCall) !== sha(toolSearchCall) || sha(archivedOutput) !== sha(toolSearchOutput))
    throw Error("original archived tool-search pair changed during migration");
  if (archived.view.some((item) => ["tool_search_call", "tool_search_output"].includes(item.type)))
    throw Error("destination archive view retained provider-specific tool-search items");
  const archivedMarkerCount = archived.view.filter((item) =>
    item.type === "message" && item.content?.some((part) => part.text === TOOL_SEARCH_HISTORY_MARKER)
  ).length;
  if (archivedMarkerCount !== 1) throw Error("destination archive view lacks one safe marker");
  await app.close();
  app = null;
  const health = await waitForIdle(gateway.url);
  if (health.activeTurns !== 0 || health.websocketConnections !== 0)
    throw Error(`isolated Gateway did not drain after qualification ${JSON.stringify({
      activeTurns: health.activeTurns,
      websocketConnections: health.websocketConnections,
    })}`);

  result = {
    schemaVersion: 1,
    verdict: "PASS",
    implementation,
    core: {
      source: core.source,
      version: core.version,
      sha256: core.sha256,
    },
    isolation: {
      temporaryHome: true,
      syntheticAuth: true,
      syntheticProviderCredential: true,
      loopbackProvider: true,
      externalNetworkRequests: 0,
      forbiddenPort8788: false,
    },
    appServer: {
      sourceTurn: sourceTurn.status,
      officialTurn: officialTurn.status,
      threadHash: sha(threadId),
      newSessionPairForwardedByAppServer: officialObservations[0]?.containsToolSearchItem ?? false,
    },
    migration: {
      canonicalizedPairs: canonicalized[0].pairs,
      destinationMarkerCount: official.markerCount,
      destinationToolSearchItems: official.containsToolSearchItem ? 1 : 0,
      destinationContainsSensitiveFixture: official.containsSecret,
      archivedOriginalCallHashPreserved: sha(archivedCall) === sha(toolSearchCall),
      archivedOriginalOutputHashPreserved: sha(archivedOutput) === sha(toolSearchOutput),
      archivedViewMarkerCount: archivedMarkerCount,
    },
    lifecycle: {
      activeTurns: health.activeTurns,
      websocketConnections: health.websocketConnections,
    },
    durationMs: Date.now() - startedAt,
  };
  process.stdout.write(`${JSON.stringify({ event: "tool_search_history_acceptance", verdict: "PASS" })}\n`);
} catch (caught) {
  error = caught;
  result = {
    schemaVersion: 1,
    verdict: "FAIL",
    error: caught?.code ?? caught?.type ?? caught?.message ?? "unknown",
    durationMs: Date.now() - startedAt,
  };
  process.stderr.write(`${JSON.stringify({ event: "tool_search_history_acceptance", verdict: "FAIL", error: result.error })}\n`);
} finally {
  await app?.close().catch(() => {});
  await gateway?.close().catch(() => {});
  await provider?.close().catch(() => {});
  delete process.env.TOOL_SEARCH_FIXTURE_KEY;
  if (output) await writeImmutableJson(output, result);
  await rm(root, { recursive: true, force: true });
}
if (error) throw error;

// E2E harness：隔离 Gateway、真实渠道驱动（A=exec / B=app-server）、健康与事件循环采样。
// 只记录结构化元数据（host、头名称、事件类型、耗时），从不记录正文或凭证值。
import { spawn, execFile } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import * as zlib from "node:zlib";
import { WebSocket, WebSocketServer } from "ws";
import { loadConfig, validate } from "../../../src/config.mjs";
import { createGateway } from "../../../src/server.mjs";
import { request, requestRaw } from "../../../src/transport.mjs";
import { credential } from "../../../src/providers.mjs";
import { Archive } from "../../../src/archive.mjs";
import { identityHash } from "./criteria.mjs";
import { createLocalIdentityResolver } from "../../../src/local-identity.mjs";
import { buildModelCatalog } from "../../../src/model-catalog.mjs";
import { discoverToolSources } from "../../../src/tool-sources.mjs";
import { isSubstantiveResponseEvent } from "../../../src/response-stream.mjs";

const exec = promisify(execFile);
export const APP_CORE = "/Applications/ChatGPT.app/Contents/Resources/codex";

export function finalizeTransportFailure(metadata, error, observedAt = Date.now()) {
  metadata.error = error?.type ?? "transport_error";
  metadata.responseBytes ??= 0;
  metadata.responseComplete = false;
  metadata.terminationReason = "transport-error-before-headers";
  metadata.totalMs = observedAt - metadata.at;
  return metadata;
}

// E2E Codex children talk only to the isolated loopback Gateway. They must not
// inherit credentials or proxy routing from the operator's shell; the Gateway
// process itself keeps its own environment for explicitly-authorized upstream
// live canaries.
const SENSITIVE_ENV_NAMES = new Set([
  "OPENAI_API_KEY",
  "FEEI_API_KEY",
  "OPENCODE_GO_API_KEY",
  "TAVILY_API_KEY",
  "EXA_API_KEY",
  "ROUTER_SEARCH_TEST_KEY",
  "ROUTER_TEST_FEEI_KEY",
  "TEST_PROVIDER_KEY",
  "TEST_VENDOR_KEY",
  "ROUTER_SHAPE_KEY",
  "CODEX_AUTH_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "LOCAL_PROXY_KEY",
  "SSH_AUTH_SOCK",
  "CODEX_APP_TOOLS_PIPE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
]);

// App-server may carry tools inside a namespace/additional_tools envelope.
// Record only names and recursively inspect the envelope; never retain the
// user-provided schemas or descriptions in public evidence.
export function collectToolNames(tool) {
  if (!tool || typeof tool !== "object") return [];
  const names = [];
  if (typeof tool.name === "string" && tool.name) names.push(tool.name);
  if (typeof tool.namespace === "string" && tool.namespace) names.push(tool.namespace);
  for (const key of ["tools", "functions"]) {
    if (Array.isArray(tool[key])) {
      for (const nested of tool[key]) names.push(...collectToolNames(nested));
    }
  }
  return names;
}

export function classifyMcpToolFailure(error) {
  const message = String(error?.message ?? "").toLowerCase();
  if (!message) return null;
  if (/certificate|self signed|unable to verify/.test(message)) return "tls";
  if (/invalid api key|unauthorized|\b401\b/.test(message)) return "auth";
  if (/rate limit|usage limit|quota|\b429\b/.test(message)) return "rate-limit";
  if (/invalid (?:argument|params)|validation|required|too small|at least/.test(message))
    return "invalid-arguments";
  if (/approval|denied/.test(message)) return "approval";
  if (/timeout|timed out/.test(message)) return "timeout";
  if (/network|fetch failed|connect|socket|econn/.test(message)) return "network";
  return "other";
}

export function isolatedChildEnv(home, overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const name of Object.keys(env)) {
    if (
      SENSITIVE_ENV_NAMES.has(name) ||
      /^(?:HTTP|HTTPS|ALL|NO)_PROXY$/i.test(name) ||
      /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PRIVATE_KEY|SECRET|PASSWORD)$/.test(name)
    ) delete env[name];
  }
  // HOME/CODEX_HOME are always authoritative for the run.  Caller overrides
  // may add harmless fixture values, but can never redirect the child back to
  // a user's real Codex directory.
  return {
    ...env,
    HOME: home,
    CODEX_HOME: home,
    XDG_CONFIG_HOME: `${home}/xdg-config`,
    XDG_CACHE_HOME: `${home}/xdg-cache`,
    XDG_DATA_HOME: `${home}/xdg-data`,
    XDG_STATE_HOME: `${home}/xdg-state`,
    XDG_RUNTIME_DIR: `${home}/xdg-runtime`,
    CODEX_LOCAL_ROUTER_HOME: `${home}/router-home`,
    CODEX_LOCAL_ROUTER_CONFIG: `${home}/router-home/config.json`,
    GATEWAY_STATE_PATH: `${home}/router-home/state/gateway.json`,
    GATEWAY_INSTANCE_ID: `acceptance-${createHash("sha256").update(home).digest("hex").slice(0, 16)}`,
  };
}

export function extractSearchResultCandidates(raw, encoding = "identity") {
  let decoded = Buffer.from(raw);
  try {
    if (encoding === "gzip") decoded = zlib.gunzipSync(decoded);
    else if (encoding === "br") decoded = zlib.brotliDecompressSync(decoded);
    else if (encoding === "zstd" && zlib.zstdDecompressSync)
      decoded = zlib.zstdDecompressSync(decoded);
  } catch {
    return [];
  }
  const text = decoded.toString("utf8").replaceAll("\\/", "/");
  return [...new Set(text.match(/https?:\/\/[^\s"'<>\\]{12,1024}/g) ?? [])]
    .slice(0, 32);
}

export function searchResultFingerprint(candidate) {
  return createHash("sha256").update(candidate).digest("hex");
}

export async function createEvidenceDirectory(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await mkdir(path, { recursive: false, mode: 0o700 });
  return path;
}

export async function writeImmutableJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const body = text.endsWith("\n") ? text : `${text}\n`;
  await writeFile(path, body, {
    flag: "wx",
    mode: 0o600,
  });
  return path;
}

// Decode only the harness observation copy. The proxy still forwards the
// original response bytes and headers unchanged, including compression.
export function decodeSseFrames(raw, encoding = "identity") {
  let decoded = Buffer.from(raw);
  try {
    if (encoding === "gzip") decoded = zlib.gunzipSync(decoded);
    else if (encoding === "deflate") decoded = zlib.inflateSync(decoded);
    else if (encoding === "br") decoded = zlib.brotliDecompressSync(decoded);
    else if (encoding === "zstd" && zlib.zstdDecompressSync)
      decoded = zlib.zstdDecompressSync(decoded);
  } catch {
    return [];
  }
  const frames = [];
  const text = decoded.toString("utf8");
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      const event = JSON.parse(data);
      frames.push({
        type: event.type,
        sequence_number: event.sequence_number,
        itemType: event.item?.type,
        inputTokens: event.response?.usage?.input_tokens ?? event.usage?.input_tokens,
        outputTokens: event.response?.usage?.output_tokens ?? event.usage?.output_tokens,
        phase: event.item?.phase,
        itemId: event.item?.id,
      });
    } catch {
      // Ignore comments and non-JSON SSE records; the transport is still
      // forwarded and the acceptance assertion will fail closed if no frames
      // can be observed.
    }
  }
  return frames;
}

export function assertAcceptanceRevision({ expected, actual, tree, status = "" }) {
  if (!expected) return { commit: "working-tree", tree: null };
  if (!/^[a-f0-9]{40}$/.test(expected) || expected !== actual)
    throw Object.assign(Error("acceptance commit does not match HEAD"), {
      code: "acceptance_revision_mismatch",
    });
  if (status.trim())
    throw Object.assign(Error("acceptance worktree is not clean"), {
      code: "acceptance_worktree_dirty",
    });
  if (!/^[a-f0-9]{40}$/.test(tree ?? ""))
    throw Object.assign(Error("acceptance tree could not be resolved"), {
      code: "acceptance_tree_unresolved",
    });
  return { commit: actual, tree };
}

// Persisted case observations must carry the same verdict as the case record;
// the probe shape may default to PASS before assertions are evaluated.
export function persistCaseVerdict(observation, finalVerdict) {
  return { ...observation, result: finalVerdict };
}

export function hasCompactionEvidence(notifications, threadId, after = 0) {
  return notifications.slice(after).some((entry) =>
    entry.threadId === threadId &&
    (entry.method === "thread/compacted" ||
      (entry.method === "item/completed" &&
        String(entry.itemType ?? "").replaceAll("_", "").toLowerCase() ===
          "contextcompaction")),
  );
}

export async function verifyAcceptanceRevision(projectRoot, expected) {
  if (!expected) return { commit: "working-tree", tree: null };
  const [{ stdout: head }, { stdout: tree }, { stdout: status }] = await Promise.all([
    exec("git", ["rev-parse", "HEAD"], { cwd: projectRoot, timeout: 20000 }),
    exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: projectRoot, timeout: 20000 }),
    exec("git", ["status", "--porcelain"], { cwd: projectRoot, timeout: 20000 }),
  ]);
  return assertAcceptanceRevision({
    expected,
    actual: head.trim(),
    tree: tree.trim(),
    status,
  });
}

export async function resolveCore() {
  const candidates = [
    { path: APP_CORE, source: "app-bundle" },
    { path: "codex", source: "path" },
  ];
  for (const candidate of candidates) {
    try {
      const { stdout } = await exec(candidate.path, ["--version"], { timeout: 20000 });
      const version = stdout.trim();
      let sha256 = null;
      if (candidate.source === "app-bundle") {
        sha256 = createHash("sha256").update(await readFile(candidate.path)).digest("hex");
      }
      return { path: candidate.path, source: candidate.source, version, sha256 };
    } catch {
      continue;
    }
  }
  throw Error("no usable codex core binary found");
}

export async function isolatedCodexHome({
  home,
  baseUrl,
  catalogPath,
  authSource,
  model,
  modelProvider = "openai",
  supportsWebsockets,
  reasoningEffort = "low",
  webSearch = "disabled",
  extra = "",
}) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  await rm(`${home}/auth.json`, { force: true });
  // Copy the fixture instead of symlinking the real auth file.  Some Codex
  // versions refresh auth metadata during startup; a symlink would let an E2E
  // child write into the user's active login.
  const authBytes = await readFile(authSource);
  await writeFile(`${home}/auth.json`, authBytes, { mode: 0o600 });
  const openaiBaseUrl = modelProvider === "openai"
    ? `openai_base_url = "${baseUrl}"\n`
    : "";
  const customProvider = modelProvider === "openai"
    ? ""
    : `\n[model_providers.${modelProvider}]\nname = "Isolated Gateway"\nbase_url = "${baseUrl}"\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = ${supportsWebsockets === true}\n`;
  const toml =
    `model_provider = "${modelProvider}"\nmodel = "${model}"\nmodel_reasoning_effort = "${reasoningEffort}"\n` +
    `${webSearch == null ? "" : `web_search = "${webSearch}"\n`}` +
    `${openaiBaseUrl}model_catalog_json = "${catalogPath}"\n${extra}${customProvider}`;
  await writeFile(`${home}/config.toml`, toml, { mode: 0o600 });
  return home;
}

export async function writeDeterministicCodexInputs(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const authPath = `${root}/auth.json`;
  const catalogPath = `${root}/models.json`;
  const jwt = (payload) => [
    Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "deterministic-fixture" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "deterministic-signature",
  ].join(".");
  const account = "deterministic-subscription-account";
  const authClaims = {
    chatgpt_account_id: account,
    chatgpt_plan_type: "plus",
    chatgpt_user_id: "deterministic-user",
    user_id: "deterministic-user",
    localhost: true,
  };
  const auth = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt({
        iss: "https://auth.openai.com/",
        aud: ["deterministic-codex-client"],
        sub: "deterministic-user",
        email: "deterministic@example.invalid",
        email_verified: true,
        iat: 1700000000,
        exp: 4102444800,
        "https://api.openai.com/auth": authClaims,
      }),
      access_token: jwt({
        iss: "https://auth.openai.com/",
        aud: ["https://api.openai.com/v1"],
        client_id: "deterministic-codex-client",
        sub: "deterministic-user",
        iat: 1700000000,
        nbf: 1700000000,
        exp: 4102444800,
        scp: ["openid", "profile", "email", "offline_access"],
        "https://api.openai.com/auth": authClaims,
        "https://api.openai.com/profile": {
          email: "deterministic@example.invalid",
          email_verified: true,
          name: "Deterministic Fixture",
        },
      }),
      refresh_token: "deterministic-refresh-token",
      account_id: account,
    },
    last_refresh: new Date().toISOString(),
  };
  const catalog = {
    models: [{
      slug: "gpt-5.6-sol",
      display_name: "Deterministic Official GPT",
      description: "Local qualification fixture",
      default_reasoning_level: "low",
      supported_reasoning_levels: [{ effort: "low", description: "low reasoning effort" }],
      shell_type: "unified_exec",
      visibility: "list",
      supported_in_api: true,
      priority: 100,
      additional_speed_tiers: [],
      service_tiers: [],
      availability_nux: null,
      upgrade: null,
      base_instructions: "",
      model_messages: null,
      supports_reasoning_summaries: true,
      default_reasoning_summary: "auto",
      support_verbosity: false,
      default_verbosity: null,
      apply_patch_tool_type: "freeform",
      web_search_tool_type: "text",
      truncation_policy: { mode: "tokens", limit: 10000 },
      supports_parallel_tool_calls: true,
      supports_image_detail_original: true,
      context_window: 272000,
      max_context_window: 272000,
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
      input_modalities: ["text", "image"],
      supports_search_tool: true,
      use_responses_lite: false,
    }],
  };
  await writeFile(authPath, `${JSON.stringify(auth)}\n`, { mode: 0o600 });
  await writeFile(catalogPath, `${JSON.stringify(catalog)}\n`, { mode: 0o600 });
  return { authPath, catalogPath };
}

export async function writeCatalog({ sourceCatalogPath, config, targetPath }) {
  const source = JSON.parse(await readFile(sourceCatalogPath, "utf8"));
  const catalog = buildModelCatalog(source, config);
  await writeFile(targetPath, JSON.stringify(catalog), { mode: 0o600 });
  return catalog;
}

// 隔离 Gateway：随机端口、独立历史库、独立访问令牌；记录出站契约与阶段耗时。
export async function startIsolatedGateway({
  configPath,
  authSource,
  tokenFile,
  archivePath,
  archiveKey,
  seed = 0,
  mutate,
  toolCodexHome,
  markerObservations = [],
  beforeOutbound,
  promptCacheSecret,
  sendRequest = request,
  officialRequest = requestRaw,
  providerSearchRequest = requestRaw,
  createOfficialWebSocket = (url, options) => new WebSocket(url, options),
}) {
  const base = structuredClone(await loadConfig(configPath));
  base.listen = { host: "127.0.0.1", port: 0 };
  base.history = { ...(base.history ?? {}), persistent: { enabled: false } };
  base.access = { required: true, tokenFile };
  mutate?.(base);
  const config = validate(base);
  const accessToken = createHash("sha256").update(`e2e-token-${seed}`).digest("hex");
  await writeFile(tokenFile, accessToken, { mode: 0o600 });
  const subscriptionToken = JSON.parse(await readFile(authSource, "utf8")).tokens.access_token;
  const providerTokens = new Set();
  for (const provider of Object.values(config.providers ?? {})) {
    const key = await credential(provider).catch(() => null);
    if (key) providerTokens.add(`Bearer ${key}`);
  }
  const toolRegistry = await discoverToolSources(
    toolCodexHome ? { codexHome: toolCodexHome } : undefined,
  );

  const logs = [];
  const outbound = [];
  const payloads = [];
  const searchEvidence = [];
  const websocketEvents = [];
  const searchMarkers = new Map();
  const archive = new Archive(archivePath, archiveKey);
  // 历史写入观测：只记录结构化元数据（是否新插、版本号、responseId 哈希）。
  const historyWrites = [];
  const saveResponse = archive.saveResponse.bind(archive);
  archive.saveResponse = (key, value, history) => {
    const saved = saveResponse(key, value, history);
    historyWrites.push({
      at: Date.now(),
      inserted: saved?.inserted === true,
      version: saved?.version ?? null,
      responseIdHash: history?.responseId ? identityHash(history.responseId) : null,
    });
    return saved;
  };
  const recordOutbound = (url, options) => {
    const startedAt = Date.now();
    const parsedUrl = new URL(url);
    const host = parsedUrl.host;
    const headers = options.headers ?? {};
    const authorization = headers.authorization ?? "";
    let body = options.body;
    if (Buffer.isBuffer(body) && !headers["content-encoding"])
      try { body = JSON.parse(body.toString("utf8")); } catch { body = null; }
    const input = Array.isArray(body?.input) ? body.input : [];
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const threadId = options.context?.thread ?? headers["thread-id"] ?? headers["x-thread-id"] ?? null;
    const turnId = options.context?.turn ?? headers["turn-id"] ?? headers["x-turn-id"] ?? null;
    const requestBytes = Buffer.isBuffer(options.body)
      ? options.body
      : Buffer.from(JSON.stringify(options.body ?? ""));
    const requestText = requestBytes.toString("utf8");
    const markerCounts = Object.fromEntries(markerObservations
      .filter((marker) => marker && typeof marker.value === "string")
      .map((marker) => {
        const encoded = JSON.stringify(marker.value).slice(1, -1);
        return [marker.label, requestText.split(encoded).length - 1];
      }));
    const markerMatches = Object.entries(markerCounts)
      .filter(([, count]) => count > 0)
      .map(([label]) => label);
    const toolResultItems = [
      ...input,
      ...messages.filter((item) => item?.role === "tool"),
    ];
    const toolCallNames = [
      ...input
        .filter((item) => ["function_call", "custom_tool_call"].includes(item?.type))
        .map((item) => item.name ?? item.function?.name ?? item.type),
      ...messages.flatMap((item) => (item.tool_calls ?? []).map((call) =>
        call.function?.name ?? call.name ?? "tool_call",
      )),
    ];
    const toolResultMarkers = markerObservations
      .filter((marker) => marker && typeof marker.value === "string")
      .filter((marker) => toolResultItems.some((item) =>
        (["function_call_output", "custom_tool_call_output"].includes(item?.type) || item?.role === "tool") &&
        JSON.stringify(item).includes(marker.value),
      ))
      .map((marker) => marker.label);
    const toolResultShapes = toolResultItems.map((item) => ({
      type: item?.type ?? null,
      role: item?.role ?? null,
      keys: item && typeof item === "object" ? Object.keys(item).sort() : [],
      outputType: item?.output == null ? null : Array.isArray(item.output) ? "array" : typeof item.output,
      outputBytes: item?.output == null ? 0 : Buffer.byteLength(JSON.stringify(item.output)),
      contentType: item?.content == null ? null : Array.isArray(item.content) ? "array" : typeof item.content,
      contentBytes: item?.content == null ? 0 : Buffer.byteLength(JSON.stringify(item.content)),
    }));
    const metadata = {
      at: startedAt,
      host,
      official: host === "chatgpt.com",
      bodyShape: body && typeof body === "object" && !Buffer.isBuffer(body)
        ? Object.fromEntries(Object.entries(body).map(([key, item]) => [
            key,
            Array.isArray(item) ? "array" : item === null ? "null" : typeof item,
          ]))
        : null,
      headerNames: Object.keys(headers).sort(),
      subscriptionBearer: Boolean(subscriptionToken) && authorization === `Bearer ${subscriptionToken}`,
      providerCredential: providerTokens.has(authorization),
      accountHeader: Boolean(headers["chatgpt-account-id"]),
      opencodeSession: Boolean(headers["x-opencode-session"]),
      path: parsedUrl.pathname,
      transport: options.transport ?? "http",
      model: body?.model ?? null,
      reasoningEffort: body?.reasoning?.effort ?? null,
      generate: body?.generate ?? null,
      requestBytes: requestBytes.length,
      requestFingerprint: createHash("sha256")
        .update(options.method ?? "POST")
        .update(parsedUrl.pathname)
        .update(requestBytes)
        .digest("hex"),
      previousResponseIdFingerprint:
        typeof body?.previous_response_id === "string"
          ? createHash("sha256").update(body.previous_response_id).digest("hex")
          : null,
      hasGatewayVirtualCheckpoint: requestText.includes("gateway-checkpoint-v1:"),
      promptCacheKeyFingerprint:
        typeof body?.prompt_cache_key === "string"
          ? createHash("sha256").update(body.prompt_cache_key).digest("hex")
          : null,
    };
    if (!metadata.official && metadata.path.endsWith("/responses")) {
      const text = (Buffer.isBuffer(options.body)
        ? options.body.toString("utf8")
        : JSON.stringify(options.body ?? "")).replaceAll("\\/", "/");
      const match = [...searchMarkers.entries()].find(([marker]) => text.includes(marker));
      metadata.searchResultFingerprint = match?.[1] ?? null;
    }
    beforeOutbound?.({
      ...metadata,
      requestFingerprint: metadata.requestFingerprint,
    });
    outbound.push(metadata);
    const additionalToolCarriers = input.filter(
      (item) => item?.type === "additional_tools" && Array.isArray(item.tools),
    );
    const additionalToolDefinitions = additionalToolCarriers.flatMap((item) => item.tools);
    payloads.push({
      host,
      path: parsedUrl.pathname,
      thread: threadId,
      turn: turnId,
      session: headers["x-opencode-session"] ?? headers["session-id"] ?? null,
      model: body?.model,
      reasoningEffort: body?.reasoning?.effort ?? null,
      generate: body?.generate ?? null,
      markerMatches,
      markerCounts,
      toolCallNames: [...new Set(toolCallNames)],
      toolResultMarkers,
      toolResultShapes,
      bytes: Buffer.isBuffer(options.body)
        ? options.body.length
        : Buffer.byteLength(JSON.stringify(options.body ?? "")),
      items: [
        ...input.map((x) => x.type ?? x.role),
        ...messages.map((x) => `${x.role}${x.tool_calls ? "+tool_calls" : ""}`),
      ],
      compactionFingerprints: input
        .filter((item) =>
          item?.type === "compaction" &&
          typeof item.encrypted_content === "string")
        .map((item) =>
          createHash("sha256").update(item.encrypted_content).digest("hex")),
      contentTypes: [
        ...input
          .filter((x) => Array.isArray(x.content))
          .map((x) => (x.content ?? []).map((part) => part?.type)),
        ...messages
          .filter((x) => Array.isArray(x.content))
          .map((x) => (x.content ?? []).map((part) => part?.type)),
      ],
      tools: (body?.tools ?? []).map((x) => x.name ?? x.function?.name ?? x.type),
      additionalToolSurface: {
        carriers: additionalToolCarriers.length,
        definitions: additionalToolDefinitions.length,
        names: [...new Set(additionalToolDefinitions.flatMap(collectToolNames))],
        hasWebRun: additionalToolDefinitions.some((tool) =>
          tool?.type === "namespace" &&
          (tool.name ?? tool.namespace) === "web" &&
          tool.tools?.some((nested) => nested?.name === "run")),
      },
      toolSizes: [...(body?.tools ?? []), ...additionalToolDefinitions].map((x) => ({
        name: x.name ?? x.function?.name ?? x.type,
        type: x.type ?? null,
        bytes: Buffer.byteLength(JSON.stringify(x)),
      })),
      callIds: [
        ...input
          .filter((x) => ["function_call", "function_call_output"].includes(x.type))
          .map((x) => `${x.type}:${x.call_id ?? ""}`),
        ...messages.flatMap((x) => [
          ...(x.role === "tool" ? [`function_call_output:${x.tool_call_id ?? ""}`] : []),
          ...((x.tool_calls ?? []).map((call) => `function_call:${call.id ?? ""}`)),
        ]),
      ],
    });
    return metadata;
  };
  const observeResponseBody = (response, metadata) => {
    let bytes = 0;
    let complete = false;
    const body = response.body;
    response.body = (async function* () {
      try {
        for await (const chunk of body) {
          const value = Buffer.from(chunk);
          bytes += value.length;
          yield value;
        }
        complete = true;
      } finally {
        metadata.responseBytes = bytes;
        metadata.responseComplete = complete;
        metadata.totalMs = Date.now() - metadata.at;
      }
    })();
    return response;
  };
  const observeSearchResponse = (response, metadata) => {
    const chunks = [];
    let bytes = 0;
    let complete = false;
    const body = response.body;
    response.body = (async function* () {
      try {
        for await (const chunk of body) {
          const value = Buffer.from(chunk);
          bytes += value.length;
          if (bytes <= 2 * 1024 * 1024) chunks.push(value);
          yield value;
        }
        complete = true;
      } finally {
        const raw = Buffer.concat(chunks);
        const encoding = response.headers?.get?.("content-encoding")?.toLowerCase();
        const candidates = extractSearchResultCandidates(raw, encoding);
        const hashes = candidates.map(searchResultFingerprint);
        for (const [index, candidate] of candidates.entries())
          searchMarkers.set(candidate, hashes[index]);
        metadata.searchResponseComplete = complete;
        metadata.searchResponseBytes = bytes;
        metadata.responseBytes = bytes;
        metadata.responseComplete = complete;
        metadata.totalMs = Date.now() - metadata.at;
        metadata.searchResultFingerprints = hashes;
        searchEvidence.push({
          host: metadata.host,
          path: metadata.path,
          status: metadata.status ?? null,
          complete,
          bytes,
          responseSha256: createHash("sha256").update(raw).digest("hex"),
          resultFingerprints: hashes,
        });
      }
    })();
    return response;
  };
  const gateway = createGateway(config, {
    archive,
    closeArchive: true,
    resolveIdentity: createLocalIdentityResolver(authSource),
    toolRegistry,
    send: async (url, options) => {
      const metadata = recordOutbound(url, options);
      try {
        const response = await sendRequest(url, options);
        metadata.status = response.status;
        metadata.responseHeadersMs = Date.now() - metadata.at;
        return observeResponseBody(response, metadata);
      } catch (error) {
        finalizeTransportFailure(metadata, error);
        throw error;
      }
    },
    officialRequest: async (url, options) => {
      const metadata = recordOutbound(url, options);
      try {
        const response = await officialRequest(url, options);
        metadata.status = response.status;
        metadata.responseHeadersMs = Date.now() - metadata.at;
        return metadata.path.endsWith("/alpha/search")
          ? observeSearchResponse(response, metadata)
          : observeResponseBody(response, metadata);
      } catch (error) {
        finalizeTransportFailure(metadata, error);
        throw error;
      }
    },
    providerSearchRequest: async (url, options) => {
      const metadata = recordOutbound(url, options);
      try {
        const response = await providerSearchRequest(url, options);
        metadata.status = response.status;
        metadata.responseHeadersMs = Date.now() - metadata.at;
        return observeSearchResponse(response, metadata);
      } catch (error) {
        finalizeTransportFailure(metadata, error);
        throw error;
      }
    },
    createOfficialWebSocket: (url, options) => {
      const socket = createOfficialWebSocket(url, options);
      const send = socket.send.bind(socket);
      const pending = [];
      const finalize = (metadata, complete, terminationReason) => {
        metadata.responseBytes ??= 0;
        metadata.responseComplete = complete;
        metadata.terminationReason = terminationReason;
        metadata.totalMs ??= Date.now() - metadata.at;
      };
      socket.send = (data, sendOptions, callback) => {
        const metadata = recordOutbound(url, {
          headers: options.headers,
          body: Buffer.from(data),
          transport: "websocket",
        });
        metadata.status = 101;
        metadata.responseBytes = 0;
        metadata.responseComplete = false;
        pending.push(metadata);
        return send(data, sendOptions, (error) => {
          if (error) {
            finalize(metadata, false, "send-error");
            const index = pending.indexOf(metadata);
            if (index >= 0) pending.splice(index, 1);
          }
          callback?.(error);
        });
      };
      socket.on("message", (data, isBinary) => {
        const metadata = pending[0];
        if (metadata) {
          const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
          metadata.responseBytes += bytes;
          metadata.responseHeadersMs ??= Date.now() - metadata.at;
        }
        if (isBinary) return;
        try {
          const event = JSON.parse(Buffer.from(data).toString("utf8"));
          if (metadata && typeof event.response?.id === "string")
            metadata.responseIdFingerprint = createHash("sha256")
              .update(event.response.id)
              .digest("hex");
          if (metadata && isSubstantiveResponseEvent(event))
            metadata.firstSubstantiveMs ??= Date.now() - metadata.at;
          if (metadata && event.type === "response.output_text.delta")
            metadata.firstTextMs ??= Date.now() - metadata.at;
          websocketEvents.push({
            at: Date.now(),
            type: event.type,
            sequence_number: event.sequence_number,
            response_status: event.response?.status,
            error_type: event.error?.type,
            error_code: event.error?.code,
          });
          if (metadata && ["response.completed", "response.incomplete", "error"].includes(event.type)) {
            finalize(metadata, true, "terminal-event");
            pending.shift();
          }
        } catch {
          // Observe only structural JSON metadata; forward the original frame.
        }
      });
      socket.on("close", () => {
        for (const metadata of pending)
          finalize(metadata, false, "socket-close");
        pending.length = 0;
      });
      socket.on("error", () => {
        for (const metadata of pending)
          finalize(metadata, false, "socket-error");
        pending.length = 0;
      });
      return socket;
    },
    log: (event) => logs.push(event),
    promptCacheSecret,
  });
  await new Promise((r) => gateway.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${gateway.server.address().port}`;
  return {
    gateway,
    archive,
    config,
    url,
    accessToken,
    subscriptionAccountId: JSON.parse(await readFile(authSource, "utf8")).tokens.account_id,
    logs,
    outbound,
    payloads,
    websocketEvents,
    searchEvidence,
    historyWrites,
    subscriptionToken,
    async close() {
      await gateway.close();
    },
  };
}

// 独立进程健康采样：用 curl 子进程观测，避免被测/驱动进程自身繁忙污染延迟测量。
export function startExternalHealthSampling(url, { intervalMs = 250, timeoutMs = 5000 } = {}) {
  const script = [
    `while :; do`,
    `  curl -s --noproxy '*' --max-time ${Math.max(1, Math.round(timeoutMs / 1000))} -w ' %{time_total} %{http_code}' '${url}/healthz'`,
    `  echo`,
    `  sleep ${(intervalMs / 1000).toFixed(3)}`,
    `done`,
  ].join("\n");
  const child = spawn("/bin/bash", ["-c", script], { stdio: ["ignore", "pipe", "ignore"] });
  const samples = [];
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const match = line.match(/ \s*([0-9.]+) (\d{3})$/);
    if (!match) return;
    let activeTurns = null;
    try {
      activeTurns = JSON.parse(line.slice(0, match.index)).activeTurns ?? null;
    } catch {}
    samples.push({
      at: Date.now(),
      ms: Math.round(Number(match[1]) * 1000),
      ok: match[2] === "200",
      activeTurns,
    });
  });
  return {
    samples,
    stop() {
      child.kill("SIGTERM");
      return samples;
    },
  };
}

// 同进程健康采样（保留作为对照：客户端繁忙时可能虚高）。
export function startHealthSampling(url, intervalMs) {
  const samples = [];
  let stopped = false;
  let timer;
  const tick = async () => {
    const at = Date.now();
    try {
      const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5000) });
      const body = await res.json();
      samples.push({ at, ms: Date.now() - at, ok: body.ok === true, activeTurns: body.activeTurns ?? null });
    } catch (error) {
      samples.push({ at, ms: Date.now() - at, ok: false, error: error?.name ?? "error" });
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);
  return {
    samples,
    stop() {
      stopped = true;
      clearTimeout(timer);
      return samples;
    },
  };
}

export function monitorEventLoop() {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  return {
    stop() {
      histogram.disable();
      const p99 = histogram.percentile(99) / 1e6;
      return Number.isFinite(p99) ? Math.round(p99) : null;
    },
  };
}

// A harness：App 包内 core 的 exec（或 PATH 回退）。返回 JSONL 事件与退出码。
export async function runCliExec({
  corePath,
  home,
  cwd,
  globalArgs = [],
  args,
  env = {},
  timeoutMs = 600000,
  prompt,
  signal,
  onEvent,
}) {
  const child = spawn(corePath, [...globalArgs, "exec", "--json", ...args, prompt], {
    cwd,
    // Codex core may resolve auxiliary caches through $HOME even when
    // CODEX_HOME is overridden. Keep both roots inside this run's temp home.
    env: isolatedChildEnv(home, env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const rows = [];
  child.stdout.on("data", (x) => (stdout += x));
  child.stderr.on("data", (x) => (stderr += x));
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const row = JSON.parse(line);
      rows.push(row);
      onEvent?.(row);
    } catch {
      // Non-JSON diagnostic output remains available in stdout but cannot be
      // used as structured cancellation evidence.
    }
  });
  const abort = () => child.kill();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  const code = await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  signal?.removeEventListener("abort", abort);
  return { code, rows, stdout, stderr };
}

export async function runCliExecResume({
  corePath,
  home,
  cwd,
  globalArgs = [],
  args = [],
  env = {},
  timeoutMs = 600000,
  prompt,
}) {
  const child = spawn(corePath, [...globalArgs, "exec", "resume", "--last", "--json", ...args, prompt], {
    cwd,
    env: isolatedChildEnv(home, env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  const rows = [];
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  createInterface({ input: child.stdout }).on("line", (line) => {
    try { rows.push(JSON.parse(line)); } catch {}
  });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  const code = await new Promise((done) => child.on("close", done));
  clearTimeout(timer);
  return { code, rows, stdout, stderr };
}

// B harness：同一二进制的 app-server --stdio（App 真实客户端协议）。
export function startAppServer({ corePath, home, cwd }) {
  const child = spawn(corePath, ["app-server", "--stdio"], {
    cwd,
    // Match runCliExec isolation: App-server startup can refresh model
    // metadata through $HOME rather than CODEX_HOME.
    env: isolatedChildEnv(home),
    stdio: ["pipe", "pipe", "ignore"],
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  const notifications = [];
  const threads = new Map();
  const pending = new Map();
  let serial = 0;
  let exited = false;
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    notifications.push({
      at: Date.now(),
      method: message.method,
      id: message.id,
      threadId: message.params?.threadId ?? null,
      turnId: message.params?.turnId ?? message.params?.turn?.id ?? null,
      itemType: message.params?.item?.type,
      turnStatus: message.params?.turn?.status ?? null,
    });
    if (message.id != null && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      message.error ? entry.reject(Error(`rpc ${JSON.stringify(message.error)}`)) : entry.resolve(message.result);
      return;
    }
    const record = threads.get(message.params?.threadId);
    if (!record) return;
    if (message.method?.startsWith("item/")) {
      const itemType = message.params?.item?.type ?? message.params?.itemType;
      if (itemType) record.itemTypes.add(itemType);
      record.itemMethods.add(message.method);
    }
    if (message.method === "item/agentMessage/delta") {
      record.text += message.params.delta;
      record.receivedAgentDelta = true;
      record.firstTextAt ??= Date.now();
      if (message.params.delta)
        record.textDeltas.push({ at: Date.now(), bytes: Buffer.byteLength(message.params.delta) });
    }
    if (message.method === "item/completed") {
      const item = message.params.item ?? {};
      if (
        !record.receivedAgentDelta &&
        ["agentMessage", "agent_message"].includes(item.type) &&
        typeof item.text === "string"
      ) {
        record.text += item.text;
        record.firstTextAt ??= Date.now();
      }
      const normalizedType = String(item.type ?? "").replaceAll("_", "");
      if (["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch"].includes(item.type) ||
        ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch"].includes(normalizedType)) {
        record.items.push({
          type: item.type,
          id: item.id,
          status: item.status ?? "completed",
          tool: item.tool ?? item.name ?? item.server ?? item.serverLabel ?? null,
          errorCategory: classifyMcpToolFailure(item.error),
          resultCount: Array.isArray(item.results) ? item.results.length : null,
          at: Date.now(),
        });
      }
      if (item.type === "contextCompaction") record.compactions++;
    }
    if (message.method === "turn/completed") record.finish(message.params.turn);
  });
  child.on("exit", () => {
    exited = true;
    for (const entry of pending.values()) entry.reject(Error("app-server exited"));
    for (const record of threads.values()) record.finish({ status: "backend_exited" });
  });
  const rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (exited) return reject(Error("app-server not running"));
      const id = ++serial;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  const request = (threadId, model, text, { timeoutMs = 600000 } = {}) => {
    const record = {
      threadId,
      model,
      text: "",
      items: [],
      itemTypes: new Set(),
      itemMethods: new Set(),
      compactions: 0,
      startedAt: Date.now(),
      firstTextAt: null,
      receivedAgentDelta: false,
      textDeltas: [],
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`turn timeout for ${threadId}`)), timeoutMs);
      record.finish = (turn) => {
        clearTimeout(timer);
        threads.delete(threadId);
        const failure = turn?.error && typeof turn.error === "object"
          ? Object.fromEntries(
              ["type", "code", "status", "kind"].filter((key) => turn.error[key] !== undefined)
                .map((key) => [key, turn.error[key]]),
            )
          : null;
        resolve({
          ...record,
          itemTypes: [...record.itemTypes],
          itemMethods: [...record.itemMethods],
          turnFailure: failure,
          turn: turn.id,
          status: turn.status,
          endedAt: Date.now(),
        });
      };
      threads.set(threadId, record);
      rpc("turn/start", { threadId, model, input: [{ type: "text", text, text_elements: [] }] }).then(
        (started) => {
          record.turnId = started?.turn?.id;
        },
        (error) => {
          clearTimeout(timer);
          threads.delete(threadId);
          reject(error);
        },
      );
    });
  };
  return {
    rpc,
    request,
    notifications,
    async initialize(name) {
      await rpc("initialize", { clientInfo: { name, version: "1.0" }, capabilities: { experimentalApi: true } });
      child.stdin.write('{"method":"initialized"}\n');
    },
    async close() {
      if (!exited) child.kill();
      await closed;
    },
  };
}

// 原始 WebSocket 探针：直接观察 Gateway 发出的 sequence_number / phase / 终态。
export function wsProbe({ url, token, accountId = "", model, input, generate = true, timeoutMs = 300000 }) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${url.replace("http", "ws")}/subscription/v1/responses`, {
      headers: { authorization: `Bearer ${token}`, ...(accountId ? { "chatgpt-account-id": accountId } : {}) },
    });
    const events = [];
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      socket.terminate();
      reject(Error("ws probe timeout"));
    }, timeoutMs);
    const done = (terminal) => {
      clearTimeout(timer);
      socket.close();
      resolve({ events, terminal, startedAt, endedAt: Date.now() });
    };
    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          type: "response.create",
          model,
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }],
          stream: true,
          max_output_tokens: 512,
          ...(generate === false ? { generate: false } : {}),
        }),
      );
    });
    socket.on("message", (data) => {
      let event;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }
      events.push({ at: Date.now(), ...event });
      if (["response.completed", "response.failed", "response.incomplete", "error"].includes(event.type))
        done(event);
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

// 协议捕获代理：在真实客户端与 Gateway 之间透明转发，只记录 SSE 帧的
// type / sequence_number / phase 元数据（不记录正文），用于 H5 协议契约判定。
export function captureProxy({ target }) {
  const upstream = new URL(target);
  const frames = [];
  let streamIndex = -1;
  const server = createServer((req, res) => {
    const stream = ++streamIndex; // 每个客户端请求一个独立事件流（sequence_number 从 0 重新开始）
    const proxyReq = httpRequest(
      {
        hostname: upstream.hostname,
        port: upstream.port,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: upstream.host },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        const streaming = (proxyRes.headers["content-type"] ?? "").includes("text/event-stream");
        const encodedChunks = [];
        let encodedBytes = 0;
        proxyRes.on("data", (chunk) => {
          if (streaming && encodedBytes <= 8 * 1024 * 1024) {
            const value = Buffer.from(chunk);
            encodedChunks.push(value);
            encodedBytes += value.length;
          }
          res.write(chunk);
        });
        proxyRes.on("end", () => {
          if (streaming && encodedBytes <= 8 * 1024 * 1024) {
            const encoding = String(proxyRes.headers["content-encoding"] ?? "identity").toLowerCase();
            for (const event of decodeSseFrames(Buffer.concat(encodedChunks), encoding))
              frames.push({ at: Date.now(), stream, ...event });
          }
          res.end();
        });
      },
    );
    proxyReq.on("error", () => res.destroy());
    req.pipe(proxyReq);
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () =>
      resolvePromise({
        url: `http://127.0.0.1:${server.address().port}`,
        frames,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(done);
          }),
      }),
    );
  });
}

// WebSocket capture proxy for clients (notably Codex CLI) that use the
// subscription Responses WebSocket rather than HTTP/SSE. It forwards opaque
// message bytes and records only structural event metadata.
export function captureWebSocketProxy({ target }) {
  const upstreamBase = new URL(target);
  upstreamBase.protocol = upstreamBase.protocol === "https:" ? "wss:" : "ws:";
  const frames = [];
  let streamIndex = -1;
  const clients = new Set();
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const hopByHop = new Set([
    "host", "connection", "upgrade", "sec-websocket-key", "sec-websocket-version",
    "sec-websocket-extensions", "sec-websocket-protocol", "content-length",
  ]);
  const forwardedHeaders = (headers) => Object.fromEntries(
    Object.entries(headers).filter(([name]) => !hopByHop.has(name.toLowerCase())),
  );
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (client) => {
      // A Codex CLI WebSocket connection carries multiple response.create
      // turns.  Treat each request as its own logical stream, matching the
      // HTTP/SSE capture contract, rather than grouping every turn by socket.
      let activeStream = null;
      clients.add(client);
      const upstream = new WebSocket(new URL(req.url ?? "/", upstreamBase).toString(), {
        headers: forwardedHeaders(req.headers),
      });
      const queued = [];
      const closeBoth = () => {
        clients.delete(client);
        if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING)
          upstream.close();
        if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING)
          client.close();
      };
      client.on("message", (data, isBinary) => {
        if (!isBinary) {
          try {
            const message = JSON.parse(data.toString("utf8"));
            if (message.type === "response.create") activeStream = ++streamIndex;
          } catch {
            // Forward opaque client messages without interpreting them.
          }
        }
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        else if (upstream.readyState === WebSocket.CONNECTING) queued.push({ data, isBinary });
      });
      upstream.on("open", () => {
        for (const item of queued) upstream.send(item.data, { binary: item.isBinary });
        queued.length = 0;
      });
      upstream.on("message", (data, isBinary) => {
        if (!isBinary) {
          try {
            const event = JSON.parse(data.toString("utf8"));
            // Keep the same structural evidence as SSE capture: only
            // sequenced response events participate in H1/H5.  Opaque
            // metadata/rate-limit events are still forwarded untouched.
            if (activeStream !== null && Number.isInteger(event.sequence_number)) {
              frames.push({
                at: Date.now(),
                stream: activeStream,
                type: event.type,
                sequence_number: event.sequence_number,
                phase: event.item?.phase,
              });
            }
          } catch {
            // Preserve opaque messages; only JSON event metadata is observed.
          }
        }
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
      });
      client.on("close", closeBoth);
      client.on("error", closeBoth);
      upstream.on("close", () => {
        clients.delete(client);
        if (client.readyState === WebSocket.OPEN) client.close();
      });
      upstream.on("error", closeBoth);
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => resolvePromise({
      url: `http://127.0.0.1:${server.address().port}`,
      frames,
      close: () => new Promise((done) => {
        for (const client of clients) client.close();
        wss.close(() => server.close(done));
      }),
    }));
  });
}

// 只读观测：按时间窗切片线上 Gateway 日志（供 E2E-6 使用）。
export async function readGatewayLogWindow(path, since, until) {
  const body = await readFile(path, "utf8").catch(() => "");
  return body
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line);
        if (!event.at) return [];
        const at = Date.parse(event.at);
        return at >= since && at <= until ? [{ ...event, atMs: at }] : [];
      } catch {
        return [];
      }
    });
}

// 无客户端帧时的前进性回退：从 Gateway 日志的时长字段提取（外部进程用法）。
export function phasesFromGatewayLogs(events) {
  const durations = (name) =>
    (events ?? []).filter((x) => x.event === name && typeof x.duration_ms === "number").map((x) => x.duration_ms);
  const substantive = durations("upstream_first_substantive_event");
  const text = [...durations("downstream_first_output_text"), ...durations("upstream_first_output_text")];
  const completed = durations("completed");
  return {
    firstSubstantiveMs: substantive.length ? Math.max(...substantive) : undefined,
    firstTextMs: text.length ? Math.max(...text) : undefined,
    maxEventGapMs: completed.length ? Math.max(...completed) : undefined,
    progressObserved: (events ?? []).some((x) => x.event === "completed" && x.status === "completed"),
    source: "gateway_logs",
  };
}

// 事件流分组：连接/请求为单位（captureProxy 按请求编号，探针默认单流）。
export function groupStreams(events) {
  const map = new Map();
  for (const event of events) {
    const key = event.stream ?? 0;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(event);
  }
  return [...map.values()];
}

// 截断检测：含有 Responses 事件但未以终态结尾的流。
export function truncatedStreams(streams, terminals) {
  return streams
    .map((events, index) => [index, events])
    .filter(([, events]) => events.length && events.some((x) => String(x.type ?? "").startsWith("response.")))
    .filter(([, events]) => !terminals.includes(events[events.length - 1].type))
    .map(([index]) => index);
}

// 重连观测：同一 turn 在 Gateway 侧被重复请求的次数（不依赖客户端日志）。
// 区分两种同 turn 多请求：
// - continuation：输入项严格增多（工具结果回填后的续跑），属正常协议行为；
// - reconnect：输入项未增长（同内容重发），属客户端重试/重连信号。
export function classifyTurnRepeats(logs) {
  const groups = new Map();
  for (const event of logs ?? []) {
    if (event.event !== "route" || !event.turn) continue;
    const key = `${event.thread ?? ""}:${event.turn}:${event.request_kind ?? "turn"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  const reconnects = [];
  const continuations = [];
  for (const [key, rows] of groups) {
    for (let i = 1; i < rows.length; i++) {
      const previous = rows[i - 1];
      const current = rows[i];
      const previousSize = previous.input_items ?? previous.payload_bytes ?? 0;
      const currentSize = current.input_items ?? current.payload_bytes ?? 0;
      if (currentSize > previousSize) continuations.push({ key, from: previousSize, to: currentSize });
      else reconnects.push({ key, size: currentSize });
    }
  }
  return { reconnects, continuations };
}

export function derivePhases({ events, startedAt }) {
  const itemType = (event) => event.item?.type ?? event.itemType;
  const itemKey = (event) => event.item?.id ?? event.itemId ?? (event.output_index != null ? String(event.output_index) : undefined);
  const substantive = events.filter(
    (x) =>
      x.type &&
      ![
        "response.created",
        "response.in_progress",
        "response.queued",
        "response.completed",
        "response.incomplete",
        "response.failed",
        "error",
        "ping",
      ].includes(x.type),
  );
  const firstText = events.find((x) => x.type === "response.output_text.delta");
  const stamps = events.map((x) => x.at ?? startedAt).sort((a, b) => a - b);
  let maxGap = 0;
  for (let i = 1; i < stamps.length; i++) maxGap = Math.max(maxGap, stamps[i] - stamps[i - 1]);
  const phasesByItem = {};
  for (const event of events) {
    if (itemType(event) !== "message" || !itemKey(event)) continue;
    const key = itemKey(event);
    phasesByItem[key] ??= {};
    if (event.type === "response.output_item.added")
      phasesByItem[key].added = event.item?.phase ?? event.phase;
    if (event.type === "response.output_item.done")
      phasesByItem[key].done = event.item?.phase ?? event.phase;
  }
  return {
    firstSubstantiveMs: substantive.length ? substantive[0].at - startedAt : undefined,
    firstTextMs: firstText ? firstText.at - startedAt : undefined,
    maxEventGapMs: maxGap,
    progressObserved: substantive.length > 0,
    phasesByItem,
  };
}

export function toolObservations(events) {
  const calls = [];
  const results = [];
  for (const event of events) {
    if (event.item?.type === "function_call" && event.type === "response.output_item.done")
      calls.push({ call_id: event.item.call_id, name: event.item.name, status: "completed" });
    if (event.type === "response.output_item.done" && event.item?.type === "function_call_output")
      results.push({ call_id: event.item.call_id });
  }
  return { calls, results };
}

// 工具调用/结果顺序：每个 result 必须引用此前已出现的 call（跨请求累积），无孤儿结果。
export function toolCallOrderViolations(payloads) {
  const seen = new Set();
  const violations = [];
  for (const [index, payload] of (payloads ?? []).entries()) {
    for (const entry of payload.callIds ?? []) {
      const [kind, callId] = entry.split(":");
      if (kind === "function_call") seen.add(callId);
      else if (!seen.has(callId)) violations.push({ payload: index, callId });
    }
  }
  return violations;
}

// 重连归因：同一 turn 的重发之前是否有该 turn 的传输/上游错误（客户端重试放大）。
// 全部重连都有前序错误才算已归因，否则返回 undefined（保持未归因）。
export function attributeReconnects({ reconnects, logs }) {
  if (!reconnects?.length) return undefined;
  const categories = new Set();
  for (const reconnect of reconnects) {
    const [thread, turn] = String(reconnect.key).split(":");
    const prior = (logs ?? []).filter(
      (x) =>
        x.thread === thread &&
        x.turn === turn &&
        ["ws_error", "upstream_transport_error", "provider_error"].includes(x.event),
    );
    if (!prior.length) return undefined;
    for (const row of prior)
      categories.add(row.transport_category ?? row.category ?? row.type ?? "unknown");
  }
  return `upstream_${[...categories].join("+")}_then_client_retry`;
}

// 从上游 payload 元数据推导工具调用/结果配对（只读 call_id，不读内容）。
export function toolObservationsFromPayloads(payloads) {
  const calls = [];
  const results = [];
  for (const payload of payloads ?? [])
    for (const entry of payload.callIds ?? []) {
      const [kind, callId] = entry.split(":");
      if (kind === "function_call") calls.push({ call_id: callId, status: "completed" });
      else results.push({ call_id: callId });
    }
  const unique = new Map();
  for (const call of calls) if (!unique.has(call.call_id)) unique.set(call.call_id, call);
  const uniqueResults = new Map();
  for (const result of results) if (!uniqueResults.has(result.call_id)) uniqueResults.set(result.call_id, result);
  return { calls: [...unique.values()], results: [...uniqueResults.values()] };
}

export function unknownEventTypes(events, known) {
  return [...new Set(events.map((x) => x.type).filter((x) => x && !known.includes(x)))];
}

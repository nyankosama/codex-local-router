import { readFile, realpath, stat } from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fail } from "./errors.mjs";
import { codexHome as defaultCodexHome } from "./product.mjs";

const equal = (left, right) => {
  const a = Buffer.from(left ?? "");
  const b = Buffer.from(right ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
};
const exec = promisify(execFile);

// 凭证解析缓存：文件存储可由 mtime/size 观测变更，钥匙串不可观测 → 定时刷新。
// 否则每个订阅请求都要 spawn 两次 `/usr/bin/security`，卡住时吃掉整个 5s 超时
// （线上实测 identity_ms 4.3-8.6s，空闲时 120ms）。
const AUTH_FRESH_MS = 30_000;
const KEYCHAIN_SKIP_MS = 120_000;
const identityCache = new Map();

export function resetIdentityCache() {
  identityCache.clear();
}

async function fileStat(path) {
  try {
    const info = await stat(path);
    return { mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    return null;
  }
}

async function configuredStore(configPath) {
  try {
    const text = await readFile(configPath, "utf8");
    return text.match(/^\s*cli_auth_credentials_store\s*=\s*"([^"]+)"/m)?.[1] ?? "auto";
  } catch {
    return "auto";
  }
}

async function codexKeychainAccount(codexHome) {
  const canonical = await realpath(codexHome).catch(() => codexHome);
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return `cli|${hash}`;
}

async function keychainAuth(services, account, load = exec) {
  for (const service of services) {
    try {
      const { stdout } = await load("/usr/bin/security", [
        "find-generic-password",
        "-s",
        service,
        "-a",
        account,
        "-w",
      ], { timeout: 5000 });
      const value = JSON.parse(stdout.trim());
      if (value?.tokens?.access_token) return { value, service };
    } catch {}
  }
}

export async function loadCodexAuth(options = {}) {
  const codexHome = options.codexHome ?? defaultCodexHome(options.env ?? process.env);
  const authPath = options.authPath ?? join(codexHome, "auth.json");
  const configPath = options.configPath ?? join(codexHome, "config.toml");
  const now = Date.now();
  const key = `${codexHome}\u0000${authPath}\u0000${configPath}`;
  const state = identityCache.get(key) ?? { keychainBlockedUntil: 0 };
  identityCache.set(key, state);

  const configStat = await fileStat(configPath);
  const configChanged =
    state.store == null ||
    state.configStat?.mtimeMs !== configStat?.mtimeMs ||
    state.configStat?.size !== configStat?.size;
  if (configChanged) {
    state.store = options.store ?? (await configuredStore(configPath));
    state.configStat = configStat;
  }
  const store = state.store;
  if (store === "ephemeral")
    throw fail(
      "unsupported_ephemeral_credentials",
      503,
      "Codex ephemeral credentials cannot be reused by the local router; use file or macOS keyring storage",
    );

  const authStat = await fileStat(authPath);
  const fresh =
    options.force !== true &&
    state.auth &&
    (store === "keyring"
      ? now - state.cachedAt < AUTH_FRESH_MS
      : state.authStat?.mtimeMs === authStat?.mtimeMs &&
        state.authStat?.size === authStat?.size);
  if (fresh) return { auth: state.auth, store: state.cachedStore, source: state.source };

  if (["keyring", "auto"].includes(store) && now >= (state.keychainBlockedUntil ?? 0)) {
    const result = await keychainAuth(
      options.keychainServices ?? ["Codex Auth", "com.openai.codex.auth"],
      options.keychainAccount ?? (await codexKeychainAccount(codexHome)),
      options.loadKeychain ?? options.exec,
    );
    if (result) {
      state.auth = result.value;
      state.source = `keychain:${result.service}`;
      state.cachedStore = "keyring";
      state.authStat = authStat;
      state.cachedAt = now;
      return { auth: result.value, store: "keyring", source: `keychain:${result.service}` };
    }
  }

  if (["file", "auto"].includes(store)) {
    try {
      const auth = JSON.parse(await readFile(authPath, "utf8"));
      state.auth = auth;
      state.source = authPath;
      state.cachedStore = "file";
      state.authStat = authStat;
      state.cachedAt = now;
      // auto + 文件存储确实可用：负缓存钥匙串探测，避免每请求 2 次子进程 + 5s 超时。
      // 文件不可读时不缓存，保持钥匙串回退语义。
      if (store === "auto") state.keychainBlockedUntil = now + KEYCHAIN_SKIP_MS;
      return { auth, store: "file", source: authPath };
    } catch {}
  }
  throw fail("trusted_subscription_identity_unavailable", 503);
}

export function createLocalIdentityResolver(
  input = {},
) {
  const options = typeof input === "string" ? { authPath: input, store: "file" } : input;
  return async (entry, headers) => {
    if (entry !== "subscription") return undefined;
    const matches = (auth, bearer, accountId) =>
      equal(bearer, auth?.tokens?.access_token) &&
      (!accountId || equal(accountId, auth?.tokens?.account_id));
    const bearer = headers.authorization?.replace(/^Bearer /, "");
    const accountHeader = headers["chatgpt-account-id"];
    let { auth } = await loadCodexAuth(options);
    // 缓存可能陈旧：只有比对失败时才强制重读一次，保持严格校验语义。
    if (!matches(auth, bearer, accountHeader))
      ({ auth } = await loadCodexAuth({ ...options, force: true }));
    const accountId = auth?.tokens?.account_id;
    const accessToken = auth?.tokens?.access_token;
    if (typeof accountId !== "string" || typeof accessToken !== "string")
      throw fail("trusted_subscription_identity_unavailable", 503);
    if (!bearer || !equal(bearer, accessToken))
      throw fail("subscription_identity_mismatch", 401);
    if (accountHeader && !equal(accountHeader, accountId))
      throw fail("subscription_identity_mismatch", 401);
    return `chatgpt:${accountId}`;
  };
}

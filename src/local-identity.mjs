import { readFile, realpath } from "node:fs/promises";
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
  const store = options.store ?? (await configuredStore(configPath));
  if (store === "ephemeral")
    throw fail(
      "unsupported_ephemeral_credentials",
      503,
      "Codex ephemeral credentials cannot be reused by the local router; use file or macOS keyring storage",
    );
  if (["keyring", "auto"].includes(store)) {
    const result = await keychainAuth(
      options.keychainServices ?? ["Codex Auth", "com.openai.codex.auth"],
      options.keychainAccount ?? await codexKeychainAccount(codexHome),
      options.loadKeychain ?? options.exec,
    );
    if (result) return { auth: result.value, store: "keyring", source: `keychain:${result.service}` };
  }
  if (["file", "auto"].includes(store)) {
    try {
      return { auth: JSON.parse(await readFile(authPath, "utf8")), store: "file", source: authPath };
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
    const { auth } = await loadCodexAuth(options);
    const accountId = auth?.tokens?.account_id;
    const accessToken = auth?.tokens?.access_token;
    if (typeof accountId !== "string" || typeof accessToken !== "string")
      throw fail("trusted_subscription_identity_unavailable", 503);
    const bearer = headers.authorization?.replace(/^Bearer /, "");
    if (!bearer || !equal(bearer, accessToken))
      throw fail("subscription_identity_mismatch", 401);
    if (
      headers["chatgpt-account-id"] &&
      !equal(headers["chatgpt-account-id"], accountId)
    )
      throw fail("subscription_identity_mismatch", 401);
    return `chatgpt:${accountId}`;
  };
}

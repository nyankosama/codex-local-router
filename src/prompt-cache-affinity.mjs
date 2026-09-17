import {
  createHmac,
  randomBytes,
} from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fail } from "./errors.mjs";

const exec = promisify(execFile);
export const PROMPT_CACHE_KEYCHAIN_SERVICE =
  "com.nyankosama.codex-local-router.prompt-cache-v1";
export const PROMPT_CACHE_KEYCHAIN_ACCOUNT = "affinity";
export const PROMPT_CACHE_LINEAGE_TTL_MS = 30 * 60 * 1000;
export const PROMPT_CACHE_MAX_LINEAGES = 256;
export const PROMPT_CACHE_AFFINITIES = new Set(["none", "gateway-opaque"]);

const clean = (value, maximum = 512) =>
  typeof value === "string" && value.length > 0 && value.length <= maximum
    ? value
    : undefined;

const hmac = (secret, ...parts) => {
  const digest = createHmac("sha256", secret);
  for (const part of parts) {
    digest.update(String(part));
    digest.update("\0");
  }
  return digest.digest("base64url");
};

export function resolvePromptCacheAffinity(config, target) {
  if (target?.provider === "chatgpt-subscription")
    return {
      mode: "passthrough",
      reason: "official-subscription-transparent",
      carrier: "client-prompt-cache-key",
      lineageSources: ["client_prompt_cache_key"],
      restartStable: true,
      restartStability: "upstream-managed",
    };
  if (target?.wireApi !== "responses")
    return {
      mode: "none",
      reason: "non-responses-unchanged",
      carrier: null,
      lineageSources: [],
      restartStable: false,
      restartStability: "not-applicable",
    };
  if (target?.app?.thirdPartyTemplate == null && target?.modelFamily !== "openai-gpt")
    return {
      mode: "none",
      reason: "non-gpt-unchanged",
      carrier: null,
      lineageSources: [],
      restartStable: false,
      restartStability: "not-applicable",
    };
  const configured = config?.providers?.[target.provider]?.promptCaching?.affinity;
  if (configured === "gateway-opaque")
    return {
      mode: "gateway-opaque",
      reason: "provider-explicit",
      carrier: "prompt_cache_key",
      lineageSources: [
        "client_prompt_cache_key",
        "verified_parent_thread",
        "thread",
      ],
      restartStable: true,
      restartStability: "keychain-secret-and-encrypted-lineage-state",
    };
  return {
    mode: "none",
    reason: configured === "none" ? "provider-explicit-none" : "provider-default-none",
    carrier: null,
    lineageSources: [],
    restartStable: false,
    restartStability: "not-applicable",
  };
}

export function sanitizePromptCacheOptions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const safe = {};
  if (["implicit", "explicit"].includes(value.mode)) safe.mode = value.mode;
  if (value.ttl === "30m") safe.ttl = value.ttl;
  return Object.keys(safe).length ? safe : undefined;
}

async function readKeychainSecret(run = exec) {
  const { stdout } = await run("/usr/bin/security", [
    "find-generic-password",
    "-s",
    PROMPT_CACHE_KEYCHAIN_SERVICE,
    "-a",
    PROMPT_CACHE_KEYCHAIN_ACCOUNT,
    "-w",
  ], { timeout: 5000 });
  const secret = Buffer.from(stdout.trim(), "hex");
  if (secret.length !== 32) throw Error("invalid prompt cache affinity key");
  return secret;
}

async function storeKeychainSecret(secret, spawnProcess = spawn) {
  await new Promise((resolve, reject) => {
    const child = spawnProcess("/usr/bin/security", ["-i"], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let errors = "";
    child.stderr.on("data", (data) => { errors += data; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0 && !/SecKeychain|Error:/i.test(errors)) resolve();
      else reject(Error("failed to store prompt cache affinity key"));
    });
    child.stdin.end(
      `add-generic-password -s ${JSON.stringify(PROMPT_CACHE_KEYCHAIN_SERVICE)} ` +
      `-a ${JSON.stringify(PROMPT_CACHE_KEYCHAIN_ACCOUNT)} ` +
      `-w ${secret.toString("hex")}\n`,
    );
  });
}

export async function promptCacheSecret({
  run = exec,
  spawnProcess = spawn,
  random = randomBytes,
} = {}) {
  try {
    return await readKeychainSecret(run);
  } catch (error) {
    if (error?.code !== 44)
      throw fail("prompt_cache_affinity_key_unavailable", 503);
  }
  const secret = random(32);
  try {
    await storeKeychainSecret(secret, spawnProcess);
    const verified = await readKeychainSecret(run);
    if (!verified.equals(secret))
      throw Error("prompt cache affinity key verification failed");
    return verified;
  } catch {
    throw fail("prompt_cache_affinity_key_unavailable", 503);
  }
}

function prunedIndex(value, now, maximum) {
  const entries = Array.isArray(value?.entries)
    ? value.entries.filter((entry) =>
        entry &&
        typeof entry.ref === "string" &&
        typeof entry.lineageId === "string" &&
        Number.isFinite(entry.expiresAt) &&
        entry.expiresAt > now)
    : [];
  entries.sort((left, right) => right.updatedAt - left.updatedAt);
  return { schemaVersion: 1, entries: entries.slice(0, maximum) };
}

function upsert(index, entry, maximum) {
  index.entries = [
    entry,
    ...index.entries.filter((candidate) => candidate.ref !== entry.ref),
  ].slice(0, maximum);
}

export class PromptCacheAffinity {
  constructor(state, {
    secret,
    loadSecret = promptCacheSecret,
    now = () => Date.now(),
    ttlMs = PROMPT_CACHE_LINEAGE_TTL_MS,
    maxLineages = PROMPT_CACHE_MAX_LINEAGES,
  } = {}) {
    this.state = state;
    this.secret = secret;
    this.loadSecret = loadSecret;
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxLineages = maxLineages;
    this.secretPromise = null;
  }

  async key() {
    if (this.secret) return this.secret;
    this.secretPromise ??= Promise.resolve(this.loadSecret()).then((value) => {
      if (!Buffer.isBuffer(value) || value.length !== 32)
        throw fail("prompt_cache_affinity_key_unavailable", 503);
      this.secret = value;
      return value;
    }).catch((error) => {
      this.secretPromise = null;
      throw error?.type
        ? error
        : fail("prompt_cache_affinity_key_unavailable", 503);
    });
    return this.secretPromise;
  }

  async resolve(config, target, body, ctx) {
    const policy = resolvePromptCacheAffinity(config, target);
    if (policy.mode !== "gateway-opaque") return { ...policy, applied: false };
    const secret = await this.key();
    const now = this.now();
    const accountHash = clean(ctx?.auth, 128);
    if (!accountHash)
      return { ...policy, applied: false, unavailableReason: "missing_account" };
    const stateKey = `prompt-cache-affinity:${accountHash}`;
    const index = prunedIndex(this.state.get(stateKey), now, this.maxLineages);
    const thread = clean(ctx?.thread, 256);
    const parentThread = clean(ctx?.parentThread, 256);
    const turn = clean(ctx?.turn, 256);
    const threadRef = thread
      ? hmac(secret, "thread-ref", accountHash, thread)
      : undefined;
    const parentRef = parentThread
      ? hmac(secret, "thread-ref", accountHash, parentThread)
      : undefined;
    const turnRef = turn
      ? hmac(
          secret,
          "turn-ref",
          accountHash,
          turn,
          ctx?.requestKind ?? "turn",
          target.provider,
          target.model,
        )
      : undefined;
    const find = (ref, kind) =>
      index.entries.find((entry) => entry.ref === `${kind}:${ref}`);

    let lineageId;
    let lineageSource;
    const frozen = turnRef && find(turnRef, "turn");
    if (frozen) {
      lineageId = frozen.lineageId;
      lineageSource = frozen.lineageSource;
    } else {
      const clientKey = clean(body?.prompt_cache_key);
      if (clientKey) {
        lineageId = hmac(secret, "client", accountHash, clientKey);
        lineageSource = "client_prompt_cache_key";
      } else {
        const parent = parentRef && find(parentRef, "thread");
        const current = threadRef && find(threadRef, "thread");
        if (parent) {
          lineageId = parent.lineageId;
          lineageSource = "verified_parent_thread";
        } else if (current) {
          lineageId = current.lineageId;
          lineageSource = current.lineageSource ?? "thread";
        } else if (thread) {
          // A thread-only lineage is stable through the encrypted index for the
          // TTL, then deliberately rotates to permit a cold start.
          lineageId = hmac(
            secret,
            "thread-lineage",
            accountHash,
            thread,
            now,
          );
          lineageSource = "thread";
        }
      }
    }
    if (!lineageId)
      return { ...policy, applied: false, unavailableReason: "missing_lineage" };

    const expiresAt = now + this.ttlMs;
    if (threadRef)
      upsert(index, {
        ref: `thread:${threadRef}`,
        lineageId,
        lineageSource,
        updatedAt: now,
        expiresAt,
      }, this.maxLineages);
    if (turnRef)
      upsert(index, {
        ref: `turn:${turnRef}`,
        lineageId,
        lineageSource,
        updatedAt: now,
        expiresAt,
      }, this.maxLineages);
    // The durable record contains derived identifiers only. Deliberately omit
    // StateStore scope metadata so raw account, thread and branch values never
    // enter the encrypted archive alongside this index.
    this.state.set(stateKey, index);
    return {
      ...policy,
      applied: true,
      lineageSource,
      providerKey:
        "clr-pc-v1-" +
        hmac(secret, "provider", target.provider, target.model, lineageId),
    };
  }
}

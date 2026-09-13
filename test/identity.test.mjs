import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalIdentityResolver, loadCodexAuth } from "../src/local-identity.mjs";
import { identity } from "../src/state.mjs";

test("trusted subscription identity survives token refresh and rejects client account claims", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-identity-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "auth.json");
  const save = (token) =>
    writeFile(
      path,
      JSON.stringify({ tokens: { account_id: "account-stable", access_token: token } }),
    );
  await save("token-one");
  const resolve = createLocalIdentityResolver(path);
  const first = await resolve("subscription", {
    authorization: "Bearer token-one",
    "chatgpt-account-id": "account-stable",
  });
  await save("token-two");
  const second = await resolve("subscription", {
    authorization: "Bearer token-two",
    "chatgpt-account-id": "account-stable",
  });
  assert.equal(first, second);
  assert.equal(
    identity(
      "subscription",
      { authorization: "Bearer token-one", "thread-id": "thread" },
      {},
      first,
    ).account,
    "chatgpt:account-stable",
  );
  await assert.rejects(
    resolve("subscription", {
      authorization: "Bearer token-two",
      "chatgpt-account-id": "claimed-other-account",
    }),
    (error) => error.type === "subscription_identity_mismatch",
  );
  await assert.rejects(
    resolve("subscription", { authorization: "Bearer stale-token" }),
    (error) => error.type === "subscription_identity_mismatch",
  );
  assert.equal(await resolve("api", {}), undefined);
});

test("Codex Keychain credential storage is supported without requiring auth.json", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-auth-keyring-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, "config.toml");
  await writeFile(configPath, 'cli_auth_credentials_store = "keyring"\n');
  const auth = { tokens: { account_id: "acct-keyring", access_token: "token-keyring" } };
  const calls = [];
  const loaded = await loadCodexAuth({
    codexHome: dir,
    authPath: join(dir, "missing.json"),
    configPath,
    keychainServices: ["test-service"],
    loadKeychain: async (...args) => { calls.push(args); return { stdout: JSON.stringify(auth) }; },
  });
  assert.equal(loaded.source, "keychain:test-service");
  assert.deepEqual(loaded.auth, auth);
  assert.deepEqual(calls[0][1].slice(0, 4), ["find-generic-password", "-s", "test-service", "-a"]);
  assert.match(calls[0][1][4], /^cli\|[a-f0-9]{16}$/);
  const resolver = createLocalIdentityResolver({
    codexHome: dir,
    authPath: join(dir, "missing.json"),
    configPath,
    keychainServices: ["test-service"],
    loadKeychain: async () => ({ stdout: JSON.stringify(auth) }),
  });
  assert.equal(await resolver("subscription", { authorization: "Bearer token-keyring" }), "chatgpt:acct-keyring");
});

test("auto credential store probes the Keychain once instead of on every request", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-auth-cache-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const authPath = join(dir, "auth.json");
  const configPath = join(dir, "config.toml");
  await writeFile(authPath, JSON.stringify({ tokens: { account_id: "acct-file", access_token: "token-file" } }));
  await writeFile(configPath, "# cli_auth_credentials_store defaults to auto\n");
  let probes = 0;
  const options = {
    codexHome: dir,
    authPath,
    configPath,
    keychainServices: ["test-service"],
    loadKeychain: async () => { probes += 1; throw new Error("item not found"); },
  };

  for (let i = 0; i < 4; i += 1) assert.equal((await loadCodexAuth(options)).store, "file");
  assert.equal(probes, 1, "Keychain must be probed once, not per request");

  const resolver = createLocalIdentityResolver(options);
  assert.equal(await resolver("subscription", { authorization: "Bearer token-file" }), "chatgpt:acct-file");
  assert.equal(probes, 1, "identity resolution must reuse the cached credential");

  await writeFile(authPath, JSON.stringify({ tokens: { account_id: "acct-file", access_token: "token-rotated" } }));
  assert.equal(
    await resolver("subscription", { authorization: "Bearer token-rotated" }),
    "chatgpt:acct-file",
  );
  await assert.rejects(
    resolver("subscription", { authorization: "Bearer token-file" }),
    (error) => error.type === "subscription_identity_mismatch",
  );
  assert.equal(probes, 1, "file rotation must not trigger Keychain probes");
});

test("auto credential store keeps the Keychain fallback while auth.json is unreadable", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-auth-fallback-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let probes = 0;
  const options = {
    codexHome: dir,
    authPath: join(dir, "missing.json"),
    configPath: join(dir, "config.toml"),
    keychainServices: ["test-service"],
    loadKeychain: async () => { probes += 1; throw new Error("item not found"); },
  };
  for (let i = 0; i < 3; i += 1)
    await assert.rejects(loadCodexAuth(options), (error) => error.type === "trusted_subscription_identity_unavailable");
  assert.equal(probes, 3, "Keychain must stay the fallback when no file credential exists");
});

#!/usr/bin/env node
import { resolve } from "node:path";
import {
  argsOf,
  assertExpected,
  assertQuiescent,
  atomicJson,
  cacheModes,
  copyManagedConfig,
  installPackage,
  packInstalledPackage,
  restore,
  runJson,
  sha256,
  snapshot,
} from "./cache-affinity-rollout-lib.mjs";
import { promptCacheSecret } from "../../src/prompt-cache-affinity.mjs";

const args = argsOf();
const candidatePackageInput = args.value("package");
const candidatePackage = candidatePackageInput
  ? resolve(String(candidatePackageInput))
  : null;
const expectedSpace = String(args.value("expected-space") ?? "");
const expectedConfigSha256 = String(
  args.value("expected-config-sha256") ?? "",
);
const expectedServerSha256 = String(
  args.value("expected-server-sha256") ?? "",
);
const expectedPackageSha256 = String(args.value("package-sha256") ?? "");
const providerInput = args.value("provider");
const idsInput = args.value("ids");
if (!candidatePackage || !expectedSpace || !expectedConfigSha256 ||
    !expectedPackageSha256 ||
    !expectedServerSha256 || !providerInput || !idsInput)
  throw Error(
    "use --package TGZ --expected-space NAME@REV " +
    "--package-sha256 HASH --expected-config-sha256 HASH " +
    "--expected-server-sha256 HASH --provider ID --ids TARGET_A,TARGET_B",
  );

const cli = String(args.value("cli", "codex-local-router"));
const npm = String(args.value("npm", "npm"));
const provider = String(providerInput);
const targetIds = String(idsInput).split(",").map((id) => id.trim()).filter(Boolean);
const backupDir = resolve(String(args.value(
  "backup-dir",
  `./cache-affinity-rollback-${new Date().toISOString().replaceAll(/[^0-9]/g, "").slice(0, 14)}`,
)));
const statePath = resolve(backupDir, "rollback.json");

const prior = await snapshot(cli);
assertQuiescent(prior);
assertExpected(prior, {
  spaceRef: expectedSpace,
  configSha256: expectedConfigSha256,
});
const beforeModes = cacheModes(prior.status, targetIds);
if (!Object.values(beforeModes).every((mode) => mode === "none"))
  throw Error("prompt-cache affinity is not in the expected none state");
if (await sha256(candidatePackage) !== expectedPackageSha256)
  throw Error("candidate package hash mismatch");

const installed = await packInstalledPackage(prior, backupDir, npm);
const managedConfig = await copyManagedConfig(prior, backupDir);
const state = {
  schemaVersion: 1,
  phase: "prepared",
  createdAt: new Date().toISOString(),
  candidatePackage,
  candidatePackageSha256: await sha256(candidatePackage),
  candidateCommit: args.value("candidate-commit", null),
  prior: {
    spaceRef: prior.spaceRef,
    configSha256: prior.configSha256,
    defaultModel: prior.defaultModel,
    packagePath: installed.packagePath,
    packageSha256: installed.packageSha256,
    serverPath: installed.serverPath,
    serverSha256: installed.serverSha256,
    managedConfig,
  },
  candidate: null,
};
await atomicJson(statePath, state);

try {
  await installPackage(candidatePackage, npm);
  let current = await snapshot(cli);
  assertQuiescent(current);
  assertExpected(current, {
    spaceRef: state.prior.spaceRef,
    configSha256: state.prior.configSha256,
  });
  const installedServer = current.status.service?.installation?.serverPath;
  if (!installedServer || await sha256(installedServer) !== expectedServerSha256)
    throw Error("installed candidate server hash mismatch");

  await promptCacheSecret();
  const spaceName = expectedSpace.split("@")[0];
  const changed = await runJson(cli, [
    "provider", "edit", provider,
    "--space", spaceName,
    "--prompt-cache-affinity", "gateway-opaque",
    "--yes", "--json",
  ]);
  if (!changed.changed || changed.switch?.pending)
    throw Error("cache-affinity space revision was not applied immediately");

  current = await snapshot(cli);
  state.candidate = {
    spaceRef: current.spaceRef,
    configSha256: current.configSha256,
    defaultModel: current.defaultModel,
    serverPath: current.status.service?.installation?.serverPath,
    serverSha256: await sha256(
      current.status.service?.installation?.serverPath,
    ),
  };
  if (current.defaultModel !== state.prior.defaultModel)
    throw Error("default model changed during activation");
  if (state.candidate.serverSha256 !== expectedServerSha256)
    throw Error("running installation does not match the candidate server");
  if (!Object.values(cacheModes(current.status, targetIds)).every(
    (mode) => mode === "gateway-opaque"))
    throw Error("effective prompt-cache affinity policy was not enabled");
  state.phase = "active";
  state.activatedAt = new Date().toISOString();
  await atomicJson(statePath, state);
  console.log(JSON.stringify({
    applied: true,
    active: state.candidate.spaceRef,
    previous: state.prior.spaceRef,
    defaultModel: current.defaultModel,
    rollbackState: statePath,
  }, null, 2));
} catch (error) {
  state.phase = "activation_failed";
  state.error = { type: error?.code ?? error?.name ?? "activation_failed" };
  await atomicJson(statePath, state);
  try {
    await restore(state, { cli, npm });
    state.phase = "rolled_back_after_activation_failure";
    await atomicJson(statePath, state);
  } catch (rollbackError) {
    state.rollbackError = {
      type: rollbackError?.code ?? rollbackError?.name ?? "rollback_failed",
    };
    await atomicJson(statePath, state);
  }
  throw Error(
    `activation failed; recovery state: ${statePath}; ${error.message}`,
  );
}

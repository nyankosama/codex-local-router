#!/usr/bin/env node
import { resolve } from "node:path";
import {
  argsOf,
  assertExpected,
  assertQuiescent,
  atomicJson,
  copyManagedConfig,
  installPackage,
  instructionModes,
  packInstalledPackage,
  restore,
  runJson,
  sha256,
  snapshot,
} from "./cache-affinity-rollout-lib.mjs";

const args = argsOf();
const candidatePackage = args.value("package")
  ? resolve(String(args.value("package")))
  : null;
const expectedSpace = String(args.value("expected-space") ?? "");
const expectedConfigSha256 = String(args.value("expected-config-sha256") ?? "");
const expectedCodexConfigSha256 = String(args.value("expected-codex-config-sha256") ?? "");
const expectedServerSha256 = String(args.value("expected-server-sha256") ?? "");
const expectedPackageSha256 = String(args.value("package-sha256") ?? "");
const idsInput = args.value("ids");
if (!candidatePackage || !expectedSpace || !expectedConfigSha256 || !expectedCodexConfigSha256 ||
    !expectedServerSha256 || !expectedPackageSha256 || !idsInput)
  throw Error(
    "use --package TGZ --expected-space NAME@REV --package-sha256 HASH " +
    "--expected-config-sha256 HASH --expected-codex-config-sha256 HASH " +
    "--expected-server-sha256 HASH --ids TARGET_A,TARGET_B",
  );

const cli = String(args.value("cli", "codex-local-router"));
const npm = String(args.value("npm", "npm"));
const ids = String(idsInput);
const targetIds = ids.split(",").map((id) => id.trim()).filter(Boolean);
const backupDir = resolve(String(args.value(
  "backup-dir",
  `./instruction-snapshot-rollback-${new Date().toISOString().replaceAll(/[^0-9]/g, "").slice(0, 14)}`,
)));
const statePath = resolve(backupDir, "rollback.json");

const prior = await snapshot(cli);
assertQuiescent(prior);
assertExpected(prior, { spaceRef: expectedSpace, configSha256: expectedConfigSha256 });
if (prior.codexConfigSha256 !== expectedCodexConfigSha256)
  throw Error("Codex configuration hash mismatch");
if (await sha256(candidatePackage) !== expectedPackageSha256)
  throw Error("candidate package hash mismatch");

const installed = await packInstalledPackage(prior, backupDir, npm);
const managedConfig = await copyManagedConfig(prior, backupDir);
const state = {
  schemaVersion: 1,
  feature: "gpt-instruction-snapshot-lite",
  phase: "prepared",
  createdAt: new Date().toISOString(),
  candidatePackage,
  candidatePackageSha256: expectedPackageSha256,
  candidateCommit: args.value("candidate-commit", null),
  prior: {
    spaceRef: prior.spaceRef,
    configSha256: prior.configSha256,
    defaultModel: prior.defaultModel,
    selectedModelPresent: prior.selectedModelPresent,
    selectedModel: prior.selectedModel,
    codexConfigSha256: prior.codexConfigSha256,
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
  if (current.codexConfigSha256 !== state.prior.codexConfigSha256 ||
      current.selectedModelPresent !== state.prior.selectedModelPresent ||
      current.selectedModel !== state.prior.selectedModel)
    throw Error("Codex selected model changed before activation");
  const installedServer = current.status.service?.installation?.serverPath;
  if (!installedServer || await sha256(installedServer) !== expectedServerSha256)
    throw Error("installed candidate server hash mismatch");

  const changed = await runJson(cli, [
    "model", "sync-instructions",
    "--ids", ids,
    "--space", expectedSpace.split("@")[0],
    "--instruction-delivery", "gateway-lite",
    "--yes", "--json",
  ]);
  if (!changed.changed || changed.switch?.pending)
    throw Error("instruction snapshot revision was not applied immediately");

  current = await snapshot(cli);
  const modes = instructionModes(current.status, targetIds);
  if (!Object.values(modes).every((item) =>
    item.delivery === "gateway-lite" &&
    item.status === "pinned" &&
    /^[a-f0-9]{64}$/.test(item.contentHash ?? "")))
    throw Error("effective instruction snapshot delivery was not enabled");
  if (current.defaultModel !== state.prior.defaultModel)
    throw Error("space default model changed during activation");
  if (current.selectedModelPresent !== state.prior.selectedModelPresent ||
      current.selectedModel !== state.prior.selectedModel)
    throw Error("Codex selected model changed during activation");
  state.candidate = {
    spaceRef: current.spaceRef,
    configSha256: current.configSha256,
    defaultModel: current.defaultModel,
    selectedModelPresent: current.selectedModelPresent,
    selectedModel: current.selectedModel,
    codexConfigSha256: current.codexConfigSha256,
    instructionModes: modes,
    serverPath: current.status.service?.installation?.serverPath,
    serverSha256: await sha256(current.status.service?.installation?.serverPath),
  };
  if (state.candidate.serverSha256 !== expectedServerSha256)
    throw Error("running installation does not match the candidate server");
  state.phase = "active";
  state.activatedAt = new Date().toISOString();
  await atomicJson(statePath, state);
  console.log(JSON.stringify({
    applied: true,
    active: state.candidate.spaceRef,
    previous: state.prior.spaceRef,
    defaultModel: current.defaultModel,
    selectedModel: current.selectedModel,
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
  throw Error(`activation failed; recovery state: ${statePath}; ${error.message}`);
}

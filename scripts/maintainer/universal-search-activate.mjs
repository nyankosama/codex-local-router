#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateReleaseQualification } from "../e2e/lib/release-qualification.mjs";
import {
  argsOf,
  assertExpected,
  assertQuiescent,
  atomicJson,
  copyManagedConfig,
  installPackage,
  packInstalledPackage,
  restore,
  runJson,
  sha256,
  snapshot,
} from "./cache-affinity-rollout-lib.mjs";

const args = argsOf();
const required = [
  "package", "package-sha256", "expected-space", "expected-config-sha256",
  "expected-codex-config-sha256", "expected-server-sha256", "candidate-commit",
  "release-receipt", "release-receipt-sha256", "id",
];
if (required.some((key) => !args.value(key)))
  throw Error(`use ${required.map((key) => `--${key} VALUE`).join(" ")}`);

const cli = String(args.value("cli", "codex-local-router"));
const npm = String(args.value("npm", "npm"));
const candidatePackage = resolve(String(args.value("package")));
const expectedSpace = String(args.value("expected-space"));
const candidateCommit = String(args.value("candidate-commit"));
const targetId = String(args.value("id"));
const backupDir = resolve(String(args.value(
  "backup-dir",
  `./universal-search-rollback-${new Date().toISOString().replaceAll(/[^0-9]/g, "").slice(0, 14)}`,
)));
const statePath = resolve(backupDir, "rollback.json");
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const protectedConfig = (config) => {
  const copy = structuredClone(config);
  delete copy.targets?.[targetId];
  return digest(copy);
};
const stableTarget = (target) => {
  const copy = structuredClone(target);
  delete copy.subscriptionSearch;
  delete copy.standaloneSearch;
  if (copy.capabilities) delete copy.capabilities.freeformTools;
  if (copy.app) {
    for (const key of [
      "capabilityProfile", "useResponsesLite", "toolMode", "thirdPartyTemplate",
      "multiAgent", "shellType", "reasoningLevels", "defaultReasoningLevel",
    ]) delete copy.app[key];
  }
  return digest(copy);
};

const prior = await snapshot(cli);
assertQuiescent(prior);
assertExpected(prior, {
  spaceRef: expectedSpace,
  configSha256: String(args.value("expected-config-sha256")),
});
if (prior.codexConfigSha256 !== String(args.value("expected-codex-config-sha256")))
  throw Error("Codex configuration hash mismatch");
if (await sha256(candidatePackage) !== String(args.value("package-sha256")))
  throw Error("candidate package hash mismatch");

const releaseReceiptPath = resolve(String(args.value("release-receipt")));
if (await sha256(releaseReceiptPath) !== String(args.value("release-receipt-sha256")))
  throw Error("release receipt hash mismatch");
const releaseReceipt = JSON.parse(await readFile(releaseReceiptPath, "utf8"));
validateReleaseQualification(releaseReceipt, candidateCommit);

const beforeConfig = JSON.parse(await readFile(prior.configPath, "utf8"));
const beforeTarget = beforeConfig.targets?.[targetId];
if (!beforeTarget) throw Error(`target not found: ${targetId}`);
const installed = await packInstalledPackage(prior, backupDir, npm);
const managedConfig = await copyManagedConfig(prior, backupDir);
const state = {
  schemaVersion: 1,
  feature: "universal-search-standard-tool-v1",
  phase: "prepared",
  createdAt: new Date().toISOString(),
  candidatePackage,
  candidatePackageSha256: String(args.value("package-sha256")),
  candidateCommit,
  targetId,
  prior: {
    spaceRef: prior.spaceRef,
    configSha256: prior.configSha256,
    defaultModel: prior.defaultModel,
    selectedModelPresent: prior.selectedModelPresent,
    selectedModel: prior.selectedModel,
    codexConfigSha256: prior.codexConfigSha256,
    protectedConfigHash: protectedConfig(beforeConfig),
    stableTargetHash: stableTarget(beforeTarget),
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
  assertExpected(current, { spaceRef: state.prior.spaceRef, configSha256: state.prior.configSha256 });
  if (current.codexConfigSha256 !== state.prior.codexConfigSha256 ||
      current.selectedModelPresent !== state.prior.selectedModelPresent ||
      current.selectedModel !== state.prior.selectedModel)
    throw Error("Codex selected model changed before activation");
  const installedServer = current.status.service?.installation?.serverPath;
  if (!installedServer || await sha256(installedServer) !== String(args.value("expected-server-sha256")))
    throw Error("installed candidate server hash mismatch");

  const changed = await runJson(cli, [
    "model", "edit", "--id", targetId, "--space", expectedSpace.split("@")[0],
    "--template", "legacy", "--app-profile", "standard-tools", "--no-responses-lite",
    "--tool-mode", "default", "--multi-agent-version", "client-default", "--no-freeform-tools",
    "--shell-type", "shell_command", "--reasoning-levels", "low,high,max",
    "--default-reasoning-level", "max", "--subscription-search", "standard-tool",
    "--yes", "--json",
  ]);
  if (!changed.changed || changed.switch?.pending)
    throw Error("GLM search revision was not applied immediately");

  current = await snapshot(cli);
  const afterConfig = JSON.parse(await readFile(current.configPath, "utf8"));
  const target = afterConfig.targets?.[targetId];
  if (protectedConfig(afterConfig) !== state.prior.protectedConfigHash ||
      stableTarget(target) !== state.prior.stableTargetHash)
    throw Error("non-search target configuration changed during activation");
  if (target.subscriptionSearch?.delivery !== "standard-tool" ||
      target.standaloneSearch?.source !== "disabled" ||
      target.capabilities?.freeformTools !== false ||
      target.app?.capabilityProfile !== "standard-tools" ||
      target.app?.useResponsesLite !== false || target.app?.toolMode != null ||
      target.app?.multiAgent != null || target.app?.thirdPartyTemplate != null ||
      target.app?.shellType !== "shell_command" ||
      JSON.stringify(target.app?.reasoningLevels) !== JSON.stringify(["low", "high", "max"]) ||
      target.app?.defaultReasoningLevel !== "max")
    throw Error("GLM target does not match the accepted standard-tool configuration");
  if (current.defaultModel !== state.prior.defaultModel ||
      current.selectedModelPresent !== state.prior.selectedModelPresent ||
      current.selectedModel !== state.prior.selectedModel)
    throw Error("a default or selected model changed during activation");
  if (current.status.service?.health?.version !== "0.5.3")
    throw Error("running service is not the accepted candidate version");
  state.candidate = {
    spaceRef: current.spaceRef,
    configSha256: current.configSha256,
    defaultModel: current.defaultModel,
    selectedModelPresent: current.selectedModelPresent,
    selectedModel: current.selectedModel,
    codexConfigSha256: current.codexConfigSha256,
  };
  state.phase = "active";
  state.activatedAt = new Date().toISOString();
  await atomicJson(statePath, state);
  console.log(JSON.stringify({
    applied: true,
    active: current.spaceRef,
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
    state.rollbackError = { type: rollbackError?.code ?? rollbackError?.name ?? "rollback_failed" };
    await atomicJson(statePath, state);
  }
  throw Error(`activation failed; recovery state: ${statePath}; ${error.message}`);
}

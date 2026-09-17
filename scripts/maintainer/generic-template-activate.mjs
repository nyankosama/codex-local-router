#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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
const required = ["package", "package-sha256", "expected-space", "expected-config-sha256",
  "expected-codex-config-sha256", "expected-template-module-sha256", "context-receipt",
  "context-receipt-sha256", "protocol-receipt", "protocol-receipt-sha256", "live-receipt", "live-receipt-sha256", "ids"];
if (required.some((key) => !args.value(key)))
  throw Error(`use ${required.map((key) => `--${key} VALUE`).join(" ")}`);

const cli = String(args.value("cli", "codex-local-router"));
const npm = String(args.value("npm", "npm"));
const candidatePackage = resolve(String(args.value("package")));
const contextReceiptPath = resolve(String(args.value("context-receipt")));
const protocolReceiptPath = resolve(String(args.value("protocol-receipt")));
const liveReceiptPath = resolve(String(args.value("live-receipt")));
const expectedSpace = String(args.value("expected-space"));
const targetIds = String(args.value("ids")).split(",").map((id) => id.trim()).filter(Boolean);
const backupDir = resolve(String(args.value("backup-dir",
  `./generic-template-rollback-${new Date().toISOString().replaceAll(/[^0-9]/g, "").slice(0, 14)}`)));
const statePath = resolve(backupDir, "rollback.json");
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const protectedState = (config) => {
  const copy = structuredClone(config);
  for (const id of targetIds) delete copy.targets?.[id];
  return digest(copy);
};

const prior = await snapshot(cli);
assertQuiescent(prior);
assertExpected(prior, { spaceRef: expectedSpace, configSha256: String(args.value("expected-config-sha256")) });
if (prior.codexConfigSha256 !== String(args.value("expected-codex-config-sha256")))
  throw Error("Codex configuration hash mismatch");
if (await sha256(candidatePackage) !== String(args.value("package-sha256")))
  throw Error("candidate package hash mismatch");
if (await sha256(contextReceiptPath) !== String(args.value("context-receipt-sha256")) ||
    await sha256(protocolReceiptPath) !== String(args.value("protocol-receipt-sha256")) ||
    await sha256(liveReceiptPath) !== String(args.value("live-receipt-sha256")))
  throw Error("acceptance receipt hash mismatch");
const contextReceipt = JSON.parse(await readFile(contextReceiptPath, "utf8"));
const protocolReceipt = JSON.parse(await readFile(protocolReceiptPath, "utf8"));
const liveReceipt = JSON.parse(await readFile(liveReceiptPath, "utf8"));
if (!contextReceipt.passed || !contextReceipt.complete || contextReceipt.results?.length !== 4 ||
    !protocolReceipt.passed || !protocolReceipt.complete || protocolReceipt.results?.length !== 2 ||
    contextReceipt.core?.sha256 !== protocolReceipt.core?.sha256)
  throw Error("generic template protocol receipts are incomplete");
if (!liveReceipt.passed || liveReceipt.blocked !== 0 || liveReceipt.cases?.length !== 3 || liveReceipt.generations > 12 ||
    liveReceipt.client?.sha256 !== contextReceipt.core?.sha256)
  throw Error("generic template live receipt is incomplete");
if (args.value("candidate-commit") &&
    (contextReceipt.candidateCommit !== args.value("candidate-commit") || protocolReceipt.candidateCommit !== args.value("candidate-commit") ||
     liveReceipt.candidateCommit !== args.value("candidate-commit")))
  throw Error("generic template receipts are bound to another candidate commit");

const beforeConfig = JSON.parse(await readFile(prior.configPath, "utf8"));
const installed = await packInstalledPackage(prior, backupDir, npm);
const managedConfig = await copyManagedConfig(prior, backupDir);
const state = {
  schemaVersion: 1,
  feature: "third-party-generic-template-v1",
  phase: "prepared",
  createdAt: new Date().toISOString(),
  candidatePackage,
  candidatePackageSha256: String(args.value("package-sha256")),
  candidateCommit: args.value("candidate-commit", null),
  prior: {
    spaceRef: prior.spaceRef,
    configSha256: prior.configSha256,
    defaultModel: prior.defaultModel,
    selectedModelPresent: prior.selectedModelPresent,
    selectedModel: prior.selectedModel,
    codexConfigSha256: prior.codexConfigSha256,
    protectedStateHash: protectedState(beforeConfig),
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
      current.selectedModelPresent !== state.prior.selectedModelPresent || current.selectedModel !== state.prior.selectedModel)
    throw Error("Codex selected model changed before activation");
  const packageRoot = dirname(dirname(resolve(current.status.service?.installation?.serverPath)));
  if (await sha256(resolve(packageRoot, "src/third-party-template.mjs")) !== String(args.value("expected-template-module-sha256")))
    throw Error("installed candidate template module hash mismatch");

  const changed = await runJson(cli, ["model", "apply-template", "--ids", targetIds.join(","), "--template", "codex-general-v1",
    "--space", expectedSpace.split("@")[0], "--yes", "--json"]);
  if (!changed.changed || changed.switch?.pending) throw Error("generic template revision was not applied immediately");
  current = await snapshot(cli);
  const afterConfig = JSON.parse(await readFile(current.configPath, "utf8"));
  if (protectedState(afterConfig) !== state.prior.protectedStateHash)
    throw Error("non-target configuration changed during template activation");
  const probes = [];
  for (const id of targetIds) {
    const probe = await runJson(cli, ["model", "probe", "--id", id, "--json"]);
    if (probe.template?.template !== "codex-general-v1" || probe.appCapabilityProfile?.toolMode !== "code_mode_only" ||
        probe.appCapabilityProfile?.toolFilteringBoundary !== "structured-only; embedded-exec-opaque" ||
        probe.instructions?.mode !== "builtin-template" || probe.instructions?.status !== "pinned" ||
        probe.multiAgent?.capabilities?.multi_agent_version !== "v2")
      throw Error(`generic template verification failed for ${id}`);
    probes.push(probe);
  }
  if (current.defaultModel !== state.prior.defaultModel || current.selectedModelPresent !== state.prior.selectedModelPresent ||
      current.selectedModel !== state.prior.selectedModel)
    throw Error("a default or selected model changed during activation");
  state.candidate = { spaceRef: current.spaceRef, configSha256: current.configSha256,
    defaultModel: current.defaultModel, selectedModelPresent: current.selectedModelPresent, selectedModel: current.selectedModel,
    codexConfigSha256: current.codexConfigSha256, probes };
  state.phase = "active";
  state.activatedAt = new Date().toISOString();
  await atomicJson(statePath, state);
  console.log(JSON.stringify({ applied: true, active: current.spaceRef, previous: state.prior.spaceRef,
    defaultModel: current.defaultModel, selectedModel: current.selectedModel, rollbackState: statePath }, null, 2));
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

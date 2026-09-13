import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { buildModelCatalog } from "./model-catalog.mjs";
import { rawConfig, writeConfigTransaction } from "./config-store.mjs";
import {
  OFFICIAL_SPACE,
  captureOfficialSpace,
  commitSpaceActivation,
  composeRuntimeConfig,
  detectSpaceDrift,
  digestJSON,
  materializeRuntimeConfig,
  parseSpaceRef,
  readSpaceIndex,
  readSpaceTransaction,
  resolveSpace,
  spacePaths,
} from "./config-spaces.mjs";
import { atomicJSON, atomicWrite, withFileLock } from "./files.mjs";
import {
  appIsRunning,
  blockValues,
  disableIntegration,
  editCodexConfig,
  inspectCodexBaseline,
  integrationPaths,
  integrationStatus,
  readIntegrationState,
  restoreCodexConfig,
  syncIntegration,
} from "./integration.mjs";
import { loadCodexAuth } from "./local-identity.mjs";
import { credential } from "./providers.mjs";
import {
  drainService,
  installService,
  installSpaceSwitcher,
  preflightCandidate,
  serviceStatus,
  spaceSwitcherStatus,
  uninstallSpaceSwitcher,
  uninstallService,
} from "./service-manager.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const ref = (value) => `${value.space}@${value.revision}`;

async function fileHash(path) {
  try {
    return hash(await readFile(path));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function safeFailure(error) {
  const allowed = new Set([
    "active_turn_timeout",
    "app_running",
    "config_conflict",
    "integration_conflict",
    "integration_catalog_conflict",
    "provider_credential_missing",
    "space_default_model_unavailable",
    "space_source_changed",
    "space_target_changed",
    "space_verification_failed",
  ]);
  const code = allowed.has(error.code) ? error.code : "space_switch_failed";
  return {
    code,
    message: code === "space_switch_failed"
      ? "configuration space switch failed; recovery material was retained"
      : error.message,
    at: Date.now(),
  };
}

async function verifyCredentials(config, options = {}) {
  const usedProviders = new Set(
    Object.values(config.targets ?? {}).map((target) => target.provider),
  );
  for (const [id, provider] of Object.entries(config.providers ?? {})) {
    if (!usedProviders.has(id)) continue;
    if (!provider.apiKeyEnv && !provider.keychain) continue;
    let secret;
    try { secret = await credential(provider, options.env); } catch {}
    if (!secret)
      throw Object.assign(Error(`credential is unavailable for provider ${id}`), {
        code: "provider_credential_missing",
      });
  }
  if (config.subscription?.enabled) {
    const loaded = await loadCodexAuth({ env: options.env });
    if (!loaded.auth?.tokens?.access_token || !loaded.auth?.tokens?.account_id)
      throw Object.assign(Error("ChatGPT subscription identity is unavailable"), {
        code: "trusted_subscription_identity_unavailable",
      });
  }
}

function defaultOperations(options, configPath) {
  const env = options.env ?? process.env;
  const serverPath = options.serverPath ?? fileURLToPath(
    new URL("./server.mjs", import.meta.url),
  );
  return {
    appRunning: options.appRunning ?? (() => appIsRunning(env)),
    verifyCredentials: options.verifyCredentials ?? ((config) =>
      verifyCredentials(config, { env })),
    preflight: options.preflight ?? ((candidatePath) =>
      preflightCandidate(serverPath, candidatePath, { env })),
    installSwitcher: options.installSwitcher ?? (() => installSpaceSwitcher({ env })),
    uninstallSwitcher: options.uninstallSwitcher ?? (() => uninstallSpaceSwitcher({
      env,
      skipBootout: options.coordinator === true,
    })),
    drain: options.drain ?? (() => drainService(configPath, {
      env,
      waitMs: options.waitMs,
      pollMs: options.pollMs,
    })),
    installService: options.installService ?? (() => installService(configPath, { env })),
    stopService: options.stopService ?? (() => uninstallService({ env })),
    resumeService: options.resumeService ?? ((pid) => {
      if (Number.isInteger(pid)) process.kill(pid, "SIGUSR1");
    }),
    serviceStatus: options.serviceStatus ?? (() => serviceStatus(configPath, env)),
    syncIntegration: options.syncIntegration ?? ((config, syncOptions) =>
      syncIntegration(config, { ...syncOptions, env })),
    disableIntegration: options.disableIntegration ?? ((disableOptions) =>
      disableIntegration({ ...disableOptions, env })),
    integrationStatus: options.integrationStatus ?? ((config) =>
      integrationStatus(config, { env })),
    verifyOfficialBaseline: options.verifyOfficialBaseline ?? (async (baseline) => {
      const paths = integrationPaths(env, options.codexHome);
      const current = inspectCodexBaseline(await readFile(paths.config, "utf8"));
      const expected = baseline.values ?? blockValues(Object.values(baseline.managed ?? {}));
      if (digestJSON(current.values) !== digestJSON(expected))
        throw Object.assign(Error("official Codex settings do not match the target revision"), {
          code: "space_verification_failed",
        });
      const expectedCatalogHash = baseline.catalog?.present
        ? baseline.catalog.sha256
        : null;
      if (await fileHash(paths.catalog) !== expectedCatalogHash)
        throw Object.assign(Error("official Codex catalog does not match the target revision"), {
          code: "space_verification_failed",
        });
    }),
  };
}

async function writeTransaction(paths, transaction) {
  transaction.updatedAt = Date.now();
  await atomicJSON(paths.spaceTransaction, transaction);
  return transaction;
}

async function installSwitcherForTransaction(transaction, options, env) {
  await (options.installSwitcher ?? (() => installSpaceSwitcher({ env })))();
  const current = await readSpaceTransaction(env);
  if (!current) {
    const index = await readSpaceIndex(env);
    if (
      index?.active?.space === transaction.target.space &&
      index.active.revision === transaction.target.revision
    ) return {
      changed: true,
      pending: false,
      active: index.active,
      previous: index.previous,
      completedByCoordinator: true,
    };
    await (options.uninstallSwitcher ?? (() => uninstallSpaceSwitcher({ env })))().catch(() => {});
    throw Object.assign(Error("the pending space switch was cancelled while its coordinator was installed"), {
      code: "space_switch_cancelled",
    });
  }
  if (current.id !== transaction.id)
    throw Object.assign(Error("the pending space switch was superseded while its coordinator was installed"), {
      code: "space_switch_superseded",
    });
  return null;
}

async function assertSourceFiles(transaction, configPath, codexConfigPath, catalogPath) {
  const [configHash, codexHash, catalogHash] = await Promise.all([
    fileHash(configPath),
    fileHash(codexConfigPath),
    fileHash(catalogPath),
  ]);
  if (
    configHash !== transaction.sourceFiles.gatewayConfigHash ||
    codexHash !== transaction.sourceFiles.codexConfigHash ||
    catalogHash !== transaction.sourceFiles.catalogHash
  )
    throw Object.assign(Error("source files changed after the switch was prepared"), {
      code: "space_source_changed",
    });
}

async function assertAppliedFiles(transaction) {
  const expected = transaction.appliedFiles;
  if (!expected)
    throw Object.assign(Error("the switch has no applied-file checkpoint"), {
      code: "space_switch_recovery_required",
    });
  const [gateway, codex, catalog] = await Promise.all([
    fileHash(transaction.sourceFiles.gatewayConfigPath),
    fileHash(transaction.sourceFiles.codexConfigPath),
    fileHash(transaction.sourceFiles.catalogPath),
  ]);
  if (
    gateway !== expected.gatewayConfigHash ||
    codex !== expected.codexConfigHash ||
    catalog !== expected.catalogHash
  ) throw Object.assign(Error("materialized files changed after verification"), {
    code: "space_source_changed",
  });
}

async function candidateConfigFor(target, sourceConfig) {
  return target.kind === "router"
    ? composeRuntimeConfig(sourceConfig, target)
    : sourceConfig;
}

async function expectedIntegrationFiles(target, targetConfig, env, codexHome) {
  const paths = integrationPaths(env, codexHome);
  const configText = await readFile(paths.config, "utf8");
  if (target.kind === "official") {
    const stored = await readIntegrationState(env);
    const restored = restoreCodexConfig(configText, {
      managed: stored?.managed ?? {},
      baseline: target.codexBaseline.managed ?? {},
    });
    return {
      codexConfigHash: hash(Buffer.from(restored.text)),
      catalogHash: target.codexBaseline.catalog?.present
        ? target.codexBaseline.catalog.sha256
        : null,
    };
  }
  const stored = await readIntegrationState(env);
  const managed = {
    model_provider: "openai",
    model: target.defaultCodexModel,
    openai_base_url: `http://${targetConfig.listen?.host ?? "127.0.0.1"}:${targetConfig.listen?.port ?? 8788}/subscription/v1`,
    model_catalog_json: paths.catalog,
  };
  const edited = editCodexConfig(configText, managed, stored?.managed);
  const sourceCatalog = JSON.parse(await readFile(paths.sourceCatalog, "utf8"));
  const catalog = Buffer.from(
    JSON.stringify(buildModelCatalog(sourceCatalog, targetConfig), null, 2) + "\n",
  );
  return {
    codexConfigHash: hash(Buffer.from(edited.text)),
    catalogHash: hash(catalog),
  };
}

async function prepareCandidate(target, sourceConfig, options, paths, operations) {
  if (target.kind !== "router") return { config: sourceConfig, hash: digestJSON(sourceConfig) };
  const config = await candidateConfigFor(target, sourceConfig);
  await operations.verifyCredentials(await materializeRuntimeConfig(sourceConfig, target));
  const path = resolve(paths.runtime, `space-candidate-${process.pid}-${randomUUID()}.json`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await atomicJSON(path, config);
  try {
    await operations.preflight(path);
  } finally {
    await rm(path, { force: true });
  }
  return { config, hash: digestJSON(config) };
}

async function latestOfficial(env) {
  const index = await readSpaceIndex(env);
  return resolveSpace(`official@${index.spaces.official.latestRevision}`, env);
}

export async function beginSpaceSwitch(targetInput, options = {}) {
  const env = options.env ?? process.env;
  const paths = spacePaths(env);
  const prepared = await withFileLock(paths.spaceTransactionLock, async () => {
    const configPath = resolve(options.configPath ?? paths.config);
    const codexPaths = integrationPaths(env, options.codexHome);
    const operations = defaultOperations(options, configPath);
    let index = await readSpaceIndex(env);
    if (!index)
      throw Object.assign(Error("configuration spaces are not initialized"), {
        code: "spaces_not_initialized",
      });
    let parsed = parseSpaceRef(targetInput);
    const entry = index.spaces[parsed.space];
    if (!entry)
      throw Object.assign(Error(`configuration space does not exist: ${parsed.space}`), {
        code: "space_not_found",
      });
    parsed = { space: parsed.space, revision: parsed.revision ?? entry.latestRevision };
    if (index.active?.space === parsed.space && index.active?.revision === parsed.revision)
      return { result: { changed: false, pending: false, active: index.active } };

    const existing = await readSpaceTransaction(env);
    if (existing) {
      if (ref(existing.target) !== ref(parsed))
        throw Object.assign(Error(`another space switch is pending: ${ref(existing.target)}`), {
          code: "space_switch_pending",
        });
      return { resume: true };
    }

    if (index.active.space === OFFICIAL_SPACE) {
      await captureOfficialSpace({ env, codexHome: options.codexHome });
      index = await readSpaceIndex(env);
    } else {
      const drift = await detectSpaceDrift({ env, configPath });
      if (drift.drift)
        throw Object.assign(Error("the materialized Router config has drift; capture or restore it before switching"), {
          code: "space_config_drift",
        });
    }

    const target = await resolveSpace(ref(parsed), env);
    const [sourceConfigBytes, sourceCodexConfigHash, sourceCatalogHash] = await Promise.all([
      readFile(configPath),
      fileHash(codexPaths.config),
      fileHash(codexPaths.catalog),
    ]);
    const sourceGatewayConfigHash = hash(sourceConfigBytes);
    const sourceConfig = JSON.parse(sourceConfigBytes);
    const candidate = await prepareCandidate(
      target,
      sourceConfig,
      options,
      paths,
      operations,
    );
    if (
      await fileHash(configPath) !== sourceGatewayConfigHash ||
      await fileHash(codexPaths.config) !== sourceCodexConfigHash ||
      await fileHash(codexPaths.catalog) !== sourceCatalogHash
    ) throw Object.assign(Error("source files changed during candidate preflight"), {
      code: "space_source_changed",
    });
    const source = index.active;
    const sourceRevision = await resolveSpace(ref(source), env);
    const transaction = {
      schemaVersion: 1,
      id: randomUUID(),
      source,
      target: parsed,
      sourceRevisionHash: sourceRevision.contentHash,
      targetRevisionHash: target.contentHash,
      targetRuntimeHash: candidate.hash,
      sourceFiles: {
        gatewayConfigPath: configPath,
        gatewayConfigHash: sourceGatewayConfigHash,
        codexConfigPath: codexPaths.config,
        codexConfigHash: sourceCodexConfigHash,
        catalogPath: codexPaths.catalog,
        catalogHash: sourceCatalogHash,
      },
      expectedFiles: {
        gatewayConfigHash: hash(Buffer.from(JSON.stringify(candidate.config, null, 2) + "\n")),
      },
      recovery: {
        sourceRuntimeConfig: sourceConfig,
        sourceRuntimeConfigBytesBase64: sourceConfigBytes.toString("base64"),
      },
      stage: "prepared",
      attempts: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await writeTransaction(paths, transaction);
    if (await operations.appRunning()) {
      transaction.stage = "pending_app_quit";
      await writeTransaction(paths, transaction);
      return {
        installSwitcher: operations.installSwitcher,
        result: { changed: true, pending: true, transaction },
      };
    }
    return { resume: true };
  });
  if (prepared.installSwitcher) {
    const completed = await installSwitcherForTransaction(
      prepared.result.transaction,
      options,
      env,
    );
    if (completed) return completed;
  }
  return prepared.resume ? resumeSpaceSwitch(options) : prepared.result;
}

async function applyIntegration(
  target,
  targetConfig,
  official,
  operations,
  configPath,
  recovery = false,
  expectedCurrentFiles = null,
) {
  const expected = expectedCurrentFiles ? {
    expectedCodexConfigHash: expectedCurrentFiles.codexConfigHash,
    expectedCatalogHash: expectedCurrentFiles.catalogHash,
  } : {};
  if (target.kind === "official") {
    return operations.disableIntegration({
      officialBaseline: target.codexBaseline,
      officialSpaceRef: ref(target),
      applyWhileRunning: true,
      force: recovery,
      trustedCurrentFiles: recovery,
      ...expected,
    });
  }
  return operations.syncIntegration(targetConfig, {
    selectedModel: target.defaultCodexModel,
    officialBaseline: official.codexBaseline,
    officialSpaceRef: ref(official),
    spaceRef: ref(target),
    gatewayConfigPath: configPath,
    applyWhileRunning: true,
    force: recovery,
    ...expected,
  });
}

async function rollback(transaction, options, operations, paths, error) {
  const configPath = transaction.sourceFiles.gatewayConfigPath;
  const codexPath = transaction.sourceFiles.codexConfigPath;
  const catalogPath = transaction.sourceFiles.catalogPath;
  const checkpointed = (key) => Object.hasOwn(transaction.appliedFiles ?? {}, key);
  try {
    const sourceFilesUnchanged =
      await fileHash(configPath) === transaction.sourceFiles.gatewayConfigHash &&
      await fileHash(codexPath) === transaction.sourceFiles.codexConfigHash &&
      await fileHash(catalogPath) === transaction.sourceFiles.catalogHash;
    if (!transaction.appliedFiles && sourceFilesUnchanged) {
      if (transaction.sourceDrainCompleted && transaction.sourceServiceWasRunning)
        await operations.resumeService(transaction.sourceServicePid);
      transaction.stage = "failed";
      transaction.recovered = true;
      transaction.failure = safeFailure(error);
      await writeTransaction(paths, transaction);
      return;
    }
    if (
      !checkpointed("gatewayConfigHash") &&
      ![
        transaction.sourceFiles.gatewayConfigHash,
        transaction.expectedFiles?.gatewayConfigHash,
      ].includes(await fileHash(configPath))
    ) throw Object.assign(Error("gateway config changed before recovery"), {
      code: "space_source_changed",
    });
    if (
      !checkpointed("codexConfigHash") &&
      ![
        transaction.sourceFiles.codexConfigHash,
        transaction.expectedFiles?.codexConfigHash,
      ].includes(await fileHash(codexPath))
    ) throw Object.assign(Error("Codex config changed before recovery"), {
      code: "space_source_changed",
    });
    if (
      !checkpointed("catalogHash") &&
      ![
        transaction.sourceFiles.catalogHash,
        transaction.expectedFiles?.catalogHash,
      ].includes(await fileHash(catalogPath))
    ) throw Object.assign(Error("Codex catalog changed before recovery"), {
      code: "space_source_changed",
    });
    if (
      checkpointed("gatewayConfigHash") &&
      await fileHash(configPath) !== transaction.appliedFiles.gatewayConfigHash
    ) throw Object.assign(Error("gateway config changed during recovery"), {
      code: "space_source_changed",
    });
    if (
      checkpointed("codexConfigHash") &&
      await fileHash(codexPath) !== transaction.appliedFiles.codexConfigHash
    ) throw Object.assign(Error("Codex config changed during recovery"), {
      code: "space_source_changed",
    });
    if (
      checkpointed("catalogHash") &&
      await fileHash(catalogPath) !== transaction.appliedFiles.catalogHash
    ) throw Object.assign(Error("Codex catalog changed during recovery"), {
      code: "space_source_changed",
    });
    const current = await rawConfig(configPath);
    if (await fileHash(configPath) !== transaction.sourceFiles.gatewayConfigHash) {
      if (transaction.recovery.sourceRuntimeConfigBytesBase64) {
        const sourceBytes = Buffer.from(
          transaction.recovery.sourceRuntimeConfigBytesBase64,
          "base64",
        );
        if (hash(sourceBytes) !== transaction.sourceFiles.gatewayConfigHash)
          throw Object.assign(Error("source Gateway config recovery snapshot is invalid"), {
            code: "space_source_changed",
          });
        await atomicWrite(configPath, sourceBytes);
      } else if (digestJSON(current) !== digestJSON(transaction.recovery.sourceRuntimeConfig)) {
        await writeConfigTransaction(
          configPath,
          current,
          transaction.recovery.sourceRuntimeConfig,
          { apply: true, env: options.env },
        );
      }
    }
    const source = await resolveSpace(ref(transaction.source), options.env);
    const official = await latestOfficial(options.env);
    const sourceIntegrationConfig = source.kind === "router"
      ? await loadConfig(configPath)
      : transaction.recovery.sourceRuntimeConfig;
    const recoveryCurrentFiles = {
      codexConfigHash: await fileHash(codexPath),
      catalogHash: await fileHash(catalogPath),
    };
    await applyIntegration(
      source,
      sourceIntegrationConfig,
      official,
      operations,
      configPath,
      true,
      recoveryCurrentFiles,
    );
    if (source.kind === "official" || transaction.sourceServiceWasRunning === false)
      await operations.stopService();
    else await operations.installService();
    transaction.sourceFiles.gatewayConfigHash = await fileHash(configPath);
    transaction.sourceFiles.codexConfigHash = await fileHash(codexPath);
    transaction.sourceFiles.catalogHash = await fileHash(catalogPath);
    transaction.stage = "failed";
    transaction.recovered = true;
    transaction.failure = safeFailure(error);
    delete transaction.appliedFiles;
  } catch (recoveryError) {
    transaction.stage = "failed";
    transaction.recovered = false;
    transaction.failure = safeFailure(error);
    transaction.recoveryFailure = safeFailure(recoveryError);
    if (transaction.sourceDrainCompleted && transaction.sourceServiceWasRunning) {
      try {
        await operations.resumeService(transaction.sourceServicePid);
        transaction.sourceServiceResumed = true;
      } catch (resumeError) {
        transaction.serviceResumeFailure = safeFailure(resumeError);
      }
    }
  }
  await writeTransaction(paths, transaction);
}

async function verifyApplied(target, targetConfig, operations, env) {
  const integration = await operations.integrationStatus(targetConfig);
  let service = await operations.serviceStatus();
  if (
    target.kind === "router" &&
    env.CODEX_LOCAL_ROUTER_TEST_LAUNCHCTL !== "1" &&
    !service.running
  ) {
    for (let attempt = 0; attempt < 20 && !service.running; attempt++) {
      await new Promise((done) => setTimeout(done, 100));
      service = await operations.serviceStatus();
    }
  }
  if (target.kind === "official") {
    await operations.verifyOfficialBaseline(target.codexBaseline);
    if (integration.active || service.running)
      throw Object.assign(Error("official space verification failed"), {
        code: "space_verification_failed",
      });
  } else if (
    !integration.active || integration.pending ||
    integration.configCurrent === false || integration.catalogCurrent === false ||
    (env.CODEX_LOCAL_ROUTER_TEST_LAUNCHCTL !== "1" && !service.running)
  ) throw Object.assign(Error("Router space verification failed"), {
    code: "space_verification_failed",
  });
  return { integration, service };
}

export async function resumeSpaceSwitch(options = {}) {
  const env = options.env ?? process.env;
  const paths = spacePaths(env);
  const outcome = await withFileLock(paths.spaceTransactionLock, async () => {
    let transaction = await readSpaceTransaction(env);
    if (!transaction) return { changed: false, pending: false, transaction: null };
    if (options.expectedTransactionId && transaction.id !== options.expectedTransactionId)
      return { changed: false, pending: true, staleCoordinator: true };
    const configPath = transaction.sourceFiles.gatewayConfigPath;
    const operations = defaultOperations(options, configPath);
    const currentIndex = await readSpaceIndex(env);
    const activeIsTarget =
      currentIndex.active?.space === transaction.target.space &&
      currentIndex.active?.revision === transaction.target.revision;
    if (
      transaction.stage === "verified" ||
      (transaction.stage === "applying" && activeIsTarget)
    ) {
      await assertAppliedFiles(transaction);
      const target = await resolveSpace(ref(transaction.target), env);
      const integrationConfig = target.kind === "router"
        ? await loadConfig(configPath)
        : transaction.recovery.sourceRuntimeConfig;
      const verification = await verifyApplied(target, integrationConfig, operations, env);
      await assertAppliedFiles(transaction);
      const index = activeIsTarget
        ? currentIndex
        : await commitSpaceActivation(transaction.target, {
            env,
            expectedActive: transaction.source,
          });
      await rm(paths.spaceTransaction, { force: true });
      await operations.uninstallSwitcher().catch(() => {});
      return {
        changed: !activeIsTarget,
        pending: false,
        active: index.active,
        previous: index.previous,
        verification,
        recoveredCommit: true,
      };
    }
    if (transaction.stage === "failed" && transaction.recovered === false)
      throw Object.assign(Error("the previous switch could not be recovered safely"), {
        code: "space_switch_recovery_required",
      });
    if (await operations.appRunning())
      return {
        changed: false,
        pending: true,
        transaction,
        waitForApp: options.coordinator === true,
      };
    if (transaction.stage === "applying") {
      const recoverySource = await resolveSpace(ref(transaction.source), env);
      const drained = recoverySource.kind === "router"
        ? await operations.drain()
        : { drained: true, wasRunning: false };
      transaction.sourceServiceWasRunning ??= drained.wasRunning;
      transaction.sourceServicePid ??= drained.before?.health?.pid;
      transaction.sourceDrainCompleted = drained.drained;
      await writeTransaction(paths, transaction);
      if (!drained.drained) {
        const error = Object.assign(Error("active Gateway turns did not finish before recovery"), {
          code: "active_turn_timeout",
        });
        transaction.failure = safeFailure(error);
        await writeTransaction(paths, transaction);
        throw error;
      }
      await rollback(
        transaction,
        options,
        operations,
        paths,
        Object.assign(Error("the previous switch process ended during apply"), {
          code: "space_switch_interrupted",
        }),
      );
      transaction = await readSpaceTransaction(env);
      if (!transaction.recovered)
        throw Object.assign(Error("the interrupted switch could not be recovered safely"), {
          code: "space_switch_recovery_required",
        });
    }
    transaction.attempts += 1;
    transaction.stage = "applying";
    delete transaction.failure;
    delete transaction.recoveryFailure;
    await writeTransaction(paths, transaction);
    try {
      await assertSourceFiles(
        transaction,
        transaction.sourceFiles.gatewayConfigPath,
        transaction.sourceFiles.codexConfigPath,
        transaction.sourceFiles.catalogPath,
      );
      const [source, target] = await Promise.all([
        resolveSpace(ref(transaction.source), env),
        resolveSpace(ref(transaction.target), env),
      ]);
      if (source.contentHash !== transaction.sourceRevisionHash)
        throw Object.assign(Error("source space revision changed"), { code: "space_source_changed" });
      if (target.contentHash !== transaction.targetRevisionHash)
        throw Object.assign(Error("target space revision changed"), { code: "space_target_changed" });
      const currentConfig = await rawConfig(transaction.sourceFiles.gatewayConfigPath);
      const targetConfig = await candidateConfigFor(target, currentConfig);
      if (digestJSON(targetConfig) !== transaction.targetRuntimeHash)
        throw Object.assign(Error("target runtime config changed"), { code: "space_target_changed" });
      const drained = source.kind === "router"
        ? await operations.drain()
        : { drained: true, wasRunning: false };
      transaction.sourceServiceWasRunning = drained.wasRunning;
      transaction.sourceServicePid = drained.before?.health?.pid;
      transaction.sourceDrainCompleted = drained.drained;
      await writeTransaction(paths, transaction);
      if (!drained.drained)
        throw Object.assign(Error("active Gateway turns did not finish before the timeout"), {
          code: "active_turn_timeout",
        });
      if (await operations.appRunning())
        throw Object.assign(Error("Codex App reopened before the switch could be applied"), {
          code: "app_running",
        });
      await assertSourceFiles(
        transaction,
        transaction.sourceFiles.gatewayConfigPath,
        transaction.sourceFiles.codexConfigPath,
        transaction.sourceFiles.catalogPath,
      );
      if (target.kind === "router" && digestJSON(currentConfig) !== digestJSON(targetConfig))
        await writeConfigTransaction(
          transaction.sourceFiles.gatewayConfigPath,
          currentConfig,
          targetConfig,
          { apply: true, env },
        );
      transaction.appliedFiles = {
        gatewayConfigHash: await fileHash(transaction.sourceFiles.gatewayConfigPath),
      };
      await writeTransaction(paths, transaction);
      const official = await latestOfficial(env);
      const integrationConfig = target.kind === "router"
        ? await loadConfig(transaction.sourceFiles.gatewayConfigPath)
        : targetConfig;
      transaction.expectedFiles = {
        ...transaction.expectedFiles,
        ...await expectedIntegrationFiles(target, integrationConfig, env, options.codexHome),
      };
      await writeTransaction(paths, transaction);
      await applyIntegration(
        target,
        integrationConfig,
        official,
        operations,
        transaction.sourceFiles.gatewayConfigPath,
        false,
        {
          codexConfigHash: transaction.sourceFiles.codexConfigHash,
          catalogHash: transaction.sourceFiles.catalogHash,
        },
      );
      const [appliedCodexConfigHash, appliedCatalogHash] = await Promise.all([
        fileHash(transaction.sourceFiles.codexConfigPath),
        fileHash(transaction.sourceFiles.catalogPath),
      ]);
      if (
        appliedCodexConfigHash !== transaction.expectedFiles.codexConfigHash ||
        appliedCatalogHash !== transaction.expectedFiles.catalogHash
      ) throw Object.assign(Error("Codex integration files changed while they were applied"), {
        code: "space_source_changed",
      });
      transaction.appliedFiles.codexConfigHash = transaction.expectedFiles.codexConfigHash;
      transaction.appliedFiles.catalogHash = transaction.expectedFiles.catalogHash;
      await writeTransaction(paths, transaction);
      if (target.kind === "official") await operations.stopService();
      else await operations.installService();
      const verification = await verifyApplied(target, integrationConfig, operations, env);
      await assertAppliedFiles(transaction);
      transaction.stage = "verified";
      await writeTransaction(paths, transaction);
      const index = await commitSpaceActivation(transaction.target, {
        env,
        expectedActive: transaction.source,
      });
      await rm(paths.spaceTransaction, { force: true });
      await operations.uninstallSwitcher().catch(() => {});
      return {
        changed: true,
        pending: false,
        active: index.active,
        previous: index.previous,
        verification,
      };
    } catch (error) {
      await rollback(transaction, options, operations, paths, error);
      throw error;
    }
  });
  if (!outcome.waitForApp) {
    if (outcome.pending && outcome.transaction && !options.coordinator) {
      const completed = await installSwitcherForTransaction(
        outcome.transaction,
        options,
        env,
      );
      if (completed) return completed;
    }
    return outcome;
  }
  const appRunning = options.appRunning ?? (() => appIsRunning(env));
  const deadline = Date.now() + (options.coordinatorWaitMs ?? 24 * 60 * 60 * 1000);
  while (await appRunning()) {
    if (Date.now() >= deadline) {
      const { waitForApp, ...pending } = outcome;
      return pending;
    }
    await new Promise((done) => setTimeout(done, options.appPollMs ?? 2000));
  }
  return resumeSpaceSwitch({
    ...options,
    expectedTransactionId: outcome.transaction.id,
  });
}

export async function cancelSpaceSwitch(options = {}) {
  const env = options.env ?? process.env;
  const paths = spacePaths(env);
  return withFileLock(paths.spaceTransactionLock, async () => {
    const transaction = await readSpaceTransaction(env);
    if (!transaction) return { changed: false };
    if (transaction.stage === "applying" || (transaction.stage === "failed" && !transaction.recovered))
      throw Object.assign(Error("the failed switch requires recovery before it can be cancelled"), {
        code: "space_switch_recovery_required",
      });
    if (transaction.stage === "verified")
      throw Object.assign(Error("the verified switch must commit or recover before it can be cancelled"), {
        code: "space_switch_recovery_required",
      });
    await rm(paths.spaceTransaction, { force: true });
    await (options.uninstallSwitcher ?? (() => uninstallSpaceSwitcher({ env })))().catch(() => {});
    return { changed: true, cancelled: ref(transaction.target) };
  });
}

export async function configurationSpaceStatus(options = {}) {
  const env = options.env ?? process.env;
  const [index, pending, switcher] = await Promise.all([
    readSpaceIndex(env),
    readSpaceTransaction(env),
    spaceSwitcherStatus(env),
  ]);
  const drift = index ? await detectSpaceDrift({
    env,
    configPath: options.configPath,
  }) : { drift: false, active: null };
  return {
    initialized: !!index,
    active: index?.active ?? null,
    previous: index?.previous ?? null,
    pending: pending
      ? { source: pending.source, target: pending.target, stage: pending.stage, attempts: pending.attempts }
      : null,
    drift: drift.drift,
    driftDetail: drift,
    coordinator: switcher,
  };
}

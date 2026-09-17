import { createHash } from "node:crypto";

const messageFields = ["instructions_template", "instructions_variables", "persistent_instructions"];
const own = (object, key) => Object.hasOwn(object ?? {}, key);
const stable = (value) => Array.isArray(value) ? value.map(stable)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
export const instructionHash = (value) => createHash("sha256")
  .update(JSON.stringify(stable(value))).digest("hex");
const fail = (code) => { throw Object.assign(Error(code.replaceAll("_", " ")), { code }); };
export const canInheritInstructions = (target) => target.provider !== "chatgpt-subscription" &&
  target.wireApi === "responses" && target.app?.enabled === true;

function content(app) {
  return Object.fromEntries(["baseInstructions", "modelMessages"]
    .filter((key) => own(app, key)).map((key) => [key, app[key]]));
}

function sourceContent(catalog, model) {
  const matches = catalog?.models?.filter((entry) => entry.slug === model) ?? [];
  if (matches.length !== 1) fail("instruction_source_unresolved");
  const source = matches[0], result = {};
  if (own(source, "base_instructions")) {
    if (typeof source.base_instructions !== "string") fail("instruction_source_invalid");
    result.baseInstructions = source.base_instructions;
  }
  if (source.model_messages != null) {
    if (typeof source.model_messages !== "object" || Array.isArray(source.model_messages))
      fail("instruction_source_invalid");
    result.modelMessages = Object.fromEntries(messageFields.filter((key) => own(source.model_messages, key))
      .map((key) => [key, structuredClone(source.model_messages[key])]));
    for (const key of ["instructions_template", "persistent_instructions"])
      if (own(result.modelMessages, key) && result.modelMessages[key] != null && typeof result.modelMessages[key] !== "string")
        fail("instruction_source_invalid");
    const variables = result.modelMessages.instructions_variables;
    if (variables != null && (typeof variables !== "object" || Array.isArray(variables)))
      fail("instruction_source_invalid");
  } else if (own(source, "model_messages")) result.modelMessages = null;
  if (![result.baseInstructions, result.modelMessages?.instructions_template]
    .some((value) => typeof value === "string" && value.trim())) fail("instruction_source_empty");
  return result;
}

export function validateInstructionSource(target) {
  const source = target.app?.instructionSource;
  if (source == null) return;
  if (source.mode === "none") {
    if (Object.keys(source).length !== 1) fail("instruction_snapshot_invalid");
    return;
  }
  if (["builtin-template", "custom"].includes(source.mode)) {
    if (target.provider === "chatgpt-subscription" || target.wireApi !== "responses" || target.app?.enabled !== true ||
        source.status !== "pinned" || source.snapshotVersion !== 1 ||
        !/^[a-f0-9]{64}$/.test(source.contentHash ?? "") ||
        source.contentHash !== instructionHash(content(target.app)) ||
        Object.keys(source).some((key) => !["mode", "status", "snapshotVersion", "contentHash", "template"].includes(key)) ||
        (source.mode === "builtin-template" && (typeof source.template !== "string" || !source.template)) ||
        (source.mode === "custom" && Object.hasOwn(source, "template")))
      fail("instruction_snapshot_invalid");
    sourceContent({ models: [{ slug: "managed",
      ...(own(target.app, "baseInstructions") ? { base_instructions: target.app.baseInstructions } : {}),
      ...(own(target.app, "modelMessages") ? { model_messages: target.app.modelMessages } : {}),
    }] }, "managed");
    return;
  }
  if (target.provider === "chatgpt-subscription" || target.wireApi !== "responses" || source.mode !== "official-snapshot" ||
      typeof source.sourceModel !== "string" || !source.sourceModel.trim() ||
      source.upstreamModel !== target.model) fail("instruction_snapshot_invalid");
  if (Object.keys(source).some((key) => !["mode", "sourceModel", "upstreamModel", "status", "snapshotVersion", "contentHash", "sourceCatalogHash", "capturedAt", "clientVersion"].includes(key)))
    fail("instruction_snapshot_invalid");
  if (source.status === "source-unresolved") {
    if (source.snapshotVersion !== 0 || Object.keys(content(target.app)).length ||
        Object.keys(source).some((key) => !["mode", "sourceModel", "upstreamModel", "status", "snapshotVersion"].includes(key)))
      fail("instruction_snapshot_invalid");
    return;
  }
  if (source.status !== "pinned" || !Number.isSafeInteger(source.snapshotVersion) || source.snapshotVersion < 1 ||
      !/^[a-f0-9]{64}$/.test(source.sourceCatalogHash ?? "") ||
      typeof source.clientVersion !== "string" || !source.clientVersion ||
      !Number.isFinite(Date.parse(source.capturedAt))) fail("instruction_snapshot_invalid");
  if (source.contentHash !== instructionHash(content(target.app))) fail("instruction_snapshot_hash_mismatch");
  sourceContent({ models: [{ slug: source.sourceModel,
    ...(own(target.app, "baseInstructions") ? { base_instructions: target.app.baseInstructions } : {}),
    ...(own(target.app, "modelMessages") ? { model_messages: target.app.modelMessages } : {}),
  }] }, source.sourceModel);
  if (target.app.modelMessages && Object.keys(target.app.modelMessages).some((key) => !messageFields.includes(key)))
    fail("instruction_snapshot_invalid");
}

// This is only called by explicit configuration writers, never config load or Relay.
export function captureInstructions(target, catalog, { sourceModel, automatic = false, clientVersion, now = new Date().toISOString() } = {}) {
  const next = structuredClone(target);
  const current = target.app?.instructionSource;
  if (sourceModel === "none") {
    if (["official-snapshot", "builtin-template", "custom"].includes(current?.mode)) {
      validateInstructionSource(target);
      delete next.app.baseInstructions;
      delete next.app.modelMessages;
    }
    next.app ??= {};
    delete next.app.instructionDelivery;
    next.app.instructionSource = { mode: "none" };
    return next;
  }
  if (!canInheritInstructions(target)) {
    if (automatic) return next;
    fail("instruction_target_ineligible");
  }
  if (automatic && target.modelFamily !== "openai-gpt") return next;
  if (current) validateInstructionSource(sourceModel && current.upstreamModel
    ? { ...target, model: current.upstreamModel } : target);
  if (automatic && current) return next;
  if (current?.mode !== "official-snapshot" && Object.keys(content(target.app)).length) {
    if (automatic) return next;
    fail("instruction_custom_conflict");
  }
  const model = sourceModel ?? current?.sourceModel ?? target.model;
  let body;
  try { body = sourceContent(catalog, model); }
  catch (error) {
    if (!automatic) throw error;
    next.app.instructionSource = { mode: "official-snapshot", sourceModel: model,
      upstreamModel: target.model, status: "source-unresolved", snapshotVersion: 0 };
    return next;
  }
  const contentHash = instructionHash(body);
  if (current?.sourceModel === model && current.upstreamModel === target.model && current.contentHash === contentHash) return next;
  if (!clientVersion) fail("instruction_client_version_unavailable");
  delete next.app.baseInstructions;
  delete next.app.modelMessages;
  Object.assign(next.app, body, { instructionSource: {
    mode: "official-snapshot", status: "pinned", sourceModel: model, upstreamModel: target.model,
    snapshotVersion: (current?.snapshotVersion ?? 0) + 1, contentHash,
    sourceCatalogHash: instructionHash(catalog), capturedAt: now, clientVersion,
  } });
  return next;
}

export function applyManagedInstructions(target, { mode, template, text } = {}) {
  if (!["builtin-template", "custom"].includes(mode) || typeof text !== "string" || !text.trim())
    fail("instruction_source_invalid");
  if (!canInheritInstructions(target)) fail("instruction_target_ineligible");
  const current = target.app?.instructionSource;
  if (current) validateInstructionSource(target);
  const body = { baseInstructions: text };
  const contentHash = instructionHash(body);
  if (current?.mode === mode && current.contentHash === contentHash && current.template === template)
    return structuredClone(target);
  if (current && current.mode !== "none") fail("instruction_custom_conflict");
  if (!current && Object.keys(content(target.app)).length) fail("instruction_custom_conflict");
  const next = structuredClone(target);
  next.app ??= {};
  delete next.app.baseInstructions;
  delete next.app.modelMessages;
  Object.assign(next.app, body, { instructionSource: {
    mode, status: "pinned", snapshotVersion: 1, contentHash,
    ...(mode === "builtin-template" ? { template } : {}),
  } });
  return next;
}

export function instructionStatus(target, catalog) {
  const source = target.app?.instructionSource;
  const summary = { target: target.id, mode: source?.mode ?? "custom-or-legacy",
    sourceModel: source?.sourceModel ?? null, contentHash: source?.contentHash ?? null,
    snapshotVersion: source?.snapshotVersion ?? null, status: source?.status ?? (source?.mode === "none" ? "disabled" : "unmanaged"),
    updateAvailable: null,
    delivery: target.app?.instructionDelivery ?? "client",
    transportCompatibility: target.app?.instructionDelivery === "gateway-lite"
      ? "gateway-lite-snapshot"
      : target.app?.useResponsesLite === true
        ? "lite-client-verification-required"
        : "standard-responses",
  };
  if (source?.mode === "official-snapshot" && catalog) {
    try { summary.updateAvailable = instructionHash(sourceContent(catalog, source.sourceModel)) !== source.contentHash; }
    catch { summary.sourceStatus = "source-unresolved"; }
  }
  return summary;
}

export function catalogInstructions(target) {
  validateInstructionSource(target);
  if (target.app?.instructionSource?.status === "pinned") return {
    ...(own(target.app, "baseInstructions") ? { base_instructions: target.app.baseInstructions } : {}),
    ...(own(target.app, "modelMessages") ? { model_messages: structuredClone(target.app.modelMessages) } : {}),
  };
  return { base_instructions: target.app?.baseInstructions ?? "", model_messages: target.app?.modelMessages ?? null };
}

// Shared CLI presentation boundary: nested revisions and diffs never print bodies.
export function instructionSummary(value) {
  if (value === undefined) return undefined;
  if (value?.redacted === true && Object.keys(value).length === 3 && Number.isInteger(value.bytes) && /^[a-f0-9]{64}$/.test(value.sha256)) return value;
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return { redacted: true, bytes: Buffer.byteLength(serialized), sha256: instructionHash(value) };
}
export function redactInstructions(value) {
  if (Array.isArray(value)) return value.map(redactInstructions);
  if (!value || typeof value !== "object") return value;
  const fields = new Set(["baseInstructions", "modelMessages", "base_instructions", "model_messages"]);
  const instructionDiff = typeof value.path === "string" && value.path.split(".").some((part) => fields.has(part));
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    fields.has(key) || (instructionDiff && ["before", "after"].includes(key))
      ? instructionSummary(child) : redactInstructions(child)]));
}

import { instructionHash, canInheritInstructions } from "./instruction-source.mjs";

const fail = (code) => { throw Object.assign(Error(code.replaceAll("_", " ")), { code }); };
const fields = ["multi_agent_version", "multi_agent_reasoning_effort"];
const efforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
function capabilities(source) {
  if (!source || !["v1", "v2"].includes(source.multi_agent_version)) fail("multi_agent_source_unresolved");
  if (Object.hasOwn(source, fields[1]) && !efforts.has(source[fields[1]])) fail("multi_agent_source_invalid");
  return Object.fromEntries(fields.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]]));
}
function resolve(catalog, model) {
  const matches = Array.isArray(catalog?.models) ? catalog.models.filter((entry) => entry?.slug === model) : [];
  if (matches.length !== 1) fail("multi_agent_source_unresolved");
  return capabilities(matches[0]);
}
export function validateMultiAgentSource(target) {
  const snapshot = target.app?.multiAgent;
  if (snapshot === undefined) return;
  if (!snapshot || Array.isArray(snapshot) || !canInheritInstructions(target) || target.capabilities?.toolCalling !== true)
    fail("multi_agent_snapshot_invalid");
  if (snapshot.mode === "configured") {
    const body = capabilities(snapshot.capabilities);
    if (Object.keys(snapshot).some((key) => !["mode", "contentHash", "capabilities"].includes(key)) ||
        Object.keys(snapshot.capabilities).some((key) => !fields.includes(key)) ||
        snapshot.contentHash !== instructionHash(body)) fail("multi_agent_snapshot_hash_mismatch");
    return;
  }
  if (snapshot.mode !== "official-snapshot" || snapshot.upstreamModel !== target.model ||
      typeof snapshot.sourceModel !== "string" || !snapshot.sourceModel.trim() ||
      typeof snapshot.clientVersion !== "string" || !snapshot.clientVersion.trim() ||
      !Number.isSafeInteger(snapshot.snapshotVersion) || snapshot.snapshotVersion < 1 ||
      typeof snapshot.capturedAt !== "string" || !Number.isFinite(Date.parse(snapshot.capturedAt)) ||
      !/^[a-f0-9]{64}$/.test(snapshot.sourceCatalogHash ?? "") ||
      Object.keys(snapshot).some((key) => !["mode", "sourceModel", "upstreamModel", "clientVersion", "snapshotVersion", "capturedAt", "sourceCatalogHash", "contentHash", "capabilities"].includes(key)))
    fail("multi_agent_snapshot_invalid");
  const body = capabilities(snapshot.capabilities);
  if (Object.keys(snapshot.capabilities).some((key) => !fields.includes(key)) ||
      snapshot.contentHash !== instructionHash(body)) fail("multi_agent_snapshot_hash_mismatch");
}
export function configureMultiAgent(target, version = "v2") {
  if (!canInheritInstructions(target) || target.capabilities?.toolCalling !== true)
    fail("multi_agent_target_ineligible");
  if (!["v1", "v2"].includes(version)) fail("multi_agent_source_invalid");
  const next = structuredClone(target);
  const body = { multi_agent_version: version };
  next.app.multiAgent = {
    mode: "configured",
    contentHash: instructionHash(body),
    capabilities: body,
  };
  return next;
}
export function captureMultiAgent(target, catalog, { sourceModel, clientVersion, now = new Date().toISOString() } = {}) {
  const next = structuredClone(target), current = target.app?.multiAgent;
  if (sourceModel === "none") { if (next.app) delete next.app.multiAgent; return next; }
  if (!canInheritInstructions(target) || target.capabilities?.toolCalling !== true) fail("multi_agent_target_ineligible");
  if (current) validateMultiAgentSource({ ...target, model: current.upstreamModel });
  const model = sourceModel ?? current?.sourceModel ??
    (target.app.instructionSource?.status === "pinned" && target.app.instructionSource.upstreamModel === target.model
      ? target.app.instructionSource.sourceModel : target.model);
  const body = resolve(catalog, model), contentHash = instructionHash(body);
  if (current?.sourceModel === model && current.upstreamModel === target.model && current.contentHash === contentHash) return next;
  if (!clientVersion) fail("multi_agent_client_version_unavailable");
  next.app.multiAgent = { mode: "official-snapshot", sourceModel: model, upstreamModel: target.model,
    clientVersion, snapshotVersion: (current?.snapshotVersion ?? 0) + 1, capturedAt: now,
    sourceCatalogHash: instructionHash(catalog), contentHash, capabilities: body };
  return next;
}
export function catalogMultiAgent(target) {
  validateMultiAgentSource(target);
  return structuredClone(target.app?.multiAgent?.capabilities ?? {});
}
export function multiAgentStatus(target, catalog) {
  validateMultiAgentSource(target);
  const snapshot = target.app?.multiAgent;
  const result = { target: target.id, mode: snapshot?.mode ?? "unchanged",
    sourceModel: snapshot?.sourceModel ?? null, contentHash: snapshot?.contentHash ?? null,
    snapshotVersion: snapshot?.snapshotVersion ?? null, capabilities: catalogMultiAgent(target), updateAvailable: null };
  if (snapshot?.mode === "official-snapshot" && catalog) {
    try { result.updateAvailable = instructionHash(resolve(catalog, snapshot.sourceModel)) !== snapshot.contentHash; }
    catch { result.sourceStatus = "source-unresolved"; }
  }
  return result;
}

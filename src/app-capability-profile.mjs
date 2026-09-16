import { resolveStandaloneSearchPolicy } from "./standalone-search.mjs";

export const THIRD_PARTY_GPT_APP_PROFILES = Object.freeze([
  "standard-tools",
  "lite-search",
]);

const profiles = new Set(THIRD_PARTY_GPT_APP_PROFILES);

export function validateAppCapabilityProfile(
  profile,
  label = "App capability profile",
) {
  if (!profiles.has(profile)) throw Error(`invalid ${label}`);
  return profile;
}

export function resolveAppCapabilityProfile(config, target, options = {}) {
  if (options.official === true || target?.provider === "chatgpt-subscription") {
    return {
      profile: "official-transparent",
      reason: "official-subscription",
      useResponsesLite: false,
      toolSurface: "official-server-managed",
      standaloneSearchAdvertised: true,
    };
  }

  const search = resolveStandaloneSearchPolicy(config, target);
  if (target?.app?.enabled !== true || target?.modelFamily !== "openai-gpt") {
    const reason = target?.app == null
      ? "app-absent"
      : target.app.enabled === true
        ? "non-gpt-unchanged"
        : "app-disabled";
    return {
      profile: null,
      reason,
      useResponsesLite: target?.app?.useResponsesLite === true,
      toolSurface: "unchanged",
      standaloneSearchAdvertised: search.advertised,
    };
  }
  if (target.wireApi !== "responses") {
    return {
      profile: null,
      reason: "non-responses-unchanged",
      useResponsesLite: target.app.useResponsesLite === true,
      toolSurface: "unchanged",
      standaloneSearchAdvertised: search.advertised,
    };
  }

  // Before capability profiles existed, users could explicitly select the
  // Responses Lite transport without enabling standalone search. Preserve
  // that transport-only configuration, but do not label it as the qualified
  // `lite-search` profile: the latter intentionally promises both Lite and an
  // active search source. An explicitly selected capabilityProfile still
  // follows the strict profile invariants below.
  if (
    target.app.capabilityProfile == null &&
    target.app.useResponsesLite === true &&
    !search.advertised
  ) {
    return {
      profile: null,
      reason: "legacy-responses-lite-transport-only",
      useResponsesLite: true,
      toolSurface: "legacy-responses-lite",
      standaloneSearchAdvertised: false,
    };
  }

  let profile;
  let reason;
  if (target.app.capabilityProfile != null) {
    profile = validateAppCapabilityProfile(
      target.app.capabilityProfile,
      `App capability profile for target ${target.id ?? target.model ?? "unknown"}`,
    );
    reason = "target-explicit";
  } else if (target.app.useResponsesLite === false) {
    profile = "standard-tools";
    reason = "legacy-standard-responses";
  } else if (
    search.advertised &&
    (target.standaloneSearch?.source != null || target.app.supportsSearchTool != null)
  ) {
    profile = "lite-search";
    reason = "legacy-search-implied-lite";
  } else if (search.advertised && search.reason === "space-default") {
    profile = "lite-search";
    reason = "space-default-implied-lite";
  } else if (target.app.useResponsesLite === true) {
    profile = "lite-search";
    reason = "legacy-responses-lite";
  } else if (search.advertised) {
    profile = "lite-search";
    reason = "legacy-search-implied-lite";
  } else {
    profile = "standard-tools";
    reason = "standard-default";
  }

  return {
    profile,
    reason,
    useResponsesLite: profile === "lite-search",
    toolSurface:
      profile === "standard-tools"
        ? "policy-filtered-standard"
        : "reduced-responses-lite",
    standaloneSearchAdvertised: search.advertised,
  };
}

export function validateResolvedAppCapabilityProfile(target, resolved, label) {
  if (resolved.profile == null) return resolved;
  const targetLabel = label ?? target?.id ?? target?.model ?? "unknown";
  if (target.wireApi !== "responses")
    throw Error(`App capability profile requires Responses target ${targetLabel}`);
  if (resolved.profile === "standard-tools") {
    if (target.app.useResponsesLite === true)
      throw Error(`standard-tools requires Standard Responses for target ${targetLabel}`);
    if (resolved.standaloneSearchAdvertised)
      throw Error(`standard-tools cannot advertise standalone search for target ${targetLabel}`);
  } else {
    if (target.app.useResponsesLite !== true)
      throw Error(`lite-search requires Responses Lite for target ${targetLabel}`);
    if (!resolved.standaloneSearchAdvertised)
      throw Error(`lite-search requires standalone search for target ${targetLabel}`);
  }
  return resolved;
}

import { applyManagedInstructions } from "./instruction-source.mjs";
import { configureMultiAgent } from "./multi-agent-source.mjs";
import { presetSupportsThirdPartyTemplate } from "./presets.mjs";

export const THIRD_PARTY_TEMPLATES = Object.freeze([
  "codex-general-v1",
  "legacy",
]);

export const GENERIC_INSTRUCTION_TEMPLATE = "codex-generic-v1";
export const GENERIC_INSTRUCTIONS =
  "Work as a coding agent in the user's project. Follow user and project instructions, use available tools accurately, verify material changes, and report results and limitations honestly.";

const fail = (code, message) => {
  throw Object.assign(Error(message ?? code.replaceAll("_", " ")), { code });
};

export function validateThirdPartyTemplate(template) {
  if (!THIRD_PARTY_TEMPLATES.includes(template))
    fail("third_party_template_invalid", "template must be codex-general-v1 or legacy");
  return template;
}

export function effectiveThirdPartyTemplate(config, explicit) {
  return validateThirdPartyTemplate(
    explicit ?? config?.thirdPartyDefaults?.template ?? "codex-general-v1",
  );
}

export function thirdPartyTemplateStatus(target) {
  const applied = target?.app?.thirdPartyTemplate;
  if (!applied && !presetSupportsThirdPartyTemplate(target?.preset, "codex-general-v1"))
    return {
      template: "legacy",
      version: null,
      status: "restricted",
      reason: "preset-compatibility-guard",
    };
  return {
    template: applied?.id ?? "legacy-or-unmanaged",
    version: applied?.version ?? null,
    status: applied ? "materialized" : "unverified",
    reason: applied ? "materialized-configuration" : "no-materialized-template",
  };
}

export function assertThirdPartyTemplateCompatible(target, template) {
  validateThirdPartyTemplate(template);
  if (template === "legacy") return;
  if (!presetSupportsThirdPartyTemplate(target?.preset, template))
    fail(
      "third_party_template_provider_unqualified",
      `${target.preset} is legacy-only until its Provider qualifies Responses freeform tools`,
    );
  if (
    target.provider === "chatgpt-subscription" ||
    target.app?.enabled !== true ||
    target.wireApi !== "responses" ||
    target.capabilities?.toolCalling !== true ||
    target.capabilities?.freeformTools !== true
  ) fail(
    "third_party_template_incompatible",
    "codex-general-v1 requires a third-party App-enabled Responses target with tool calling and freeform tools",
  );
}

export function applyThirdPartyTemplate(target, template, options = {}) {
  assertThirdPartyTemplateCompatible(target, template);
  const next = structuredClone(target);
  if (template === "legacy") {
    if (next.app) delete next.app.thirdPartyTemplate;
    return next;
  }

  next.app.capabilityProfile = "standard-tools";
  next.app.useResponsesLite = false;
  next.app.toolMode = "code_mode_only";
  next.app.thirdPartyTemplate = { id: "codex-general-v1", version: 1 };
  next.pluginToolPolicy = "third-party-gpt-default";
  next.standaloneSearch = { source: "disabled" };

  const withAgents = configureMultiAgent(next, "v2");
  return options.instructions === false
    ? withAgents
    : applyManagedInstructions(withAgents, {
        mode: "builtin-template",
        template: GENERIC_INSTRUCTION_TEMPLATE,
        text: GENERIC_INSTRUCTIONS,
      });
}

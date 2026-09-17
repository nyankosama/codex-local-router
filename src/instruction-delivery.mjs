import { fail } from "./errors.mjs";
import { validateInstructionSource } from "./instruction-source.mjs";

export const INSTRUCTION_DELIVERIES = ["client", "gateway-lite"];

function delivery(target) {
  return target.app?.instructionDelivery ?? "client";
}

export function gatewayLiteInstruction(target) {
  validateInstructionSource(target);
  const source = target.app?.instructionSource;
  if (!["official-snapshot", "builtin-template", "custom"].includes(source?.mode) || source.status !== "pinned")
    throw Error("gateway-lite instruction delivery requires pinned managed instructions");
  const variables = target.app?.modelMessages?.instructions_variables;
  if (variables != null && Object.keys(variables).length)
    throw Error("gateway-lite instruction delivery does not support runtime instruction variables");
  const template = target.app?.modelMessages?.instructions_template;
  const fallback = target.app?.baseInstructions;
  const text = typeof template === "string" && template.trim()
    ? template
    : fallback;
  if (typeof text !== "string" || !text.trim())
    throw Error("gateway-lite instruction delivery requires non-empty instructions");
  return text;
}

export function validateInstructionDelivery(target) {
  const mode = delivery(target);
  if (!INSTRUCTION_DELIVERIES.includes(mode))
    throw Error("invalid instruction delivery mode");
  if (mode === "client") return mode;
  if (
    target.provider === "chatgpt-subscription" ||
    target.wireApi !== "responses" ||
    target.app?.enabled !== true ||
    target.app?.useResponsesLite !== true
  ) throw Error("gateway-lite instruction delivery requires an App-enabled third-party Responses Lite target");
  gatewayLiteInstruction(target);
  return mode;
}

const exactDeveloperMessage = (item, text) =>
  item?.type === "message" &&
  item.role === "developer" &&
  Array.isArray(item.content) &&
  item.content.length === 1 &&
  item.content[0]?.type === "input_text" &&
  item.content[0].text === text;

export function applyInstructionDelivery(target, body, context = {}) {
  const mode = delivery(target);
  if (
    mode !== "gateway-lite" ||
    context.entry !== "subscription" ||
    context.requestKind !== "turn" ||
    context.responsesLite !== true
  ) return { body, applied: false, mode, reason: "not-applicable" };

  const text = gatewayLiteInstruction(target);
  if (Object.hasOwn(body, "instructions")) {
    if (body.instructions !== text)
      throw fail(
        "instruction_delivery_conflict",
        409,
        "The Lite request contains base instructions that conflict with the configured snapshot",
      );
    return { body, applied: false, mode, reason: "matching-top-level" };
  }
  if (!Array.isArray(body.input))
    throw fail(
      "instruction_delivery_input_unsupported",
      409,
      "The Lite request input cannot carry the configured instruction snapshot",
    );
  if (body.input.some((item) => exactDeveloperMessage(item, text)))
    return { body, applied: false, mode, reason: "already-present" };

  const input = body.input;
  let at = 0;
  while (input[at]?.type === "additional_tools") at++;
  const message = {
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text }],
  };
  return {
    body: { ...body, input: [...input.slice(0, at), message, ...input.slice(at)] },
    applied: true,
    mode,
    reason: "snapshot-injected",
    bytes: Buffer.byteLength(text),
    sourceModel: target.app.instructionSource.sourceModel ?? target.app.instructionSource.template ?? target.app.instructionSource.mode,
    snapshotVersion: target.app.instructionSource.snapshotVersion,
    contentHash: target.app.instructionSource.contentHash,
  };
}

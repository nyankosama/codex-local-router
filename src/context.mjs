const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value));

// This deliberately reports an estimate. Borderline context decisions remain
// upstream-owned; the Engine only blocks requests above a wide safety margin.
export function estimateRequestTokens(body) {
  return Math.ceil(jsonBytes({
    instructions: body.instructions,
    input: body.input,
    tools: body.tools,
  }) / 3.2);
}

export function inputBudget(target, body = {}) {
  if (!target.contextWindow) return null;
  const window = target.contextWindow;
  const effective = Math.floor(
    window * ((target.effectiveContextWindowPercent ?? 95) / 100),
  );
  const outputReserve =
    body.max_output_tokens ?? target.outputReserveTokens ?? 16384;
  return Math.max(0, Math.min(effective, window - outputReserve) - 2048);
}

export function isExplicitContextError(status, detail, classification = {}) {
  if (![400, 413, 422].includes(status)) return false;
  const code = String(detail?.error?.code ?? detail?.code ?? "").toLowerCase();
  const type = String(detail?.error?.type ?? detail?.type ?? "").toLowerCase();
  const message = String(
    detail?.error?.message ?? detail?.message ?? "",
  ).toLowerCase();
  const codes = new Set([
    "context_length_exceeded",
    "max_tokens_exceeded",
    "prompt_too_long",
    ...(classification.contextErrorCodes ?? []),
  ]);
  const excluded = new Set([
    "request_too_large",
    "body_too_large",
    "attachment_too_large",
    ...(classification.nonContextErrorCodes ?? []),
  ]);
  if ([code, type].some((value) => excluded.has(value))) return false;
  return (
    [code, type].some((value) =>
      codes.has(value),
    ) ||
    /context.{0,24}(length|window|limit|maximum|too (long|large)|exceed)/i.test(
      message,
    ) ||
    /(prompt|input).{0,24}(too (long|large)|exceed.{0,12}(token|limit|maximum))/i.test(
      message,
    )
  );
}

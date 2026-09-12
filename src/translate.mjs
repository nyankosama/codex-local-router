import { fail } from "./errors.mjs";
import { randomUUID } from "node:crypto";
export function textOf(v) {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return v == null ? "" : String(v);
  return v.map((x) => (typeof x === "string" ? x : (x?.text ?? ""))).join("\n");
}
export function inputToMessages(p) {
  const out = [];
  if (p.instructions) out.push({ role: "system", content: p.instructions });
  const input = Array.isArray(p.input)
    ? p.input
    : [{ role: "user", content: p.input ?? "" }];
  let calls = [],
    reasoning = "";
  const flush = () => {
    if (calls.length || reasoning) {
      out.push({
        role: "assistant",
        content: "",
        ...(calls.length ? { tool_calls: calls } : {}),
        ...(reasoning ? { reasoning_content: reasoning } : {}),
      });
      calls = [];
      reasoning = "";
    }
  };
  for (const item of input) {
    if (typeof item === "string") {
      flush();
      out.push({ role: "user", content: item });
      continue;
    }
    if (!item || typeof item !== "object") throw fail("invalid_request", 400);
    if (item.type === "reasoning") {
      const text = (item.summary ?? []).map((x) => x.text ?? "").join("\n");
      if (item.encrypted_content && !text)
        throw fail("history_incompatible", 400);
      reasoning += text;
      continue;
    }
    if (item.type === "function_call") {
      if (!item.call_id || !item.name) throw fail("invalid_tool_call", 400);
      calls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments ?? "{}" },
      });
      continue;
    }
    if (item.type === "function_call_output") {
      flush();
      out.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: textOf(item.output),
      });
      continue;
    }
    if (item.type && item.type !== "message")
      throw fail("capability_error", 400, "Chat input item is unsupported");
    if (
      Array.isArray(item.content) &&
      item.content.some(
        (x) =>
          typeof x !== "string" &&
          !["input_text", "output_text", "text"].includes(x.type),
      )
    )
      throw fail(
        "capability_error",
        400,
        "Chat adapter supports text input only",
      );
    flush();
    const role = item.role === "developer" ? "system" : (item.role ?? "user");
    if (!["system", "user", "assistant"].includes(role))
      throw fail("invalid_request", 400);
    out.push({ role, content: textOf(item.content ?? item.text ?? "") });
  }
  flush();
  return out.length ? out : [{ role: "user", content: "" }];
}
export function toolsToChat(tools = []) {
  return tools.flatMap((t) => {
    if (t.type === "function" && t.function) return [t];
    if (t.type !== "function" && t.type !== "custom") return [];
    const name = t.name ?? t.function?.name;
    return name
      ? [
          {
            type: "function",
            function: {
              name,
              description: t.description ?? t.function?.description ?? "",
              parameters: t.parameters ??
                t.function?.parameters ?? { type: "object", properties: {} },
            },
          },
        ]
      : [];
  });
}
export function toChat(p, model, options = {}) {
  const q = { model, messages: inputToMessages(p), stream: p.stream === true };
  if (q.stream) q.stream_options = { include_usage: true };
  if (p.reasoning?.effort ?? p.thinkLevel)
    q.reasoning_effort = p.reasoning?.effort ?? p.thinkLevel;
  const tools = toolsToChat(p.tools);
  if (options.webSearchFallback)
    tools.push({
      type: "function",
      function: {
        name: "gateway_web_search",
        description: "Search the web and return cited results.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      },
    });
  if (tools.length) {
    q.tools = tools;
    if (p.tool_choice != null)
      q.tool_choice =
        p.tool_choice?.type === "function" && p.tool_choice.name
          ? { type: "function", function: { name: p.tool_choice.name } }
          : p.tool_choice;
  }
  if (p.temperature != null) q.temperature = p.temperature;
  if (p.top_p != null) q.top_p = p.top_p;
  if (p.max_output_tokens != null) q.max_tokens = p.max_output_tokens;
  return q;
}
export function chatToResponse(chat, requestedModel) {
  const m = chat.choices?.[0]?.message ?? {},
    output = [];
  if (m.reasoning_content)
    output.push({
      type: "reasoning",
      id: `rs_${randomUUID()}`,
      summary: [{ type: "summary_text", text: m.reasoning_content }],
      status: "completed",
    });
  for (const c of m.tool_calls ?? [])
    output.push({
      type: "function_call",
      id: `fc_${randomUUID()}`,
      call_id: c.id,
      name: c.function?.name ?? "",
      arguments: c.function?.arguments ?? "{}",
      status: "completed",
    });
  if (m.content)
    output.push({
      type: "message",
      id: `msg_${randomUUID()}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: m.content, annotations: [] }],
    });
  return {
    id: `resp_${randomUUID()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: requestedModel,
    output,
    output_text: typeof m.content === "string" ? m.content : "",
    usage: chat.usage
      ? {
          input_tokens: chat.usage.prompt_tokens ?? 0,
          output_tokens: chat.usage.completion_tokens ?? 0,
          total_tokens: chat.usage.total_tokens ?? 0,
        }
      : null,
  };
}
export function chatChunkToEvents(chunk, state) {
  const d = chunk.choices?.[0]?.delta ?? {},
    events = [];
  if (d.reasoning_content)
    events.push({
      type: "response.reasoning_summary_text.delta",
      delta: d.reasoning_content,
    });
  if (d.content)
    events.push({ type: "response.output_text.delta", delta: d.content });
  for (const c of d.tool_calls ?? [])
    events.push({
      type: "response.function_call_arguments.delta",
      call_id: c.id ?? state.callId,
      delta: c.function?.arguments ?? "",
    });
  return events;
}

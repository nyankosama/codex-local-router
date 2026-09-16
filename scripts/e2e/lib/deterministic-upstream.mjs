import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

const responseId = (prefix) => `${prefix}_${randomUUID().replaceAll("-", "")}`;

const responseMessage = (text) => ({
  id: responseId("msg"),
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});

const responseFunctionCall = (name, argumentsValue) => ({
  id: responseId("fc"),
  type: "function_call",
  call_id: responseId("call"),
  name,
  arguments: JSON.stringify(argumentsValue),
  status: "completed",
});

const completedResponse = (model, output) => ({
  id: responseId("resp"),
  object: "response",
  created_at: Math.floor(Date.now() / 1000),
  model: model ?? "deterministic-fixture",
  status: "completed",
  output,
  usage: { input_tokens: 32, output_tokens: 8, total_tokens: 40 },
});

const jsonResponse = (body, status = 200) => {
  const bytes = Buffer.from(JSON.stringify(body));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({
      "content-type": "application/json",
      "content-length": String(bytes.length),
    }),
    rawHeaders: [
      ["content-type", "application/json"],
      ["content-length", String(bytes.length)],
    ],
    body: Readable.from([bytes]),
  };
};

const sseResponse = (events) => {
  const chunks = events.map((event) => Buffer.from(`data: ${JSON.stringify(event)}\n\n`));
  return {
    status: 200,
    ok: true,
    headers: new Headers({ "content-type": "text/event-stream" }),
    rawHeaders: [["content-type", "text/event-stream"]],
    body: Readable.from(chunks),
  };
};

function responseEvents(response) {
  const events = [{
    type: "response.created",
    response: { ...response, status: "in_progress", output: [] },
  }];
  for (const [outputIndex, item] of response.output.entries()) {
    events.push({ type: "response.output_item.added", output_index: outputIndex, item });
    if (item.type === "message") {
      const part = item.content[0];
      events.push(
        { type: "response.content_part.added", output_index: outputIndex, content_index: 0, item_id: item.id, part: { ...part, text: "" } },
        { type: "response.output_text.delta", output_index: outputIndex, content_index: 0, item_id: item.id, delta: part.text },
        { type: "response.output_text.done", output_index: outputIndex, content_index: 0, item_id: item.id, text: part.text },
        { type: "response.content_part.done", output_index: outputIndex, content_index: 0, item_id: item.id, part },
      );
    } else if (item.type === "function_call") {
      events.push(
        { type: "response.function_call_arguments.delta", output_index: outputIndex, item_id: item.id, call_id: item.call_id, delta: item.arguments },
        { type: "response.function_call_arguments.done", output_index: outputIndex, item_id: item.id, call_id: item.call_id, arguments: item.arguments },
      );
    }
    events.push({ type: "response.output_item.done", output_index: outputIndex, item });
  }
  events.push({ type: `response.${response.status}`, response });
  return events.map((event, sequence_number) => ({ ...event, sequence_number }));
}

const requestBody = (options) => {
  if (Buffer.isBuffer(options?.body)) {
    try { return JSON.parse(options.body.toString("utf8")); } catch { return {}; }
  }
  return options?.body && typeof options.body === "object" ? options.body : {};
};

const requestText = (body) => JSON.stringify(body);
const markerMatches = (text) => [
  ...(text.match(/MEM_[a-f0-9]{8}/gi) ?? []),
  ...(text.match(/FILE_[a-f0-9]{8}/gi) ?? []),
];

function exactReply(text) {
  const match = text.match(/Reply exactly\s+([A-Z0-9_]+(?:_OK)?)/i);
  return match?.[1] ?? null;
}

function responsesOutput(body) {
  const text = requestText(body);
  if (body.generate === false) return [];

  const exact = exactReply(text);
  if (exact) return [responseMessage(exact)];

  const toolResultPresent = /function_call_output|custom_tool_call_output/.test(text);
  const requestedCommand = text.match(/cat\s+([^"\\\s]+marker-\d+\.txt)/)?.[0];
  if (requestedCommand && !toolResultPresent)
    return [responseFunctionCall("exec_command", { cmd: requestedCommand, yield_time_ms: 1000 })];

  const markers = [...new Set(markerMatches(text))];
  if (markers.length) return [responseMessage(markers.join(" "))];
  if (/dominant color|input_image|describe the image/i.test(text))
    return [responseMessage("The synthetic image is red.")];
  if (/Was an image present/i.test(text)) return [responseMessage("Yes, an image was present.")];
  return [responseMessage("Deterministic fixture response.")];
}

function chatCompletion(body) {
  const hasToolResult = (body.messages ?? []).some((message) => message?.role === "tool");
  const model = body.model ?? "deterministic-chat-fixture";
  const message = hasToolResult
    ? { role: "assistant", content: "The deterministic search result is available." }
    : {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: responseId("call"),
          type: "function",
          function: {
            name: "gateway_web_search",
            arguments: JSON.stringify({ query: "deterministic gateway qualification", numResults: 1 }),
          },
        }],
      };
  return {
    id: responseId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: hasToolResult ? "stop" : "tool_calls" }],
    usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 },
  };
}

function chatChunks(completion) {
  const choice = completion.choices[0];
  return [
    {
      id: completion.id,
      object: "chat.completion.chunk",
      created: completion.created,
      model: completion.model,
      choices: [{ index: 0, delta: choice.message, finish_reason: null }],
    },
    {
      id: completion.id,
      object: "chat.completion.chunk",
      created: completion.created,
      model: completion.model,
      choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }],
      usage: completion.usage,
    },
  ];
}

export async function deterministicProviderRequest(_url, options) {
  const body = requestBody(options);
  if (Array.isArray(body.messages)) {
    const completion = chatCompletion(body);
    return body.stream ? sseResponse(chatChunks(completion)) : jsonResponse(completion);
  }
  const response = completedResponse(body.model, responsesOutput(body));
  return body.stream ? sseResponse(responseEvents(response)) : jsonResponse(response);
}

export async function deterministicOfficialRequest(url, options) {
  const path = new URL(url).pathname;
  if (path.endsWith("/models")) return jsonResponse({ models: [] });
  const body = requestBody(options);
  return jsonResponse(completedResponse(body.model, responsesOutput(body)));
}

export class DeterministicOfficialWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open");
    });
  }

  send(data, _options, callback) {
    callback?.();
    const body = requestBody({ body: Buffer.from(data) });
    const response = completedResponse(body.model, responsesOutput(body));
    const events = [
      { type: "response.created", sequence_number: 0, response: { ...response, status: "in_progress", output: [] } },
      ...response.output.flatMap((item, outputIndex) => [
        { type: "response.output_item.added", sequence_number: outputIndex * 2 + 1, output_index: outputIndex, item },
        { type: "response.output_item.done", sequence_number: outputIndex * 2 + 2, output_index: outputIndex, item },
      ]),
      { type: "response.completed", sequence_number: response.output.length * 2 + 1, response },
    ];
    queueMicrotask(() => {
      for (const event of events)
        this.emit("message", Buffer.from(JSON.stringify(event)), false);
    });
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }

  terminate() {
    this.close();
  }
}

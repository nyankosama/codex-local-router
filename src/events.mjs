import { randomUUID } from "node:crypto";
import { fail } from "./errors.mjs";
export class ChatEncoder {
  constructor(model, toolNameMap = new Map()) {
    this.response = {
      id: `resp_${randomUUID()}`,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      model,
      status: "in_progress",
      output: [],
    };
    this.calls = new Map();
    this.finished = false;
    this.seq = 0;
    this.toolNameMap = toolNameMap;
  }
  event(type, fields = {}) {
    return { type, sequence_number: this.seq++, ...fields };
  }
  start() {
    return this.event("response.created", {
      response: { ...this.response, output: [] },
    });
  }
  add(item) {
    const index = this.response.output.length;
    this.response.output.push(item);
    return {
      index,
      event: this.event("response.output_item.added", {
        output_index: index,
        item: structuredClone(item),
      }),
    };
  }
  consume(chunk) {
    const events = [],
      choice = chunk.choices?.[0],
      d = choice?.delta ?? {};
    if (chunk.usage)
      this.response.usage = {
        input_tokens: chunk.usage.prompt_tokens ?? 0,
        output_tokens: chunk.usage.completion_tokens ?? 0,
        total_tokens: chunk.usage.total_tokens ?? 0,
      };
    if (d.reasoning_content) {
      if (this.reasoning == null) {
        const x = this.add({
          type: "reasoning",
          id: `rs_${randomUUID()}`,
          summary: [{ type: "summary_text", text: "" }],
        });
        this.reasoning = x.index;
        events.push(
          x.event,
          this.event("response.reasoning_summary_part.added", {
            item_id: this.response.output[x.index].id,
            output_index: x.index,
            summary_index: 0,
            part: { type: "summary_text", text: "" },
          }),
        );
      }
      const item = this.response.output[this.reasoning];
      item.summary[0].text += d.reasoning_content;
      events.push(
        this.event("response.reasoning_summary_text.delta", {
          item_id: item.id,
          output_index: this.reasoning,
          summary_index: 0,
          delta: d.reasoning_content,
        }),
      );
    }
    if (d.content) {
      if (this.text == null) {
        const x = this.add({
          type: "message",
          id: `msg_${randomUUID()}`,
          role: "assistant",
          status: "in_progress",
          content: [{ type: "output_text", text: "", annotations: [] }],
        });
        this.text = x.index;
        events.push(
          x.event,
          this.event("response.content_part.added", {
            item_id: this.response.output[x.index].id,
            output_index: x.index,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          }),
        );
      }
      const item = this.response.output[this.text];
      item.content[0].text += d.content;
      events.push(
        this.event("response.output_text.delta", {
          item_id: item.id,
          output_index: this.text,
          content_index: 0,
          delta: d.content,
        }),
      );
    }
    for (const call of d.tool_calls ?? []) {
      let index = this.calls.get(call.index ?? 0);
      if (index == null) {
        if (!call.id || !call.function?.name)
          throw fail("invalid_upstream_tool_call", 502);
        const original = this.toolNameMap.get(call.function.name) ?? {
          name: call.function.name,
        };
        const x = this.add({
          type: "function_call",
          id: `fc_${randomUUID()}`,
          call_id: call.id,
          name: original.name,
          ...(original.namespace ? { namespace: original.namespace } : {}),
          arguments: "",
          status: "in_progress",
        });
        index = x.index;
        this.calls.set(call.index ?? 0, index);
        events.push(x.event);
      }
      const item = this.response.output[index];
      if (call.function?.arguments) {
        item.arguments += call.function.arguments;
        events.push(
          this.event("response.function_call_arguments.delta", {
            item_id: item.id,
            output_index: index,
            call_id: item.call_id,
            delta: call.function.arguments,
          }),
        );
      }
    }
    if (choice?.finish_reason) {
      this.finished = true;
      this.finishReason = choice.finish_reason;
    }
    return events;
  }
  end() {
    if (!this.finished) throw fail("upstream_stream_incomplete", 502);
    const events = [];
    for (const [i, item] of this.response.output.entries()) {
      if (item.type === "function_call") {
        try {
          JSON.parse(item.arguments);
        } catch {
          throw fail("invalid_upstream_tool_arguments", 502);
        }
        events.push(
          this.event("response.function_call_arguments.done", {
            item_id: item.id,
            output_index: i,
            arguments: item.arguments,
          }),
        );
      }
      if (item.type === "message") {
        events.push(
          this.event("response.output_text.done", {
            item_id: item.id,
            output_index: i,
            content_index: 0,
            text: item.content[0].text,
          }),
          this.event("response.content_part.done", {
            item_id: item.id,
            output_index: i,
            content_index: 0,
            part: item.content[0],
          }),
        );
      }
      if (item.type === "reasoning")
        events.push(
          this.event("response.reasoning_summary_text.done", {
            item_id: item.id,
            output_index: i,
            summary_index: 0,
            text: item.summary[0].text,
          }),
          this.event("response.reasoning_summary_part.done", {
            item_id: item.id,
            output_index: i,
            summary_index: 0,
            part: item.summary[0],
          }),
        );
      if (item.type !== "reasoning") item.status = "completed";
      events.push(
        this.event("response.output_item.done", {
          output_index: i,
          item: structuredClone(item),
        }),
      );
    }
    this.response.status = ["length", "content_filter"].includes(
      this.finishReason,
    )
      ? "incomplete"
      : "completed";
    if (this.response.status === "incomplete")
      this.response.incomplete_details = {
        reason:
          this.finishReason === "length"
            ? "max_output_tokens"
            : "content_filter",
      };
    events.push(
      this.event(`response.${this.response.status}`, {
        response: structuredClone(this.response),
      }),
    );
    return events;
  }
}
export function completedEvents(response) {
  const events = [
    {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    },
  ];
  for (const [output_index, item] of (response.output ?? []).entries()) {
    events.push(
      { type: "response.output_item.added", output_index, item },
      { type: "response.output_item.done", output_index, item },
    );
  }
  events.push({ type: `response.${response.status ?? "completed"}`, response });
  return events.map((e, sequence_number) => ({ ...e, sequence_number }));
}

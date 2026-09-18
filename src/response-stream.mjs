import { fail } from "./errors.mjs";
import { randomUUID } from "node:crypto";

// One client response can span several private search generations. Only unknown
// function names wait for classification; ordinary content never waits for EOF.
export class SearchResponseStream {
  constructor(isInternalCall) {
    this.isInternalCall = isInternalCall;
    this.id = `resp_gateway_${randomUUID()}`;
    this.output = [];
    this.beginRound();
  }
  beginRound() {
    this.items = new Map();
  }
  push(event) {
    const events = [];
    if (!this.started) {
      this.started = true;
      events.push({ type: "response.created", response: {
        ...event.response, id: this.id, object: "response", status: "in_progress", output: [],
      } });
    }
    if (event.response || lifecycleEvents.has(event.type)) return events;
    const index = event.output_index;
    let item = this.items.get(index);
    if (!item && event.type === "response.output_item.done") {
      events.push(...this.push({ ...event, type: "response.output_item.added" }));
      item = this.items.get(index);
    }
    if (event.type === "response.output_item.added") {
      if (item || !Number.isInteger(index) || index < 0 || !event.item)
        throw fail("invalid_upstream_response", 502);
      item = { pending: [], hidden: null, done: false };
      this.items.set(index, item);
    }
    if (!item) throw fail("invalid_upstream_response", 502);
    if (item.hidden === null) {
      const definition = event.item;
      item.pending.push(event);
      if (!definition || (definition.type === "function_call" && !definition.name))
        return events;
      item.hidden = this.isInternalCall(definition);
      if (item.hidden) {
        item.pending = [];
        item.done = event.type === "response.output_item.done";
        return events;
      }
      item.index = this.output.length;
      item.id = `item_gateway_${randomUUID()}`;
      this.output.push({ ...definition, id: item.id });
      for (const pending of item.pending) {
        const known = pending.item?.type === "function_call" && !pending.item.name
          ? { ...pending, item: { ...pending.item, name: definition.name } }
          : pending;
        events.push(this.project(known, item));
      }
      item.pending = [];
    } else if (!item.hidden) {
      if (event.item && this.isInternalCall(event.item))
        throw fail("invalid_upstream_response", 502);
      events.push(this.project(event, item));
    }
    if (event.type === "response.output_item.done") item.done = true;
    return events;
  }
  project(event, item) {
    const projected = { ...event, output_index: item.index };
    if (event.response_id) projected.response_id = this.id;
    if (event.item_id) projected.item_id = item.id;
    if (event.item) {
      projected.item = { ...event.item, id: item.id };
      this.output[item.index] = projected.item;
    }
    if (event.type === "response.output_item.done") item.done = true;
    return projected;
  }
  endRound(response) {
    const events = [];
    for (const [output_index, item] of (response.output ?? []).entries()) {
      if (!this.items.has(output_index))
        events.push(...this.push({ type: "response.output_item.added", output_index, item }));
      const state = this.items.get(output_index);
      if (!state.done)
        events.push(...this.push({ type: "response.output_item.done", output_index, item }));
      if (state.hidden === null) throw fail("invalid_upstream_response", 502);
    }
    if ([...this.items.values()].some((item) => item.hidden === null || !item.done))
      throw fail("upstream_stream_incomplete", 502);
    return events;
  }
  finish(response) {
    return { type: `response.${response.status}`, response: {
      ...response, id: this.id, output: this.output,
    } };
  }
}

const lifecycleEvents = new Set([
  "response.created",
  "response.in_progress",
  "response.queued",
  "response.completed",
  "response.incomplete",
  "response.failed",
  "error",
  "ping",
]);

export const isSubstantiveResponseEvent = (event) =>
  typeof event?.type === "string" && !lifecycleEvents.has(event.type);

const isMessageEvent = (event, type) =>
  event?.type === type && event.item?.type === "message";

const sameItem = (pending, event) => {
  if (pending.id && event.item?.id) return pending.id === event.item.id;
  return (
    pending.outputIndex != null &&
    event.output_index != null &&
    pending.outputIndex === event.output_index
  );
};

const rewritePhase = (event, pending) => {
  if (
    pending.finalPhase === undefined ||
    event.item?.type !== "message" ||
    !sameItem(pending, event)
  )
    return event;
  return {
    ...event,
    item: { ...event.item, phase: pending.finalPhase },
  };
};

export async function* stabilizeResponseMessagePhases(
  events,
  {
    policy = "passthrough",
    onUpstreamOutput = () => {},
    onRelease = () => {},
  } = {},
) {
  let held = [];
  let pending = [];

  for await (const event of events) {
    if (isSubstantiveResponseEvent(event)) onUpstreamOutput(event);
    if (policy === "passthrough") {
      yield event;
      continue;
    }

    if (!held.length && !isMessageEvent(event, "response.output_item.added")) {
      yield event;
      continue;
    }

    const position = held.length;
    held.push({
      event,
      bytes: Buffer.byteLength(JSON.stringify(event)),
    });
    if (isMessageEvent(event, "response.output_item.added"))
      pending.push({
        id: event.item.id,
        outputIndex: event.output_index,
        initialPhase: event.item.phase,
        finalPhase: undefined,
        resolved: false,
        startedAt: Date.now(),
        startPosition: position,
        endPosition: undefined,
      });
    if (isMessageEvent(event, "response.output_item.done")) {
      const item = pending.find((candidate) =>
        sameItem(candidate, event),
      );
      if (item && !item.resolved) {
        item.finalPhase = event.item.phase ?? item.initialPhase;
        item.resolved = true;
        item.endPosition = position;
      }
    }

    if (!pending.length || pending.some((item) => !item.resolved))
      continue;

    const released = held;
    const completed = pending;
    held = [];
    pending = [];
    for (const item of completed) {
      const section = released.slice(item.startPosition, item.endPosition + 1);
      onRelease({
        initialPhase: item.initialPhase,
        finalPhase: item.finalPhase,
        changed: item.initialPhase !== item.finalPhase,
        eventCount: section.length,
        bytes: section.reduce((total, entry) => total + entry.bytes, 0),
        waitMs: Date.now() - item.startedAt,
      });
    }
    for (const entry of released) {
      let normalized = entry.event;
      for (const item of completed) normalized = rewritePhase(normalized, item);
      yield normalized;
    }
  }

  if (held.length)
    throw fail(
      "upstream_stream_incomplete",
      502,
      "The upstream stream ended before a message item completed",
    );
}

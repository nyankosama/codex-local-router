import { fail } from "./errors.mjs";

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

import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { WebSocket } from "ws";
import { Engine } from "../src/engine.mjs";
import { validate } from "../src/config.mjs";
import { createGateway } from "../src/server.mjs";
import { sseEvents } from "../src/sse.mjs";
import { fail } from "../src/errors.mjs";
import {
  isSubstantiveResponseEvent,
  stabilizeResponseMessagePhases,
} from "../src/response-stream.mjs";

const message = (id, phase, text = "done") => ({
  type: "message",
  id,
  role: "assistant",
  phase,
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});

const call = (id) => ({
  type: "function_call",
  id,
  call_id: `call_${id}`,
  name: "phase_probe",
  arguments: "{}",
});

const stream = (events) => ({
  ok: true,
  status: 200,
  headers: new Headers({ "content-type": "text/event-stream" }),
  body: Readable.from(
    events.map((event) =>
      Buffer.from(`data: ${JSON.stringify(event)}\n\n`),
    ),
  ),
});

const collect = async (events, options) => {
  const output = [];
  for await (const event of stabilizeResponseMessagePhases(events, options))
    output.push(event);
  return output;
};

const from = async function* (events) {
  yield* events;
};

test("only content-bearing Responses events mark upstream output", () => {
  for (const type of [
    "response.created",
    "response.in_progress",
    "response.completed",
    "response.incomplete",
    "response.failed",
    "error",
    "ping",
  ])
    assert.equal(isSubstantiveResponseEvent({ type }), false);
  for (const type of [
    "response.output_item.added",
    "response.reasoning_text.delta",
    "response.output_text.delta",
    "response.function_call_arguments.delta",
  ])
    assert.equal(isSubstantiveResponseEvent({ type }), true);
});

test("deferred Responses messages expose only their final phase", async () => {
  let releaseDone;
  const doneGate = new Promise((resolve) => {
    releaseDone = resolve;
  });
  let upstreamEvents = 0;
  const source = async function* () {
    yield {
      type: "response.output_item.added",
      output_index: 0,
      item: message("m1", "final_answer", ""),
    };
    yield {
      type: "response.output_text.delta",
      output_index: 0,
      item_id: "m1",
      delta: "checking",
    };
    await doneGate;
    yield {
      type: "response.output_item.done",
      output_index: 0,
      item: message("m1", "commentary", "checking"),
    };
    yield {
      type: "response.output_item.added",
      output_index: 1,
      item: call("f1"),
    };
  };
  const iterator = stabilizeResponseMessagePhases(source(), {
    policy: "defer_until_done",
    onUpstreamOutput: () => upstreamEvents++,
  });
  const firstEvent = iterator.next();
  assert.equal(
    await Promise.race([
      firstEvent.then(() => "released"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 20)),
    ]),
    "waiting",
  );
  assert.equal(upstreamEvents, 2);
  releaseDone();
  assert.equal((await firstEvent).value.item.phase, "commentary");
  assert.equal((await iterator.next()).value.delta, "checking");
  assert.equal((await iterator.next()).value.item.phase, "commentary");
  assert.equal((await iterator.next()).value.item.type, "function_call");
});

test("each commentary segment releases before its following tool", async () => {
  const events = [];
  for (let index = 0; index < 2; index++) {
    events.push(
      {
        type: "response.output_item.added",
        output_index: index * 2,
        item: message(`m${index}`, "final_answer", ""),
      },
      {
        type: "response.output_text.delta",
        output_index: index * 2,
        item_id: `m${index}`,
        delta: `step ${index}`,
      },
      {
        type: "response.output_item.done",
        output_index: index * 2,
        item: message(`m${index}`, "commentary", `step ${index}`),
      },
      {
        type: "response.output_item.added",
        output_index: index * 2 + 1,
        item: call(`f${index}`),
      },
    );
  }
  events.push(
    {
      type: "response.output_item.added",
      output_index: 4,
      item: message("final", "final_answer", ""),
    },
    {
      type: "response.output_text.delta",
      output_index: 4,
      item_id: "final",
      delta: "answer",
    },
    {
      type: "response.output_item.done",
      output_index: 4,
      item: message("final", "final_answer", "answer"),
    },
    {
      type: "response.completed",
      response: {
        id: "r1",
        object: "response",
        status: "completed",
        output: [message("final", "final_answer", "answer")],
      },
    },
  );
  const output = await collect(from(events), { policy: "defer_until_done" });
  assert.deepEqual(
    output
      .filter((event) => event.type === "response.output_item.added")
      .map((event) => [event.item.type, event.item.phase]),
    [
      ["message", "commentary"],
      ["function_call", undefined],
      ["message", "commentary"],
      ["function_call", undefined],
      ["message", "final_answer"],
    ],
  );
  assert.ok(
    output.findIndex(
      (event) =>
        event.type === "response.output_item.done" && event.item.id === "m0",
    ) <
      output.findIndex(
        (event) =>
          event.type === "response.output_item.added" && event.item.id === "f0",
      ),
  );
  assert.ok(
    output.findIndex(
      (event) =>
        event.type === "response.output_item.done" &&
        event.item.id === "final",
    ) < output.findIndex((event) => event.type === "response.completed"),
  );
});

test("passthrough streams remain byte-structurally unchanged", async () => {
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: message("m1", "final_answer", ""),
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      item_id: "m1",
      delta: "live",
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: message("m1", "commentary", "live"),
    },
  ];
  assert.deepEqual(
    await collect(from(events), { policy: "passthrough" }),
    events,
  );
});

test("a final answer is released at its own done boundary", async () => {
  let releaseDone;
  const doneGate = new Promise((resolve) => {
    releaseDone = resolve;
  });
  const source = async function* () {
    yield {
      type: "response.output_item.added",
      output_index: 0,
      item: message("final", "final_answer", ""),
    };
    yield {
      type: "response.output_text.delta",
      output_index: 0,
      item_id: "final",
      delta: "answer",
    };
    await doneGate;
    yield {
      type: "response.output_item.done",
      output_index: 0,
      item: message("final", "final_answer", "answer"),
    };
    yield {
      type: "response.completed",
      response: {
        id: "r-final",
        object: "response",
        status: "completed",
        output: [message("final", "final_answer", "answer")],
      },
    };
  };
  const iterator = stabilizeResponseMessagePhases(source(), {
    policy: "defer_until_done",
  });
  const firstEvent = iterator.next();
  assert.equal(
    await Promise.race([
      firstEvent.then(() => "released"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 20)),
    ]),
    "waiting",
  );
  releaseDone();
  assert.equal((await firstEvent).value.item.phase, "final_answer");
  assert.equal((await iterator.next()).value.type, "response.output_text.delta");
  assert.equal((await iterator.next()).value.type, "response.output_item.done");
  assert.equal((await iterator.next()).value.type, "response.completed");
});

test("official subscription Responses messages remain immediately streaming", async () => {
  let releaseDone;
  const doneGate = new Promise((resolve) => {
    releaseDone = resolve;
  });
  const config = validate({
    mode: "fixed",
    defaultTarget: "go",
    fixedTarget: "go",
    providers: {
      go: { adapter: "opencode-go", baseUrl: "http://127.0.0.1:9000" },
    },
    targets: {
      go: { provider: "go", model: "deepseek", wireApi: "responses" },
    },
    subscription: { enabled: true, models: ["gpt-5.5"] },
    rules: [],
  });
  const engine = new Engine(config, {
    send: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: Readable.from(
        (async function* () {
          yield Buffer.from(
            `data: ${JSON.stringify({
              type: "response.output_item.added",
              output_index: 0,
              item: message("official", "final_answer", ""),
            })}\n\n`,
          );
          await doneGate;
          yield Buffer.from(
            `data: ${JSON.stringify({
              type: "response.output_item.done",
              output_index: 0,
              item: message("official", "final_answer", "answer"),
            })}\n\n`,
          );
          yield Buffer.from(
            `data: ${JSON.stringify({
              type: "response.completed",
              response: {
                id: "official-response",
                object: "response",
                status: "completed",
                output: [message("official", "final_answer", "answer")],
              },
            })}\n\n`,
          );
        })(),
      ),
    }),
  });
  const iterator = engine.sample(
    config,
    {
      id: "official:gpt-5.5",
      provider: "chatgpt-subscription",
      model: "gpt-5.5",
      wireApi: "responses",
    },
    { model: "gpt-5.5", input: [], stream: true },
    {
      entry: "subscription",
      headers: { authorization: "Bearer test" },
      providerCalls: 0,
    },
    new AbortController().signal,
  );
  assert.equal((await iterator.next()).value.item.id, "official");
  releaseDone();
  assert.equal((await iterator.next()).value.type, "response.output_item.done");
  assert.equal((await iterator.next()).value.type, "response.completed");
});

test("an unfinished buffered message fails without provider fallback", async () => {
  const config = validate({
    mode: "fixed",
    defaultTarget: "primary",
    fixedTarget: "primary",
    fallbackTarget: "backup",
    providers: {
      go: {
        adapter: "opencode-go",
        baseUrl: "http://127.0.0.1:9000",
      },
    },
    targets: {
      primary: {
        provider: "go",
        model: "primary",
        wireApi: "responses",
      },
      backup: {
        provider: "go",
        model: "backup",
        wireApi: "responses",
      },
    },
    rules: [],
  });
  let calls = 0;
  const engine = new Engine(config, {
    send: async () => {
      calls++;
      return stream([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: message("partial", "final_answer", ""),
        },
        {
          type: "response.output_text.delta",
          output_index: 0,
          item_id: "partial",
          delta: "partial",
        },
      ]);
    },
  });
  await assert.rejects(
    async () => {
      for await (const _ of engine.generate(
        "api",
        {},
        { model: "requested", input: "hello", stream: true },
        new AbortController().signal,
      )) {
        // No buffered message event should become visible.
      }
    },
    /upstream stream ended before a message item completed/,
  );
  assert.equal(calls, 1);
});

test("cancellation and buffer overflow never replay an observed message", async () => {
  const makeConfig = (maxBodyBytes) =>
    validate({
      mode: "fixed",
      defaultTarget: "primary",
      fixedTarget: "primary",
      fallbackTarget: "backup",
      maxBodyBytes,
      providers: {
        go: {
          adapter: "opencode-go",
          baseUrl: "http://127.0.0.1:9000",
        },
      },
      targets: {
        primary: {
          provider: "go",
          model: "primary",
          wireApi: "responses",
        },
        backup: {
          provider: "go",
          model: "backup",
          wireApi: "responses",
        },
      },
      rules: [],
    });
  const partial = {
    type: "response.output_item.added",
    output_index: 0,
    item: message("partial", "final_answer", ""),
  };

  let cancelCalls = 0;
  const cancelled = new Engine(makeConfig(1024 * 1024), {
    send: async (_url, options) => {
      cancelCalls++;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: Readable.from(
          (async function* () {
            yield Buffer.from(`data: ${JSON.stringify(partial)}\n\n`);
            await new Promise((resolve, reject) => {
              options.signal.addEventListener(
                "abort",
                () => reject(fail("cancelled", 499)),
                { once: true },
              );
            });
          })(),
        ),
      };
    },
  });
  const controller = new AbortController();
  const cancelledIterator = cancelled.generate(
    "api",
    {},
    { model: "requested", input: "hello", stream: true },
    controller.signal,
  );
  const waiting = cancelledIterator.next();
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await assert.rejects(waiting, /cancelled/);
  assert.equal(cancelCalls, 1);

  let overflowCalls = 0;
  const overflow = new Engine(makeConfig(32), {
    send: async () => {
      overflowCalls++;
      return stream([partial]);
    },
  });
  await assert.rejects(
    async () => {
      for await (const _ of overflow.generate(
        "api",
        {},
        { model: "requested", input: "hello", stream: true },
        new AbortController().signal,
      )) {
        // The oversized event is observed upstream but never released.
      }
    },
    /upstream_body_too_large/,
  );
  assert.equal(overflowCalls, 1);
});

test("HTTP and WebSocket expose stable phases with continuous sequences", async (t) => {
  const finalMessage = message("m1", "commentary", "checking");
  const upstreamEvents = [
    {
      type: "response.created",
      response: { id: "r1", object: "response", status: "in_progress" },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: message("m1", "final_answer", ""),
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      item_id: "m1",
      delta: "checking",
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: finalMessage,
    },
    {
      type: "response.completed",
      response: {
        id: "r1",
        object: "response",
        status: "completed",
        output: [finalMessage],
      },
    },
  ];
  const logs = [];
  const gateway = createGateway(
    validate({
      mode: "fixed",
      defaultTarget: "go",
      fixedTarget: "go",
      providers: {
        go: {
          adapter: "opencode-go",
          baseUrl: "http://127.0.0.1:9000",
        },
      },
      targets: {
        go: { provider: "go", model: "deepseek", wireApi: "responses" },
      },
      rules: [],
    }),
    { send: async () => stream(upstreamEvents), log: (event) => logs.push(event) },
  );
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  t.after(() => gateway.close());
  const port = gateway.server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "requested", input: "hello", stream: true }),
  });
  const httpEvents = [];
  for await (const event of sseEvents(response.body)) httpEvents.push(event);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/responses`);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  t.after(() => socket.close());
  const wsEvents = await new Promise((resolve, reject) => {
    const events = [];
    socket.on("message", (data) => {
      const event = JSON.parse(data);
      events.push(event);
      if (event.type === "response.completed") resolve(events);
    });
    socket.once("error", reject);
    socket.send(
      JSON.stringify({
        type: "response.create",
        model: "requested",
        input: "hello",
      }),
    );
  });
  for (const events of [httpEvents, wsEvents]) {
    assert.deepEqual(
      events.map((event) => event.sequence_number),
      events.map((_, index) => index),
    );
    assert.equal(
      events.find((event) => event.type === "response.output_item.added").item
        .phase,
      "commentary",
    );
  }
  const release = logs.find(
    (event) => event.event === "response_message_phase_released",
  );
  assert.equal(release.initial_phase, "final_answer");
  assert.equal(release.final_phase, "commentary");
  assert.equal(release.phase_changed, true);
  assert.equal("text" in release, false);
});

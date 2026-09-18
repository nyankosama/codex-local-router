import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { once } from "node:events";
import { WebSocket } from "ws";
import { validate } from "../../../src/config.mjs";
import { createGateway } from "../../../src/server.mjs";
import { sseEvents } from "../../../src/sse.mjs";
import { completedEvents } from "../../../src/events.mjs";

// Loopback only: the upstream cannot finish until the CLIENT acknowledges each
// nonempty text delta. A buffered response fails, regardless of model speed.
export async function probeSearchStreaming({ transport, mode, rounds = 0 }) {
  const subscription = mode === "subscription_bridge";
  const config = validate({
    mode: "fixed", defaultTarget: "probe", fixedTarget: "probe", rules: [],
    providers: { probe: { baseUrl: "http://127.0.0.1:1" } },
    targets: { probe: { provider: "probe", model: "probe", wireApi: "responses",
      capabilities: { toolCalling: true, nativeWebSearch: false },
      ...(subscription ? {
        app: { enabled: true, modelId: "probe", useResponsesLite: false, capabilityProfile: "standard-tools" },
        standaloneSearch: { source: "disabled" }, subscriptionSearch: { delivery: "standard-tool" },
      } : {}),
    } },
    subscription: { enabled: true, models: ["gpt-fixture"], customModels: { probe: "probe" } },
    webSearch: { backend: "fake" },
  });
  const logs = [], requests = [], lags = [], events = [];
  let acknowledge, sentAt, calls = 0, searches = 0, terminalSent = false, streamError;
  const message = (text) => ({ type: "message", id: "same-provider-item-id",
    role: "assistant", status: "completed", content: [{ type: "output_text", text }] });
  const gateway = createGateway(config, {
    log: (event) => logs.push(event),
    officialRequest: async () => {
      searches++;
      return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), body: Readable.from([Buffer.from(JSON.stringify({
        results: [{ title: "Fixture", url: "https://example.com/fixture", snippet: "Fixture" }],
      }))]) };
    },
    send: async (_url, options) => {
      requests.push(options.body);
      const round = calls++;
      const response = { id: `provider-${round}`, status: "completed", output: [] };
      const source = async function* () {
        try {
          if (round < rounds) {
            response.output = [message(`Progress ${round}`), {
              type: "function_call", id: "hidden", call_id: `search-${round}`,
              name: subscription ? "gateway_subscription_web_search" : "gateway_web_search",
              arguments: '{"query":"synthetic"}',
            }];
            yield* completedEvents(response);
            return;
          }
          const final = message("onetwothree");
          yield { type: "response.created", response: { ...response, status: "in_progress" } };
          yield { type: "response.output_item.added", output_index: 0, item: message("") };
          for (const delta of ["one", "two", "three"]) {
            const received = new Promise((resolve) => { acknowledge = resolve; });
            sentAt = performance.now();
            yield { type: "response.output_text.delta", output_index: 0, item_id: final.id, delta };
            let timer;
            try {
              await Promise.race([received, new Promise((_, reject) => {
                timer = setTimeout(() => reject(Error("client_text_waited_for_terminal")), 3000);
              })]);
            } finally { clearTimeout(timer); }
          }
          yield { type: "response.output_item.done", output_index: 0, item: final };
          terminalSent = true;
          yield { type: "response.completed", response: { ...response, output: [final] } };
        } catch (error) { streamError = error; throw error; }
      };
      return { ok: true, status: 200, headers: new Headers({ "content-type": "text/event-stream" }),
        body: Readable.from((async function* () {
          for await (const event of source()) yield Buffer.from(`data: ${JSON.stringify(event)}\n\n`);
        })()),
      };
    },
  });
  const receive = (event) => {
    events.push(event);
    if (event.type === "response.output_text.delta" && event.delta) {
      assert.equal(terminalSent, false);
      lags.push(performance.now() - sentAt);
      acknowledge();
    }
  };
  let socket;
  try {
    gateway.server.listen(0, "127.0.0.1");
    await once(gateway.server, "listening");
    const address = `127.0.0.1:${gateway.server.address().port}/subscription/v1/responses`;
    const body = { model: "probe", input: "synthetic", stream: true,
      tools: [{ type: "web_search", mode: "cached" }] };
    const headers = { authorization: "Bearer synthetic-only", "thread-id": "synthetic-only" };
    if (transport === "http") {
      const response = await fetch(`http://${address}`, { method: "POST",
        headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(response.status, 200, response.status === 200 ? undefined : JSON.stringify(logs));
      for await (const event of sseEvents(response.body)) receive(event);
    } else {
      socket = new WebSocket(`ws://${address}`, { headers });
      await once(socket, "open");
      await new Promise((resolve, reject) => {
        socket.on("error", reject);
        socket.on("message", (data) => {
          try {
            const event = JSON.parse(data);
            receive(event);
            if (event.type === "error") reject(Error(JSON.stringify(event)));
            if (event.type === "response.completed") resolve();
          } catch (error) { reject(error); }
        });
        socket.send(JSON.stringify({ type: "response.create", ...body }));
      });
    }
    if (streamError) throw streamError;
    assert.equal(lags.length, 3);
    assert.equal(calls, rounds + 1);
    assert.equal(searches, subscription ? rounds : 0);
    assert.equal(events.filter((e) => e.type === "response.created").length, 1);
    assert.equal(events.filter((e) => e.type === "response.completed").length, 1);
    assert.deepEqual(events.map((e) => e.sequence_number), events.map((_, i) => i));
    assert.ok(!JSON.stringify(events).includes("gateway_web_search"));
    assert.ok(!JSON.stringify(events).includes("gateway_subscription_web_search"));
    const done = events.at(-1).response;
    assert.equal(events[0].response.id, done.id);
    assert.equal(done.output.length, rounds + 1);
    assert.equal(new Set(done.output.map((item) => item.id)).size, rounds + 1);
    assert.deepEqual(events.filter((e) => e.type === "response.output_item.done").map((e) => e.output_index),
      Array.from({ length: rounds + 1 }, (_, i) => i));
    const ctx = await gateway.engine.identify("subscription", headers, body);
    const replay = gateway.engine.state.replay(ctx, { previous_response_id: done.id, input: [] });
    assert.equal(replay.body.input.filter((item) => item.type === "function_call_output").length, rounds);
    assert.equal(replay.body.input.filter((item) => item.type === "message" && item.role === "assistant").length, rounds + 1);
    const delivered = logs.find((e) => e.event === "downstream_stream_completed");
    assert.equal(delivered.text_deltas, 3);
    assert.equal(delivered.text_bytes, 11);
    assert.equal(logs.filter((e) => e.event === "downstream_first_output_text").length, 1);
    return { transport, mode, rounds, textDeltas: 3, beforeTerminal: true,
      receiveLagMs: lags, providerCalls: calls, searchCalls: searches };
  } finally {
    socket?.terminate();
    await gateway.close();
  }
}

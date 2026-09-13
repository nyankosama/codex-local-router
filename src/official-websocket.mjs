import WebSocket from "ws";
import { fail } from "./errors.mjs";
import { relayRequestHeaders } from "./official-relay.mjs";

export const OFFICIAL_RESPONSES_WEBSOCKET =
  "wss://chatgpt.com/backend-api/codex/responses";

const terminal = (event) =>
  ["response.completed", "response.incomplete", "error"].includes(event?.type);

export class OfficialWebSocketSession {
  constructor(headers, options = {}) {
    this.headers = relayRequestHeaders(headers, { websocket: true });
    this.createSocket =
      options.createSocket ??
      ((url, socketOptions) => new WebSocket(url, socketOptions));
    this.url = options.url ?? OFFICIAL_RESPONSES_WEBSOCKET;
    this.maxPayload = options.maxPayload ?? 20 * 1024 * 1024;
    this.log = options.log ?? (() => {});
    this.socket = null;
    this.connecting = null;
    this.active = null;
  }

  async connect(signal) {
    if (signal?.aborted) throw fail("cancelled", 499);
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === 1)
      return this.socket;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const socket = this.createSocket(this.url, {
        headers: this.headers,
        perMessageDeflate: false,
        followRedirects: false,
        maxPayload: this.maxPayload,
      });
      this.socket = socket;
      const abort = () => {
        socket.terminate?.();
        reject(fail("cancelled", 499));
      };
      const opened = () => {
        cleanup();
        socket.on("message", (data, isBinary) => this.receive(data, isBinary));
        socket.on("close", () => this.closed());
        socket.on("error", (error) => this.failed(error));
        resolve(socket);
      };
      const failed = () => {
        cleanup();
        reject(fail("upstream_connection_error", 502));
      };
      const cleanup = () => {
        signal?.removeEventListener("abort", abort);
        socket.off?.("open", opened);
        socket.off?.("error", failed);
      };
      signal?.addEventListener("abort", abort, { once: true });
      socket.once("open", opened);
      socket.once("error", failed);
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  receive(data, isBinary) {
    const active = this.active;
    if (!active) {
      this.log({ event: "official_ws_unexpected_message" });
      return;
    }
    active.chain = active.chain.then(async () => {
      let event;
      if (!isBinary) {
        try { event = JSON.parse(Buffer.from(data).toString("utf8")); } catch {}
      }
      if (event?.type === "response.output_item.done" && event.item)
        active.outputItems.set(event.output_index ?? active.outputItems.size, event.item);
      if (terminal(event) && event?.response && !event.response.output?.length && active.outputItems.size)
        event = {
          ...event,
          response: {
            ...event.response,
            output: [...active.outputItems.entries()]
              .sort((left, right) => left[0] - right[0])
              .map((entry) => entry[1]),
          },
        };
      let observationTask;
      if (terminal(event) && active.observe) {
        try { observationTask = active.observe(event); }
        catch (error) {
          this.log({
            event: "official_history_observation_failed",
            transport: "websocket",
            type: error.type ?? "observation_error",
          });
        }
      }
      await active.forward(data, isBinary);
      Promise.resolve(observationTask).catch((error) => {
        this.log({
          event: "official_history_observation_failed",
          transport: "websocket",
          type: error.type ?? "observation_error",
        });
      });
      if (terminal(event)) {
        this.active = null;
        active.resolve(event);
      }
    }).catch((error) => {
      if (this.active === active) this.active = null;
      active.reject(error);
    });
  }

  closed() {
    this.socket = null;
    if (this.active) {
      const active = this.active;
      this.active = null;
      active.reject(fail("upstream_connection_error", 502));
    }
  }

  failed() {
    if (this.active) {
      const active = this.active;
      this.active = null;
      active.reject(fail("upstream_connection_error", 502));
    }
  }

  async run(data, isBinary, { signal, forward, observe } = {}) {
    if (this.active) throw fail("official_ws_turn_active", 409);
    const socket = await this.connect(signal);
    if (signal?.aborted) {
      socket.terminate?.();
      throw fail("cancelled", 499);
    }
    return new Promise((resolve, reject) => {
      const settled = (callback) => (value) => {
        signal?.removeEventListener("abort", abort);
        callback(value);
      };
      let resolveTurn, rejectTurn;
      const active = {
        resolve: (value) => resolveTurn(value),
        reject: (error) => rejectTurn(error),
        forward,
        observe,
        outputItems: new Map(),
        chain: Promise.resolve(),
      };
      this.active = active;
      const abort = () => {
        if (this.active === active) this.active = null;
        socket.terminate?.();
        rejectTurn(fail("cancelled", 499));
      };
      resolveTurn = settled(resolve);
      rejectTurn = settled(reject);
      signal?.addEventListener("abort", abort, { once: true });
      const done = (error) => {
        if (!error) return;
        signal?.removeEventListener("abort", abort);
        if (this.active === active) this.active = null;
        rejectTurn(fail("upstream_connection_error", 502));
      };
      socket.send(data, { binary: !!isBinary }, done);
    });
  }

  close() {
    this.socket?.close?.(1000);
    this.socket = null;
  }
}

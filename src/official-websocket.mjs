import WebSocket from "ws";
import { ProxyAgent } from "proxy-agent";
import { getProxyForUrl } from "proxy-from-env";
import * as tls from "node:tls";
import { fail } from "./errors.mjs";
import { relayRequestHeaders } from "./official-relay.mjs";

export const OFFICIAL_RESPONSES_WEBSOCKET =
  "wss://chatgpt.com/backend-api/codex/responses";

const terminal = (event) =>
  ["response.completed", "response.incomplete", "error"].includes(event?.type);

const TLS_FAILURE_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "CERT_SIGNATURE_FAILURE",
  "CERT_UNTRUSTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_TLS_CERT_ALTNAME_FORMAT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "INVALID_CA",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

const rawConnectionCode = (error) => error?.code ?? error?.cause?.code;
const safeConnectionCode = (error) => {
  const code = rawConnectionCode(error);
  return typeof code === "string" && TLS_FAILURE_CODES.has(code) ? code : undefined;
};

export function officialWebSocketCaCertificates(tlsApi = tls) {
  if (typeof tlsApi.getCACertificates !== "function") return null;
  const unique = new Set();
  const append = (certificates) => {
    for (const certificate of certificates ?? [])
      if (typeof certificate === "string" && certificate.length) unique.add(certificate);
  };
  try {
    append(tlsApi.getCACertificates("default"));
    append(tlsApi.getCACertificates("system"));
  } catch { return null; }
  return [...unique];
}

let cachedOfficialCaCertificates;
const defaultOfficialCaCertificates = () => {
  cachedOfficialCaCertificates ??= officialWebSocketCaCertificates();
  return cachedOfficialCaCertificates;
};

const connectionFailureCategory = (error) => {
  const code = rawConnectionCode(error);
  const message = String(error?.message ?? error?.cause?.message ?? "");
  if (code === "ETIMEDOUT" || /timed?\s*out/i.test(message)) return "timeout";
  if (["ENOTFOUND", "EAI_AGAIN"].includes(code) || /getaddrinfo/i.test(message)) return "dns";
  if (code === "ECONNREFUSED") return "connect";
  if (["ECONNRESET", "EPIPE"].includes(code)) return "receive";
  if (TLS_FAILURE_CODES.has(code)) return "tls";
  if (/\b407\b|proxy authentication/i.test(message)) return "proxy_auth";
  if (/proxy|tunnel/i.test(message)) return "proxy_connect";
  if (/certificate|ssl|tls/i.test(message)) return "tls";
  return "other";
};

const connectionFailure = (error) => {
  const failure = fail("upstream_connection_error", 502);
  failure.transportCategory = connectionFailureCategory(error);
  failure.transportCode = safeConnectionCode(error);
  return failure;
};

const connectionFailureDiagnostics = (failure) => ({
  ...(failure.transportCode ? { transport_code: failure.transportCode } : {}),
  transport_category: failure.transportCategory,
});

export function officialWebSocketProxyForUrl(
  url,
  resolve = getProxyForUrl,
  env = process.env,
) {
  const compatible = new URL(url);
  let websocketVariable;
  if (compatible.protocol === "wss:") {
    websocketVariable = env.wss_proxy ?? env.WSS_PROXY;
    compatible.protocol = "https:";
  } else if (compatible.protocol === "ws:") {
    websocketVariable = env.ws_proxy ?? env.WS_PROXY;
    compatible.protocol = "http:";
  } else return "";
  if (websocketVariable) return resolve(url);
  return resolve(compatible.href);
}

export const createOfficialWebSocketAgent = ({
  resolveProxy = getProxyForUrl,
  env = process.env,
  ...options
} = {}) => new ProxyAgent({
  ...options,
  getProxyForUrl: (url) => officialWebSocketProxyForUrl(url, resolveProxy, env),
});

export class OfficialWebSocketSession {
  constructor(headers, options = {}) {
    this.headers = relayRequestHeaders(headers, { websocket: true });
    this.agent = options.agent ?? createOfficialWebSocketAgent(options.proxyAgentOptions);
    this.ownsAgent = options.agent == null;
    this.createSocket =
      options.createSocket ??
      ((url, socketOptions) => new WebSocket(url, socketOptions));
    this.caCertificates = options.caCertificates ?? defaultOfficialCaCertificates();
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
      let socket;
      try {
        socket = this.createSocket(this.url, {
          agent: this.agent,
          headers: this.headers,
          perMessageDeflate: false,
          followRedirects: false,
          maxPayload: this.maxPayload,
          ...(this.caCertificates ? { ca: this.caCertificates } : {}),
          rejectUnauthorized: true,
        });
      } catch (error) {
        const failure = connectionFailure(error);
        this.log({
          event: "official_ws_connect_failed",
          transport: "websocket",
          ...connectionFailureDiagnostics(failure),
        });
        reject(failure);
        return;
      }
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
      const failed = (error) => {
        cleanup();
        const failure = connectionFailure(error);
        this.log({
          event: "official_ws_connect_failed",
          transport: "websocket",
          ...connectionFailureDiagnostics(failure),
        });
        reject(failure);
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

  failed(error) {
    if (this.active) {
      const active = this.active;
      this.active = null;
      active.reject(connectionFailure(error));
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
        rejectTurn(connectionFailure(error));
      };
      socket.send(data, { binary: !!isBinary }, done);
    });
  }

  close() {
    this.socket?.close?.(1000);
    this.socket = null;
    if (this.ownsAgent) this.agent?.destroy?.();
  }
}

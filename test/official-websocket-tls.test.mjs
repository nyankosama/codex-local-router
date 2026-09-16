import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import https from "node:https";
import net from "node:net";
import { WebSocketServer } from "ws";
import { OfficialWebSocketSession } from "../src/official-websocket.mjs";

const run = promisify(execFile);

const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });

const close = (server) => new Promise((resolve) => server.close(resolve));

async function certificateFixture(root) {
  const caConfig = join(root, "ca.cnf");
  const caKey = join(root, "ca-key.pem");
  const caCert = join(root, "ca.pem");
  await writeFile(caConfig, [
    "[req]",
    "distinguished_name=dn",
    "x509_extensions=v3_ca",
    "prompt=no",
    "[dn]",
    "CN=Codex Local Router test CA",
    "[v3_ca]",
    "basicConstraints=critical,CA:TRUE",
    "keyUsage=critical,keyCertSign,cRLSign",
    "subjectKeyIdentifier=hash",
    "authorityKeyIdentifier=keyid:always,issuer",
    "",
  ].join("\n"));
  await run("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1",
    "-keyout", caKey, "-out", caCert, "-config", caConfig,
  ]);

  const server = async (name, hostname, serial) => {
    const key = join(root, `${name}-key.pem`);
    const csr = join(root, `${name}.csr`);
    const cert = join(root, `${name}.pem`);
    const extensions = join(root, `${name}-extensions.cnf`);
    await writeFile(extensions, [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      `subjectAltName=DNS:${hostname}`,
      "",
    ].join("\n"));
    await run("openssl", [
      "req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256",
      "-keyout", key, "-out", csr, "-subj", `/CN=${hostname}`,
    ]);
    await run("openssl", [
      "x509", "-req", "-in", csr, "-CA", caCert, "-CAkey", caKey,
      "-set_serial", String(serial), "-sha256", "-days", "1",
      "-out", cert, "-extfile", extensions,
    ]);
    return {
      key: await readFile(key),
      cert: await readFile(cert),
    };
  };

  return {
    ca: await readFile(caCert, "utf8"),
    good: await server("good", "chatgpt.com", 1001),
    wrongHost: await server("wrong-host", "wrong.invalid", 1002),
  };
}

async function createWebSocketUpstream(credentials) {
  const received = [];
  const server = https.createServer(credentials);
  const webSocketServer = new WebSocketServer({ server });
  webSocketServer.on("connection", (socket) => {
    socket.on("message", (data, isBinary) => {
      received.push({ data: Buffer.from(data), isBinary });
      socket.send(JSON.stringify({
        type: "response.completed",
        response: { id: "resp_tls_fixture", status: "completed", output: [] },
      }));
    });
  });
  const port = await listen(server);
  return {
    port,
    received,
    async close() {
      for (const socket of webSocketServer.clients) socket.terminate();
      webSocketServer.close();
      await close(server);
    },
  };
}

async function createConnectProxy(upstreamPort) {
  const targets = [];
  const sockets = new Set();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
    let request = Buffer.alloc(0);
    const receive = (chunk) => {
      request = Buffer.concat([request, chunk]);
      const end = request.indexOf("\r\n\r\n");
      if (end === -1) return;
      client.off("data", receive);
      const [requestLine] = request.subarray(0, end).toString("latin1").split("\r\n");
      targets.push(requestLine);
      const upstream = net.connect(upstreamPort, "127.0.0.1");
      sockets.add(upstream);
      upstream.once("close", () => sockets.delete(upstream));
      upstream.once("error", () => client.destroy());
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const remainder = request.subarray(end + 4);
        if (remainder.length) upstream.write(remainder);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    };
    client.on("data", receive);
  });
  const port = await listen(server);
  return {
    port,
    targets,
    async close() {
      for (const socket of sockets) socket.destroy();
      await close(server);
    },
  };
}

const sessionFor = ({ proxyPort, caCertificates, logs }) =>
  new OfficialWebSocketSession(
    { authorization: "Bearer synthetic-subscription" },
    {
      url: "wss://chatgpt.com/backend-api/codex/responses",
      caCertificates,
      proxyAgentOptions: {
        env: { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` },
        resolveProxy: (url) =>
          url.startsWith("https:") ? `http://127.0.0.1:${proxyPort}` : "",
      },
      log: (event) => logs.push(event),
    },
  );

test("A6 real CONNECT TLS requires explicit trust and keeps hostname verification", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-router-wss-tls-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const certificates = await certificateFixture(root);

  const trustedUpstream = await createWebSocketUpstream(certificates.good);
  const trustedProxy = await createConnectProxy(trustedUpstream.port);
  t.after(() => trustedUpstream.close());
  t.after(() => trustedProxy.close());

  const untrustedLogs = [];
  const untrusted = sessionFor({
    proxyPort: trustedProxy.port,
    caCertificates: [],
    logs: untrustedLogs,
  });
  await assert.rejects(untrusted.connect(), (error) =>
    error.type === "upstream_connection_error" &&
    error.transportCategory === "tls" &&
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"].includes(
      error.transportCode,
    ),
  );
  untrusted.close();
  assert.equal(untrustedLogs[0].transport_category, "tls");
  assert.equal(typeof untrustedLogs[0].transport_code, "string");

  const trustedLogs = [];
  const trusted = sessionFor({
    proxyPort: trustedProxy.port,
    caCertificates: [certificates.ca],
    logs: trustedLogs,
  });
  const forwarded = [];
  const request = Buffer.from(JSON.stringify({ type: "response.create", generate: true }));
  const terminal = await trusted.run(request, false, {
    forward: async (data, isBinary) => forwarded.push({ data: Buffer.from(data), isBinary }),
  });
  trusted.close();
  assert.equal(terminal.type, "response.completed");
  assert.equal(trustedUpstream.received.length, 1);
  assert.equal(Buffer.compare(trustedUpstream.received[0].data, request), 0);
  assert.equal(forwarded.length, 1);
  assert.equal(trustedLogs.length, 0);
  assert.deepEqual(trustedProxy.targets, [
    "CONNECT chatgpt.com:443 HTTP/1.1",
    "CONNECT chatgpt.com:443 HTTP/1.1",
  ]);

  const wrongHostUpstream = await createWebSocketUpstream(certificates.wrongHost);
  const wrongHostProxy = await createConnectProxy(wrongHostUpstream.port);
  t.after(() => wrongHostUpstream.close());
  t.after(() => wrongHostProxy.close());
  const wrongHostLogs = [];
  const wrongHost = sessionFor({
    proxyPort: wrongHostProxy.port,
    caCertificates: [certificates.ca],
    logs: wrongHostLogs,
  });
  await assert.rejects(wrongHost.connect(), (error) =>
    error.type === "upstream_connection_error" &&
    error.transportCategory === "tls" &&
    error.transportCode === "ERR_TLS_CERT_ALTNAME_INVALID",
  );
  wrongHost.close();
  assert.deepEqual(wrongHostLogs, [{
    event: "official_ws_connect_failed",
    transport: "websocket",
    transport_code: "ERR_TLS_CERT_ALTNAME_INVALID",
    transport_category: "tls",
  }]);
});

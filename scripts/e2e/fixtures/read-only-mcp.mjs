#!/usr/bin/env node
import { createInterface } from "node:readline";

const marker = process.env.ROUTER_ACCEPTANCE_MCP_MARKER ?? "MCP_FIXTURE_OK";
const lines = createInterface({ input: process.stdin });

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

for await (const line of lines) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  if (request.id == null) continue;
  if (request.method === "initialize") {
    reply(request.id, {
      protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "router-read-only-acceptance", version: "1.0.0" },
    });
  } else if (request.method === "tools/list") {
    reply(request.id, {
      tools: [{
        name: "read_marker",
        description: "Return a synthetic public acceptance marker without reading files or network data",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }],
    });
  } else if (request.method === "tools/call") {
    reply(request.id, {
      content: [{ type: "text", text: marker }],
      structuredContent: { marker },
      isError: false,
    });
  } else reply(request.id, {});
}

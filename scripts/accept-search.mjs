import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import assert from "node:assert/strict";
import { writeAcceptanceEvidence } from "./e2e/lib/evidence-path.mjs";
const base = process.env.ACCEPT_GATEWAY_URL ?? "http://127.0.0.1:18791";
const out = [];
for (const native of [false, true]) {
  const headers = {
    "content-type": "application/json",
    "session-id": native
      ? "native-search-acceptance"
      : "tavily-search-acceptance",
  };
  if (native) {
    const { tokens } = JSON.parse(
      await readFile(homedir() + "/.codex/auth.json", "utf8"),
    );
    headers.authorization = `Bearer ${tokens.access_token}`;
    headers["chatgpt-account-id"] = tokens.account_id;
  }
  const body = {
    model: native ? "gpt-5.5" : "deepseek-v4.1-flash",
    instructions:
      "Use the available web search tool before answering. Be concise.",
    input:
      "Search for OpenAI Codex official documentation and return two source URLs from the search results.",
    tools: [{ type: "web_search" }],
    stream: false,
  };
  const r = await fetch(
    base + (native ? "/subscription" : "") + "/v1/responses",
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    },
  );
  const x = await r.json();
  assert.equal(r.status, 200, JSON.stringify(x.error));
  assert.equal(x.status, "completed");
  const output = (x.output ?? []).map((item) => ({
    type: item.type,
    ...(item.type === "message" ? { content: item.content } : {}),
    ...(item.type === "web_search_call" ? { status: item.status } : {}),
  }));
  if (native) assert.ok(output.some((x) => x.type === "web_search_call"));
  out.push({
    mode: native ? "native" : "tool_fallback",
    status: r.status,
    output,
  });
  console.log(
    JSON.stringify({ event: "search_passed", mode: out.at(-1).mode }),
  );
}
await writeAcceptanceEvidence("search.json", out);

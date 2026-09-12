import test from "node:test";
import assert from "node:assert/strict";
import {
  FakeWebSearchAdapter,
  ExaWebSearchAdapter,
  TavilyWebSearchAdapter,
} from "../src/websearch.mjs";
test("fake search returns structured results", async () => {
  const r = await new FakeWebSearchAdapter().search({ query: "gateway" });
  assert.equal(r.results[0].url, "https://example.com");
});
test("fake page extraction returns bounded readable content", async () => {
  const adapter = new FakeWebSearchAdapter(undefined, {
    "https://example.com/report": "report body".repeat(200),
  });
  const page = await adapter.fetchPage({
    url: "https://example.com/report",
    maxCharacters: 1000,
  });
  assert.equal(page.characters, 1000);
  assert.equal(page.content.length, 1000);
  assert.equal(page.truncated, true);
});
test("exa adapter reports missing credential", async () => {
  await assert.rejects(
    () => new ExaWebSearchAdapter({ apiKey: "" }).search({ query: "x" }),
    /not configured/,
  );
});
test("tavily adapter maps search results without exposing credential", async () => {
  let request;
  const r = await new TavilyWebSearchAdapter({
    apiKey: "test-key",
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          results: [{ title: "T", url: "https://t.example", content: "C" }],
        }),
        { status: 200 },
      );
    },
  }).search({ query: "gateway", numResults: 2 });
  assert.deepEqual(r.results, [
    { title: "T", url: "https://t.example", snippet: "C" },
  ]);
  assert.equal(request.api_key, "test-key");
});
test("tavily adapter extracts a page with bearer auth and bounded output", async () => {
  let request;
  const page = await new TavilyWebSearchAdapter({
    apiKey: "test-key",
    fetchImpl: async (url, options) => {
      request = { url, headers: options.headers, body: JSON.parse(options.body) };
      return new Response(
        JSON.stringify({
          results: [
            {
              url: "https://example.com/report",
              raw_content: "page".repeat(600),
            },
          ],
        }),
        { status: 200 },
      );
    },
  }).fetchPage({
    url: "https://example.com/report",
    query: "latest finding",
    maxCharacters: 1000,
  });
  assert.equal(request.url, "https://api.tavily.com/extract");
  assert.equal(request.headers.authorization, "Bearer test-key");
  assert.deepEqual(request.body, {
    urls: "https://example.com/report",
    extract_depth: "basic",
    format: "markdown",
    include_images: false,
    query: "latest finding",
    chunks_per_source: 5,
  });
  assert.equal(page.characters, 1000);
  assert.equal(page.truncated, true);
});
test("exa adapter uses the contents endpoint and trims extracted text", async () => {
  let request;
  const page = await new ExaWebSearchAdapter({
    apiKey: "test-key",
    fetchImpl: async (url, options) => {
      request = { url, headers: options.headers, body: JSON.parse(options.body) };
      return new Response(
        JSON.stringify({
          results: [
            { url: "https://example.com/report", text: "exa".repeat(500) },
          ],
        }),
        { status: 200 },
      );
    },
  }).fetchPage({
    url: "https://example.com/report",
    maxCharacters: 1000,
  });
  assert.equal(request.url, "https://api.exa.ai/contents");
  assert.equal(request.headers["x-api-key"], "test-key");
  assert.deepEqual(request.body, {
    urls: ["https://example.com/report"],
    text: true,
  });
  assert.equal(page.characters, 1000);
  assert.equal(page.truncated, true);
});

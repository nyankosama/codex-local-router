import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  hostedSearchRequest,
  resolveSubscriptionSearchPolicy,
} from "../src/subscription-search.mjs";
import { SubscriptionWebSearchAdapter } from "../src/websearch.mjs";

const response = (status, value) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: new Headers({ "content-type": "application/json" }),
  rawHeaders: [["content-type", "application/json"]],
  body: Readable.from([Buffer.from(JSON.stringify(value))]),
});

test("subscription search is explicit and hosted tools are identified by type only", () => {
  assert.equal(resolveSubscriptionSearchPolicy({}).delivery, "disabled");
  assert.deepEqual(
    resolveSubscriptionSearchPolicy({
      app: { enabled: true },
      subscriptionSearch: { delivery: "standard-tool" },
    }),
    {
      delivery: "standard-tool",
      reason: "target-explicit",
      advertised: true,
      carrier: "hosted-to-standard-function",
    },
  );
  assert.deepEqual(
    hostedSearchRequest({
      type: "web_search",
      mode: "live",
      filters: { allowed_domains: ["docs.example.com"] },
    }),
    {
      type: "web_search",
      mode: "live",
      allowedDomains: ["docs.example.com"],
    },
  );
  assert.throws(
    () => hostedSearchRequest({ type: "web_search", filters: { allowed_domains: ["https://bad.example/path"] } }),
    (error) => error.type === "subscription_search_request_unsupported" && error.status === 400,
  );
});

test("subscription adapter uses only subscription identity and returns bounded allowed results", async () => {
  let seen;
  const adapter = new SubscriptionWebSearchAdapter({
    headers: {
      authorization: "Bearer subscription-token",
      "chatgpt-account-id": "account",
      "content-length": "999",
      "x-provider-key": "must-not-exist",
    },
    model: "custom-model",
    requestShape: {
      mode: "live",
      allowedDomains: ["docs.example.com"],
    },
    fetchImpl: async (url, request) => {
      seen = { url, request };
      return response(200, {
        results: [
          { title: "Allowed", url: "https://docs.example.com/page", snippet: "ok", ref_id: "r1" },
          { title: "Blocked", url: "https://other.example/page", snippet: "no" },
        ],
      });
    },
  });
  const result = await adapter.search({ query: "fixture", numResults: 2 });
  assert.equal(seen.url, "https://chatgpt.com/backend-api/codex/alpha/search");
  assert.equal(seen.request.headers.authorization, "Bearer subscription-token");
  assert.equal(seen.request.headers["content-length"], undefined);
  assert.equal(seen.request.headers["x-provider-key"], undefined);
  const body = JSON.parse(seen.request.body);
  assert.deepEqual(body.commands, {
    search_query: [{ q: "fixture" }],
    response_length: "short",
  });
  assert.equal(body.settings.external_web_access, true);
  assert.deepEqual(body.settings.allowed_domains, ["docs.example.com"]);
  assert.deepEqual(result.results.map((item) => item.url), [
    "https://docs.example.com/page",
  ]);
});

test("subscription adapter fails closed when the current search mode is not observable", async () => {
  const adapter = new SubscriptionWebSearchAdapter({
    model: "custom-model",
    requestShape: { mode: null, allowedDomains: [] },
    fetchImpl: async () => {
      throw Error("must not send");
    },
  });
  await assert.rejects(
    adapter.search({ query: "fixture" }),
    (error) => error.code === "subscription_search_mode_unresolved",
  );
});

test("subscription adapter classifies transport failures without retrying", async () => {
  let calls = 0;
  const adapter = new SubscriptionWebSearchAdapter({
    model: "custom-model",
    requestShape: { mode: "cached", allowedDomains: [] },
    fetchImpl: async () => {
      calls++;
      throw Object.assign(Error("fixture"), { type: "upstream_timeout" });
    },
  });
  await assert.rejects(
    adapter.search({ query: "fixture" }),
    (error) => error.code === "subscription_search_timeout" && error.status === 504,
  );
  assert.equal(calls, 1);
});

import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import {
  assertAcceptanceRevision,
  extractSearchResultCandidates,
  searchResultFingerprint,
} from "../scripts/e2e/lib/harness.mjs";

test("A10 search evidence extracts only bounded URL candidates and hashes them", () => {
  const url = "https://learn.chatgpt.com/docs/web-search?fixture=one";
  const encoded = zlib.gzipSync(Buffer.from(JSON.stringify({
    results: [{ url }],
    privateText: "must not be returned by the extractor",
  })));
  const candidates = extractSearchResultCandidates(encoded, "gzip");
  assert.deepEqual(candidates, [url]);
  assert.match(searchResultFingerprint(candidates[0]), /^[a-f0-9]{64}$/);
  assert.equal(searchResultFingerprint(candidates[0]).includes("learn.chatgpt.com"), false);
});

test("A10 malformed compressed search evidence fails closed", () => {
  assert.deepEqual(extractSearchResultCandidates(Buffer.from("not gzip"), "gzip"), []);
});

test("A10 acceptance evidence is bound to an exact clean commit", () => {
  const commit = "a".repeat(40);
  assert.deepEqual(
    assertAcceptanceRevision({ expected: commit, actual: commit }),
    { commit },
  );
  assert.throws(
    () => assertAcceptanceRevision({ expected: "a".repeat(7), actual: commit }),
    /does not match HEAD/,
  );
  assert.throws(
    () => assertAcceptanceRevision({ expected: commit, actual: "b".repeat(40) }),
    /does not match HEAD/,
  );
  assert.throws(
    () => assertAcceptanceRevision({ expected: commit, actual: commit, status: " M src/a.mjs" }),
    /not clean/,
  );
});

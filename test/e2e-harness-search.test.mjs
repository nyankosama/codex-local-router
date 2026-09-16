import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import {
  assertAcceptanceRevision,
  createEvidenceDirectory,
  decodeSseFrames,
  extractSearchResultCandidates,
  searchResultFingerprint,
  writeImmutableJson,
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

test("A10 protocol evidence decodes compressed SSE without changing the forwarded bytes", () => {
  const encoded = zlib.gzipSync(Buffer.from([
    "data: {\"type\":\"response.created\",\"sequence_number\":0}\r\n\r\n",
    "data: {\"type\":\"response.completed\",\"sequence_number\":1}\r\n\r\n",
  ].join("")));
  assert.deepEqual(decodeSseFrames(encoded, "gzip").map(({ type, sequence_number }) => ({ type, sequence_number })), [
    { type: "response.created", sequence_number: 0 },
    { type: "response.completed", sequence_number: 1 },
  ]);
});

test("A10 acceptance evidence is bound to an exact clean commit", () => {
  const commit = "a".repeat(40);
  const tree = "c".repeat(40);
  assert.deepEqual(
    assertAcceptanceRevision({ expected: commit, actual: commit, tree }),
    { commit, tree },
  );
  assert.throws(
    () => assertAcceptanceRevision({ expected: "a".repeat(7), actual: commit, tree }),
    /does not match HEAD/,
  );
  assert.throws(
    () => assertAcceptanceRevision({ expected: commit, actual: "b".repeat(40), tree }),
    /does not match HEAD/,
  );
  assert.throws(
    () => assertAcceptanceRevision({ expected: commit, actual: commit, tree, status: " M src/a.mjs" }),
    /not clean/,
  );
  assert.throws(
    () => assertAcceptanceRevision({ expected: commit, actual: commit, tree: null }),
    /tree could not be resolved/,
  );
});

test("A10 evidence directories and JSON receipts are create-once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "router-evidence-once-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = join(root, "run-1");
  await createEvidenceDirectory(run);
  await assert.rejects(createEvidenceDirectory(run), { code: "EEXIST" });
  const receipt = join(run, "summary.json");
  await writeImmutableJson(receipt, { verdict: "PASS" });
  assert.equal(JSON.parse(await readFile(receipt, "utf8")).verdict, "PASS");
  await assert.rejects(writeImmutableJson(receipt, { verdict: "FAIL" }), { code: "EEXIST" });
});

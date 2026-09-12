import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createHmac } from "node:crypto";
import { Archive, openArchive } from "../src/archive.mjs";
import { StateStore } from "../src/state.mjs";

const key = Buffer.alloc(32, 7);
const ctx = {
  auth: "auth",
  account: "chatgpt:account-1",
  owner: "owner\0thread-1",
  thread: "thread-1",
  branch: "branch-1",
  session: "thread-1",
};
const message = (role, text) => ({
  type: "message",
  role,
  content: [
    { type: role === "assistant" ? "output_text" : "input_text", text },
  ],
});
const target = {
  id: "custom-a",
  provider: "provider-a",
  model: "model-a",
  wireApi: "responses",
};

test("encrypted SQLite history survives restart and preserves order, duplicates and branch isolation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-archive-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "history.sqlite");
  let archive = new Archive(path, key);
  let state = new StateStore({ maxBytes: 512, ttlMs: 1 }, archive);
  const input = [
    message("user", "SECRET_MARKER_771"),
    message("user", "duplicate"),
    message("user", "duplicate"),
    { type: "function_call", call_id: "c1", name: "read", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: "RESULT_882" },
  ];
  const response = {
    id: "resp-one",
    status: "completed",
    output: [message("assistant", "done")],
  };
  assert.equal(state.save(ctx, response, input, target), 1);
  assert.equal(
    state.save(ctx, response, [message("user", "MUTATED_RETRY")], target),
    1,
  );
  assert.equal(archive.stats().versions, 1);
  assert.ok(
    !state
      .replay(ctx, { previous_response_id: "resp-one", input: [] })
      .body.input.some(
        (item) => item.content?.[0]?.text === "MUTATED_RETRY",
      ),
  );
  archive.close();

  const raw = await readFile(path);
  assert.equal(raw.includes(Buffer.from("SECRET_MARKER_771")), false);
  assert.equal(raw.includes(Buffer.from("RESULT_882")), false);

  archive = new Archive(path, key);
  state = new StateStore({ maxBytes: 512, ttlMs: 1 }, archive);
  const replay = state.replay(ctx, {
    previous_response_id: "resp-one",
    input: [message("user", "next")],
  });
  assert.equal(
    replay.body.input.filter(
      (item) => item.content?.[0]?.text === "duplicate",
    ).length,
    2,
  );
  assert.ok(replay.body.input.some((item) => item.output === "RESULT_882"));
  assert.equal(
    archive.history({
      owner: ctx.account,
      thread: ctx.thread,
      branch: ctx.branch,
    }).version,
    1,
  );
  assert.equal(
    archive.history({
      owner: ctx.account,
      thread: ctx.thread,
      branch: "another-branch",
    }),
    undefined,
  );
  archive.close();
});

test("summary operations persist terminal state and pruning cannot orphan retained versions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-archive-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const archive = new Archive(join(dir, "history.sqlite"), key);
  t.after(() => archive.close());
  const state = new StateStore({}, archive);
  state.save(
    ctx,
    { id: "r1", status: "completed", output: [message("assistant", "one")] },
    [message("user", "one")],
    target,
  );
  state.save(
    ctx,
    { id: "r2", status: "completed", output: [message("assistant", "two")] },
    [message("user", "one"), message("user", "two")],
    target,
  );
  const operation = {
    owner: ctx.account,
    thread: ctx.thread,
    branch: ctx.branch,
    version: 2,
    kind: "migration:target-b",
  };
  archive.setOperation(operation, {
    status: "completed",
    result: [message("assistant", "summary")],
  });
  assert.equal(archive.getOperation(operation).status, "completed");
  assert.throws(
    () =>
      archive.prune({
        owner: ctx.account,
        thread: ctx.thread,
        branch: ctx.branch,
        beforeVersion: 2,
        dryRun: true,
      }),
    (error) => error.type === "history_prune_referenced",
  );
  assert.deepEqual(
    archive.prune({
      owner: ctx.account,
      thread: ctx.thread,
      branch: ctx.branch,
      dryRun: true,
    }),
    { count: 2, dryRun: true },
  );
  assert.deepEqual(
    archive.prune({
      owner: ctx.account,
      thread: ctx.thread,
      branch: ctx.branch,
      dryRun: false,
    }),
    { count: 2, dryRun: false },
  );
  assert.equal(archive.stats().versions, 0);
});

test("history quota stops new encrypted content without deleting existing versions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-archive-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const archive = new Archive(join(dir, "history.sqlite"), key, {
    diskMaxBytes: 256 * 1024,
  });
  t.after(() => archive.close());
  const state = new StateStore({}, archive);
  state.save(
    ctx,
    { id: "small", status: "completed", output: [] },
    [message("user", "kept")],
    target,
  );
  assert.throws(
    () =>
      state.save(
        ctx,
        { id: "large", status: "completed", output: [] },
        [message("user", "x".repeat(400000))],
        target,
      ),
    (error) => error.type === "history_disk_full",
  );
  assert.equal(archive.stats().versions, 1);
});

test("fork metadata binds a child to the exact retained parent version", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-archive-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const archive = new Archive(join(dir, "history.sqlite"), key);
  t.after(() => archive.close());
  archive.appendHistory({
    owner: ctx.account,
    thread: "parent",
    branch: "parent",
    target,
    responseId: "parent-response",
    original: [message("user", "parent")],
    view: [message("user", "parent")],
  });
  archive.appendHistory({
    owner: ctx.account,
    thread: "child",
    branch: "child",
    parent: { thread: "parent", branch: "parent" },
    target,
    responseId: "child-response",
    original: [message("user", "parent"), message("user", "child")],
    view: [message("user", "parent"), message("user", "child")],
  });
  assert.equal(
    archive.history({
      owner: ctx.account,
      thread: "child",
      branch: "child",
    }).branch.parent_version,
    1,
  );
  assert.throws(
    () =>
      archive.prune({
        owner: ctx.account,
        thread: "parent",
        branch: "parent",
        dryRun: false,
      }),
    (error) => error.type === "history_prune_referenced",
  );
});

test("new history versions store only event suffixes and reconstruct exact prefixes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-archive-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const archive = new Archive(join(dir, "history.sqlite"), key);
  t.after(() => archive.close());
  const first = [message("user", "one"), message("assistant", "answer-one")];
  const second = [...first, message("user", "two"), message("assistant", "answer-two")];
  archive.appendHistory({ owner: ctx.account, thread: ctx.thread, branch: ctx.branch, target, original: first, view: first });
  archive.appendHistory({ owner: ctx.account, thread: ctx.thread, branch: ctx.branch, target, original: second, view: second });
  assert.equal(archive.stats().events, 8);
  assert.deepEqual(archive.history({ owner: ctx.account, thread: ctx.thread, branch: ctx.branch }).original, second);
});

test("opening a v2 archive keeps a recovery backup and writes future versions incrementally", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-archive-v2-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "history.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE blobs(hash TEXT PRIMARY KEY, body BLOB NOT NULL, bytes INTEGER NOT NULL);
    CREATE TABLE records(key TEXT PRIMARY KEY,hash TEXT NOT NULL,updated INTEGER NOT NULL,owner TEXT,thread TEXT,branch TEXT);
    CREATE TABLE history_versions(owner TEXT NOT NULL,thread TEXT NOT NULL,branch TEXT NOT NULL,version INTEGER NOT NULL,parent_version INTEGER,target_id TEXT,provider TEXT,model TEXT,response_id TEXT,status TEXT NOT NULL,original_hash TEXT NOT NULL,view_hash TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(owner,thread,branch,version));
    CREATE TABLE branches(owner TEXT NOT NULL,thread TEXT NOT NULL,branch TEXT NOT NULL,parent_thread TEXT,parent_branch TEXT,parent_version INTEGER,created INTEGER NOT NULL,PRIMARY KEY(owner,thread,branch));
    CREATE TABLE operations(key TEXT PRIMARY KEY,owner TEXT NOT NULL,thread TEXT NOT NULL,branch TEXT NOT NULL,version INTEGER NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,result_hash TEXT,error_type TEXT,updated INTEGER NOT NULL);
    PRAGMA user_version=2;
  `);
  const opaque = (value) => createHmac("sha256", key).update(value).digest("hex");
  const put = (value, ivByte) => {
    const raw = Buffer.from(JSON.stringify(value));
    const hash = createHmac("sha256", key).update(raw).digest("hex");
    const iv = Buffer.alloc(12, ivByte);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(hash));
    const body = Buffer.concat([iv, cipher.update(raw), cipher.final(), cipher.getAuthTag()]);
    db.prepare("INSERT OR IGNORE INTO blobs(hash,body,bytes) VALUES (?,?,?)").run(hash, body, body.length);
    return hash;
  };
  const original = [message("user", "legacy")];
  const extended = [...original, message("assistant", "continued")];
  const originalHash = put(original, 1), viewHash = put(original, 2);
  const extendedHash = put(extended, 3), extendedViewHash = put(extended, 4);
  const insert = db.prepare("INSERT INTO history_versions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
  insert.run(
    opaque(ctx.account), opaque(ctx.thread), opaque(ctx.branch), 1, null,
    target.id, target.provider, target.model, "legacy-response", "complete_original",
    originalHash, viewHash, Date.now(),
  );
  insert.run(
    opaque(ctx.account), opaque(ctx.thread), opaque(ctx.branch), 2, 1,
    target.id, target.provider, target.model, "legacy-response-2", "complete_original",
    extendedHash, extendedViewHash, Date.now() + 1,
  );
  db.close();
  const archive = await openArchive({ path }, { key });
  assert.deepEqual(archive.history({ owner: ctx.account, thread: ctx.thread, branch: ctx.branch }).original, extended);
  assert.equal(archive.stats().events, 0);
  const recent = [...extended, message("user", "recent")];
  archive.appendHistory({
    owner: ctx.account,
    thread: ctx.thread,
    branch: ctx.branch,
    target,
    responseId: "current-response",
    original: recent,
    view: recent,
  });
  assert.deepEqual(archive.history({ owner: ctx.account, thread: ctx.thread, branch: ctx.branch }).original, recent);
  assert.equal(archive.stats().events, 2);
  const migrated = archive.db.prepare(
    "SELECT original_base_version,original_prefix,original_count FROM history_versions WHERE version=3",
  ).get();
  assert.equal(migrated.original_base_version, 2);
  assert.equal(migrated.original_prefix, 2);
  assert.equal(migrated.original_count, 3);
  archive.close();
  const names = await readdir(dir);
  const backup = names.find((name) => name.startsWith("history.sqlite.before-v3-"));
  assert.ok(backup);
  assert.ok(!names.some((name) => name.endsWith(".copying")));
  const snapshot = new DatabaseSync(join(dir, backup), { readOnly: true });
  assert.equal(snapshot.prepare("PRAGMA user_version").get().user_version, 2);
  assert.equal(snapshot.prepare("SELECT count(*) AS n FROM history_versions").get().n, 2);
  snapshot.close();
});

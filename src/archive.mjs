import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import { mkdir, chmod, readdir, rename, rm, stat } from "node:fs/promises";
import { statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fail } from "./errors.mjs";
import { runtimePaths, legacyPaths } from "./product.mjs";

export const defaultStatePath = () =>
  runtimePaths().history;

const exec = promisify(execFile);

async function snapshotDatabase(sourcePath, targetPath) {
  const staging = `${targetPath}.copying`;
  await rm(staging, { force: true });
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await sqliteBackup(source, staging);
  } finally {
    source.close();
  }
  await chmod(staging, 0o600);
  await rename(staging, targetPath);
}

async function hasMigrationBackup(path, version) {
  const prefix = `${basename(path)}.before-v${version}-`;
  let names;
  try { names = await readdir(dirname(path)); }
  catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  for (const name of names.sort().reverse()) {
    if (!name.startsWith(prefix) || name.endsWith(".copying")) continue;
    let snapshot;
    try {
      snapshot = new DatabaseSync(join(dirname(path), name), { readOnly: true });
      if (snapshot.prepare("PRAGMA user_version").get().user_version < version)
        return true;
    } catch {} finally {
      snapshot?.close();
    }
  }
  return false;
}

export async function historyKey(options = {}) {
  const service = options.keychainService ?? "llm-auto-gateway-history-v1";
  const account = "archive";
  try {
    const { stdout } = await exec("/usr/bin/security", [
      "find-generic-password",
      "-s",
      service,
      "-a",
      account,
      "-w",
    ]);
    const key = Buffer.from(stdout.trim(), "hex");
    if (key.length !== 32) throw Error("invalid history key");
    return key;
  } catch (error) {
    // A missing key for a non-empty archive is data loss, not a new archive.
    if (options.existing || error.code !== 44)
      throw fail("history_key_unavailable", 503);
    const key = randomBytes(32);
    await new Promise((resolve, reject) => {
      const child = spawn("/usr/bin/security", ["-i"], {
        stdio: ["pipe", "ignore", "pipe"],
      });
      let errors = "";
      child.stderr.on("data", (data) => {
        errors += data;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0 && !/SecKeychain|Error:/i.test(errors)) resolve();
        else reject(fail("history_key_unavailable", 503));
      });
      // Interactive input keeps the generated secret out of the process list.
      child.stdin.end(
        `add-generic-password -s ${JSON.stringify(service)} -a ${JSON.stringify(account)} -w ${key.toString("hex")}\n`,
      );
    });
    const { stdout } = await exec("/usr/bin/security", [
      "find-generic-password",
      "-s",
      service,
      "-a",
      account,
      "-w",
    ]);
    if (stdout.trim() !== key.toString("hex"))
      throw fail("history_key_unavailable", 503);
    return key;
  }
}

export class Archive {
  constructor(
    path,
    key,
    {
      diskMaxBytes = 10 * 1024 ** 3,
      warningPercent = 80,
      log = () => {},
    } = {},
  ) {
    if (!Buffer.isBuffer(key) || key.length !== 32)
      throw Error("archive needs a 256-bit key");
    this.path = path;
    this.key = key;
    this.limit = diskMaxBytes;
    this.warningPercent = warningPercent;
    this.log = log;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS blobs (
        hash TEXT PRIMARY KEY,
        body BLOB NOT NULL,
        bytes INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS records (
        key TEXT PRIMARY KEY,
        hash TEXT NOT NULL REFERENCES blobs(hash),
        updated INTEGER NOT NULL,
        owner TEXT,
        thread TEXT,
        branch TEXT
      );
      CREATE TABLE IF NOT EXISTS history_versions (
        owner TEXT NOT NULL,
        thread TEXT NOT NULL,
        branch TEXT NOT NULL,
        version INTEGER NOT NULL,
        parent_version INTEGER,
        target_id TEXT,
        provider TEXT,
        model TEXT,
        response_id TEXT,
        status TEXT NOT NULL,
        original_hash TEXT NOT NULL REFERENCES blobs(hash),
        view_hash TEXT NOT NULL REFERENCES blobs(hash),
        created INTEGER NOT NULL,
        PRIMARY KEY(owner, thread, branch, version)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS history_response
        ON history_versions(owner, thread, branch, response_id)
        WHERE response_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS branches (
        owner TEXT NOT NULL,
        thread TEXT NOT NULL,
        branch TEXT NOT NULL,
        parent_thread TEXT,
        parent_branch TEXT,
        parent_version INTEGER,
        created INTEGER NOT NULL,
        PRIMARY KEY(owner, thread, branch)
      );
      CREATE TABLE IF NOT EXISTS operations (
        key TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        thread TEXT NOT NULL,
        branch TEXT NOT NULL,
        version INTEGER NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        result_hash TEXT REFERENCES blobs(hash),
        error_type TEXT,
        updated INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS history_event_items (
        owner TEXT NOT NULL,
        thread TEXT NOT NULL,
        branch TEXT NOT NULL,
        version INTEGER NOT NULL,
        kind TEXT NOT NULL,
        position INTEGER NOT NULL,
        hash TEXT NOT NULL REFERENCES blobs(hash),
        PRIMARY KEY(owner,thread,branch,version,kind,position),
        FOREIGN KEY(owner,thread,branch,version)
          REFERENCES history_versions(owner,thread,branch,version)
          ON DELETE CASCADE
      );
    `);
    const recordColumns = new Set(
      this.db.prepare("PRAGMA table_info(records)").all().map((row) => row.name),
    );
    for (const column of ["owner", "thread", "branch"])
      if (!recordColumns.has(column))
        this.db.exec(`ALTER TABLE records ADD COLUMN ${column} TEXT`);
    const historyColumns = new Set(
      this.db.prepare("PRAGMA table_info(history_versions)").all().map((row) => row.name),
    );
    for (const column of [
      "original_base_version",
      "original_prefix",
      "original_count",
      "view_base_version",
      "view_prefix",
      "view_count",
    ])
      if (!historyColumns.has(column))
        this.db.exec(`ALTER TABLE history_versions ADD COLUMN ${column} INTEGER`);
    this.migrateEventStorage();
  }

  migrateEventStorage() {
    const version = this.db.prepare("PRAGMA user_version").get().user_version;
    if (version >= 3) return;
    const legacyVersions = this.db
      .prepare("SELECT count(*) AS n FROM history_versions")
      .get().n;
    this.transaction(() => this.db.exec("PRAGMA user_version=3"));
    this.log({ event: "history_migration_ready", legacyVersions });
  }

  opaque(value) {
    return createHmac("sha256", this.key).update(value).digest("hex");
  }

  encode(value) {
    const raw = Buffer.from(JSON.stringify(value));
    const hash = this.blobHash(raw);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(hash));
    return {
      hash,
      body: Buffer.concat([
        iv,
        cipher.update(raw),
        cipher.final(),
        cipher.getAuthTag(),
      ]),
    };
  }

  blobHash(value) {
    const raw = Buffer.isBuffer(value)
      ? value
      : Buffer.from(JSON.stringify(value));
    return createHmac("sha256", this.key).update(raw).digest("hex");
  }

  decode(row) {
    if (!row) return undefined;
    try {
      const data = Buffer.from(row.body);
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        data.subarray(0, 12),
      );
      decipher.setAAD(Buffer.from(row.hash));
      decipher.setAuthTag(data.subarray(-16));
      const raw = Buffer.concat([
        decipher.update(data.subarray(12, -16)),
        decipher.final(),
      ]);
      return JSON.parse(raw.toString());
    } catch {
      throw fail("history_corrupt", 503);
    }
  }

  physicalBytes() {
    let total = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        total += statSync(this.path + suffix).size;
      } catch {}
    }
    return total;
  }

  ensureQuota(additionalBytes) {
    // 配额用物理文件大小（O(1)）”估；`SUM(bytes)` 在数 GB 库上是全表扫描，
    // 而每个 blob 写入都会走到这里，会阻塞主线程数秒（线上实测健康检查 p95 5s，
    // sample 显示 87% 主线程采样停在 StatementSync::Get）。
    // ponytail: 物理大小作为上界（blob 存在库内，sum ≤ file）；若将来出现库外溢存
    // 再改成增量计数器。
    const used = this.physicalBytes();
    if (used + additionalBytes > this.limit)
      throw fail(
        "history_disk_full",
        507,
        "History quota reached; export or explicitly prune history before continuing",
      );
    if (used + additionalBytes >= this.limit * (this.warningPercent / 100))
      this.log({
        event: "history_quota_warning",
        bytes: used,
        limit: this.limit,
      });
  }

  putBlob(value) {
    const data = this.encode(value);
    if (!this.db.prepare("SELECT 1 FROM blobs WHERE hash=?").get(data.hash)) {
      this.ensureQuota(data.body.length);
      this.db
        .prepare("INSERT INTO blobs(hash,body,bytes) VALUES (?,?,?)")
        .run(data.hash, data.body, data.body.length);
    }
    return data.hash;
  }

  getBlob(hash) {
    return this.decode(
      this.db.prepare("SELECT hash,body FROM blobs WHERE hash=?").get(hash),
    );
  }

  insertEventItems(scope, kind, items) {
    const statement = this.db.prepare(`
      INSERT OR REPLACE INTO history_event_items(owner,thread,branch,version,kind,position,hash)
      VALUES (?,?,?,?,?,?,?)
    `);
    items.forEach((item, position) =>
      statement.run(
        scope.owner,
        scope.thread,
        scope.branch,
        scope.version,
        kind,
        position,
        this.putBlob(item),
      ),
    );
  }

  readEventStream(scope, kind, seen = new Set()) {
    const marker = `${kind}:${scope.version}`;
    if (seen.has(marker)) throw fail("history_corrupt", 503);
    seen.add(marker);
    const row = this.db.prepare(`
      SELECT ${kind}_base_version AS base_version,
             ${kind}_prefix AS prefix_count,
             ${kind}_count AS item_count,
             ${kind}_hash AS legacy_hash
      FROM history_versions
      WHERE owner=? AND thread=? AND branch=? AND version=?
    `).get(scope.owner, scope.thread, scope.branch, scope.version);
    if (!row) return undefined;
    if (row.item_count == null) return this.getBlob(row.legacy_hash);
    let items = [];
    if (row.base_version != null) {
      items = this.readEventStream({ ...scope, version: row.base_version }, kind, seen);
      if (!Array.isArray(items) || items.length < row.prefix_count)
        throw fail("history_corrupt", 503);
      items = items.slice(0, row.prefix_count);
    }
    const suffix = this.db.prepare(`
      SELECT b.hash,b.body FROM history_event_items e
      JOIN blobs b ON b.hash=e.hash
      WHERE e.owner=? AND e.thread=? AND e.branch=? AND e.version=? AND e.kind=?
      ORDER BY e.position
    `).all(scope.owner, scope.thread, scope.branch, scope.version, kind)
      .map((entry) => this.decode(entry));
    items.push(...suffix);
    if (items.length !== row.item_count) throw fail("history_corrupt", 503);
    return items;
  }

  writeEventStream(scope, kind, items, previousVersion, previousItems) {
    let prefix = 0;
    const previous = Array.isArray(previousItems) ? previousItems : [];
    while (
      prefix < previous.length &&
      prefix < items.length &&
      JSON.stringify(previous[prefix]) === JSON.stringify(items[prefix])
    ) prefix++;
    const baseVersion = prefix > 0 ? previousVersion : null;
    const suffix = items.slice(baseVersion == null ? 0 : prefix);
    this.insertEventItems(scope, kind, suffix);
    this.db.prepare(`
      UPDATE history_versions SET
        ${kind}_base_version=?,${kind}_prefix=?,${kind}_count=?
      WHERE owner=? AND thread=? AND branch=? AND version=?
    `).run(
      baseVersion,
      baseVersion == null ? 0 : prefix,
      items.length,
      scope.owner,
      scope.thread,
      scope.branch,
      scope.version,
    );
  }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getState(key) {
    const row = this.db
      .prepare(
        "SELECT b.hash,b.body FROM records r JOIN blobs b ON b.hash=r.hash WHERE r.key=?",
      )
      .get(this.opaque(key));
    const value = this.decode(row);
    if (!value?.historyRef) return value;
    const history = this.history(value.historyRef);
    if (!history) throw fail("history_corrupt", 503);
    if (value.historyKind === "checkpoint")
      return {
        ...value,
        original: history.original,
        view: value.checkpointView ?? history.view,
      };
    return {
      ...value,
      input: history.view,
      original: history.original,
    };
  }

  writeState(key, value, scope) {
    const hash = this.putBlob(value);
    this.db
      .prepare(
        "INSERT INTO records(key,hash,updated,owner,thread,branch) VALUES (?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET hash=excluded.hash,updated=excluded.updated,owner=excluded.owner,thread=excluded.thread,branch=excluded.branch",
      )
      .run(
        this.opaque(key),
        hash,
        Date.now(),
        scope ? this.opaque(scope.owner) : null,
        scope ? this.opaque(scope.thread) : null,
        scope ? this.opaque(scope.branch) : null,
      );
  }

  setState(key, value, scope) {
    this.transaction(() => this.writeState(key, value, scope));
  }

  setStates(entries) {
    this.transaction(() => {
      for (const { key, value, scope } of entries)
        this.writeState(key, value, scope);
    });
  }

  setRecoveredCheckpoints(entries) {
    this.transaction(() => {
      for (const { key, value, scope } of entries) {
        const version = this.appendHistoryRow({
          owner: scope.owner,
          thread: scope.thread,
          branch: scope.branch,
          target: {
            id: value.targetId,
            provider: value.provider,
            model: value.model,
          },
          status: value.completeness ?? "complete_original",
          original: value.original,
          view: value.view,
        });
        this.writeState(
          key,
          {
            ...value,
            original: undefined,
            view: undefined,
            historyKind: "checkpoint",
            historyRef: {
              owner: scope.owner,
              thread: scope.thread,
              branch: scope.branch,
              version,
            },
          },
          scope,
        );
      }
    });
  }

  appendHistoryRow({
    owner,
    thread,
    branch,
    target,
    responseId,
    status = "complete",
    original,
    view,
    parent,
  }) {
    const ownerKey = this.opaque(owner);
    const threadKey = this.opaque(thread);
    const branchKey = this.opaque(branch);
    let parentVersion = parent?.version;
    if (parent && parentVersion == null)
      parentVersion = this.db
        .prepare(
          "SELECT max(version) AS version FROM history_versions WHERE owner=? AND thread=? AND branch=?",
        )
        .get(
          ownerKey,
          this.opaque(parent.thread),
          this.opaque(parent.branch ?? parent.thread),
        ).version;
    this.db
      .prepare(`
        INSERT OR IGNORE INTO branches(owner,thread,branch,parent_thread,parent_branch,parent_version,created)
        VALUES (?,?,?,?,?,?,?)
      `)
      .run(
        ownerKey,
        threadKey,
        branchKey,
        parent ? this.opaque(parent.thread) : null,
        parent ? this.opaque(parent.branch ?? parent.thread) : null,
        parentVersion ?? null,
        Date.now(),
      );
    if (responseId) {
      const prior = this.db
          .prepare(
            "SELECT version FROM history_versions WHERE owner=? AND thread=? AND branch=? AND response_id=?",
          )
          .get(ownerKey, threadKey, branchKey, responseId);
      if (prior) return prior.version;
    }
    const previous = this.db
        .prepare(
          "SELECT max(version) AS version FROM history_versions WHERE owner=? AND thread=? AND branch=?",
        )
        .get(ownerKey, threadKey, branchKey).version;
    const version = Number(previous ?? 0) + 1;
    const emptyHash = this.putBlob([]);
    const previousOriginal = previous == null
      ? []
      : this.readEventStream({ owner: ownerKey, thread: threadKey, branch: branchKey, version: previous }, "original");
    const previousView = previous == null
      ? []
      : this.readEventStream({ owner: ownerKey, thread: threadKey, branch: branchKey, version: previous }, "view");
    this.db
        .prepare(`
          INSERT INTO history_versions(
            owner,thread,branch,version,parent_version,target_id,provider,model,
            response_id,status,original_hash,view_hash,created
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        `)
        .run(
          ownerKey,
          threadKey,
          branchKey,
          version,
          previous ?? null,
          target?.id ?? null,
          target?.provider ?? null,
          target?.model ?? null,
          responseId ?? null,
          status,
          emptyHash,
          emptyHash,
          Date.now(),
        );
    const scope = { owner: ownerKey, thread: threadKey, branch: branchKey, version };
    this.writeEventStream(scope, "original", original, previous, previousOriginal);
    this.writeEventStream(scope, "view", view, previous, previousView);
    return version;
  }

  appendHistory(args) {
    return this.transaction(() => this.appendHistoryRow(args));
  }

  saveResponse(key, value, history) {
    return this.transaction(() => {
      if (history.responseId) {
        const prior = this.db
          .prepare(
            "SELECT version FROM history_versions WHERE owner=? AND thread=? AND branch=? AND response_id=?",
          )
          .get(
            this.opaque(history.owner),
            this.opaque(history.thread),
            this.opaque(history.branch),
            history.responseId,
          );
        if (prior) return { version: prior.version, inserted: false };
      }
      const version = this.appendHistoryRow(history);
      const hash = this.putBlob({
        ...value,
        input: undefined,
        original: undefined,
        historyRef: {
          owner: history.owner,
          thread: history.thread,
          branch: history.branch,
          version,
        },
      });
      this.db
        .prepare(
          "INSERT INTO records(key,hash,updated,owner,thread,branch) VALUES (?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET hash=excluded.hash,updated=excluded.updated,owner=excluded.owner,thread=excluded.thread,branch=excluded.branch",
        )
        .run(
          this.opaque(key),
          hash,
          Date.now(),
          this.opaque(history.owner),
          this.opaque(history.thread),
          this.opaque(history.branch),
        );
      return { version, inserted: true };
    });
  }

  history({ owner, thread, branch, version }) {
    const values = [this.opaque(owner), this.opaque(thread), this.opaque(branch)];
    const row = version == null
      ? this.db
          .prepare(
            "SELECT * FROM history_versions WHERE owner=? AND thread=? AND branch=? ORDER BY version DESC LIMIT 1",
          )
          .get(...values)
      : this.db
          .prepare(
            "SELECT * FROM history_versions WHERE owner=? AND thread=? AND branch=? AND version=?",
          )
          .get(...values, version);
    if (!row) return undefined;
    return {
      version: row.version,
      parentVersion: row.parent_version,
      target: {
        id: row.target_id,
        provider: row.provider,
        model: row.model,
      },
      responseId: row.response_id,
      status: row.status,
      original: this.readEventStream(
        { owner: values[0], thread: values[1], branch: values[2], version: row.version },
        "original",
      ),
      view: this.readEventStream(
        { owner: values[0], thread: values[1], branch: values[2], version: row.version },
        "view",
      ),
      created: row.created,
      branch: this.db
        .prepare(
          "SELECT parent_version FROM branches WHERE owner=? AND thread=? AND branch=?",
        )
        .get(...values),
    };
  }

  historySummary({ owner, thread, branch, version }) {
    const values = [this.opaque(owner), this.opaque(thread), this.opaque(branch)];
    const row = version == null
      ? this.db
          .prepare(
            "SELECT * FROM history_versions WHERE owner=? AND thread=? AND branch=? ORDER BY version DESC LIMIT 1",
          )
          .get(...values)
      : this.db
          .prepare(
            "SELECT * FROM history_versions WHERE owner=? AND thread=? AND branch=? AND version=?",
          )
          .get(...values, version);
    if (!row) return undefined;
    const count = (kind) => {
      if (row[`${kind}_count`] != null) return row[`${kind}_count`];
      const legacy = this.getBlob(row[`${kind}_hash`]);
      if (!Array.isArray(legacy)) throw fail("history_corrupt", 503);
      return legacy.length;
    };
    return {
      version: row.version,
      parentVersion: row.parent_version,
      target: {
        id: row.target_id,
        provider: row.provider,
        model: row.model,
      },
      responseId: row.response_id,
      status: row.status,
      originalItems: count("original"),
      viewItems: count("view"),
      created: row.created,
      branch: this.db
        .prepare(
          "SELECT parent_version FROM branches WHERE owner=? AND thread=? AND branch=?",
        )
        .get(...values),
    };
  }

  listHistory({ owner, thread, branch, limit = 100 } = {}) {
    const where = [];
    const values = [];
    for (const [column, value] of [
      ["owner", owner],
      ["thread", thread],
      ["branch", branch],
    ]) {
      if (value == null) continue;
      where.push(`${column}=?`);
      values.push(this.opaque(value));
    }
    const sql = `SELECT version,target_id,provider,model,response_id,status,created FROM history_versions${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created DESC LIMIT ?`;
    return this.db.prepare(sql).all(...values, limit);
  }

  historyViewForItem({ owner, thread, branch, item }) {
    const scope = [this.opaque(owner), this.opaque(thread), this.opaque(branch)];
    const row = this.db.prepare(`
      SELECT version FROM history_event_items
      WHERE owner=? AND thread=? AND branch=? AND kind='view' AND hash=?
      ORDER BY version ASC LIMIT 1
    `).get(...scope, this.blobHash(item));
    if (!row) return undefined;
    const historyRef = { owner, thread, branch, version: row.version };
    const history = this.history(historyRef);
    const serialized = JSON.stringify(item);
    if (!history?.view?.some((candidate) => JSON.stringify(candidate) === serialized))
      return undefined;
    return { view: history.view, historyRef };
  }

  historyViewForStateItem({ key, item }) {
    const scope = this.db.prepare(
      "SELECT owner,thread,branch FROM records WHERE key=?",
    ).get(this.opaque(key));
    if (!scope?.owner || !scope.thread || !scope.branch) return undefined;
    const versions = this.db.prepare(`
      SELECT version FROM history_versions
      WHERE owner=? AND thread=? AND branch=?
      ORDER BY version DESC
    `).all(scope.owner, scope.thread, scope.branch);
    for (const { version } of versions) {
      const view = this.readEventStream({ ...scope, version }, "view");
      if (view?.some((candidate) =>
        candidate?.encrypted_content === item.encrypted_content))
        return { view };
    }
    return undefined;
  }

  checkpoints({ owner, thread, branch, hydrate = false }) {
    const rows = this.db.prepare(`
      SELECT b.hash,b.body,r.updated FROM records r
      JOIN blobs b ON b.hash=r.hash
      WHERE r.owner=? AND r.thread=? AND r.branch=?
      ORDER BY r.updated DESC
    `).all(this.opaque(owner), this.opaque(thread), this.opaque(branch));
    return rows
      .map((row) => {
        const value = this.decode(row);
        if (
          !hydrate ||
          !value?.historyRef ||
          value.historyKind !== "checkpoint"
        )
          return { value, updated: row.updated };
        const history = this.history(value.historyRef);
        if (!history) throw fail("history_corrupt", 503);
        return {
          value: {
            ...value,
            original: history.original,
            view: value.checkpointView ?? history.view,
          },
          updated: row.updated,
        };
      })
      .filter(({ value }) =>
        value &&
        typeof value === "object" &&
        Object.hasOwn(value, "virtual") &&
        Object.hasOwn(value, "targetId"),
      );
  }

  checkpointStats({ owner, thread, branch }) {
    const checkpoints = this.checkpoints({ owner, thread, branch });
    const originalComplete = checkpoints.filter(({ value }) =>
      (Array.isArray(value.original ?? value.portable) &&
        (value.original ?? value.portable).length) ||
      (value.historyKind === "checkpoint" &&
        value.completeness === "complete_original"),
    );
    const summaryPortable = checkpoints.filter(
      ({ value }) =>
        value.migration?.status === "completed" &&
        (Array.isArray(value.migration.view) || value.historyKind === "checkpoint"),
    );
    const portable = checkpoints.filter(
      (checkpoint) =>
        originalComplete.includes(checkpoint) ||
        summaryPortable.includes(checkpoint),
    );
    return {
      portable: portable.length,
      unrecoverable: checkpoints.length - portable.length,
      completeOriginal: originalComplete.length,
      metadataOnly: checkpoints.filter(({ value }) =>
        !["complete_original", "gap_present", "observing"].includes(
          value.completeness,
        ) && value.migration?.status !== "completed",
      ).length,
      observing: checkpoints.filter(
        ({ value }) => value.completeness === "observing",
      ).length,
      gapPresent: checkpoints.filter(
        ({ value }) => value.completeness === "gap_present",
      ).length,
      summaryPortable: summaryPortable.length,
      migrationFailed: checkpoints.filter(
        ({ value }) =>
          value.migration?.status === "failed" ||
          value.migration?.status === "uncertain",
      ).length,
      recovered: checkpoints.filter(({ value }) => value.recovery?.sourceHash).length,
      recentRecoverySourceHash:
        checkpoints.find(({ value }) => value.recovery?.sourceHash)?.value.recovery.sourceHash ?? null,
    };
  }

  operationKey({ owner, thread, branch, version, kind }) {
    return this.opaque([owner, thread, branch, version, kind].join("\0"));
  }

  getOperation(spec) {
    const row = this.db
      .prepare("SELECT * FROM operations WHERE key=?")
      .get(this.operationKey(spec));
    if (!row) return undefined;
    return {
      status: row.status,
      result: row.result_hash ? this.getBlob(row.result_hash) : undefined,
      errorType: row.error_type,
      updated: row.updated,
    };
  }

  setOperation(spec, { status, result, errorType }) {
    this.transaction(() => {
      const resultHash = result === undefined ? null : this.putBlob(result);
      this.db
        .prepare(`
          INSERT INTO operations(key,owner,thread,branch,version,kind,status,result_hash,error_type,updated)
          VALUES (?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(key) DO UPDATE SET status=excluded.status,result_hash=excluded.result_hash,error_type=excluded.error_type,updated=excluded.updated
        `)
        .run(
          this.operationKey(spec),
          this.opaque(spec.owner),
          this.opaque(spec.thread),
          this.opaque(spec.branch),
          spec.version,
          spec.kind,
          status,
          resultHash,
          errorType ?? null,
          Date.now(),
        );
    });
  }

  prune({ owner, thread, branch, beforeVersion, dryRun = true }) {
    if (!owner || !thread || !branch)
      throw fail("history_prune_scope_required", 400);
    const values = [this.opaque(owner), this.opaque(thread), this.opaque(branch)];
    const extra = beforeVersion == null ? "" : " AND version<?";
    const params = beforeVersion == null ? values : [...values, beforeVersion];
    const count = this.db
      .prepare(
        `SELECT count(*) AS count FROM history_versions WHERE owner=? AND thread=? AND branch=?${extra}`,
      )
      .get(...params).count;
    const retained = beforeVersion == null
      ? 0
      : this.db
          .prepare(
            "SELECT count(*) AS count FROM history_versions WHERE owner=? AND thread=? AND branch=? AND version>=?",
          )
          .get(...values, beforeVersion).count;
    const children = this.db
      .prepare(
        "SELECT count(*) AS count FROM branches WHERE owner=? AND parent_thread=? AND parent_branch=?",
      )
      .get(values[0], values[1], values[2]).count;
    if (count && children)
      throw fail(
        "history_prune_referenced",
        409,
        "The selected branch is referenced by a retained fork",
      );
    if (count && retained)
      throw fail(
        "history_prune_referenced",
        409,
        "The selected versions are ancestors of retained history; export and prune the complete branch instead",
      );
    if (dryRun) return { count, dryRun: true };
    this.transaction(() => {
      this.db
        .prepare(
          `DELETE FROM history_versions WHERE owner=? AND thread=? AND branch=?${extra}`,
        )
        .run(...params);
      this.db
        .prepare("DELETE FROM operations WHERE owner=? AND thread=? AND branch=?")
        .run(...values);
      this.db
        .prepare("DELETE FROM records WHERE owner=? AND thread=? AND branch=?")
        .run(...values);
      if (beforeVersion == null)
        this.db
          .prepare("DELETE FROM branches WHERE owner=? AND thread=? AND branch=?")
          .run(...values);
      this.deleteUnreferencedBlobs();
    });
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return { count, dryRun: false };
  }

  deleteUnreferencedBlobs() {
    this.db.exec(`
      DELETE FROM blobs WHERE hash NOT IN (
        SELECT hash FROM records
        UNION SELECT original_hash FROM history_versions
        UNION SELECT view_hash FROM history_versions
        UNION SELECT result_hash FROM operations WHERE result_hash IS NOT NULL
        UNION SELECT hash FROM history_event_items
      )
    `);
  }

  stats() {
    const blobs = this.db
      .prepare("SELECT coalesce(sum(bytes),0) AS bytes,count(*) AS blobs FROM blobs")
      .get();
    const records = this.db.prepare("SELECT count(*) AS n FROM records").get().n;
    const versions = this.db
      .prepare("SELECT count(*) AS n FROM history_versions")
      .get().n;
    const operations = this.db
      .prepare("SELECT count(*) AS n FROM operations")
      .get().n;
    const events = this.db
      .prepare("SELECT count(*) AS n FROM history_event_items")
      .get().n;
    return {
      bytes: Number(blobs.bytes),
      physicalBytes: this.physicalBytes(),
      blobs: Number(blobs.blobs),
      records: Number(records),
      versions: Number(versions),
      operations: Number(operations),
      events: Number(events),
      limit: this.limit,
      warningPercent: this.warningPercent,
    };
  }

  close() {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.close();
  }
}

export async function openArchive(options = {}, overrides = {}) {
  let path = options.path ?? defaultStatePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let existing = false;
  try {
    existing = (await stat(path)).size > 0;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!existing && !options.path) {
    const legacy = legacyPaths().history;
    try {
      if ((await stat(legacy)).size > 0) {
        await snapshotDatabase(legacy, path);
        existing = true;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (existing) {
    let schema = 0;
    const probe = new DatabaseSync(path, { readOnly: true });
    try { schema = probe.prepare("PRAGMA user_version").get().user_version; }
    finally { probe.close(); }
    if (schema < 3 && !(await hasMigrationBackup(path, 3))) {
      const backup = `${path}.before-v3-${Date.now()}`;
      await snapshotDatabase(path, backup);
    }
  }
  const key = overrides.key ?? (await historyKey({ ...options, existing }));
  const archive = new Archive(path, key, { ...options, ...overrides });
  await Promise.all(
    [path, `${path}-wal`, `${path}-shm`].map(async (file) => {
      try {
        await chmod(file, 0o600);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }),
  );
  return archive;
}

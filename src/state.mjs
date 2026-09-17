import { createHash, randomUUID } from "node:crypto";
import { fail } from "./errors.mjs";

const durablePrefixes = [
  "session:",
  "response:",
  "checkpoint:",
  "last-target:",
  "last-provider:",
  "search:",
  "summary:",
  "prepared:",
  "image-description:",
  "observation-incomplete:",
  "standalone-search-route:",
  "prompt-cache-affinity:",
];

export const threadOwner = (auth, thread) =>
  auth + "\0" + (thread ?? "http");

export function identity(entry, headers, body, trustedAccount) {
  const auth = trustedAccount
    ? createHash("sha256").update(trustedAccount).digest("hex")
    : createHash("sha256")
        .update(entry + "\0" + (headers.authorization ?? "anonymous"))
        .digest("hex");
  const flat = body.client_metadata ?? {};
  let meta = {};
  try {
    meta = JSON.parse(
      flat["x-codex-turn-metadata"] ??
        (flat.turn_id || flat.thread_id
          ? "{}"
          : headers["x-codex-turn-metadata"]) ??
        "{}",
    );
  } catch {
    throw fail("invalid_turn_metadata", 400);
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta))
    throw fail("invalid_turn_metadata", 400);
  const thread =
    meta.thread_id ??
    flat.thread_id ??
    headers["thread-id"] ??
    meta.session_id ??
    flat.session_id ??
    headers["session-id"] ??
    body.metadata?.session_id ??
    body.session_id;
  const turn = meta.turn_id ?? flat.turn_id ?? headers["turn-id"];
  const branch =
    meta.branch_id ??
    flat.branch_id ??
    headers["branch-id"] ??
    meta.fork_id ??
    flat.fork_id ??
    thread ??
    "http";
  const parentThread =
    meta.parent_thread_id ??
    flat.parent_thread_id ??
    meta.forked_from_thread_id ??
    flat.forked_from_thread_id;
  for (const value of [thread, turn, branch, parentThread])
    if (value != null && (typeof value !== "string" || value.length > 256))
      throw fail("invalid_turn_metadata", 400);
  const trigger =
    Array.isArray(body.input) &&
    body.input.some((item) => item.type === "compaction_trigger");
  return {
    auth,
    account: trustedAccount ?? `api:${auth}`,
    thread,
    branch,
    parentThread,
    owner: threadOwner(auth, thread),
    turn,
    requestKind:
      trigger || meta.request_kind === "compaction" ? "compaction" : "turn",
    compactionPhase: ["pre_turn", "mid_turn", "standalone_turn"].includes(
      meta.compaction?.phase,
    )
      ? meta.compaction.phase
      : undefined,
    compactionReason:
      typeof meta.compaction?.reason === "string"
        ? meta.compaction.reason
        : undefined,
    session: thread ?? headers["x-opencode-session"],
  };
}

export class StateStore {
  constructor(
    { maxBytes = 128 * 1024 * 1024, ttlMs = 30 * 60 * 1000 } = {},
    archive,
  ) {
    this.maxBytes = maxBytes;
    this.ttlMs = ttlMs;
    this.archive = archive;
    this.bytes = 0;
    this.items = new Map();
  }

  durable(key) {
    return !!this.archive && durablePrefixes.some((prefix) => key.startsWith(prefix));
  }

  get(key) {
    const item = this.items.get(key);
    if (item && Date.now() - item.time <= this.ttlMs) {
      item.time = Date.now();
      this.items.delete(key);
      this.items.set(key, item);
      return item.value;
    }
    if (item) this.remove(key);
    if (!this.durable(key)) return undefined;
    const value = this.archive.getState(key);
    if (value === undefined) return undefined;
    this.setMemory(key, value);
    return value;
  }

  remove(key) {
    const item = this.items.get(key);
    if (item) this.bytes -= item.bytes;
    this.items.delete(key);
  }

  setMemory(key, value) {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > this.maxBytes) return false;
    this.remove(key);
    while (this.bytes + bytes > this.maxBytes && this.items.size)
      this.remove(this.items.keys().next().value);
    this.items.set(key, { value, bytes, time: Date.now() });
    this.bytes += bytes;
    return true;
  }

  set(key, value, ctx) {
    if (this.durable(key))
      this.archive.setState(
        key,
        value,
        ctx
          ? {
              owner: ctx.account,
              thread: ctx.thread ?? "http",
              branch: ctx.branch,
            }
          : undefined,
      );
    if (!this.setMemory(key, value) && !this.durable(key))
      throw fail("history_capacity_exceeded", 413);
  }

  session(ctx) {
    const key = "session:" + ctx.auth + ":" + (ctx.session ?? ctx.owner);
    let id = this.get(key);
    if (!id) {
      id = randomUUID();
      this.set(key, id, ctx);
    }
    return id;
  }

  replay(ctx, body) {
    if (!body.previous_response_id)
      return { body, previous: null, delta: body.input ?? [] };
    const previous = this.get(
      "response:" + ctx.owner + ":" + body.previous_response_id,
    );
    if (!previous)
      throw fail(
        "previous_response_not_found",
        400,
        "Previous response is unavailable or belongs to another account, thread, or branch; restore full history before retrying",
      );
    const delta = Array.isArray(body.input) ? body.input : [];
    const next = {
      ...body,
      input: [...previous.input, ...delta],
    };
    delete next.previous_response_id;
    return { body: next, previous, delta };
  }

  save(
    ctx,
    response,
    viewInput,
    target,
    originalInput = viewInput,
    { continuationProvenance = "gateway-replay" } = {},
  ) {
    const record = {
      input: [...viewInput, ...(response.output ?? [])],
      original: [...originalInput, ...(response.output ?? [])],
      target: target ? structuredClone(target) : null,
      // Old cache compatibility for sessions created before target identities.
      provider: target?.provider ?? null,
      // Only responses observed on the opaque official relay can safely retain
      // their upstream previous_response_id. Engine and local responses must be
      // replayed from this record before the next provider request.
      continuationProvenance,
    };
    const responseKey = response.id
      ? "response:" + ctx.owner + ":" + response.id
      : undefined;
    if (this.archive) {
      const history = {
        owner: ctx.account,
        thread: ctx.thread ?? "http",
        branch: ctx.branch,
        target,
        responseId: response.id,
        status: response.status ?? "completed",
        original: record.original,
        view: record.input,
        parent: ctx.parentThread
          ? { thread: ctx.parentThread, branch: ctx.parentThread }
          : undefined,
      };
      if (!responseKey) return this.archive.appendHistory(history);
      const saved = this.archive.saveResponse(responseKey, record, history);
      if (saved.inserted) this.setMemory(responseKey, record);
      else this.get(responseKey);
      return saved.version;
    }
    if (responseKey) this.set(responseKey, record);
  }
}

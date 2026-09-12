import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCallback,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const stable = (value) => JSON.stringify(value);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function createHistoryPayload({ owner, thread, branch, versions }) {
  const data = {
    schemaVersion: 2,
    product: "codex-local-router",
    exportedAt: new Date().toISOString(),
    recovery: versions.every((version) => version.status === "complete_original")
      ? "complete_original"
      : versions.some((version) => version.original?.length)
        ? "original_available"
        : "view_only",
    owner,
    thread,
    branch,
    versions,
  };
  return { ...data, integrity: sha256(stable(data)) };
}

export function verifyHistoryPayload(payload) {
  const { integrity, ...data } = payload ?? {};
  if (!integrity || sha256(stable(data)) !== integrity)
    throw Object.assign(Error("history package integrity check failed"), {
      code: "history_package_corrupt",
    });
  if (data.product !== "codex-local-router" || data.schemaVersion !== 2)
    throw Object.assign(Error("unsupported history package"), {
      code: "history_package_unsupported",
    });
  return payload;
}

export async function encryptHistoryPayload(payload, passphrase) {
  if (!passphrase) throw Object.assign(Error("a passphrase is required for encrypted export"), { code: "history_passphrase_required" });
  const raw = Buffer.from(JSON.stringify(payload));
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = await scrypt(passphrase, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("codex-local-router-history-v2"));
  const ciphertext = Buffer.concat([cipher.update(raw), cipher.final()]);
  return {
    schemaVersion: 1,
    product: "codex-local-router-encrypted-history",
    kdf: "scrypt",
    cipher: "aes-256-gcm",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    ciphertextSha256: sha256(ciphertext),
  };
}

export async function decryptHistoryPayload(envelope, passphrase) {
  if (envelope?.product !== "codex-local-router-encrypted-history")
    return verifyHistoryPayload(envelope);
  if (!passphrase) throw Object.assign(Error("a passphrase is required for encrypted import"), { code: "history_passphrase_required" });
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  if (sha256(ciphertext) !== envelope.ciphertextSha256)
    throw Object.assign(Error("encrypted history package is corrupt"), { code: "history_package_corrupt" });
  try {
    const key = await scrypt(passphrase, Buffer.from(envelope.salt, "base64"), 32);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(Buffer.from("codex-local-router-history-v2"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const raw = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return verifyHistoryPayload(JSON.parse(raw.toString("utf8")));
  } catch (error) {
    if (error.code?.startsWith?.("history_")) throw error;
    throw Object.assign(Error("history package passphrase or authentication is invalid"), { code: "history_package_auth_failed" });
  }
}

function textContent(item) {
  if (typeof item.content === "string") return item.content;
  return (item.content ?? []).map((part) =>
    part.text ?? (part.type === "input_image" || part.type === "image_url"
      ? `[archived image: ${part.file_id ?? part.image_url ?? "embedded"}]`
      : JSON.stringify(part)),
  ).join("\n");
}

export function historyResumePrompt(history) {
  const lines = [
    "Continue from the archived Codex conversation below.",
    "Treat tool calls and tool outputs as already completed facts. Do not replay them.",
    "Preserve prior decisions, constraints, unresolved work, and the current context view.",
    "",
  ];
  for (const item of history.view ?? history.original ?? []) {
    if (item.type === "message" || item.role)
      lines.push(`${String(item.role ?? "message").toUpperCase()}: ${textContent(item)}`);
    else if (["function_call", "custom_tool_call"].includes(item.type))
      lines.push(`COMPLETED TOOL CALL ${item.call_id}: ${item.name} ${item.arguments ?? item.input ?? ""}`);
    else if (["function_call_output", "custom_tool_call_output"].includes(item.type))
      lines.push(`COMPLETED TOOL RESULT ${item.call_id}: ${item.output ?? ""}`);
    else if (!["reasoning"].includes(item.type))
      lines.push(`ARCHIVED ITEM: ${JSON.stringify(item)}`);
  }
  lines.push("", "Continue with the user's next instruction. Do not claim the archived tool calls were run in this new session.");
  return lines.join("\n");
}

import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export async function readJSON(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && arguments.length > 1) return fallback;
    throw error;
  }
}

export async function atomicWrite(path, body, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, body, { mode });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function atomicJSON(path, value, mode = 0o600) {
  await atomicWrite(path, JSON.stringify(value, null, 2) + "\n", mode);
}

export async function withFileLock(path, callback, { staleMs = 10 * 60 * 1000 } = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const info = await stat(path).catch(() => null);
    if (!info || Date.now() - info.mtimeMs <= staleMs) {
      const locked = Error(`operation is already in progress: ${path}`);
      locked.code = "operation_locked";
      throw locked;
    }
    await rm(path, { force: true });
    handle = await open(path, "wx", 0o600);
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, created: Date.now() }));
    return await callback();
  } finally {
    await handle.close().catch(() => {});
    await rm(path, { force: true }).catch(() => {});
  }
}

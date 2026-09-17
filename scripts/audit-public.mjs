#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exportPublic } from "./export-public.mjs";
import { assertAllowedFiles, scanTextFiles } from "./public-boundary.mjs";

const root = await mkdtemp(join(tmpdir(), "codex-local-router-public-audit-"));
try {
  const destination = join(root, "public");
  const result = await exportPublic(destination);
  assertAllowedFiles(result.files);
  const report = await scanTextFiles(destination, result.files, {
    skip: ["scripts/public-boundary.mjs"],
  });
  console.log(JSON.stringify({ ok: true, ...report }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const exec = promisify(execFile);

test("generic-template rollout scripts fail closed before touching local state", async () => {
  await assert.rejects(
    exec(process.execPath, [resolve("scripts/maintainer/generic-template-activate.mjs")]),
    /--package VALUE.*--ids VALUE/s,
  );
  await assert.rejects(
    exec(process.execPath, [resolve("scripts/maintainer/generic-template-rollback.mjs")]),
    /--state PATH_TO_ROLLBACK_JSON/,
  );
  await assert.rejects(
    exec(process.execPath, [resolve("scripts/e2e/third-party-template-live.mjs")]),
    /requires --run/,
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { evidencePath } from "../scripts/e2e/lib/evidence-path.mjs";

test("acceptance evidence defaults to Router data and refuses the source tree", () => {
  const projectRoot = "/tmp/router-source";
  const env = { CODEX_LOCAL_ROUTER_HOME: "/tmp/router-data" };
  assert.equal(
    evidencePath(null, "e2e/run.json", { projectRoot, env }),
    "/tmp/router-data/evidence/e2e/run.json",
  );
  assert.throws(
    () => evidencePath(join(projectRoot, "artifacts", "run.json"), "unused", { projectRoot, env }),
    /outside the source tree/,
  );
});

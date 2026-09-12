import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGateway } from "../src/server.mjs";
import { validate } from "../src/config.mjs";

test("raw API requires the independent local token while health stays readable", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "router-access-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tokenFile = join(dir, "token");
  await writeFile(tokenFile, "local-secret\n", { mode: 0o600 });
  const config = validate({
    schemaVersion: 3,
    listen: { host: "127.0.0.1", port: 0 },
    access: { required: true, tokenFile },
    mode: "rules",
    defaultTarget: "mock",
    providers: { mock: { baseUrl: "http://127.0.0.1:9999" } },
    targets: { mock: { provider: "mock", model: "mock", wireApi: "responses", contextWindow: 1000 } },
  });
  const gateway = createGateway(config);
  t.after(() => gateway.close());
  await new Promise((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const health = await fetch(`${base}/healthz`).then((response) => response.json());
  assert.equal(health.service, "codex-local-router");
  assert.equal(health.activeTurns, 0);
  assert.equal((await fetch(`${base}/v1/models`)).status, 401);
  const models = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer local-secret" } });
  assert.equal(models.status, 200);
});

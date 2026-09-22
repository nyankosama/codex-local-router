import { mkdir, readFile, writeFile, symlink, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildModelCatalog } from "../src/model-catalog.mjs";
const root = "/tmp/llm-gateway-hybrid-probe";
const home = join(root, "home");
await mkdir(home, { recursive: true, mode: 0o700 });
const source = join(homedir(), ".codex");
const auth = join(home, "auth.json");
try {
  await lstat(auth);
} catch (e) {
  if (e.code !== "ENOENT") throw e;
  await symlink(join(source, "auth.json"), auth);
}
const catalog = JSON.parse(
  await readFile(join(source, "models_cache.json"), "utf8"),
);
await writeFile(
  join(home, "models.json"),
  JSON.stringify(buildModelCatalog(catalog)),
  {
    mode: 0o600,
  },
);
await writeFile(
  join(home, "config.toml"),
  `model_provider = "openai"\nmodel = "gpt-5.5"\nopenai_base_url = "http://127.0.0.1:18789/v1"\nmodel_catalog_json = "${home}/models.json"\n`,
  { mode: 0o600 },
);
console.log(
  "Isolated probe prepared. User config unchanged; auth uses a symlink, no credential copy.",
);

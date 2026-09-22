import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { resolve } from "node:path";
const path = resolve(process.argv[2] ?? "config/gateway.local.json");
try {
  await readFile(path);
  if (!process.argv.includes("--replace"))
    throw Error(
      "Configuration exists; choose a new path or explicitly use --replace",
    );
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const c = JSON.parse(
  await readFile(
    new URL("../config/gateway.example.json", import.meta.url),
    "utf8",
  ),
);
c.providers["opencode-go"].keychain = {
  account: userInfo().username,
  service: "codex-opencode-go-api-key",
};
c.subscription.catalogPath = resolve(homedir(), ".codex/models_cache.json");
delete c.subscription.models;
await mkdir(resolve(path, ".."), { recursive: true });
await writeFile(path, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
console.log(`Created ${path}; credentials remain in environment/Keychain.`);

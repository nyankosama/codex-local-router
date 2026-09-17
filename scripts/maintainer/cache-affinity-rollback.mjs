#!/usr/bin/env node
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import {
  argsOf,
  atomicJson,
  restore,
} from "./cache-affinity-rollout-lib.mjs";

const args = argsOf();
const statePath = resolve(String(args.value("state") ?? ""));
if (!statePath) throw Error("use --state PATH_TO_ROLLBACK_JSON");
const state = JSON.parse(await readFile(statePath, "utf8"));
if (state.schemaVersion !== 1 || !state.prior?.spaceRef ||
    !state.prior?.packagePath)
  throw Error("invalid cache-affinity rollback state");

const restored = await restore(state, {
  cli: String(args.value("cli", "codex-local-router")),
  npm: String(args.value("npm", "npm")),
});
state.phase = "rolled_back";
state.rolledBackAt = new Date().toISOString();
await atomicJson(statePath, state);
console.log(JSON.stringify({
  rolledBack: true,
  active: restored.spaceRef,
  defaultModel: restored.defaultModel,
  officialRescue: "codex-local-router rescue --subscription --yes",
}, null, 2));

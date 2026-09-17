#!/usr/bin/env node
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import {
  argsOf,
  atomicJson,
  restore,
} from "./cache-affinity-rollout-lib.mjs";

const args = argsOf();
const stateInput = args.value("state");
if (!stateInput) throw Error("use --state PATH_TO_ROLLBACK_JSON");
const statePath = resolve(String(stateInput));
const state = JSON.parse(await readFile(statePath, "utf8"));
if (state.schemaVersion !== 1 ||
    state.feature !== "gpt-instruction-snapshot-lite" ||
    !state.prior?.spaceRef || !state.prior?.packagePath)
  throw Error("invalid instruction-snapshot rollback state");

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
  selectedModel: restored.selectedModel,
  officialRescue: "codex-local-router rescue --subscription --yes",
}, null, 2));

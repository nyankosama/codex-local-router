#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { argsOf, atomicJson, restore } from "./cache-affinity-rollout-lib.mjs";

const args = argsOf();
if (!args.value("state")) throw Error("use --state PATH_TO_ROLLBACK_JSON");
const statePath = resolve(String(args.value("state")));
const state = JSON.parse(await readFile(statePath, "utf8"));
if (state.schemaVersion !== 1 || state.feature !== "third-party-generic-template-v1" ||
    !state.prior?.spaceRef || !state.prior?.packagePath)
  throw Error("invalid generic-template rollback state");
const restored = await restore(state, { cli: String(args.value("cli", "codex-local-router")), npm: String(args.value("npm", "npm")) });
state.phase = "rolled_back";
state.rolledBackAt = new Date().toISOString();
await atomicJson(statePath, state);
console.log(JSON.stringify({ rolledBack: true, active: restored.spaceRef, defaultModel: restored.defaultModel,
  selectedModel: restored.selectedModel, officialRescue: "codex-local-router rescue --subscription --yes" }, null, 2));

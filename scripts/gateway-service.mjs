#!/usr/bin/env node
// Compatibility entry point for installations and scripts created before v0.2.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const command = process.argv[2] ?? "status";
const config = process.argv[3];
const args = [fileURLToPath(new URL("./gateway-admin.mjs", import.meta.url)), "service", command];
if (config) args.push("--config", config);
const result = spawnSync(process.execPath, args, { stdio: "inherit", env: process.env });
process.exitCode = result.status ?? 1;

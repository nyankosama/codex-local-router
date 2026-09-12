#!/usr/bin/env node
// Compatibility entry point for the old integration upgrade command.
import { loadConfig } from "../src/config.mjs";
import { syncIntegration } from "../src/integration.mjs";
import { resolve } from "node:path";

const configPath = resolve(process.argv[2] ?? "config/gateway.subscription.local.json");
const config = await loadConfig(configPath);
const result = await syncIntegration(config, {
  gatewayConfigPath: configPath,
  env: process.env,
});
console.log(JSON.stringify(result, null, 2));

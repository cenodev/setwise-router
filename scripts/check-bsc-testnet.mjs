#!/usr/bin/env node

import {
  evaluateBscTestnetRollout,
  loadBscTestnetRollout,
} from "../deployments/bsc-testnet.mjs";

const rollout = loadBscTestnetRollout();
const result = evaluateBscTestnetRollout(rollout);

for (const check of result.checks) {
  console.log(`${check.ok ? "PASS" : "PENDING"} ${check.id}: ${check.message}`);
}
console.log(`BSC testnet release ready: ${result.ready ? "yes" : "no"}`);

if (process.argv.includes("--require-ready") && !result.ready) {
  process.exitCode = 1;
}

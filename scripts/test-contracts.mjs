#!/usr/bin/env node
/**
 * Secret-free Foundry test mode for CI.
 *
 * 1. zFi-main offline suites via a temporary foundry.toml without `eth_rpc_url`
 * 2. contracts/ Setwise data-type tests (no forge-std / no RPC)
 *
 * Fork suites belong in the separate `ci-fork` workflow.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveForge, runForge, withOfflineFoundryConfig } from "./lib/forge.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const zfi = join(root, "zFi-main");
const contracts = join(root, "contracts");

/** Unit / local-deploy suites that do not require a mainnet fork. */
const OFFLINE_MATCH_PATH = "test/{zSwap,ShareBurner,CollectorVault}.t.sol";
const FORK_TEST_PATH = "test/fork/*.t.sol";

const forge = resolveForge();
if (!forge) {
  console.error("forge not found. Install Foundry from https://getfoundry.sh/");
  process.exit(1);
}

const zfiStatus = withOfflineFoundryConfig(zfi, (configPath) => {
  console.log("Running secret-free zFi-main Foundry tests (no eth_rpc_url)...");
  console.log(`match-path: ${OFFLINE_MATCH_PATH}`);
  const result = runForge(forge, ["test", "-vv", "--match-path", OFFLINE_MATCH_PATH], {
    cwd: zfi,
    env: { ...process.env, FOUNDRY_CONFIG: configPath },
  });
  return result.status ?? 1;
});

if (zfiStatus !== 0) {
  process.exit(zfiStatus);
}

console.log("\nRunning secret-free contracts/ Foundry tests...");
console.log(`no-match-path: ${FORK_TEST_PATH}`);
const contractsResult = runForge(
  forge,
  ["test", "-vv", "--no-match-path", FORK_TEST_PATH],
  { cwd: contracts },
);
process.exit(contractsResult.status ?? 1);

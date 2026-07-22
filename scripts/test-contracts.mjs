#!/usr/bin/env node
/**
 * Secret-free Foundry test mode for CI.
 *
 * Uses a temporary foundry.toml without `eth_rpc_url` so tests never contact
 * a live RPC. Fork suites belong in the separate `ci-fork` workflow.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveForge, runForge, withOfflineFoundryConfig } from "./lib/forge.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const zfi = join(root, "zFi-main");

/** Unit / local-deploy suites that do not require a mainnet fork. */
const OFFLINE_MATCH_PATH = "test/{zSwap,ShareBurner,CollectorVault}.t.sol";

const forge = resolveForge();
if (!forge) {
  console.error("forge not found. Install Foundry from https://getfoundry.sh/");
  process.exit(1);
}

const status = withOfflineFoundryConfig(zfi, (configPath) => {
  console.log("Running secret-free Foundry tests (no eth_rpc_url)...");
  console.log(`match-path: ${OFFLINE_MATCH_PATH}`);
  const result = runForge(forge, ["test", "-vv", "--match-path", OFFLINE_MATCH_PATH], {
    cwd: zfi,
    env: { ...process.env, FOUNDRY_CONFIG: configPath },
  });
  return result.status ?? 1;
});

process.exit(status);

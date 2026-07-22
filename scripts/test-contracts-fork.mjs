#!/usr/bin/env node
/**
 * Fork-backed Foundry tests (separate from the secret-free CI baseline).
 *
 * Uses a public Ethereum RPC by default — no production secrets required.
 * Flaky public RPC behavior must not block the deterministic CI job.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveForge, runForge } from "./lib/forge.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const zfi = join(root, "zFi-main");
const contracts = join(root, "contracts");

const rpc =
  process.env.FOUNDRY_ETH_RPC_URL ||
  process.env.ETH_RPC_URL ||
  // Prefer 1rpc (also used by upstream zFi-main). publicnode archive now requires a token.
  "https://1rpc.io/eth";

const forge = resolveForge();
if (!forge) {
  console.error("forge not found. Install Foundry from https://getfoundry.sh/");
  process.exit(1);
}

console.log(`Running fork Foundry tests against ${rpc} (pinned block from foundry.toml)...`);

const FORK_MATCH_PATH = "test/{zQuoterFork,zQuoterCurveCalldata}.t.sol";

const upstreamResult = runForge(
  forge,
  ["test", "--fork-url", rpc, "--match-path", FORK_MATCH_PATH, "-vv"],
  {
    cwd: zfi,
    env: { ...process.env, FOUNDRY_ETH_RPC_URL: rpc },
  },
);

if ((upstreamResult.status ?? 1) !== 0) process.exit(upstreamResult.status ?? 1);

console.log("\nRunning chain-aware AMM adapter forks (Ethereum, BSC, Base, Robinhood matrix)...");
const adapterEnv = {
  ...process.env,
  RPC_URL_ETHEREUM: process.env.RPC_URL_ETHEREUM || rpc,
};
for (const name of ["RPC_URL_BSC", "RPC_ARCHIVE_URL_BSC", "RPC_URL_BASE"]) {
  if (!adapterEnv[name]) delete adapterEnv[name];
}
const adapterResult = runForge(
  forge,
  ["test", "--match-path", "test/fork/ChainAwareAmmAdapterFork.t.sol", "-vv"],
  {
    cwd: contracts,
    env: adapterEnv,
  },
);

process.exit(adapterResult.status ?? 1);

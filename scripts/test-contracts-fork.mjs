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

const result = runForge(
  forge,
  ["test", "--fork-url", rpc, "--match-path", FORK_MATCH_PATH, "-vv"],
  {
    cwd: zfi,
    env: { ...process.env, FOUNDRY_ETH_RPC_URL: rpc },
  },
);

process.exit(result.status ?? 1);

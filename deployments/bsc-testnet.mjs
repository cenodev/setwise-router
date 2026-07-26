import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isAddress } from "../config/schema.mjs";
import { getDeploymentManifest } from "./registry.mjs";

const deploymentDir = dirname(fileURLToPath(import.meta.url));
const rolloutPath = join(deploymentDir, "bsc-testnet-97.rollout.json");
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const BLOCK_HASH_RE = TX_HASH_RE;

export function loadBscTestnetRollout(path = rolloutPath) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Fail-closed acceptance evaluation for the BSC testnet rollout. A pending
 * deployment, missing confirmed canary, or missing safety result keeps the
 * environment explicitly not ready.
 */
export function evaluateBscTestnetRollout(
  rollout = loadBscTestnetRollout(),
  deployment = getDeploymentManifest(97),
) {
  const checks = [];
  const check = (id, ok, message) => checks.push({ id, ok: Boolean(ok), message });

  check("chain", rollout.chainId === 97, "rollout is bound to BSC testnet chain 97");
  check(
    "pool",
    isAddress(rollout.set?.poolAddress),
    "existing Set proxy address is recorded",
  );
  check(
    "signer",
    isAddress(rollout.set?.quoteSigner),
    "live quote signer address is recorded",
  );
  check(
    "wrapped-native",
    isAddress(rollout.set?.wrappedNativeToken),
    "mock wrapped BNB address is recorded",
  );
  check(
    "verified-block",
    /^(0|[1-9][0-9]*)$/.test(rollout.set?.verifiedBlock ?? "") &&
      BLOCK_HASH_RE.test(rollout.set?.verifiedBlockHash ?? ""),
    "pool verification block and hash are recorded",
  );
  check(
    "faucet",
    isAddress(rollout.faucet?.address),
    "test asset faucet address is recorded",
  );

  const assetAddresses = new Set();
  const assetIds = new Set();
  let assetsValid = Array.isArray(rollout.assets) && rollout.assets.length > 0;
  for (const asset of rollout.assets ?? []) {
    const address = asset?.address?.toLowerCase();
    if (
      typeof asset?.id !== "string" ||
      !isAddress(asset?.address) ||
      !Number.isInteger(asset?.decimals) ||
      assetIds.has(asset.id) ||
      assetAddresses.has(address)
    ) {
      assetsValid = false;
    }
    assetIds.add(asset?.id);
    assetAddresses.add(address);
  }
  check("assets", assetsValid, "RFQ asset ids and token addresses are unique");

  for (const role of [
    "setwisePoolRegistry",
    "setwiseRouter",
    "setwiseQuoter",
  ]) {
    check(
      `deployment:${role}`,
      deployment.contracts?.[role]?.status === "deployed",
      `${deployment.contracts?.[role]?.displayName ?? role} is deployed`,
    );
  }

  const canaries = new Map(
    (rollout.canaries ?? []).map((canary) => [canary.mode, canary]),
  );
  for (const mode of rollout.requiredCanaries ?? []) {
    const canary = canaries.get(mode);
    check(
      `canary:${mode}`,
      canary?.status === "confirmed" &&
        canary.chainId === 97 &&
        TX_HASH_RE.test(canary.transactionHash ?? ""),
      `${mode} canary is confirmed on chain 97`,
    );
  }

  for (const id of rollout.requiredSafetyChecks ?? []) {
    const evidence = rollout.safetyChecks?.[id];
    check(
      `safety:${id}`,
      evidence?.status === "passed" &&
        typeof evidence.evidence === "string" &&
        evidence.evidence.length > 0,
      `${id} acceptance check has recorded evidence`,
    );
  }

  return {
    ready: checks.every((entry) => entry.ok),
    checks,
    missing: checks.filter((entry) => !entry.ok).map((entry) => entry.id),
  };
}

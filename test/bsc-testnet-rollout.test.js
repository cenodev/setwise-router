import assert from "node:assert/strict";
import test from "node:test";

import { getChainConfig } from "../config/registry.mjs";
import {
  evaluateBscTestnetRollout,
  loadBscTestnetRollout,
} from "../deployments/bsc-testnet.mjs";
import { getDeploymentManifest } from "../deployments/registry.mjs";

test("records the verified BSC testnet Set, signer, wrapped BNB, faucet, and RFQ", () => {
  const rollout = loadBscTestnetRollout();
  const chain = getChainConfig(97);
  assert.equal(rollout.chainId, 97);
  assert.equal(rollout.set.poolAddress, "0xA54D041eD831BBE2D6F97107Ab3aD9f9682C392a");
  assert.equal(rollout.set.quoteSigner, "0x0B37DDA72EbC2E9Cd177D1455139e7355d3a9e50");
  assert.equal(
    rollout.set.wrappedNativeToken.toLowerCase(),
    chain.wrappedNative.address.toLowerCase(),
  );
  assert.equal(rollout.faucet.address, "0x357B4Ba272421de4A0067EF2A830103Afa038F3C");
  assert.equal(
    rollout.rfq.baseUrl,
    "https://setwise-rfq-api.datadex.workers.dev",
  );
  assert.equal(rollout.architecture.pricing, "external-rfq");
  assert.equal(rollout.architecture.onchainQuoterRequired, false);
  assert.equal(rollout.architecture.tokenHubRequired, false);
  assert.equal(rollout.assets.length, 9);
});

test("current rollout remains fail-closed until deploy and canary evidence is recorded", () => {
  const result = evaluateBscTestnetRollout();
  assert.equal(result.ready, false);
  assert.ok(result.missing.includes("deployment:setwiseRouter"));
  assert.ok(result.missing.includes("deployment:routerControl"));
  assert.ok(result.missing.includes("governance:registry-owner"));
  assert.ok(result.missing.includes("canary:erc20-to-erc20"));
  assert.ok(result.missing.includes("safety:faucet-to-confirmed-swap"));
});

test("readiness requires every asset mode, external competition, and safety check", () => {
  const rollout = structuredClone(loadBscTestnetRollout());
  const deployment = structuredClone(getDeploymentManifest(97));
  for (const role of ["setwisePoolRegistry", "setwiseRouter"]) {
    deployment.contracts[role].status = "deployed";
  }
  rollout.deployment.routerControl = {
    status: "deployed",
    address: "0x1111111111111111111111111111111111111111",
    implementation: "0x2222222222222222222222222222222222222222",
    transactionHash: `0x${"ab".repeat(32)}`,
    blockNumber: 123,
  };
  rollout.deployment.governance = {
    deployer: "0x3333333333333333333333333333333333333333",
    owner: "0x4444444444444444444444444444444444444444",
    emergencyGuardian: "0x5555555555555555555555555555555555555555",
    registryOwnershipTransferRequired: true,
    registryOwnerAccepted: true,
    acceptanceTransactionHash: `0x${"cd".repeat(32)}`,
  };
  rollout.canaries = rollout.requiredCanaries.map((mode, index) => ({
    mode,
    status: "confirmed",
    chainId: 97,
    transactionHash: `0x${String(index + 1).padStart(64, "0")}`,
  }));
  rollout.safetyChecks = Object.fromEntries(
    rollout.requiredSafetyChecks.map((id) => [
      id,
      { status: "passed", evidence: `test:${id}` },
    ]),
  );

  const result = evaluateBscTestnetRollout(rollout, deployment);
  assert.equal(result.ready, true);
  assert.deepEqual(result.missing, []);
});

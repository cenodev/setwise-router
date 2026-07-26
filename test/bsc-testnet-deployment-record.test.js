import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildBscTestnetDeploymentRecords } from "../scripts/record-bsc-testnet-deployment.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const address = (suffix) => `0x${suffix.padStart(40, "0")}`;
const hash = (digit) => `0x${digit.repeat(64)}`;

const ADDRESSES = {
  chainId: 97,
  deployer: address("1"),
  governance: address("2"),
  emergencyGuardian: address("3"),
  setPool: "0xA54D041eD831BBE2D6F97107Ab3aD9f9682C392a",
  wrappedNative: "0x119FF2a8b74dfCE4c378CE4bd2c10201bf47e395",
  poolRegistryImplementation: address("4"),
  poolRegistryProxy: address("5"),
  routerControlImplementation: address("6"),
  routerControlProxy: address("7"),
  setwiseRouter: address("8"),
  registryOwnershipPending: true,
};

function fixture() {
  const create = (contractName, contractAddress, transactionHash) => ({
    transactionType: "CREATE",
    contractName,
    contractAddress,
    hash: transactionHash,
  });
  return {
    addresses: structuredClone(ADDRESSES),
    broadcast: {
      transactions: [
        create("ERC1967Proxy", ADDRESSES.poolRegistryProxy, hash("1")),
        create("ERC1967Proxy", ADDRESSES.routerControlProxy, hash("2")),
        create(
          "SetwiseExecutionAdapter",
          ADDRESSES.setwiseRouter,
          hash("3"),
        ),
      ],
      receipts: [
        { transactionHash: hash("1"), blockNumber: "0x64", status: "0x1" },
        { transactionHash: hash("2"), blockNumber: "0x65", status: "0x1" },
        { transactionHash: hash("3"), blockNumber: "0x66", status: "0x1" },
      ],
    },
    chain: JSON.parse(
      readFileSync(join(root, "config/chains/97.json"), "utf8"),
    ),
    manifest: JSON.parse(
      readFileSync(join(root, "deployments/bsc-testnet-97.json"), "utf8"),
    ),
    rollout: JSON.parse(
      readFileSync(
        join(root, "deployments/bsc-testnet-97.rollout.json"),
        "utf8",
      ),
    ),
    runtimeCode: {
      poolRegistryImplementation: "0x6001",
      poolRegistryProxy: "0x6002",
      routerControlImplementation: "0x6003",
      routerControlProxy: "0x6004",
      setwiseRouter: "0x6005",
    },
  };
}

const fakeHash = (runtime) =>
  runtime === "0x6001" ? `0x${"ab".repeat(32)}` : `0x${"cd".repeat(32)}`;

test("builds reviewed manifest, config, and governance records from confirmed receipts", () => {
  const records = buildBscTestnetDeploymentRecords(fixture(), fakeHash);

  assert.equal(records.chain.router, ADDRESSES.setwiseRouter);
  assert.equal(
    records.chain.venues.setwise.poolRegistry,
    ADDRESSES.poolRegistryProxy,
  );
  assert.equal(
    records.chain.venues.setwise.enabled,
    false,
    "canaries must pass before enabling Set",
  );

  const registry = records.manifest.contracts.setwisePoolRegistry;
  assert.equal(registry.status, "deployed");
  assert.equal(registry.address, ADDRESSES.poolRegistryProxy);
  assert.equal(
    registry.implementation.address,
    ADDRESSES.poolRegistryImplementation,
  );
  assert.equal(registry.deployment.transactionHash, hash("1"));
  assert.equal(registry.deployment.blockNumber, 100);

  const router = records.manifest.contracts.setwiseRouter;
  assert.equal(router.status, "deployed");
  assert.equal(router.address, ADDRESSES.setwiseRouter);
  assert.deepEqual(router.constructorInputs, [
    "97",
    ADDRESSES.wrappedNative,
    ADDRESSES.governance,
    ADDRESSES.poolRegistryProxy,
    ADDRESSES.routerControlProxy,
  ]);
  assert.equal(
    records.manifest.contracts.setwiseQuoter.status,
    "pending",
    "external RFQ pricing must not be represented as a fake contract",
  );
  assert.equal(records.rollout.architecture.pricing, "external-rfq");
  assert.equal(records.rollout.architecture.onchainQuoterRequired, false);
  assert.equal(
    records.rollout.deployment.routerControl.address,
    ADDRESSES.routerControlProxy,
  );
  assert.equal(
    records.rollout.deployment.governance.registryOwnerAccepted,
    false,
  );
});

test("marks registry ownership complete when deployer is governance", () => {
  const input = fixture();
  input.addresses.governance = input.addresses.deployer;
  input.addresses.registryOwnershipPending = false;

  const records = buildBscTestnetDeploymentRecords(input, fakeHash);
  assert.equal(
    records.rollout.deployment.governance.registryOwnerAccepted,
    true,
  );
  assert.equal(
    records.rollout.deployment.governance.registryOwnershipTransferRequired,
    false,
  );
});

test("deployment record generation is deterministic", () => {
  const first = buildBscTestnetDeploymentRecords(fixture(), fakeHash);
  const second = buildBscTestnetDeploymentRecords(fixture(), fakeHash);
  assert.deepEqual(first, second);
});

test("rejects wrong-chain, mismatched-address, and unconfirmed broadcast input", () => {
  const wrongChain = fixture();
  wrongChain.addresses.chainId = 56;
  assert.throws(
    () => buildBscTestnetDeploymentRecords(wrongChain, fakeHash),
    /chainId must be 97/,
  );

  const wrongSet = fixture();
  wrongSet.addresses.setPool = address("99");
  assert.throws(
    () => buildBscTestnetDeploymentRecords(wrongSet, fakeHash),
    /does not match the verified rollout Set/,
  );

  const noReceipt = fixture();
  noReceipt.broadcast.receipts = noReceipt.broadcast.receipts.slice(1);
  assert.throws(
    () => buildBscTestnetDeploymentRecords(noReceipt, fakeHash),
    /no receipt/,
  );
});

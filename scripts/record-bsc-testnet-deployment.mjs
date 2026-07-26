#!/usr/bin/env node
/**
 * Build reviewed chain configuration, deployment-manifest, and rollout records
 * from a confirmed Foundry chain-97 broadcast.
 *
 * The command previews JSON by default. `--write` is explicit because these
 * source-controlled records must never be updated from a simulation or a
 * partially confirmed broadcast.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isAddress, validateChainConfig } from "../config/schema.mjs";
import { runtimeBytecodeHash } from "../deployments/bytecode.mjs";
import { EIP1967_IMPLEMENTATION_SLOT } from "../deployments/constants.mjs";
import { addressFromStorageWord } from "../deployments/proxy.mjs";
import {
  assertRpcChainId,
  getCode,
  getStorageAt,
  resolvePublicRpcUrl,
} from "../deployments/rpc.mjs";
import {
  validateDeploymentManifest,
  validateManifestAgainstConfig,
} from "../deployments/schema.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHAIN_ID = 97;
const COMPILER = Object.freeze({
  profile: "default",
  solcVersion: "0.8.28",
  optimizer: true,
  optimizerRuns: 200,
  evmVersion: "cancun",
});
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

function clone(value) {
  return structuredClone(value);
}

function sameAddress(left, right) {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    left.toLowerCase() === right.toLowerCase()
  );
}

function requireAddress(value, label) {
  if (!isAddress(value)) throw new Error(`${label} must be a non-zero address`);
  return value;
}

function parseBlockNumber(value) {
  const block =
    typeof value === "string" && value.startsWith("0x")
      ? Number.parseInt(value.slice(2), 16)
      : Number(value);
  if (!Number.isSafeInteger(block) || block < 0) {
    throw new Error(`invalid broadcast block number: ${value}`);
  }
  return block;
}

function receiptForTransaction(broadcast, transaction) {
  const transactionHash =
    transaction.hash ?? transaction.transactionHash ?? transaction.txHash;
  if (!TX_HASH_RE.test(transactionHash ?? "")) {
    throw new Error(
      `deployment ${transaction.contractName ?? transaction.contractAddress} has no confirmed transaction hash`,
    );
  }
  const receipt = (broadcast.receipts ?? []).find((item) =>
    sameAddress(item.transactionHash, transactionHash),
  );
  if (!receipt) {
    throw new Error(`broadcast has no receipt for ${transactionHash}`);
  }
  if (
    receipt.status !== undefined &&
    receipt.status !== "0x1" &&
    receipt.status !== 1 &&
    receipt.status !== "1"
  ) {
    throw new Error(`deployment transaction ${transactionHash} did not succeed`);
  }
  return {
    transactionHash,
    blockNumber: parseBlockNumber(receipt.blockNumber),
  };
}

function deploymentForAddress(broadcast, address, label) {
  const transaction = (broadcast.transactions ?? []).find(
    (item) =>
      sameAddress(item.contractAddress, address) &&
      (item.transactionType === undefined ||
        String(item.transactionType).toUpperCase().includes("CREATE")),
  );
  if (!transaction) {
    throw new Error(`broadcast has no create transaction for ${label} ${address}`);
  }
  return receiptForTransaction(broadcast, transaction);
}

function requireRuntimeCode(runtime, label) {
  if (
    typeof runtime !== "string" ||
    runtime === "" ||
    runtime === "0x" ||
    runtime === "0x0"
  ) {
    throw new Error(`${label} has no deployed runtime bytecode`);
  }
  return runtime.startsWith("0x") ? runtime : `0x${runtime}`;
}

function explorer(address, deployment, explorerBaseUrl) {
  return {
    addressUrl: `${explorerBaseUrl}/address/${address}`,
    transactionUrl: `${explorerBaseUrl}/tx/${deployment.transactionHash}`,
  };
}

/**
 * Produce deployment records without writing files.
 *
 * @param {object} input
 * @param {object} input.addresses Foundry script address output.
 * @param {object} input.broadcast Foundry run-latest broadcast.
 * @param {object} input.chain Existing chain-97 config.
 * @param {object} input.manifest Existing chain-97 manifest.
 * @param {object} input.rollout Existing chain-97 rollout record.
 * @param {object} input.runtimeCode Confirmed on-chain runtime bytecode.
 * @param {(runtime: string) => string} [hashRuntime]
 */
export function buildBscTestnetDeploymentRecords(
  input,
  hashRuntime = runtimeBytecodeHash,
) {
  const addresses = clone(input.addresses);
  if (addresses.chainId !== CHAIN_ID) {
    throw new Error(`address output chainId must be ${CHAIN_ID}`);
  }
  for (const field of [
    "deployer",
    "governance",
    "emergencyGuardian",
    "setPool",
    "wrappedNative",
    "poolRegistryImplementation",
    "poolRegistryProxy",
    "routerControlImplementation",
    "routerControlProxy",
    "setwiseRouter",
  ]) {
    requireAddress(addresses[field], `addresses.${field}`);
  }
  if (typeof addresses.registryOwnershipPending !== "boolean") {
    throw new Error("addresses.registryOwnershipPending must be a boolean");
  }

  const chain = clone(input.chain);
  const manifest = clone(input.manifest);
  const rollout = clone(input.rollout);
  if (
    chain.chainId !== CHAIN_ID ||
    manifest.chainId !== CHAIN_ID ||
    rollout.chainId !== CHAIN_ID
  ) {
    throw new Error("all deployment records must target chain 97");
  }
  if (!sameAddress(addresses.setPool, rollout.set?.poolAddress)) {
    throw new Error("deployed Set does not match the verified rollout Set proxy");
  }
  if (!sameAddress(addresses.wrappedNative, chain.wrappedNative?.address)) {
    throw new Error("deployment wrapped native does not match chain configuration");
  }
  for (const [field, label] of [
    ["poolRegistryImplementation", "Set pool registry implementation"],
    ["poolRegistryProxy", "Set pool registry proxy"],
    ["routerControlImplementation", "router control implementation"],
    ["routerControlProxy", "router control proxy"],
    ["setwiseRouter", "Set Router"],
  ]) {
    requireRuntimeCode(input.runtimeCode?.[field], label);
  }

  const registryDeployment = deploymentForAddress(
    input.broadcast,
    addresses.poolRegistryProxy,
    "Set pool registry",
  );
  const controlDeployment = deploymentForAddress(
    input.broadcast,
    addresses.routerControlProxy,
    "router control",
  );
  const routerDeployment = deploymentForAddress(
    input.broadcast,
    addresses.setwiseRouter,
    "Set Router",
  );
  const explorerBaseUrl = chain.explorer.baseUrl.replace(/\/$/, "");

  manifest.contracts.setwisePoolRegistry = {
    status: "deployed",
    kind: "uups-proxy",
    displayName: "Set pool registry",
    address: addresses.poolRegistryProxy,
    implementation: {
      kind: "implementation",
      address: addresses.poolRegistryImplementation,
      bytecodeHash: hashRuntime(
        requireRuntimeCode(
          input.runtimeCode.poolRegistryImplementation,
          "Set pool registry implementation",
        ),
      ),
      compiler: { ...COMPILER },
      constructorInputs: [],
    },
    constructorInputs: [
      addresses.poolRegistryImplementation,
      `initialize(${addresses.deployer},${addresses.emergencyGuardian})`,
    ],
    deployment: registryDeployment,
    explorer: explorer(
      addresses.poolRegistryProxy,
      registryDeployment,
      explorerBaseUrl,
    ),
  };
  manifest.contracts.setwiseRouter = {
    status: "deployed",
    kind: "direct",
    displayName: "Set Router",
    address: addresses.setwiseRouter,
    bytecodeHash: hashRuntime(
      requireRuntimeCode(input.runtimeCode.setwiseRouter, "Set Router"),
    ),
    compiler: { ...COMPILER },
    constructorInputs: [
      String(CHAIN_ID),
      addresses.wrappedNative,
      addresses.governance,
      addresses.poolRegistryProxy,
      addresses.routerControlProxy,
    ],
    deployment: routerDeployment,
    explorer: explorer(
      addresses.setwiseRouter,
      routerDeployment,
      explorerBaseUrl,
    ),
  };

  chain.router = addresses.setwiseRouter;
  chain.venues.setwise.poolRegistry = addresses.poolRegistryProxy;

  rollout.architecture = {
    pricing: "external-rfq",
    onchainQuoterRequired: false,
    tokenHubRequired: false,
  };
  rollout.deployment = {
    poolRegistry: {
      status: "deployed",
      address: addresses.poolRegistryProxy,
      implementation: addresses.poolRegistryImplementation,
      ...registryDeployment,
    },
    routerControl: {
      status: "deployed",
      address: addresses.routerControlProxy,
      implementation: addresses.routerControlImplementation,
      ...controlDeployment,
    },
    setwiseRouter: {
      status: "deployed",
      address: addresses.setwiseRouter,
      ...routerDeployment,
    },
    governance: {
      deployer: addresses.deployer,
      owner: addresses.governance,
      emergencyGuardian: addresses.emergencyGuardian,
      registryOwnershipTransferRequired:
        addresses.registryOwnershipPending,
      registryOwnerAccepted: !addresses.registryOwnershipPending,
      acceptanceTransactionHash: null,
    },
  };

  const configResult = validateChainConfig(chain, CHAIN_ID);
  if (!configResult.valid) {
    throw new Error(`generated chain config is invalid:\n${configResult.errors.join("\n")}`);
  }
  const manifestResult = validateDeploymentManifest(manifest, CHAIN_ID);
  if (!manifestResult.valid) {
    throw new Error(
      `generated deployment manifest is invalid:\n${manifestResult.errors.join("\n")}`,
    );
  }
  const crossResult = validateManifestAgainstConfig(chain, manifest);
  if (!crossResult.valid) {
    throw new Error(
      `generated manifest/config pair is invalid:\n${crossResult.errors.join("\n")}`,
    );
  }

  return { chain, manifest, rollout };
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function parseArgs(argv) {
  const defaults = {
    addresses: join(root, "contracts/broadcast/bsc-testnet-97.addresses.json"),
    broadcast: join(
      root,
      "contracts/broadcast/DeployBscTestnet.s.sol/97/run-latest.json",
    ),
    write: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") {
      defaults.write = true;
    } else if (arg === "--addresses" || arg === "--broadcast") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a path`);
      defaults[arg.slice(2)] = resolve(value);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return defaults;
}

async function loadConfirmedRuntimeCode(rpcUrl, addresses) {
  await assertRpcChainId(rpcUrl, CHAIN_ID);
  const fields = [
    "poolRegistryImplementation",
    "poolRegistryProxy",
    "routerControlImplementation",
    "routerControlProxy",
    "setwiseRouter",
  ];
  const entries = await Promise.all(
    fields.map(async (field) => [
      field,
      requireRuntimeCode(await getCode(rpcUrl, addresses[field]), field),
    ]),
  );
  const runtimeCode = Object.fromEntries(entries);

  for (const [proxyField, implementationField] of [
    ["poolRegistryProxy", "poolRegistryImplementation"],
    ["routerControlProxy", "routerControlImplementation"],
  ]) {
    const storageWord = await getStorageAt(
      rpcUrl,
      addresses[proxyField],
      EIP1967_IMPLEMENTATION_SLOT,
    );
    const actual = addressFromStorageWord(storageWord);
    if (!sameAddress(actual, addresses[implementationField])) {
      throw new Error(
        `${proxyField} points to ${actual}; expected ${addresses[implementationField]}`,
      );
    }
  }
  return runtimeCode;
}

async function runCli() {
  const options = parseArgs(process.argv.slice(2));
  const chainPath = join(root, "config/chains/97.json");
  const manifestPath = join(root, "deployments/bsc-testnet-97.json");
  const rolloutPath = join(root, "deployments/bsc-testnet-97.rollout.json");
  const addresses = loadJson(options.addresses);
  const chain = loadJson(chainPath);
  const rpcUrl = resolvePublicRpcUrl(chain);
  if (!rpcUrl) throw new Error("RPC_URL_BSC_TESTNET is not configured");
  const records = buildBscTestnetDeploymentRecords({
    addresses,
    broadcast: loadJson(options.broadcast),
    chain,
    manifest: loadJson(manifestPath),
    rollout: loadJson(rolloutPath),
    runtimeCode: await loadConfirmedRuntimeCode(rpcUrl, addresses),
  });

  if (options.write) {
    writeFileSync(chainPath, `${JSON.stringify(records.chain, null, 2)}\n`);
    writeFileSync(
      manifestPath,
      `${JSON.stringify(records.manifest, null, 2)}\n`,
    );
    writeFileSync(
      rolloutPath,
      `${JSON.stringify(records.rollout, null, 2)}\n`,
    );
    process.stdout.write(
      "wrote chain config, deployment manifest, and rollout record for chain 97\n",
    );
    return;
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        mode: "preview",
        message: "Pass --write only after reviewing confirmed chain-97 receipts.",
        records,
      },
      null,
      2,
    )}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

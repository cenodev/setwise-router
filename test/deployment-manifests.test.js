import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { getChainConfig } from "../config/registry.mjs";
import {
  MANIFEST_CONTRACT_ROLES,
  EIP1967_IMPLEMENTATION_SLOT,
} from "../deployments/constants.mjs";
import {
  addressFromStorageWord,
  bytecodeHasUupsInterface,
  classifyBytecode,
  inspectAddress,
} from "../deployments/proxy.mjs";
import {
  DeploymentManifestError,
  loadDeploymentManifests,
  manifestFileName,
  manifestChainIds,
} from "../deployments/registry.mjs";
import {
  validateDeploymentManifest,
  validateManifestAgainstConfig,
  validateManifestRegistry,
} from "../deployments/schema.mjs";
import { RpcChainMismatchError, assertRpcChainId } from "../deployments/rpc.mjs";
import {
  formatReleaseChecklist,
  verifyManifestsOffline,
} from "../deployments/verify.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SUPPORTED = [1, 56, 97, 4663, 8453];

function baseManifest() {
  return structuredClone(
    JSON.parse(readFileSync(join(root, "deployments/ethereum-1.json"), "utf8")),
  );
}

function writeManifestDir(manifests) {
  const dir = mkdtempSync(join(tmpdir(), "sw-deploy-"));
  for (const manifest of manifests) {
    const file = manifestFileName(manifest.chainKey, manifest.chainId);
    writeFileSync(join(dir, file), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return dir;
}

function deployedUupsProxy(overrides = {}) {
  return {
    status: "deployed",
    kind: "uups-proxy",
    displayName: "Set pool registry",
    address: "0x1111111111111111111111111111111111111111",
    implementation: {
      kind: "implementation",
      address: "0x2222222222222222222222222222222222222222",
      bytecodeHash: `0x${"ab".repeat(32)}`,
      compiler: {
        profile: "default",
        solcVersion: "0.8.28",
        optimizer: true,
        optimizerRuns: 200,
        evmVersion: "cancun",
      },
      constructorInputs: [],
    },
    deployment: {
      transactionHash: `0x${"cd".repeat(32)}`,
      blockNumber: 100,
    },
    explorer: {
      addressUrl: "https://etherscan.io/address/0x1111",
      transactionUrl: "https://etherscan.io/tx/0xcd",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Committed manifests
// ---------------------------------------------------------------------------

test("all supported chains have a deployment manifest", () => {
  assert.deepEqual(manifestChainIds(), SUPPORTED);
  const manifests = loadDeploymentManifests();
  assert.equal(manifests.size, SUPPORTED.length);
});

test("committed manifests use Set UI labels with internal contract keys", () => {
  const manifests = loadDeploymentManifests();
  for (const chainId of SUPPORTED) {
    const manifest = manifests.get(chainId);
    for (const [name, role] of Object.entries(MANIFEST_CONTRACT_ROLES)) {
      const entry = manifest.contracts[name];
      assert.ok(entry, `chain ${chainId} missing ${name}`);
      assert.equal(entry.displayName, role.displayName);
      assert.match(entry.displayName, /Set/);
      if (name === "setwisePoolRegistry") {
        assert.match(entry.displayName, /pool registry/i);
      }
    }
  }
});

test("offline verification passes for committed manifests", () => {
  const result = verifyManifestsOffline();
  assert.equal(result.ok, true);
  assert.ok(result.findings.some((f) => f.level === "skip" && f.contract === "setwisePoolRegistry"));
});

// ---------------------------------------------------------------------------
// Schema validation — fail closed
// ---------------------------------------------------------------------------

test("rejects manifest chainId that does not match file name", () => {
  const manifest = baseManifest();
  const result = validateDeploymentManifest(manifest, 56);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /does not match file name/.test(e)));
});

test("rejects uups-proxy when proxy and implementation addresses match", () => {
  const manifest = baseManifest();
  manifest.contracts.setwisePoolRegistry = deployedUupsProxy({
    address: "0x1111111111111111111111111111111111111111",
    implementation: {
      kind: "implementation",
      address: "0x1111111111111111111111111111111111111111",
      bytecodeHash: `0x${"ab".repeat(32)}`,
      compiler: {
        profile: "default",
        solcVersion: "0.8.28",
        optimizer: true,
        optimizerRuns: 200,
      },
      constructorInputs: [],
    },
  });
  const result = validateDeploymentManifest(manifest, 1);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /must differ from implementation/.test(e)));
});

test("rejects deployed direct contract without bytecodeHash", () => {
  const manifest = baseManifest();
  manifest.contracts.setwiseRouter = {
    status: "deployed",
    kind: "direct",
    displayName: "Set Router",
    address: "0x3333333333333333333333333333333333333333",
    bytecodeHash: `0x${"ee".repeat(32)}`,
    compiler: {
      profile: "default",
      solcVersion: "0.8.28",
      optimizer: true,
      optimizerRuns: 200,
    },
    constructorInputs: [],
    deployment: {
      transactionHash: `0x${"ff".repeat(32)}`,
      blockNumber: 1,
    },
    explorer: {
      addressUrl: "https://etherscan.io/address/0x3333",
    },
  };
  delete manifest.contracts.setwiseRouter.bytecodeHash;
  const result = validateDeploymentManifest(manifest, 1);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /bytecodeHash/.test(e)));
});

test("rejects pending entry that still carries an address", () => {
  const manifest = baseManifest();
  manifest.contracts.setwiseRouter = {
    status: "pending",
    kind: "direct",
    displayName: "Set Router",
    address: "0x3333333333333333333333333333333333333333",
  };
  const result = validateDeploymentManifest(manifest, 1);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /pending entries must not include address/.test(e)));
});

test("validateManifestAgainstConfig rejects manifest/config address mismatch", () => {
  const eth = getChainConfig(1);
  const manifest = baseManifest();
  manifest.contracts.setwisePoolRegistry = deployedUupsProxy();
  const result = validateManifestAgainstConfig(eth, manifest);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (e) => /does not match config registry|has no address/.test(e),
    ),
  );
});

test("loadDeploymentManifests throws on duplicate addresses across chains", () => {
  const eth = baseManifest();
  const bsc = structuredClone(
    JSON.parse(readFileSync(join(root, "deployments/bsc-56.json"), "utf8")),
  );
  bsc.contracts.setwisePoolRegistry = deployedUupsProxy();
  eth.contracts.setwisePoolRegistry = deployedUupsProxy();
  const dir = writeManifestDir([eth, bsc]);
  assert.throws(() => loadDeploymentManifests(dir), DeploymentManifestError);
});

test("validateManifestRegistry rejects duplicate chain keys", () => {
  const eth = baseManifest();
  const dup = structuredClone(eth);
  dup.chainId = 999;
  const result = validateManifestRegistry(new Map([[1, eth], [999, dup]]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /duplicate chain keys/.test(e)));
});

// ---------------------------------------------------------------------------
// RPC chain-id guard
// ---------------------------------------------------------------------------

test("assertRpcChainId fails closed on mismatch", async () => {
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return { jsonrpc: "2.0", id: 1, result: "0x38" }; // 56
    },
  });
  await assert.rejects(
    () => assertRpcChainId("https://rpc.example", 1, { fetchImpl }),
    RpcChainMismatchError,
  );
});

test("assertRpcChainId accepts matching chain id", async () => {
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return { jsonrpc: "2.0", id: 1, result: "0x1" };
    },
  });
  const chainId = await assertRpcChainId("https://rpc.example", 1, { fetchImpl });
  assert.equal(chainId, 1);
});

// ---------------------------------------------------------------------------
// Proxy / UUPS helpers
// ---------------------------------------------------------------------------

test("addressFromStorageWord parses EIP-1967 implementation pointers", () => {
  const word = `0x${"0".repeat(24)}2222222222222222222222222222222222222222`;
  assert.equal(
    addressFromStorageWord(word),
    "0x2222222222222222222222222222222222222222",
  );
  assert.equal(addressFromStorageWord(ZERO_WORD()), null);
});

function ZERO_WORD() {
  return `0x${"0".repeat(64)}`;
}

test("classifyBytecode detects EIP-1967 slot references", () => {
  const proxyCode =
    "0x608060405234801561001057600080fd5b50336000806101000a81548173" +
    "360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  assert.equal(classifyBytecode(proxyCode), "eip1967-slot-reference");
  assert.equal(classifyBytecode("0x"), "empty");
});

test("inspectAddress does not mistake UUPS implementation code for a proxy", async () => {
  const implementation = "0x2222222222222222222222222222222222222222";
  const uupsCode =
    "0x60806040" +
    EIP1967_IMPLEMENTATION_SLOT.slice(2) +
    "5b600052d1902d6000";
  const fetchImpl = async (_url, init) => {
    const request = JSON.parse(init.body);
    const result =
      request.method === "eth_getCode"
        ? uupsCode
        : request.method === "eth_getStorageAt"
          ? ZERO_WORD()
          : null;
    return {
      ok: true,
      async json() {
        return { jsonrpc: "2.0", id: request.id, result };
      },
    };
  };

  const inspection = await inspectAddress(
    "https://rpc.example",
    implementation,
    { fetchImpl },
  );

  assert.equal(inspection.classification, "eip1967-slot-reference");
  assert.equal(inspection.eip1967Implementation, null);
  assert.equal(inspection.hasUupsInterface, true);
  assert.equal(inspection.role, "implementation");
});

test("inspectAddress classifies a populated ERC-1967 slot as a proxy", async () => {
  const implementation = "2222222222222222222222222222222222222222";
  const proxyCode = `0x60806040${EIP1967_IMPLEMENTATION_SLOT.slice(2)}6000`;
  const fetchImpl = async (_url, init) => {
    const request = JSON.parse(init.body);
    const result =
      request.method === "eth_getCode"
        ? proxyCode
        : request.method === "eth_getStorageAt"
          ? `0x${"0".repeat(24)}${implementation}`
          : null;
    return {
      ok: true,
      async json() {
        return { jsonrpc: "2.0", id: request.id, result };
      },
    };
  };

  const inspection = await inspectAddress(
    "https://rpc.example",
    "0x1111111111111111111111111111111111111111",
    { fetchImpl },
  );

  assert.equal(
    inspection.eip1967Implementation,
    `0x${implementation}`,
  );
  assert.equal(inspection.role, "proxy");
});

test("bytecodeHasUupsInterface detects proxiableUUID selector", () => {
  const code = `0x${"00".repeat(10)}52d1902d${"00".repeat(10)}`;
  assert.equal(bytecodeHasUupsInterface(code), true);
  assert.equal(bytecodeHasUupsInterface("0x6000"), false);
});

test("EIP-1967 implementation slot constant is canonical", () => {
  assert.equal(
    EIP1967_IMPLEMENTATION_SLOT,
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  );
});

// ---------------------------------------------------------------------------
// Release checklist
// ---------------------------------------------------------------------------

test("formatReleaseChecklist renders human-readable output", () => {
  const text = formatReleaseChecklist([
    { level: "ok", chainId: 1, contract: "*", message: "manifest validated" },
    {
      level: "skip",
      chainId: 1,
      contract: "setwisePoolRegistry",
      message: "Set pool registry pending deployment",
    },
    {
      level: "error",
      chainId: 56,
      contract: "setwiseRouter",
      message: "bytecode hash mismatch",
    },
  ]);
  assert.match(text, /# Setwise Router deployment release checklist/);
  assert.match(text, /Set pool registry pending deployment/);
  assert.match(text, /Release ready: no/);
});

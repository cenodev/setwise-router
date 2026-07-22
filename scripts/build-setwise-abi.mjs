import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contractsDir = join(root, "contracts");
const outDir = join(contractsDir, "out");
const baselineDir = join(root, "baseline", "abi");

const CONTRACT = "ISetwisePool";
const SOURCE = "contracts/src/setwise/ISetwisePool.sol";

// Classification of the minimal pool surface. `group` separates the swap entry
// points from config/replay/view helpers; `assetMode` records which settlement
// mode each entry point executes (issue #7 scope).
const POOL_GROUPS = {
  swapExactAssetForAsset: {
    group: "swap",
    assetMode: "erc20-to-erc20",
    notes: "ERC-20 -> ERC-20; pulls inputAmount of inputAsset, transfers outputAmount of outputAsset",
  },
  swapExactNativeForAsset: {
    group: "swap",
    assetMode: "native-to-erc20",
    notes: "Native -> ERC-20; msg.value == inputAmount, signed quote input asset is WRAPPED_NATIVE_TOKEN",
  },
  swapExactAssetForNative: {
    group: "swap",
    assetMode: "erc20-to-native",
    notes: "ERC-20 -> native; signed quote output asset is WRAPPED_NATIVE_TOKEN, pool unwraps to recipient",
  },
  QUOTE_SIGNER: { group: "config", notes: "Address SwapQuote signatures are verified against" },
  WRAPPED_NATIVE_TOKEN: { group: "config", notes: "On-chain representation of a native leg" },
  usedQuoteIds: { group: "replay", notes: "One-time quoteId consumption flag" },
  isSupportedAsset: { group: "config", notes: "Pool asset allowlist membership" },
  quoteDomainSeparator: { group: "config", notes: "EIP-712 domain separator for SwapQuote" },
  recordedBalance: { group: "view", notes: "Pool's internally recorded asset balance" },
};

// EIP-712 quote the pool verifies. `payer` is the caller the pool observes
// (the router). Domain name/version match the deployed SetwisePoolBase.
const EIP712 = {
  domainName: "SetwisePool",
  domainVersion: "2.0.0",
  swapQuoteType:
    "SwapQuote(address payer,address inputAsset,address outputAsset,uint256 inputAmount," +
    "uint256 outputAmount,bytes32 quoteId,uint256 deadline,address recipient)",
};

function resolveForge() {
  if (process.env.FORGE_BIN) return process.env.FORGE_BIN;
  const which = spawnSync("command", ["-v", "forge"], { shell: true, encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  const fallback = join(process.env.HOME || "", ".foundry/bin/forge");
  try {
    accessSync(fallback, constants.X_OK);
    return fallback;
  } catch {
    return null;
  }
}

function resolveCast() {
  if (process.env.CAST_BIN) return process.env.CAST_BIN;
  const which = spawnSync("command", ["-v", "cast"], { shell: true, encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  const fallback = join(process.env.HOME || "", ".foundry/bin/cast");
  return existsSync(fallback) ? fallback : null;
}

function canonType(input) {
  if (input.type === "tuple" || input.type.startsWith("tuple")) {
    const inner = `(${(input.components || []).map(canonType).join(",")})`;
    return inner + input.type.slice("tuple".length);
  }
  return input.type;
}

function canonSignature(name, inputs) {
  return `${name}(${(inputs || []).map(canonType).join(",")})`;
}

function stripInternal(param) {
  const out = { name: param.name, type: param.type };
  if (param.indexed) out.indexed = true;
  if (param.components) out.components = param.components.map(stripInternal);
  return out;
}

const cast = resolveCast();
const selectorCache = new Map();

function castSig(signature) {
  if (selectorCache.has(signature)) return selectorCache.get(signature);
  let value = null;
  if (cast) {
    const res = spawnSync(cast, ["sig", signature], { encoding: "utf8" });
    if (res.status === 0) value = res.stdout.trim();
  }
  selectorCache.set(signature, value);
  return value;
}

function castSigEvent(signature) {
  const key = `event:${signature}`;
  if (selectorCache.has(key)) return selectorCache.get(key);
  let value = null;
  if (cast) {
    const res = spawnSync(cast, ["sig-event", signature], { encoding: "utf8" });
    if (res.status === 0) value = res.stdout.trim();
  }
  selectorCache.set(key, value);
  return value;
}

function castKeccak(text) {
  if (!cast) return null;
  const res = spawnSync(cast, ["keccak", text], { encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() : null;
}

function build() {
  const forge = resolveForge();
  if (!forge) {
    console.error("forge not found. Install Foundry from https://getfoundry.sh/");
    process.exit(1);
  }
  const result = spawnSync(forge, ["build"], { cwd: contractsDir, stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function main() {
  if (!cast) {
    console.error("cast not found. Install Foundry from https://getfoundry.sh/");
    process.exit(1);
  }

  build();

  const artifactPath = join(outDir, `${CONTRACT}.sol`, `${CONTRACT}.json`);
  if (!existsSync(artifactPath)) {
    console.error(`missing artifact: ${artifactPath}`);
    process.exit(1);
  }
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  const methodIdentifiers = artifact.methodIdentifiers || {};

  const functions = [];
  const events = [];
  const errors = [];

  for (const entry of artifact.abi) {
    if (entry.type === "function") {
      const signature = canonSignature(entry.name, entry.inputs);
      const selector = methodIdentifiers[signature];
      if (!selector) {
        console.error(`no methodIdentifier for ${CONTRACT}.${signature}`);
        process.exit(1);
      }
      const meta = POOL_GROUPS[entry.name];
      if (!meta) {
        console.error(`uncategorized ${CONTRACT} function: ${entry.name}`);
        process.exit(1);
      }
      functions.push({
        name: entry.name,
        signature,
        selector: `0x${selector}`,
        stateMutability: entry.stateMutability,
        inputs: (entry.inputs || []).map(stripInternal),
        outputs: (entry.outputs || []).map(stripInternal),
        ...meta,
      });
    } else if (entry.type === "event") {
      const signature = canonSignature(entry.name, entry.inputs);
      events.push({
        name: entry.name,
        signature,
        topicHash: castSigEvent(signature),
        inputs: (entry.inputs || []).map(stripInternal),
      });
    } else if (entry.type === "error") {
      const signature = canonSignature(entry.name, entry.inputs);
      errors.push({
        name: entry.name,
        signature,
        selector: castSig(signature),
        inputs: (entry.inputs || []).map(stripInternal),
      });
    }
  }

  functions.sort((a, b) => a.selector.localeCompare(b.selector));
  errors.sort((a, b) => a.selector.localeCompare(b.selector));
  events.sort((a, b) => a.name.localeCompare(b.name));

  const record = {
    schema: "setwise-router/setwise-pool-abi@1",
    contract: CONTRACT,
    source: SOURCE,
    interface: true,
    upstream: {
      repository: "https://github.com/cenodev/setwise-contracts",
      paths: ["contracts/SetwisePoolBase.sol", "contracts/SetwisePool.sol"],
      note:
        "Selectors, the SwapExecuted event, and the revert surface mirror the deployed " +
        "SetwisePoolBase/SetwisePool swap surface. This repository vendors only the minimal " +
        "interface, not the upgradeable implementation.",
    },
    eip712: {
      domainName: EIP712.domainName,
      domainVersion: EIP712.domainVersion,
      swapQuoteType: EIP712.swapQuoteType,
      swapQuoteTypehash: castKeccak(EIP712.swapQuoteType),
    },
    abi: { functions, events, errors },
  };

  mkdirSync(baselineDir, { recursive: true });
  const target = join(baselineDir, "setwisePool.json");
  writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`);
  console.log(
    `wrote setwisePool: ${functions.length} functions, ${events.length} events, ${errors.length} errors`,
  );
}

main();

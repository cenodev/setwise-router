import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "zFi-main", "out");
const baselineDir = join(root, "baseline", "abi");

const CONTRACTS = [
  { contract: "zRouter", source: "zFi-main/src/zRouter.sol" },
  { contract: "zQuoter", source: "zFi-main/src/zQuoter.sol" },
];

// Analysis result: how each zRouter function maps to a compatibility group and
// preservation scope. `scope` drives the swap-vs-extension boundary required by
// issue #5; `ethereumOnly` flags behavior that issue #11 must capability-gate.
const ROUTER_GROUPS = {
  snwap: { group: "swap", scope: "core-swap", venue: "EXECUTOR", notes: "Generic executor swap; Bebop/Bitgetol/any via safeExecutor" },
  snwapMulti: { group: "swap", scope: "core-swap", venue: "EXECUTOR", notes: "Multi-output executor swap" },
  swapV2: { group: "swap", scope: "core-swap", venue: "UNI_V2|SUSHI", notes: "deadline == type(uint256).max sentinel selects the SUSHI factory" },
  swapV3: { group: "swap", scope: "core-swap", venue: "UNI_V3" },
  swapV4: { group: "swap", scope: "core-swap", venue: "UNI_V4" },
  swapCurve: { group: "swap", scope: "core-swap", venue: "CURVE", notes: "Up to 5 hops; exchange/underlying/add_liquidity/remove_liquidity_one_coin" },
  swapVZ: { group: "swap", scope: "core-swap", venue: "ZAMM", notes: "Raw selectors to ZAMM/ZAMM_0; ERC-20 (id 0) and ERC-6909 ids" },
  wrap: { group: "native", scope: "swap-support", notes: "ETH -> WETH" },
  unwrap: { group: "native", scope: "swap-support", notes: "WETH -> ETH" },
  deposit: { group: "native", scope: "swap-support", notes: "Pull ETH/ERC-20/ERC-6909 into transient balance" },
  ethToExactSTETH: { group: "native", scope: "swap-support", venue: "LIDO", ethereumOnly: true, notes: "Exact-out ETH -> stETH" },
  ethToExactWSTETH: { group: "native", scope: "swap-support", venue: "LIDO", ethereumOnly: true, notes: "Exact-out ETH -> wstETH" },
  exactETHToSTETH: { group: "native", scope: "swap-support", venue: "LIDO", ethereumOnly: true, notes: "Exact-in ETH -> stETH" },
  exactETHToWSTETH: { group: "native", scope: "swap-support", venue: "LIDO", ethereumOnly: true, notes: "Exact-in ETH -> wstETH" },
  ensureAllowance: { group: "funding", scope: "swap-support", admin: true, notes: "onlyOwner max approval / ERC-6909 operator" },
  permit: { group: "funding", scope: "swap-support", notes: "ERC-2612 permit" },
  permit2TransferFrom: { group: "funding", scope: "swap-support", notes: "Permit2 signed single transfer" },
  permit2BatchTransferFrom: { group: "funding", scope: "swap-support", notes: "Permit2 signed batch transfer" },
  permitDAI: { group: "funding", scope: "swap-support", notes: "DAI-style permit" },
  trust: { group: "funding", scope: "swap-support", admin: true, notes: "onlyOwner execute() target whitelist" },
  execute: { group: "plumbing", scope: "swap-support", notes: "Call a trusted target; locks the V3/V4 callback slot" },
  multicall: { group: "plumbing", scope: "swap-support", notes: "delegatecall batch; the chaining primitive" },
  sweep: { group: "plumbing", scope: "swap-support", notes: "Withdraw ETH/ERC-20/ERC-6909" },
  unlockCallback: { group: "plumbing", scope: "swap-support", venue: "UNI_V4", notes: "V4 PoolManager unlock callback" },
  safeExecutor: { group: "plumbing", scope: "swap-support", notes: "Immutable SafeExecutor getter" },
  addLiquidity: { group: "liquidity", scope: "extension", venue: "ZAMM", notes: "Mints zAMM liquidity; NOT a swap (no router slippage/deadline guard)" },
  transferOwnership: { group: "admin", scope: "extension", admin: true },
  revealName: { group: "extension", scope: "extension", ethereumOnly: true, notes: "NameNFT .wei commit-reveal registration" },
  onERC721Received: { group: "extension", scope: "extension", notes: "ERC-721 receiver hook used during NameNFT reveal" },
};

const QUOTER_GROUPS = {
  getQuotes: { group: "quote", scope: "core-swap", notes: "All-venue quote discovery; filters bogus exact-out V3 picks" },
  buildBestSwap: { group: "quote", scope: "core-swap", notes: "Best single-hop route + calldata" },
  buildBestSwapViaETHMulticall: { group: "quote", scope: "core-swap", notes: "Best of single-hop vs 2-hop hub route" },
  buildSplitSwap: { group: "quote", scope: "core-swap", notes: "Exact-in split across top 2 venues" },
  buildHybridSplit: { group: "quote", scope: "core-swap", notes: "Exact-in split: best direct vs best 2-hop" },
  buildSwapAuto: { group: "quote", scope: "core-swap", notes: "Cascade: 2-hop then 3-hop" },
  build3HopMulticall: { group: "quote", scope: "core-swap", notes: "3-hop route over two hub intermediates" },
  quoteCurve: { group: "quote", scope: "core-swap", venue: "CURVE", notes: "Single-hop Curve quote via MetaRegistry" },
  quoteLido: { group: "quote", scope: "core-swap", venue: "LIDO", ethereumOnly: true, notes: "ETH -> stETH/wstETH quote" },
};

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

function resolveCast() {
  if (process.env.CAST_BIN) return process.env.CAST_BIN;
  const which = spawnSync("command", ["-v", "cast"], { shell: true, encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  const fallback = join(process.env.HOME || "", ".foundry/bin/cast");
  return existsSync(fallback) ? fallback : null;
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

function stripInternal(param) {
  const out = { name: param.name, type: param.type };
  if (param.indexed) out.indexed = true;
  if (param.components) out.components = param.components.map(stripInternal);
  return out;
}

function sha256(text) {
  return `0x${createHash("sha256").update(text).digest("hex")}`;
}

function buildContract({ contract, source }, upstreamCommit) {
  const artifactPath = join(outDir, `${contract}.sol`, `${contract}.json`);
  if (!existsSync(artifactPath)) {
    console.error(`missing artifact: ${artifactPath} (run: npm run build)`);
    process.exit(1);
  }
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  const groups = contract === "zRouter" ? ROUTER_GROUPS : QUOTER_GROUPS;
  const methodIdentifiers = artifact.methodIdentifiers || {};

  const functions = [];
  const events = [];
  const errors = [];
  let constructor = null;
  let receive = false;
  let fallback = false;

  for (const entry of artifact.abi) {
    if (entry.type === "function") {
      const signature = canonSignature(entry.name, entry.inputs);
      const selector = methodIdentifiers[signature] ?? null;
      if (!selector) {
        console.error(`no methodIdentifier for ${contract}.${signature}`);
        process.exit(1);
      }
      const meta = groups[entry.name];
      if (!meta) {
        console.error(`uncategorized ${contract} function: ${entry.name}`);
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
    } else if (entry.type === "constructor") {
      constructor = {
        stateMutability: entry.stateMutability,
        inputs: (entry.inputs || []).map(stripInternal),
      };
    } else if (entry.type === "receive") {
      receive = true;
    } else if (entry.type === "fallback") {
      fallback = true;
    }
  }

  const bySelector = (a, b) => a.selector.localeCompare(b.selector);
  functions.sort(bySelector);
  errors.sort(bySelector);
  events.sort((a, b) => a.name.localeCompare(b.name));

  const deployedObject = artifact.deployedBytecode?.object ?? "0x";
  const deployedBytecodeSize = Math.max(0, (deployedObject.length - 2) / 2);

  return {
    contract,
    source,
    upstreamCommit,
    deployedBytecodeSize,
    deployedBytecodeHash: sha256(deployedObject),
    abi: {
      constructor,
      receive,
      fallback,
      functions,
      events,
      errors,
    },
  };
}

function summarizeScope(record) {
  const buckets = { "core-swap": [], "swap-support": [], extension: [] };
  const ethereumOnly = [];
  for (const fn of record.abi.functions) {
    buckets[fn.scope].push(fn.name);
    if (fn.ethereumOnly) ethereumOnly.push(fn.name);
  }
  for (const key of Object.keys(buckets)) buckets[key].sort();
  ethereumOnly.sort();
  return { byScope: buckets, ethereumOnly };
}

function main() {
  const provenance = JSON.parse(
    readFileSync(join(root, "docs/upstream/PROVENANCE.json"), "utf8"),
  );
  const upstreamCommit = provenance.upstream.commit;

  if (!cast) {
    console.error("cast not found. Install Foundry from https://getfoundry.sh/");
    process.exit(1);
  }

  mkdirSync(baselineDir, { recursive: true });

  const records = {};
  for (const spec of CONTRACTS) {
    const record = buildContract(spec, upstreamCommit);
    records[spec.contract] = record;
    const target = join(baselineDir, `${spec.contract}.json`);
    writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`);
    console.log(
      `wrote ${spec.contract}: ${record.abi.functions.length} functions, ` +
        `${record.abi.events.length} events, ${record.abi.errors.length} errors ` +
        `(deployed ${record.deployedBytecodeSize} bytes)`,
    );
  }

  const routerScope = summarizeScope(records.zRouter);
  const quoterScope = summarizeScope(records.zQuoter);

  const matrix = {
    schema: "setwise-router/abi-compatibility-matrix@1",
    upstream: {
      repository: provenance.upstream.repository,
      commit: upstreamCommit,
      localPath: provenance.localPath,
    },
    contracts: {
      zRouter: {
        source: records.zRouter.source,
        deployedBytecodeSize: records.zRouter.deployedBytecodeSize,
        deployedBytecodeHash: records.zRouter.deployedBytecodeHash,
        functionCount: records.zRouter.abi.functions.length,
        eventCount: records.zRouter.abi.events.length,
        errorCount: records.zRouter.abi.errors.length,
        scope: routerScope,
      },
      zQuoter: {
        source: records.zQuoter.source,
        deployedBytecodeSize: records.zQuoter.deployedBytecodeSize,
        deployedBytecodeHash: records.zQuoter.deployedBytecodeHash,
        functionCount: records.zQuoter.abi.functions.length,
        eventCount: records.zQuoter.abi.events.length,
        errorCount: records.zQuoter.abi.errors.length,
        scope: quoterScope,
      },
    },
    venues: [
      { id: 0, name: "UNI_V2", routerFunction: "swapV2", quoterSource: "UNI_V2", notes: "CREATE2 pair; 0.30% fee math" },
      { id: 1, name: "SUSHI", routerFunction: "swapV2", quoterSource: "SUSHI", notes: "swapV2 with deadline == max sentinel" },
      { id: 2, name: "ZAMM", routerFunction: "swapVZ", quoterSource: "ZAMM", notes: "Precision pools; ERC-20 + ERC-6909" },
      { id: 3, name: "UNI_V3", routerFunction: "swapV3", quoterSource: "UNI_V3", notes: "Concentrated liquidity; fee tiers" },
      { id: 4, name: "UNI_V4", routerFunction: "swapV4", quoterSource: "UNI_V4", notes: "PoolManager unlock callback" },
      { id: 5, name: "CURVE", routerFunction: "swapCurve", quoterSource: "CURVE", notes: "StableNg/Crypto/Meta pools; up to 5 hops" },
      { id: 6, name: "LIDO", routerFunction: "exactETHToSTETH|exactETHToWSTETH|ethToExactSTETH|ethToExactWSTETH", quoterSource: "LIDO", ethereumOnly: true, notes: "stETH/wstETH wrap-style routes" },
      { id: 7, name: "WETH_WRAP", routerFunction: "wrap|unwrap", quoterSource: "WETH_WRAP", notes: "Native <-> WETH 1:1 fast path" },
      { id: null, name: "EXECUTOR", routerFunction: "snwap|snwapMulti", quoterSource: null, notes: "Generic safeExecutor target (e.g. Bebop, Bitgetol forwarders)" },
    ],
    routeShapes: [
      { name: "single-hop", quoterFunction: "buildBestSwap", hops: 1, notes: "Best direct venue" },
      { name: "two-hop-hub", quoterFunction: "buildBestSwapViaETHMulticall", hops: 2, notes: "Via one hub intermediate" },
      { name: "three-hop", quoterFunction: "build3HopMulticall", hops: 3, notes: "Via two hub intermediates" },
      { name: "split", quoterFunction: "buildSplitSwap", hops: 1, notes: "Exact-in split across top 2 venues" },
      { name: "hybrid-split", quoterFunction: "buildHybridSplit", hops: 2, notes: "Split best direct vs best 2-hop" },
      { name: "auto", quoterFunction: "buildSwapAuto", hops: 3, notes: "Cascade 2-hop then 3-hop" },
    ],
    hubs: ["WETH", "USDC", "USDT", "DAI", "WBTC", "WSTETH"],
    extensionDecision: {
      summary:
        "Preserve the swap surface (core-swap + swap-support) as the routing baseline. " +
        "Treat NameNFT, zAMM liquidity, and ownership as non-swap extensions that are " +
        "capability-gated per issue #11 and excluded from non-Ethereum deployments.",
      nonSwapExtensions: {
        NameNFT: {
          functions: ["revealName", "onERC721Received"],
          decision: "ethereum-only",
          rationale: ".wei naming is an Ethereum-mainnet product; gate behind a capability flag and drop on other chains.",
        },
        zAMM_liquidity: {
          functions: ["addLiquidity"],
          decision: "out-of-swap-scope",
          rationale: "LP minting, not routing; preserved for parity but not part of Setwise swap execution.",
        },
        ownership: {
          functions: ["transferOwnership"],
          decision: "retain",
          rationale: "Required for trust/ensureAllowance administration; keep but govern via issue #37.",
        },
      },
      separateContracts: [
        { name: "DAO (Moloch)", path: "zFi-main/src/dao", decision: "out-of-scope", rationale: "Not part of router/quoter ABI." },
        { name: "Coin launch", path: "zFi-main/src (CoinLaunch/CauseCoin)", decision: "out-of-scope", rationale: "Token-launch product, not routing." },
        { name: "Dutch auction", path: "zFi-main/src/DutchAuction.sol", decision: "out-of-scope", rationale: "Auction product, not routing." },
      ],
      knownUnsupported: [
        "Default-profile zQuoter bytecode exceeds EIP-170 (24,576 bytes); deploy with the `zquoter` Foundry profile (optimizer_runs=20, yul=false).",
        "Bebop and Bitgetol have no typed router interface; reachable only as snwap executor targets.",
        "Curve pools using the CURVE_ETH sentinel directly are not buildable by the router (quoter filters them).",
      ],
    },
  };

  const matrixPath = join(baselineDir, "compatibility-matrix.json");
  writeFileSync(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`);
  console.log("wrote compatibility-matrix.json");
}

main();

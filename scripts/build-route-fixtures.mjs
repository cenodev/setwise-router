import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const abiDir = join(root, "baseline", "abi");
const routesDir = join(root, "baseline", "routes");

const router = JSON.parse(readFileSync(join(abiDir, "zRouter.json"), "utf8"));
const quoter = JSON.parse(readFileSync(join(abiDir, "zQuoter.json"), "utf8"));
const matrix = JSON.parse(readFileSync(join(abiDir, "compatibility-matrix.json"), "utf8"));

const T = {
  ETH: "0x0000000000000000000000000000000000000000",
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
  WSTETH: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
};

const RECIPIENT = "0x000000000000000000000000000000000000bEEF";
const BITGETOL_EXECUTOR = "0xBc1D9760bd6ca468CA9fB5Ff2CFbEAC35d86c973";
const CURVE_3POOL = "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7";
// Fixed future timestamp (2030-01-01T00:00:00Z) keeps calldata deterministic.
const DEADLINE = "1893456000";
const DEADLINE_MAX = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
const SLIPPAGE_BPS = "100";
const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

// Representative Curve 1-hop USDC -> USDT route encoding (stable pool, swap_type 1).
const CURVE_ROUTE = `[${T.USDC},${CURVE_3POOL},${T.USDT},${T.ETH},${T.ETH},${T.ETH},${T.ETH},${T.ETH},${T.ETH},${T.ETH},${T.ETH}]`;
const CURVE_SWAP_PARAMS = "[[0,1,1,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]]";
const CURVE_BASE_POOLS = `[${T.ETH},${T.ETH},${T.ETH},${T.ETH},${T.ETH}]`;

// args entries are { name, value } in signature order; `value` is the literal
// passed to `cast calldata`. Types/selectors are pulled from the ABI fixtures.
const ROUTES = [
  // ---- zRouter: swap execution core, one per venue/shape ----
  {
    id: "router-swapV2-eth-to-dai-exact-in",
    contract: "zRouter",
    fn: "swapV2",
    venue: "UNI_V2",
    shape: "single-hop",
    description: "Exact-in ETH -> DAI on Uniswap V2 (explicit deadline).",
    args: [
      { name: "to", value: RECIPIENT },
      { name: "exactOut", value: "false" },
      { name: "tokenIn", value: T.ETH },
      { name: "tokenOut", value: T.DAI },
      { name: "swapAmount", value: "1000000000000000000" },
      { name: "amountLimit", value: "0" },
      { name: "deadline", value: DEADLINE },
    ],
  },
  {
    id: "router-swapV2-usdc-to-usdt-sushi-sentinel",
    contract: "zRouter",
    fn: "swapV2",
    venue: "SUSHI",
    shape: "single-hop",
    description: "Exact-in USDC -> USDT routed to SushiSwap via the deadline == type(uint256).max sentinel.",
    args: [
      { name: "to", value: RECIPIENT },
      { name: "exactOut", value: "false" },
      { name: "tokenIn", value: T.USDC },
      { name: "tokenOut", value: T.USDT },
      { name: "swapAmount", value: "1000000000" },
      { name: "amountLimit", value: "0" },
      { name: "deadline", value: DEADLINE_MAX },
    ],
  },
  {
    id: "router-swapV2-dai-to-eth-exact-out",
    contract: "zRouter",
    fn: "swapV2",
    venue: "UNI_V2",
    shape: "single-hop",
    description: "Exact-out DAI -> ETH (swapAmount is the desired ETH out; amountLimit caps input).",
    args: [
      { name: "to", value: RECIPIENT },
      { name: "exactOut", value: "true" },
      { name: "tokenIn", value: T.DAI },
      { name: "tokenOut", value: T.ETH },
      { name: "swapAmount", value: "1000000000000000000" },
      { name: "amountLimit", value: "5000000000000000000000" },
      { name: "deadline", value: DEADLINE },
    ],
  },
  {
    id: "router-swapV3-usdc-to-weth-exact-in",
    contract: "zRouter",
    fn: "swapV3",
    venue: "UNI_V3",
    shape: "single-hop",
    description: "Exact-in USDC -> WETH on Uniswap V3, 0.30% fee tier.",
    args: [
      { name: "to", value: RECIPIENT },
      { name: "exactOut", value: "false" },
      { name: "swapFee", value: "3000" },
      { name: "tokenIn", value: T.USDC },
      { name: "tokenOut", value: T.WETH },
      { name: "swapAmount", value: "1000000000" },
      { name: "amountLimit", value: "0" },
      { name: "deadline", value: DEADLINE },
    ],
  },
  {
    id: "router-swapV4-weth-to-usdc-exact-in",
    contract: "zRouter",
    fn: "swapV4",
    venue: "UNI_V4",
    shape: "single-hop",
    description: "Exact-in WETH -> USDC on Uniswap V4, 0.05% fee tier, tick spacing 10.",
    args: [
      { name: "to", value: RECIPIENT },
      { name: "exactOut", value: "false" },
      { name: "swapFee", value: "500" },
      { name: "tickSpace", value: "10" },
      { name: "tokenIn", value: T.WETH },
      { name: "tokenOut", value: T.USDC },
      { name: "swapAmount", value: "1000000000000000000" },
      { name: "amountLimit", value: "0" },
      { name: "deadline", value: DEADLINE },
    ],
  },
  {
    id: "router-swapVZ-usdc-to-usdt-exact-in",
    contract: "zRouter",
    fn: "swapVZ",
    venue: "ZAMM",
    shape: "single-hop",
    description: "Exact-in USDC -> USDT on a zAMM precision pool using ERC-20 ids (idIn == idOut == 0).",
    args: [
      { name: "to", value: RECIPIENT },
      { name: "exactOut", value: "false" },
      { name: "feeOrHook", value: "3000" },
      { name: "tokenIn", value: T.USDC },
      { name: "tokenOut", value: T.USDT },
      { name: "idIn", value: "0" },
      { name: "idOut", value: "0" },
      { name: "swapAmount", value: "1000000000" },
      { name: "amountLimit", value: "0" },
      { name: "deadline", value: DEADLINE },
    ],
  },
  {
    id: "router-swapCurve-usdc-to-usdt-exact-in",
    contract: "zRouter",
    fn: "swapCurve",
    venue: "CURVE",
    shape: "single-hop",
    description: "Exact-in USDC -> USDT single-hop Curve stable swap (representative route/param encoding).",
    args: [
      { name: "to", value: RECIPIENT },
      { name: "exactOut", value: "false" },
      { name: "route", value: CURVE_ROUTE },
      { name: "swapParams", value: CURVE_SWAP_PARAMS },
      { name: "basePools", value: CURVE_BASE_POOLS },
      { name: "swapAmount", value: "1000000000" },
      { name: "amountLimit", value: "0" },
      { name: "deadline", value: DEADLINE },
    ],
  },
  {
    id: "router-snwap-usdc-to-weth-executor",
    contract: "zRouter",
    fn: "snwap",
    venue: "EXECUTOR",
    shape: "single-hop",
    description: "Generic executor swap USDC -> WETH (e.g. Bitgetol forwarder) via safeExecutor.",
    args: [
      { name: "tokenIn", value: T.USDC },
      { name: "amountIn", value: "1000000000" },
      { name: "recipient", value: RECIPIENT },
      { name: "tokenOut", value: T.WETH },
      { name: "amountOutMin", value: "0" },
      { name: "executor", value: BITGETOL_EXECUTOR },
      { name: "executorData", value: "0x" },
    ],
  },
  // ---- zRouter: native / wrapped ----
  {
    id: "router-wrap-eth",
    contract: "zRouter",
    fn: "wrap",
    venue: "WETH_WRAP",
    shape: "single-hop",
    description: "Wrap 1 ETH into WETH.",
    args: [{ name: "amount", value: "1000000000000000000" }],
  },
  {
    id: "router-unwrap-weth",
    contract: "zRouter",
    fn: "unwrap",
    venue: "WETH_WRAP",
    shape: "single-hop",
    description: "Unwrap 1 WETH into ETH.",
    args: [{ name: "amount", value: "1000000000000000000" }],
  },
  // ---- zRouter: non-swap extensions (encoding preserved for parity) ----
  {
    id: "router-revealName-extension",
    contract: "zRouter",
    fn: "revealName",
    venue: "—",
    shape: "extension",
    description: "NameNFT .wei reveal (Ethereum-only extension); chained after a swap via multicall.",
    args: [
      { name: "label", value: '"setwise"' },
      { name: "innerSecret", value: "0x1111111111111111111111111111111111111111111111111111111111111111" },
      { name: "to", value: RECIPIENT },
    ],
  },
  {
    id: "router-addLiquidity-extension",
    contract: "zRouter",
    fn: "addLiquidity",
    venue: "ZAMM",
    shape: "extension",
    description: "zAMM liquidity mint (not a swap); poolKey tuple encoding preserved for parity.",
    args: [
      { name: "poolKey", value: `(0,0,${T.USDC},${T.USDT},3000)` },
      { name: "amount0Desired", value: "1000000000" },
      { name: "amount1Desired", value: "1000000000" },
      { name: "amount0Min", value: "0" },
      { name: "amount1Min", value: "0" },
      { name: "to", value: RECIPIENT },
      { name: "deadline", value: DEADLINE },
    ],
  },
  // ---- zQuoter: route discovery, one per shape ----
  {
    id: "quoter-getQuotes-eth-to-dai",
    contract: "zQuoter",
    fn: "getQuotes",
    venue: "ALL",
    shape: "discovery",
    description: "All-venue exact-in quote discovery ETH -> DAI.",
    args: [
      { name: "exactOut", value: "false" },
      { name: "tokenIn", value: T.ETH },
      { name: "tokenOut", value: T.DAI },
      { name: "swapAmount", value: "1000000000000000000" },
    ],
  },
  {
    id: "quoter-buildBestSwap-eth-to-wbtc",
    contract: "zQuoter",
    fn: "buildBestSwap",
    venue: "ALL",
    shape: "single-hop",
    description: "Best single-hop exact-in route ETH -> WBTC.",
    args: [
      { name: "to", value: RECIPIENT },
      { name: "exactOut", value: "false" },
      { name: "tokenIn", value: T.ETH },
      { name: "tokenOut", value: T.WBTC },
      { name: "swapAmount", value: "10000000000000000000" },
      { name: "slippageBps", value: SLIPPAGE_BPS },
      { name: "deadline", value: DEADLINE_MAX },
    ],
  },
  {
    id: "quoter-buildBestSwapViaETHMulticall-eth-to-wsteth",
    contract: "zQuoter",
    fn: "buildBestSwapViaETHMulticall",
    venue: "ALL",
    shape: "two-hop-hub",
    description: "Best of single-hop vs 2-hop hub route ETH -> wstETH.",
    args: [
      { name: "to", value: RECIPIENT },
      { name: "refundTo", value: RECIPIENT },
      { name: "exactOut", value: "false" },
      { name: "tokenIn", value: T.ETH },
      { name: "tokenOut", value: T.WSTETH },
      { name: "swapAmount", value: "1000000000000000000" },
      { name: "slippageBps", value: SLIPPAGE_BPS },
      { name: "deadline", value: DEADLINE_MAX },
    ],
  },
  {
    id: "quoter-build3HopMulticall-usdt-to-wbtc",
    contract: "zQuoter",
    fn: "build3HopMulticall",
    venue: "ALL",
    shape: "three-hop",
    description: "3-hop exact-in route USDT -> WBTC over two hub intermediates.",
    args: [
      { name: "to", value: RECIPIENT },
      { name: "exactOut", value: "false" },
      { name: "tokenIn", value: T.USDT },
      { name: "tokenOut", value: T.WBTC },
      { name: "swapAmount", value: "1000000000" },
      { name: "slippageBps", value: SLIPPAGE_BPS },
      { name: "deadline", value: DEADLINE_MAX },
    ],
  },
  {
    id: "quoter-buildSplitSwap-usdc-to-usdt",
    contract: "zQuoter",
    fn: "buildSplitSwap",
    venue: "ALL",
    shape: "split",
    description: "Exact-in split USDC -> USDT across the top two venues.",
    args: [
      { name: "to", value: RECIPIENT },
      { name: "tokenIn", value: T.USDC },
      { name: "tokenOut", value: T.USDT },
      { name: "swapAmount", value: "1000000000" },
      { name: "slippageBps", value: SLIPPAGE_BPS },
      { name: "deadline", value: DEADLINE_MAX },
    ],
  },
  {
    id: "quoter-buildHybridSplit-eth-to-usdt",
    contract: "zQuoter",
    fn: "buildHybridSplit",
    venue: "ALL",
    shape: "hybrid-split",
    description: "Exact-in hybrid split ETH -> USDT (best direct vs best 2-hop).",
    args: [
      { name: "to", value: RECIPIENT },
      { name: "tokenIn", value: T.ETH },
      { name: "tokenOut", value: T.USDT },
      { name: "swapAmount", value: "50000000000000000000" },
      { name: "slippageBps", value: SLIPPAGE_BPS },
      { name: "deadline", value: DEADLINE_MAX },
    ],
  },
  {
    id: "quoter-buildSwapAuto-eth-to-dai",
    contract: "zQuoter",
    fn: "buildSwapAuto",
    venue: "ALL",
    shape: "auto",
    description: "Auto cascade (2-hop then 3-hop) ETH -> DAI.",
    args: [
      { name: "to", value: RECIPIENT },
      { name: "exactOut", value: "false" },
      { name: "tokenIn", value: T.ETH },
      { name: "tokenOut", value: T.DAI },
      { name: "swapAmount", value: "1000000000000000000" },
      { name: "slippageBps", value: SLIPPAGE_BPS },
      { name: "deadline", value: DEADLINE_MAX },
    ],
  },
  {
    id: "quoter-quoteCurve-usdc-to-usdt",
    contract: "zQuoter",
    fn: "quoteCurve",
    venue: "CURVE",
    shape: "single-hop",
    description: "Single-hop Curve quote USDC -> USDT.",
    args: [
      { name: "exactOut", value: "false" },
      { name: "tokenIn", value: T.USDC },
      { name: "tokenOut", value: T.USDT },
      { name: "swapAmount", value: "1000000000" },
      { name: "maxCandidates", value: "8" },
    ],
  },
  {
    id: "quoter-quoteLido-eth-to-wsteth",
    contract: "zQuoter",
    fn: "quoteLido",
    venue: "LIDO",
    shape: "single-hop",
    description: "Lido exact-in quote ETH -> wstETH (Ethereum-only).",
    args: [
      { name: "exactOut", value: "false" },
      { name: "tokenOut", value: T.WSTETH },
      { name: "swapAmount", value: "1000000000000000000" },
    ],
  },
];

function resolveCast() {
  if (process.env.CAST_BIN) return process.env.CAST_BIN;
  const which = spawnSync("command", ["-v", "cast"], { shell: true, encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  const fallback = join(process.env.HOME || "", ".foundry/bin/cast");
  return existsSync(fallback) ? fallback : null;
}

function abiFor(contract) {
  return contract === "zRouter" ? router : quoter;
}

function main() {
  const cast = resolveCast();
  if (!cast) {
    console.error("cast not found. Install Foundry from https://getfoundry.sh/");
    process.exit(1);
  }

  const fixtures = [];
  for (const route of ROUTES) {
    const abi = abiFor(route.contract);
    const fn = abi.abi.functions.find((f) => f.name === route.fn);
    if (!fn) {
      console.error(`${route.id}: ${route.fn} not in ${route.contract} ABI fixture`);
      process.exit(1);
    }
    if (fn.inputs.length !== route.args.length) {
      console.error(`${route.id}: arg count ${route.args.length} != ABI ${fn.inputs.length}`);
      process.exit(1);
    }
    const argNames = fn.inputs.map((i) => i.name);
    for (let i = 0; i < route.args.length; i++) {
      if (route.args[i].name !== argNames[i]) {
        console.error(`${route.id}: arg[${i}] named ${route.args[i].name}, ABI expects ${argNames[i]}`);
        process.exit(1);
      }
    }

    const values = route.args.map((a) => a.value);
    const res = spawnSync(cast, ["calldata", fn.signature, ...values], { encoding: "utf8" });
    if (res.status !== 0) {
      console.error(`${route.id}: cast calldata failed\n${res.stderr}`);
      process.exit(1);
    }
    const calldata = res.stdout.trim();
    if (!calldata.startsWith(fn.selector)) {
      console.error(`${route.id}: calldata ${calldata.slice(0, 10)} does not start with ${fn.selector}`);
      process.exit(1);
    }

    fixtures.push({
      id: route.id,
      contract: route.contract,
      description: route.description,
      venue: route.venue,
      shape: route.shape,
      function: route.fn,
      signature: fn.signature,
      selector: fn.selector,
      args: route.args.map((a, i) => ({ name: a.name, type: fn.inputs[i].type, value: a.value })),
      calldata,
    });
  }

  const doc = {
    schema: "setwise-router/route-calldata@1",
    upstream: {
      repository: matrix.upstream.repository,
      commit: matrix.upstream.commit,
    },
    targets: {
      zRouter: "0x000000000000FB114709235f1ccBFfb925F600e4",
      zQuoter: "stateless; deployed fresh per fork (see baseline/fork)",
    },
    notes:
      "Deterministic calldata for representative Ethereum routes, encoded from the " +
      "pinned ABI via `cast calldata`. Regenerate with scripts/build-route-fixtures.mjs. " +
      "test/abi-baseline.test.js re-encodes each entry and fails on any drift.",
    routes: fixtures,
  };

  mkdirSync(routesDir, { recursive: true });
  writeFileSync(join(routesDir, "calldata.json"), `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote baseline/routes/calldata.json (${fixtures.length} routes)`);
}

main();

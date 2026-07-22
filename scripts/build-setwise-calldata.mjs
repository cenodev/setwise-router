import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const abiDir = join(root, "baseline", "abi");
const setwiseDir = join(root, "baseline", "setwise");

const pool = JSON.parse(readFileSync(join(abiDir, "setwisePool.json"), "utf8"));

const T = {
  NATIVE: "0x0000000000000000000000000000000000000000",
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
};

// Deterministic stand-ins so the fixtures are reproducible without a live RFQ
// service or signer key. The signature is a correctly-sized (65-byte)
// placeholder; these fixtures assert ABI encoding, not signature validity.
const POOL_PROXY = "0x5e7151DeF0a13C29CA4d3a16b13B6b4a4d6a3a29";
const RECIPIENT = "0x000000000000000000000000000000000000bEEF";
const DEADLINE = "1893456000"; // 2030-01-01T00:00:00Z, keeps calldata deterministic
const SIG = `0x${"aa".repeat(32)}${"bb".repeat(32)}1c`; // r || s || v (65 bytes)
const AUX_EMPTY = "0x";
const AUX_RFQ = "0x726671"; // "rfq"

// args entries are { name, value } in signature order; `value` is the literal
// passed to `cast calldata`. `quote` records the canonical assets the EIP-712
// SwapQuote binds (native legs normalized to WETH); `value` is msg.value.
const ROUTES = [
  {
    id: "setwise-erc20-to-erc20-usdc-to-weth",
    fn: "swapExactAssetForAsset",
    assetMode: "erc20-to-erc20",
    description: "Exact fixed ERC-20 -> ERC-20: 1000 USDC for 0.5 WETH.",
    value: "0",
    quote: { inputAsset: T.USDC, outputAsset: T.WETH, inputAmount: "1000000000", outputAmount: "500000000000000000" },
    args: [
      { name: "inputAsset", value: T.USDC },
      { name: "outputAsset", value: T.WETH },
      { name: "inputAmount", value: "1000000000" },
      { name: "outputAmount", value: "500000000000000000" },
      { name: "quoteId", value: `0x${"11".repeat(32)}` },
      { name: "deadline", value: DEADLINE },
      { name: "recipient", value: RECIPIENT },
      { name: "signature", value: SIG },
      { name: "auxiliaryData", value: AUX_EMPTY },
    ],
  },
  {
    id: "setwise-native-to-erc20-eth-to-usdc",
    fn: "swapExactNativeForAsset",
    assetMode: "native-to-erc20",
    description:
      "Exact fixed native -> ERC-20: 1 ETH (msg.value) for 2000 USDC. The signed quote names WETH as the input asset.",
    value: "1000000000000000000",
    quote: { inputAsset: T.WETH, outputAsset: T.USDC, inputAmount: "1000000000000000000", outputAmount: "2000000000" },
    args: [
      { name: "outputAsset", value: T.USDC },
      { name: "inputAmount", value: "1000000000000000000" },
      { name: "outputAmount", value: "2000000000" },
      { name: "quoteId", value: `0x${"22".repeat(32)}` },
      { name: "deadline", value: DEADLINE },
      { name: "recipient", value: RECIPIENT },
      { name: "signature", value: SIG },
      { name: "auxiliaryData", value: AUX_RFQ },
    ],
  },
  {
    id: "setwise-erc20-to-native-usdc-to-eth",
    fn: "swapExactAssetForNative",
    assetMode: "erc20-to-native",
    description:
      "Exact fixed ERC-20 -> native: 2000 USDC for 1 ETH. The signed quote names WETH as the output asset; the pool unwraps to the recipient.",
    value: "0",
    quote: { inputAsset: T.USDC, outputAsset: T.WETH, inputAmount: "2000000000", outputAmount: "1000000000000000000" },
    args: [
      { name: "inputAsset", value: T.USDC },
      { name: "inputAmount", value: "2000000000" },
      { name: "outputAmount", value: "1000000000000000000" },
      { name: "quoteId", value: `0x${"33".repeat(32)}` },
      { name: "deadline", value: DEADLINE },
      { name: "recipient", value: RECIPIENT },
      { name: "signature", value: SIG },
      { name: "auxiliaryData", value: AUX_RFQ },
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

function main() {
  const cast = resolveCast();
  if (!cast) {
    console.error("cast not found. Install Foundry from https://getfoundry.sh/");
    process.exit(1);
  }

  const fixtures = [];
  for (const route of ROUTES) {
    const fn = pool.abi.functions.find((f) => f.name === route.fn);
    if (!fn) {
      console.error(`${route.id}: ${route.fn} not in ISetwisePool ABI fixture`);
      process.exit(1);
    }
    if (fn.assetMode !== route.assetMode) {
      console.error(`${route.id}: assetMode ${route.assetMode} != ABI ${fn.assetMode}`);
      process.exit(1);
    }
    if (fn.inputs.length !== route.args.length) {
      console.error(`${route.id}: arg count ${route.args.length} != ABI ${fn.inputs.length}`);
      process.exit(1);
    }
    for (let i = 0; i < route.args.length; i++) {
      if (route.args[i].name !== fn.inputs[i].name) {
        console.error(`${route.id}: arg[${i}] named ${route.args[i].name}, ABI expects ${fn.inputs[i].name}`);
        process.exit(1);
      }
    }
    const expectsValue = fn.stateMutability === "payable";
    if (expectsValue && route.value === "0") {
      console.error(`${route.id}: payable entry point must carry a non-zero msg.value`);
      process.exit(1);
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
      contract: pool.contract,
      description: route.description,
      assetMode: route.assetMode,
      function: route.fn,
      signature: fn.signature,
      selector: fn.selector,
      value: route.value,
      quote: route.quote,
      args: route.args.map((a, i) => ({ name: a.name, type: fn.inputs[i].type, value: a.value })),
      calldata,
    });
  }

  const doc = {
    schema: "setwise-router/setwise-calldata@1",
    upstream: {
      repository: pool.upstream.repository,
      paths: pool.upstream.paths,
    },
    targets: {
      pool: POOL_PROXY,
      payer: "msg.sender (the Setwise Router); bound as `payer` in the EIP-712 SwapQuote",
    },
    notes:
      "Deterministic calldata for the three Setwise settlement modes, encoded from the " +
      "ISetwisePool ABI via `cast calldata`. `quote` shows the canonical assets the " +
      "EIP-712 SwapQuote binds: a native leg is normalized to WRAPPED_NATIVE_TOKEN (WETH " +
      "here), never address(0). Signatures are sized placeholders. Regenerate with " +
      "scripts/build-setwise-calldata.mjs; test/setwise-pool.test.js re-encodes each entry.",
    routes: fixtures,
  };

  mkdirSync(setwiseDir, { recursive: true });
  writeFileSync(join(setwiseDir, "calldata.json"), `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote baseline/setwise/calldata.json (${fixtures.length} routes)`);
}

main();

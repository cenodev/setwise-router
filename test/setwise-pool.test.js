import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "contracts", "out");

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".toLowerCase();
const NATIVE_SENTINEL = "0x0000000000000000000000000000000000000000";
const SELECTOR_RE = /^0x[0-9a-f]{8}$/;
const TOPIC_RE = /^0x[0-9a-f]{64}$/;

// Selectors / topic / typehash captured from the deployed SetwisePoolBase and
// SetwisePool swap surface (cenodev/setwise-contracts). The fixture and the
// compiled interface must both reproduce these exactly.
const DEPLOYED_SELECTORS = {
  "swapExactAssetForAsset(address,address,uint256,uint256,bytes32,uint256,address,bytes,bytes)": "0x24266baa",
  "swapExactNativeForAsset(address,uint256,uint256,bytes32,uint256,address,bytes,bytes)": "0xdcf8b279",
  "swapExactAssetForNative(address,uint256,uint256,bytes32,uint256,address,bytes,bytes)": "0x695d9b7f",
  "QUOTE_SIGNER()": "0xd0e15ba4",
  "WRAPPED_NATIVE_TOKEN()": "0x1b3f8c5e",
  "usedQuoteIds(bytes32)": "0x03ea8003",
  "isSupportedAsset(address)": "0x9be918e6",
  "quoteDomainSeparator()": "0x7102ae2a",
  "recordedBalance(address)": "0x5089331d",
};
const DEPLOYED_SWAP_TOPIC = "0xa2fe6ab887b4a569b99c1b733c36e55e75e395f7aee85044820ab8155716c9e6";
const DEPLOYED_TYPEHASH = "0x05f457dcd915199b3c456f83a601d28b8a9c57b952c20f6b13c56eec1b203c13";
const SWAP_ENTRY_POINTS = new Set([
  "swapExactAssetForAsset",
  "swapExactNativeForAsset",
  "swapExactAssetForNative",
]);
const MODE_BY_FUNCTION = {
  swapExactAssetForAsset: "erc20-to-erc20",
  swapExactNativeForAsset: "native-to-erc20",
  swapExactAssetForNative: "erc20-to-native",
};

const pool = JSON.parse(readFileSync(join(root, "baseline/abi/setwisePool.json"), "utf8"));
const calldata = JSON.parse(readFileSync(join(root, "baseline/setwise/calldata.json"), "utf8"));

// --- canonicalization (mirrors scripts/build-setwise-abi.mjs) ---

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

function digestFromFixture(record) {
  return {
    functions: record.abi.functions
      .map((f) => ({
        signature: f.signature,
        selector: f.selector,
        stateMutability: f.stateMutability,
        inputs: f.inputs,
        outputs: f.outputs,
      }))
      .sort((a, b) => a.selector.localeCompare(b.selector)),
    events: record.abi.events.map((e) => e.signature).sort(),
    errors: record.abi.errors.map((e) => e.signature).sort(),
  };
}

function digestFromArtifact() {
  const artifact = JSON.parse(readFileSync(join(outDir, "ISetwisePool.sol", "ISetwisePool.json"), "utf8"));
  const functions = [];
  const events = [];
  const errors = [];
  for (const entry of artifact.abi) {
    if (entry.type === "function") {
      const signature = canonSignature(entry.name, entry.inputs);
      const selector = artifact.methodIdentifiers[signature];
      assert.ok(selector, `artifact missing methodIdentifier for ISetwisePool.${signature}`);
      functions.push({
        signature,
        selector: `0x${selector}`,
        stateMutability: entry.stateMutability,
        inputs: (entry.inputs || []).map(stripInternal),
        outputs: (entry.outputs || []).map(stripInternal),
      });
    } else if (entry.type === "event") {
      events.push(canonSignature(entry.name, entry.inputs));
    } else if (entry.type === "error") {
      errors.push(canonSignature(entry.name, entry.inputs));
    }
  }
  functions.sort((a, b) => a.selector.localeCompare(b.selector));
  events.sort();
  errors.sort();
  return { functions, events, errors };
}

function resolveCast() {
  if (process.env.CAST_BIN) return process.env.CAST_BIN;
  const which = spawnSync("command", ["-v", "cast"], { shell: true, encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  const fallback = join(process.env.HOME || "", ".foundry/bin/cast");
  return existsSync(fallback) ? fallback : null;
}

// ---------------------------------------------------------------------------
// 1. Fixture integrity and parity with the deployed pool ABI
// ---------------------------------------------------------------------------

test("setwisePool fixture is well-formed and matches the deployed selectors", () => {
  assert.equal(pool.interface, true, "ISetwisePool is an interface (no bytecode)");
  const seen = new Set();
  for (const fn of pool.abi.functions) {
    assert.match(fn.selector, SELECTOR_RE, `${fn.name} selector format`);
    assert.ok(!seen.has(fn.selector), `duplicate selector ${fn.selector}`);
    seen.add(fn.selector);
    assert.equal(fn.signature, canonSignature(fn.name, fn.inputs), `${fn.name} canonical signature`);
    assert.equal(fn.selector, DEPLOYED_SELECTORS[fn.signature], `${fn.name} matches deployed selector`);
    if (SWAP_ENTRY_POINTS.has(fn.name)) {
      assert.equal(fn.group, "swap", `${fn.name} grouped as swap`);
      assert.equal(fn.assetMode, MODE_BY_FUNCTION[fn.name], `${fn.name} asset mode`);
    }
  }
  assert.equal(Object.keys(DEPLOYED_SELECTORS).length, pool.abi.functions.length, "no extra/missing functions");

  const swap = pool.abi.events.find((e) => e.name === "SwapExecuted");
  assert.ok(swap, "SwapExecuted event present");
  assert.equal(swap.topicHash, DEPLOYED_SWAP_TOPIC, "SwapExecuted topic matches deployed");
  for (const ev of pool.abi.events) assert.match(ev.topicHash, TOPIC_RE, `${ev.name} topic format`);
  for (const er of pool.abi.errors) assert.match(er.selector, SELECTOR_RE, `${er.name} error selector`);

  // Only the native-input entry point is payable.
  for (const fn of pool.abi.functions) {
    const shouldBePayable = fn.name === "swapExactNativeForAsset";
    assert.equal(fn.stateMutability === "payable", shouldBePayable, `${fn.name} mutability`);
  }
});

test("EIP-712 SwapQuote typehash matches the deployed pool", () => {
  assert.equal(pool.eip712.swapQuoteTypehash, DEPLOYED_TYPEHASH, "SwapQuote typehash");
  assert.match(
    pool.eip712.swapQuoteType,
    /^SwapQuote\(address payer,address inputAsset,address outputAsset,uint256 inputAmount,uint256 outputAmount,bytes32 quoteId,uint256 deadline,address recipient\)$/,
    "SwapQuote type string",
  );
});

// ---------------------------------------------------------------------------
// 2. Drift: committed fixture must match the freshly compiled interface
// ---------------------------------------------------------------------------

test("setwisePool fixture matches the compiled interface artifact", (t) => {
  const artifact = join(outDir, "ISetwisePool.sol", "ISetwisePool.json");
  if (!existsSync(artifact)) {
    t.skip("contracts/out missing; run `node scripts/build-setwise-abi.mjs` to enable the drift check");
    return;
  }
  assert.deepEqual(digestFromFixture(pool), digestFromArtifact(), "ISetwisePool ABI drifted from fixture");
});

// ---------------------------------------------------------------------------
// 3. RFQ-API calldata fixtures: consistent, normalized, byte-exact
// ---------------------------------------------------------------------------

test("setwise calldata fixtures are consistent with the ABI baseline", () => {
  const fnByName = Object.fromEntries(pool.abi.functions.map((f) => [f.name, f]));
  const modes = new Set();
  for (const route of calldata.routes) {
    const fn = fnByName[route.function];
    assert.ok(fn, `${route.id}: ${route.function} not in ISetwisePool ABI`);
    assert.equal(route.signature, fn.signature, `${route.id} signature`);
    assert.equal(route.selector, fn.selector, `${route.id} selector`);
    assert.equal(route.assetMode, fn.assetMode, `${route.id} asset mode`);
    assert.equal(route.assetMode, MODE_BY_FUNCTION[route.function], `${route.id} mode/function alignment`);
    modes.add(route.assetMode);
    assert.ok(route.calldata.startsWith(fn.selector), `${route.id} calldata selector prefix`);
    assert.equal(route.args.length, fn.inputs.length, `${route.id} arg count`);
    route.args.forEach((arg, i) => {
      assert.equal(arg.name, fn.inputs[i].name, `${route.id} arg[${i}] name`);
      assert.equal(arg.type, fn.inputs[i].type, `${route.id} arg[${i}] type`);
    });

    // Payable entry point carries the native input as msg.value, not an arg.
    if (fn.stateMutability === "payable") {
      assert.notEqual(route.value, "0", `${route.id} payable route must attach msg.value`);
      assert.ok(!route.args.some((a) => a.name === "inputAsset"), `${route.id} native-in has no inputAsset arg`);
    } else {
      assert.equal(route.value, "0", `${route.id} non-payable route attaches no value`);
    }
  }
  // All three settlement modes are covered.
  assert.deepEqual([...modes].sort(), ["erc20-to-erc20", "erc20-to-native", "native-to-erc20"], "mode coverage");
});

test("native legs are normalized to wrapped-native in the signed quote", () => {
  for (const route of calldata.routes) {
    assert.notEqual(route.quote.inputAsset.toLowerCase(), NATIVE_SENTINEL, `${route.id} quote input not sentinel`);
    assert.notEqual(route.quote.outputAsset.toLowerCase(), NATIVE_SENTINEL, `${route.id} quote output not sentinel`);
    if (route.assetMode === "native-to-erc20") {
      assert.equal(route.quote.inputAsset.toLowerCase(), WETH, `${route.id} native-in quote asset is wrapped-native`);
      assert.equal(route.quote.inputAmount, route.value, `${route.id} msg.value equals signed input amount`);
    }
    if (route.assetMode === "erc20-to-native") {
      assert.equal(route.quote.outputAsset.toLowerCase(), WETH, `${route.id} native-out quote asset is wrapped-native`);
    }
    // The signed amounts agree with the calldata args.
    const inArg = route.args.find((a) => a.name === "inputAmount");
    const outArg = route.args.find((a) => a.name === "outputAmount");
    assert.equal(inArg.value, route.quote.inputAmount, `${route.id} inputAmount`);
    assert.equal(outArg.value, route.quote.outputAmount, `${route.id} outputAmount`);
  }
});

test("setwise calldata fixtures re-encode byte-for-byte via cast", (t) => {
  const cast = resolveCast();
  if (!cast) {
    t.skip("cast not found; skipping calldata re-encode check");
    return;
  }
  for (const route of calldata.routes) {
    const res = spawnSync(cast, ["calldata", route.signature, ...route.args.map((a) => a.value)], {
      encoding: "utf8",
    });
    assert.equal(res.status, 0, `${route.id}: cast calldata failed: ${res.stderr}`);
    assert.equal(res.stdout.trim(), route.calldata, `${route.id}: calldata drifted`);
  }
});

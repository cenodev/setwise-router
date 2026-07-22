import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  MULTICALL3_AGGREGATE3_SELECTOR,
  decodeAggregate3,
  decodeQuoterResult,
  encodeAggregate3,
  encodeAggregate3Result,
  encodeQuoterCall,
  quoterErrorName,
  quoterFunction,
  quoterFunctionNames,
  quoterSelector,
} from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const calldata = JSON.parse(readFileSync(join(root, "baseline/routes/calldata.json"), "utf8"));
const execution = JSON.parse(readFileSync(join(root, "baseline/routes/execution.json"), "utf8"));
const quoterAbi = JSON.parse(readFileSync(join(root, "baseline/abi/zQuoter.json"), "utf8"));

function capture(id) {
  const found = execution.captures.find((c) => c.id === id);
  assert.ok(found, `missing execution capture ${id}`);
  return found;
}

function argValue(arg) {
  if (arg.type === "bool") return arg.value === "true";
  return arg.value;
}

test("quoter selectors come from the pinned ABI baseline", () => {
  for (const fn of quoterAbi.abi.functions) {
    assert.equal(quoterSelector(fn.name), fn.selector, `${fn.name} selector`);
    assert.equal(quoterFunction(fn.name).signature, fn.signature, `${fn.name} signature`);
  }
  assert.ok(quoterFunctionNames().includes("buildBestSwap"));
  assert.throws(() => quoterFunction("doesNotExist"), /unknown zQuoter function/);
});

test("re-encodes every quoter route fixture byte-for-byte without cast", () => {
  const quoterRoutes = calldata.routes.filter((r) => r.contract === "zQuoter");
  assert.ok(quoterRoutes.length >= 7, "expected the full quoter route shape set");
  const shapes = new Set(quoterRoutes.map((r) => r.shape));
  for (const expected of ["single-hop", "two-hop-hub", "three-hop", "split", "hybrid-split", "auto", "discovery"]) {
    assert.ok(shapes.has(expected), `missing route shape ${expected}`);
  }
  for (const route of quoterRoutes) {
    const encoded = encodeQuoterCall(route.function, route.args.map(argValue));
    assert.equal(encoded, route.calldata, `${route.id} calldata drifted`);
  }
});

test("decodes the buildBestSwap fixture into route evidence", () => {
  const cap = capture("quoter-buildBestSwap-usdc-to-usdt");
  const decoded = decodeQuoterResult("buildBestSwap", cap.returnData);
  assert.equal(decoded.best.source, String(cap.source));
  assert.equal(decoded.best.feeBps, String(cap.feeBps));
  assert.equal(decoded.best.amountIn, cap.amountIn);
  assert.equal(decoded.best.amountOut, cap.amountOut);
  assert.equal(decoded.amountLimit, cap.amountLimit);
  assert.equal(decoded.msgValue, cap.msgValue);
  // The executable calldata targets the router's V3 swap entry point.
  assert.ok(decoded.callData.startsWith("0xafeae12b"), "expected swapV3 router calldata");
});

test("decodes the exact-in buildBestSwap ETH route with native value", () => {
  const cap = capture("quoter-buildBestSwap-eth-to-wbtc");
  const decoded = decodeQuoterResult("buildBestSwap", cap.returnData);
  assert.equal(decoded.best.amountIn, cap.amountIn);
  assert.equal(decoded.best.amountOut, cap.amountOut);
  assert.equal(decoded.amountLimit, cap.amountLimit);
  assert.equal(decoded.msgValue, cap.msgValue);
  assert.equal(decoded.msgValue, cap.amountIn, "native input forwards swap amount as msg.value");
});

test("decodes the all-venue getQuotes discovery fixture", () => {
  const cap = capture("quoter-getQuotes-eth-to-dai");
  const decoded = decodeQuoterResult("getQuotes", cap.returnData);
  assert.equal(decoded.best.source, String(cap.source));
  assert.equal(decoded.best.amountIn, cap.amountIn);
  assert.equal(decoded.best.amountOut, cap.amountOut);
  assert.ok(Array.isArray(decoded.quotes) && decoded.quotes.length > 1, "expected multiple venue quotes");
  for (const quote of decoded.quotes) {
    assert.ok(["source", "feeBps", "amountIn", "amountOut"].every((k) => k in quote));
  }
});

test("decodes the Lido quote fixture (Ethereum-only capability)", () => {
  const cap = capture("quoter-quoteLido-eth-to-wsteth");
  const decoded = decodeQuoterResult("quoteLido", cap.returnData);
  assert.equal(decoded.amountIn, "1000000000000000000");
  assert.ok(BigInt(decoded.amountOut) > 0n);
});

test("maps recorded revert selectors to ABI error names", () => {
  assert.equal(quoterErrorName("0x6586e129"), "NoRoute");
  assert.equal(quoterErrorName("0x982c96c6"), "SlippageBpsTooHigh");
  assert.equal(quoterErrorName("0xdeadbeef"), null);
});

test("aggregate3 batching round-trips per-call success and failure", () => {
  const okReturn = capture("quoter-buildBestSwap-usdc-to-usdt").returnData;
  const calls = [
    { target: "0x5aAdFB43eF8dAF45DD80F4676345b7676f1D70e3", allowFailure: true, callData: encodeQuoterCall("buildBestSwap", ["0x000000000000000000000000000000000000bEEF", false, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "0xdAC17F958D2ee523a2206206994597C13D831ec7", "1000000000", "100", "1893456000"]) },
    { target: "0x5aAdFB43eF8dAF45DD80F4676345b7676f1D70e3", allowFailure: true, callData: "0xe1fd10bc" },
  ];
  const encoded = encodeAggregate3(calls);
  assert.ok(encoded.startsWith(MULTICALL3_AGGREGATE3_SELECTOR), "aggregate3 selector prefix");

  const results = [
    { success: true, returnData: okReturn },
    { success: false, returnData: "0x6586e129" },
  ];
  const decoded = decodeAggregate3(encodeAggregate3Result(results));
  assert.equal(decoded.length, 2);
  assert.equal(decoded[0].success, true);
  assert.equal(decoded[0].returnData, okReturn);
  assert.equal(decoded[1].success, false);
  assert.equal(decoded[1].returnData, "0x6586e129");
  // The successful leg still decodes through the quoter ABI.
  assert.equal(decodeQuoterResult("buildBestSwap", decoded[0].returnData).best.amountOut, "999335336");
});

test("aggregate3 result coding preserves empty return data", () => {
  const decoded = decodeAggregate3(
    encodeAggregate3Result([{ success: false, returnData: "0x" }]),
  );
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].success, false);
  assert.equal(decoded[0].returnData, "0x");
});

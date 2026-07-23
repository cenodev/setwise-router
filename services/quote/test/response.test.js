import assert from "node:assert/strict";
import test from "node:test";

import { getChainConfig } from "../../../config/index.mjs";
import {
  MockQuoteAdapter,
  QUOTE_ERROR_CODES,
  QuoteSchemaError,
  assembleQuoteResponse,
  decodeAggregate3Calls,
  encodeAggregate3Result,
  encodeQuoterResult,
  quoterSelector,
  runQuote,
  selectBestSource,
} from "../src/index.js";
import { ZfiQuoteAdapter } from "../src/zfi-adapter.js";

const NOW = "2026-07-22T20:00:00.000Z";
const now = () => NOW;

const address = (suffix) => `0x${suffix.padStart(40, "0")}`;
const scoped = (chainId, suffix) => ({ chainId, address: address(suffix) });

function request(overrides = {}) {
  return {
    apiVersion: "v1",
    chainId: 8453,
    tokenIn: scoped(8453, "11"),
    tokenOut: scoped(8453, "22"),
    router: scoped(8453, "33"),
    mode: "exact-input",
    amount: "1000000",
    recipient: scoped(8453, "44"),
    funder: scoped(8453, "55"),
    slippage: { maxBps: 50 },
    ...overrides,
  };
}

function evidence(overrides = {}) {
  return {
    kind: "onchain",
    observedAt: NOW,
    reference: "base:123456",
    blockNumber: "123456",
    ...overrides,
  };
}

function quote(kind, amounts, overrides = {}) {
  return {
    kind,
    amounts,
    gas: { estimatedUnits: "180000", estimatedCost: "24000000000000" },
    fees: [],
    approvalTarget: kind === "firm" ? scoped(8453, "33") : null,
    expiresAt: kind === "firm" ? "2026-07-22T20:01:00.000Z" : null,
    ...overrides,
  };
}

function available(id, amounts, overrides = {}) {
  return {
    source: { id, type: "zfi", displayName: id.toUpperCase() },
    status: "available",
    quote: quote("indicative", amounts),
    evidence: [evidence({ reference: `${id}:test` })],
    ...overrides,
  };
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof QuoteSchemaError);
    assert.equal(error.code, code);
    return true;
  });
}

test("selectBestSource ranks exact-input routes by highest output", () => {
  const sources = [
    available("low", { input: "1000000", output: "2400000", limit: "2388000" }),
    available("high", { input: "1000000", output: "2600000", limit: "2587000" }),
    available("mid", { input: "1000000", output: "2500000", limit: "2487500" }),
  ];
  assert.equal(selectBestSource(sources, "exact-input"), "high");
});

test("selectBestSource ranks exact-output routes by lowest input", () => {
  const sources = [
    available("expensive", { input: "1200000", output: "2500000", limit: "1206000" }),
    available("cheapest", { input: "1000000", output: "2500000", limit: "1005000" }),
    available("middle", { input: "1100000", output: "2500000", limit: "1105500" }),
  ];
  assert.equal(selectBestSource(sources, "exact-output"), "cheapest");
});

test("selectBestSource breaks ties deterministically by source id", () => {
  const tied = [
    available("zeta", { input: "1000000", output: "2500000", limit: "2487500" }),
    available("alpha", { input: "1000000", output: "2500000", limit: "2487500" }),
  ];
  assert.equal(selectBestSource(tied, "exact-input"), "alpha");
  assert.equal(selectBestSource([...tied].reverse(), "exact-input"), "alpha");
});

test("selectBestSource ignores unavailable sources and returns null when none qualify", () => {
  const none = [
    { source: { id: "dry", type: "zfi", displayName: "Dry" }, status: "unavailable", quote: null, evidence: [evidence({ kind: "http", reference: "dry:test" })] },
    { source: { id: "broken", type: "aggregator", displayName: "Broken" }, status: "failed", quote: null, evidence: [evidence({ kind: "http", reference: "broken:test" })] },
  ];
  assert.equal(selectBestSource(none, "exact-input"), null);
  assert.equal(selectBestSource([], "exact-input"), null);
});

test("assembleQuoteResponse builds a schema-valid indicative response", () => {
  const sources = [available("zfi", { input: "1000000", output: "2500000", limit: "2487500" })];
  const response = assembleQuoteResponse({
    request: request(),
    sources,
    kind: "indicative",
    requestId: "req_assemble",
  });
  assert.equal(response.apiVersion, "v1");
  assert.equal(response.kind, "indicative");
  assert.equal(response.selectedSourceId, "zfi");
  assert.equal(response.transaction, null, "indicative responses carry no transaction");
  assert.equal(response.sources[0].quote.amounts.input, "1000000");
});

test("assembleQuoteResponse lifts the selected source transaction for firm quotes", () => {
  const sources = [
    {
      source: { id: "zfi", type: "zfi", displayName: "ZFi" },
      status: "available",
      quote: quote("firm", { input: "1000000", output: "2500000", limit: "2487500" }),
      evidence: [evidence()],
    },
  ];
  const transaction = { chainId: 8453, to: address("33"), calldata: "0x1234", value: "0" };
  const response = assembleQuoteResponse({
    request: request(),
    sources,
    kind: "firm",
    requestId: "req_firm",
    transactions: { zfi: transaction },
  });
  assert.equal(response.selectedSourceId, "zfi");
  assert.deepEqual(response.transaction, transaction);
});

test("assembleQuoteResponse rejects a firm quote with no selectable source", () => {
  const sources = [
    { source: { id: "dry", type: "zfi", displayName: "Dry" }, status: "unavailable", quote: null, evidence: [evidence({ kind: "http", reference: "dry:test" })] },
  ];
  expectCode(
    () => assembleQuoteResponse({ request: request(), sources, kind: "firm", requestId: "req_firm" }),
    QUOTE_ERROR_CODES.AMBIGUOUS_EXECUTION,
  );
});

test("assembleQuoteResponse rejects a firm quote whose selected source has no transaction", () => {
  const sources = [
    {
      source: { id: "zfi", type: "zfi", displayName: "ZFi" },
      status: "available",
      quote: quote("firm", { input: "1000000", output: "2500000", limit: "2487500" }),
      evidence: [evidence()],
    },
  ];
  expectCode(
    () => assembleQuoteResponse({ request: request(), sources, kind: "firm", requestId: "req_firm" }),
    QUOTE_ERROR_CODES.AMBIGUOUS_EXECUTION,
  );
});

test("assembleQuoteResponse preserves selected and rejected route evidence", () => {
  const sources = [
    available("zfi", { input: "1000000", output: "2500000", limit: "2487500" }),
    {
      source: { id: "zeroex", type: "aggregator", displayName: "0x" },
      status: "unavailable",
      quote: null,
      evidence: [evidence({ kind: "http", reference: "zeroex:no-liquidity", code: "NO_LIQUIDITY", message: "no route" })],
    },
  ];
  const response = assembleQuoteResponse({
    request: request(),
    sources,
    kind: "indicative",
    requestId: "req_mixed",
  });
  assert.equal(response.selectedSourceId, "zfi");
  const byId = Object.fromEntries(response.sources.map((s) => [s.source.id, s]));
  assert.equal(byId.zfi.status, "available");
  assert.equal(byId.zeroex.status, "unavailable");
  assert.equal(byId.zeroex.evidence[0].code, "NO_LIQUIDITY", "rejected route keeps its evidence");
});

test("runQuote drives adapters end to end and validates the assembled response", async () => {
  const zfi = new MockQuoteAdapter(
    { id: "zfi", type: "zfi", displayName: "ZFi" },
    { capabilities: { chains: [8453] }, behavior: { outputAmount: "2500000" } },
  );
  const set = new MockQuoteAdapter(
    { id: "set-bstock-ai", type: "setwise", displayName: "Set", poolId: "bstock-ai" },
    { capabilities: { chains: [8453] }, behavior: { outputAmount: "2510000" } },
  );
  const { response } = await runQuote([zfi, set], request(), { requestId: "req_run", now });
  assert.equal(response.selectedSourceId, "set-bstock-ai", "higher-output Set route wins");
  assert.equal(response.transaction, null);
  assert.equal(response.sources.length, 2);
});

test("runQuote selects the lowest-input route for exact-output", async () => {
  const expensive = new MockQuoteAdapter(
    { id: "expensive", type: "zfi", displayName: "Expensive" },
    { capabilities: { chains: [8453] }, behavior: { inputAmount: "1200000" } },
  );
  const cheap = new MockQuoteAdapter(
    { id: "cheap", type: "zfi", displayName: "Cheap" },
    { capabilities: { chains: [8453] }, behavior: { inputAmount: "1000000" } },
  );
  const req = request({ mode: "exact-output", amount: "2500000" });
  const { response } = await runQuote([expensive, cheap], req, { requestId: "req_eo", now });
  assert.equal(response.selectedSourceId, "cheap");
  assert.equal(response.sources.find((s) => s.source.id === "cheap").quote.amounts.output, "2500000");
});

test("runQuote marks exact-input-only sources excluded for exact-output requests", async () => {
  const inputOnly = new MockQuoteAdapter(
    { id: "input-only", type: "aggregator", displayName: "Input only" },
    { capabilities: { chains: [8453], modes: ["exact-input"] } },
  );
  const both = new MockQuoteAdapter(
    { id: "zfi", type: "zfi", displayName: "ZFi" },
    { capabilities: { chains: [8453] }, behavior: { inputAmount: "1000000" } },
  );
  const req = request({ mode: "exact-output", amount: "2500000" });
  const { response } = await runQuote([inputOnly, both], req, { requestId: "req_excl", now });
  const byId = Object.fromEntries(response.sources.map((s) => [s.source.id, s]));
  assert.equal(byId["input-only"].status, "excluded");
  assert.equal(byId["input-only"].evidence[0].code, "UNSUPPORTED_MODE");
  assert.equal(response.selectedSourceId, "zfi", "only the capable source is selectable");
});

const QUOTER = "0x5aAdFB43eF8dAF45DD80F4676345b7676f1D70e3";
const DIRECT_SEL = quoterSelector("buildBestSwap").toLowerCase();

function zfiTransport(returnData) {
  return {
    async getChainId() {
      return 1;
    },
    async getCode() {
      return "0x6080604052";
    },
    async call(to, data) {
      const inner = decodeAggregate3Calls(data);
      const results = inner.map((c) =>
        c.callData.slice(0, 10).toLowerCase() === DIRECT_SEL
          ? { success: true, returnData }
          : { success: false, returnData: "0x" },
      );
      return encodeAggregate3Result(results);
    },
  };
}

function zfiRequest(overrides = {}) {
  return {
    apiVersion: "v1",
    chainId: 1,
    tokenIn: { chainId: 1, address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
    tokenOut: { chainId: 1, address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
    router: { chainId: 1, address: "0x000000000000FB114709235f1ccBFfb925F600e4" },
    mode: "exact-input",
    amount: "1000000000",
    recipient: { chainId: 1, address: "0x000000000000000000000000000000000000bEEF" },
    funder: { chainId: 1, address: "0x000000000000000000000000000000000000bEEF" },
    slippage: { maxBps: 100 },
    ...overrides,
  };
}

test("runQuote lifts a ZFi firm transaction and records the selected route path", async () => {
  const callData = "0xafeae12bdeadbeef";
  const returnData = encodeQuoterResult("buildBestSwap", {
    best: { source: "3", feeBps: "5", amountIn: "1000000000", amountOut: "999335336" },
    callData,
    amountLimit: "989341982",
    msgValue: "0",
  });
  const zfi = new ZfiQuoteAdapter(
    { id: "zfi", type: "zfi", displayName: "ZFi" },
    { transport: zfiTransport(returnData), deployments: { 1: { quoter: QUOTER, routes: { direct: true } } } },
  );
  const req = zfiRequest();
  const { response } = await runQuote([zfi], req, { kind: "firm", requestId: "req_zfi_firm", now });

  assert.equal(response.kind, "firm");
  assert.equal(response.selectedSourceId, "zfi");
  assert.equal(response.transaction.to, req.router.address);
  assert.equal(response.transaction.calldata, callData, "firm transaction is lifted from the selected source");

  const selected = response.sources.find((s) => s.source.id === "zfi");
  const pathEvidence = selected.evidence.find((e) => e.reference === "zfi:direct");
  assert.ok(pathEvidence.message, "selected route records a path message");
  const path = JSON.parse(pathEvidence.message);
  assert.equal(path.builder, "direct");
  assert.equal(path.amountOut, "999335336");
  assert.equal(path.legs[0].proportionBps, 10000, "a single-leg route is 100% of the input");
});

test("a split ZFi route reports per-leg split proportions in evidence", async () => {
  const splitSel = quoterSelector("buildSplitSwap").toLowerCase();
  const returnData = encodeQuoterResult("buildSplitSwap", {
    legs: [
      { source: "1", feeBps: "30", amountIn: "600000000", amountOut: "599000000" },
      { source: "3", feeBps: "5", amountIn: "400000000", amountOut: "399800000" },
    ],
    multicall: "0xdeadbeef",
    msgValue: "0",
  });
  const transport = {
    async getChainId() {
      return 1;
    },
    async getCode() {
      return "0x6080604052";
    },
    async call(to, data) {
      const inner = decodeAggregate3Calls(data);
      const results = inner.map((c) =>
        c.callData.slice(0, 10).toLowerCase() === splitSel
          ? { success: true, returnData }
          : { success: false, returnData: "0x" },
      );
      return encodeAggregate3Result(results);
    },
  };
  const zfi = new ZfiQuoteAdapter(
    { id: "zfi", type: "zfi", displayName: "ZFi" },
    { transport, deployments: { 1: { quoter: QUOTER, routes: { split: true } } } },
  );
  const { response } = await runQuote([zfi], zfiRequest(), { requestId: "req_split", now });
  const selected = response.sources.find((s) => s.source.id === "zfi");
  const path = JSON.parse(selected.evidence.find((e) => e.reference === "zfi:split").message);
  assert.equal(path.builder, "split");
  assert.deepEqual(path.legs.map((l) => l.proportionBps), [6000, 4000], "legs sum to the full input");
});

test("getChainConfig is available for chain-aware assembly", () => {
  assert.equal(getChainConfig(8453).chainId, 8453);
});

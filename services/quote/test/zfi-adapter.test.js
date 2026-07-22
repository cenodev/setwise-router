import assert from "node:assert/strict";
import test from "node:test";

import { getChainConfig } from "../../../config/index.mjs";
import {
  ZFI_ERROR_CODES,
  ZfiQuoteAdapter,
  createRpcTransport,
  defaultRoutePolicy,
  decodeAggregate3Calls,
  encodeAggregate3Result,
  encodeQuoterResult,
  quoterSelector,
  runQuoteSources,
  validateQuoteResponse,
} from "../src/index.js";

const NOW = "2026-07-22T20:00:00.000Z";
const QUOTER = "0x5aAdFB43eF8dAF45DD80F4676345b7676f1D70e3";
const MULTICALL3 = getChainConfig(1).multicall3;

const SEL = {
  direct: quoterSelector("buildBestSwap").toLowerCase(),
  multiHop: quoterSelector("buildBestSwapViaETHMulticall").toLowerCase(),
  threeHop: quoterSelector("build3HopMulticall").toLowerCase(),
  split: quoterSelector("buildSplitSwap").toLowerCase(),
  hybrid: quoterSelector("buildHybridSplit").toLowerCase(),
};

const BUILDER_NAMES = ["direct", "multiHop", "threeHop", "split", "hybrid"];
const only = (...names) =>
  Object.fromEntries(BUILDER_NAMES.map((n) => [n, names.includes(n)]));

const leg = (source, feeBps, amountIn, amountOut) => ({
  source: String(source),
  feeBps: String(feeBps),
  amountIn: String(amountIn),
  amountOut: String(amountOut),
});

function directReturn({ amountIn, amountOut, amountLimit, msgValue = "0", callData = "0xafeae12bdeadbeef" }) {
  return encodeQuoterResult("buildBestSwap", {
    best: leg(3, 5, amountIn, amountOut),
    callData,
    amountLimit: String(amountLimit),
    msgValue: String(msgValue),
  });
}

function multiHopReturn({ amountIn, midAmount, amountOut, msgValue = "0", multicall = "0xdeadbeef" }) {
  return encodeQuoterResult("buildBestSwapViaETHMulticall", {
    a: leg(3, 5, amountIn, midAmount),
    b: leg(3, 5, midAmount, amountOut),
    calls: [multicall],
    multicall,
    msgValue: String(msgValue),
  });
}

function threeHopReturn({ amountIn, m1, m2, amountOut, msgValue = "0", multicall = "0xdeadbeef" }) {
  return encodeQuoterResult("build3HopMulticall", {
    a: leg(3, 5, amountIn, m1),
    b: leg(3, 5, m1, m2),
    c: leg(3, 5, m2, amountOut),
    calls: [multicall],
    multicall,
    msgValue: String(msgValue),
  });
}

function splitReturn(fn, { legs, msgValue = "0", multicall = "0xdeadbeef" }) {
  return encodeQuoterResult(fn, {
    legs: legs.map((l) => leg(l.source, l.feeBps, l.amountIn, l.amountOut)),
    multicall,
    msgValue: String(msgValue),
  });
}

const ok = (returnData) => ({ success: true, returnData });
const revert = (returnData = "0x6586e129") => ({ success: false, returnData });

function fakeTransport({ chainId = 1, code = "0x6080604052", responses = {} } = {}) {
  const calls = [];
  const transport = {
    calls,
    async getChainId() {
      return chainId;
    },
    async getCode() {
      return code;
    },
    async call(to, data) {
      calls.push({ to, data });
      const inner = decodeAggregate3Calls(data);
      const results = inner.map((c) => {
        const selector = c.callData.slice(0, 10).toLowerCase();
        const resp = responses[selector];
        if (resp === undefined) return { success: false, returnData: "0x" };
        return typeof resp === "function" ? resp(c) : resp;
      });
      return encodeAggregate3Result(results);
    },
  };
  return transport;
}

function request(overrides = {}) {
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

function context(kind = "indicative", chainId = 1) {
  return { kind, now: () => NOW, chainConfig: getChainConfig(chainId) };
}

function adapter(transport, deployments, options = {}) {
  return new ZfiQuoteAdapter(
    { id: "zfi", type: "zfi", displayName: "ZFi" },
    { transport, deployments, ...options },
  );
}

const directDeployment = (extra = {}) => ({ 1: { quoter: QUOTER, routes: only("direct"), ...extra } });

test("describes a ZFi source and requires the zfi type", () => {
  const transport = fakeTransport();
  const zfi = adapter(transport, directDeployment());
  assert.deepEqual(zfi.describe(), { id: "zfi", type: "zfi", displayName: "ZFi" });
  assert.throws(
    () => new ZfiQuoteAdapter({ id: "x", type: "aggregator", displayName: "X" }, { transport, deployments: {} }),
    /zfi/,
  );
  assert.deepEqual(zfi.capabilities.chains, [1], "chains default to the configured deployments");
});

test("returns an indicative direct quote with route evidence", async () => {
  const transport = fakeTransport({
    responses: {
      [SEL.direct]: ok(directReturn({ amountIn: "1000000000", amountOut: "999335336", amountLimit: "989341982" })),
    },
  });
  const result = await adapter(transport, directDeployment()).quote(request(), context());
  assert.equal(result.status, "available");
  assert.equal(result.quote.kind, "indicative");
  assert.equal(result.quote.amounts.input, "1000000000");
  assert.equal(result.quote.amounts.output, "999335336");
  assert.equal(result.quote.amounts.limit, "989341982", "uses the on-chain amount limit");
  assert.equal(result.quote.approvalTarget, null, "indicative quotes carry no approval target");
  assert.equal(result.quote.expiresAt, null);
  assert.equal(result.transaction, undefined, "indicative quotes carry no executable transaction");
  assert.deepEqual(result.evidence.map((e) => e.reference), ["zfi:direct"]);
  assert.equal(result.evidence[0].kind, "onchain");
  // The batch was sent to the verified Multicall3 deployment.
  assert.equal(transport.calls[0].to, MULTICALL3);
});

test("returns a firm quote with executable router calldata", async () => {
  const callData = "0xafeae12bdeadbeef";
  const transport = fakeTransport({
    responses: {
      [SEL.direct]: ok(directReturn({ amountIn: "1000000000", amountOut: "999335336", amountLimit: "989341982", msgValue: "0", callData })),
    },
  });
  const req = request();
  const result = await adapter(transport, directDeployment()).quote(req, context("firm"));
  assert.equal(result.status, "available");
  assert.equal(result.quote.kind, "firm");
  assert.deepEqual(result.quote.approvalTarget, req.router);
  assert.ok(result.quote.expiresAt, "firm quotes require an expiry");
  assert.deepEqual(result.transaction, {
    chainId: 1,
    to: req.router.address,
    calldata: callData,
    value: "0",
  });
});

test("forwards native value on a native-input route", async () => {
  const transport = fakeTransport({
    responses: {
      [SEL.direct]: ok(directReturn({ amountIn: "1000000000000000000", amountOut: "2316220645547324993283", amountLimit: "2293058439091851743350", msgValue: "1000000000000000000" })),
    },
  });
  const req = request({ amount: "1000000000000000000" });
  const result = await adapter(transport, directDeployment()).quote(req, context("firm"));
  assert.equal(result.transaction.value, "1000000000000000000");
  assert.equal(result.quote.amounts.input, "1000000000000000000");
});

test("verifies the chain id before making any call", async () => {
  const transport = fakeTransport({ chainId: 56, responses: { [SEL.direct]: ok(directReturn({ amountIn: "1000000000", amountOut: "1", amountLimit: "1" })) } });
  const result = await adapter(transport, directDeployment()).quote(request(), context());
  assert.equal(result.status, "unavailable");
  assert.equal(result.evidence[0].code, ZFI_ERROR_CODES.CHAIN_MISMATCH);
  assert.equal(transport.calls.length, 0, "no multicall is issued on a chain-id mismatch");
});

test("verifies deployment code is present before calling", async () => {
  const transport = fakeTransport({ code: "0x", responses: { [SEL.direct]: ok(directReturn({ amountIn: "1000000000", amountOut: "1", amountLimit: "1" })) } });
  const result = await adapter(transport, directDeployment()).quote(request(), context());
  assert.equal(result.status, "unavailable");
  assert.equal(result.evidence[0].code, ZFI_ERROR_CODES.NO_CODE);
  assert.equal(transport.calls.length, 0);
});

test("verifies the runtime bytecode hash when configured", async () => {
  const expected = "0x" + "ab".repeat(32);
  const hashCode = (code) => (code === "0x6080604052" ? expected : "0x" + "cd".repeat(32));
  const good = fakeTransport();
  const goodResult = await adapter(good, directDeployment({ codeHash: expected }), { hashCode, deadlineTtlSeconds: 300 })
    .quote(request(), context());
  // No route responses configured -> unavailable for routes, but code verification passed.
  assert.notEqual(goodResult.evidence[0].code, ZFI_ERROR_CODES.CODE_MISMATCH);

  const bad = fakeTransport();
  const badResult = await adapter(bad, directDeployment({ codeHash: "0x" + "11".repeat(32) }), { hashCode })
    .quote(request(), context());
  assert.equal(badResult.status, "unavailable");
  assert.equal(badResult.evidence[0].code, ZFI_ERROR_CODES.CODE_MISMATCH);
  assert.equal(bad.calls.length, 0);
});

test("reports partial Multicall failures per route", async () => {
  const transport = fakeTransport({
    responses: {
      [SEL.direct]: ok(directReturn({ amountIn: "1000000000", amountOut: "999335336", amountLimit: "989341982" })),
      [SEL.multiHop]: revert("0x6586e129"),
    },
  });
  const deployments = { 1: { quoter: QUOTER, routes: only("direct", "multiHop") } };
  const result = await adapter(transport, deployments).quote(request(), context());
  assert.equal(result.status, "available", "a surviving route keeps the quote available");
  assert.equal(result.quote.amounts.output, "999335336");
  const byRef = Object.fromEntries(result.evidence.map((e) => [e.reference, e]));
  assert.ok(!("code" in byRef["zfi:direct"]), "successful route has no error code");
  assert.equal(byRef["zfi:multi-hop"].code, "NoRoute", "failed route surfaces the revert selector");
});

test("is unavailable when every route builder reverts", async () => {
  const transport = fakeTransport({
    responses: {
      [SEL.direct]: revert("0x6586e129"),
      [SEL.multiHop]: revert("0x982c96c6"),
    },
  });
  const deployments = { 1: { quoter: QUOTER, routes: only("direct", "multiHop") } };
  const result = await adapter(transport, deployments).quote(request(), context());
  assert.equal(result.status, "unavailable");
  assert.equal(result.quote, null);
  const codes = result.evidence.map((e) => e.code).sort();
  assert.deepEqual(codes, ["NoRoute", "SlippageBpsTooHigh"]);
});

test("selects the best route by output for exact-input", async () => {
  const transport = fakeTransport({
    responses: {
      [SEL.direct]: ok(directReturn({ amountIn: "1000000000", amountOut: "900000000", amountLimit: "891000000" })),
      [SEL.multiHop]: ok(multiHopReturn({ amountIn: "1000000000", midAmount: "500000000000000000", amountOut: "950000000" })),
    },
  });
  const deployments = { 1: { quoter: QUOTER, routes: only("direct", "multiHop") } };
  const result = await adapter(transport, deployments).quote(request(), context());
  assert.equal(result.quote.amounts.output, "950000000", "higher-output multi-hop route wins");
  assert.ok(result.evidence.some((e) => e.reference === "zfi:multi-hop"));
});

test("selects the best route by input for exact-output", async () => {
  const transport = fakeTransport({
    responses: {
      [SEL.direct]: ok(directReturn({ amountIn: "1200000000", amountOut: "999335336", amountLimit: "1212000000" })),
      [SEL.multiHop]: ok(multiHopReturn({ amountIn: "1100000000", midAmount: "500000000000000000", amountOut: "999335336" })),
    },
  });
  const deployments = { 1: { quoter: QUOTER, routes: only("direct", "multiHop") } };
  const req = request({ mode: "exact-output", amount: "999335336" });
  const result = await adapter(transport, deployments).quote(req, context());
  assert.equal(result.quote.amounts.output, "999335336");
  assert.equal(result.quote.amounts.input, "1100000000", "lower-input multi-hop route wins");
});

test("splits sum their legs and are exact-input only", async () => {
  const transport = fakeTransport({
    responses: {
      [SEL.split]: ok(splitReturn("buildSplitSwap", {
        legs: [
          { source: 1, feeBps: 30, amountIn: "600000000", amountOut: "599000000" },
          { source: 3, feeBps: 5, amountIn: "400000000", amountOut: "399800000" },
        ],
      })),
    },
  });
  const deployments = { 1: { quoter: QUOTER, routes: only("split") } };
  const result = await adapter(transport, deployments).quote(request(), context());
  assert.equal(result.status, "available");
  assert.equal(result.quote.amounts.input, "1000000000", "split legs sum to the input");
  assert.equal(result.quote.amounts.output, "998800000", "split legs sum to the output");

  const exactOut = await adapter(transport, deployments).quote(
    request({ mode: "exact-output", amount: "998800000" }),
    context(),
  );
  assert.equal(exactOut.status, "unavailable", "split builder is gated off for exact-output");
  assert.equal(exactOut.evidence[0].code, ZFI_ERROR_CODES.NO_ROUTES);
});

test("capability-gates route builders via explicit overrides and default policy", async () => {
  // Explicit override disables split even though Ethereum's venues would allow it.
  const transport = fakeTransport({ responses: { [SEL.direct]: ok(directReturn({ amountIn: "1000000000", amountOut: "1", amountLimit: "1" })) } });
  const deployments = { 1: { quoter: QUOTER, routes: { ...only("direct"), split: false, hybrid: false } } };
  const result = await adapter(transport, deployments).quote(request(), context());
  const selectors = decodeAggregate3Calls(transport.calls[0].data).map((c) => c.callData.slice(0, 10).toLowerCase());
  assert.deepEqual(selectors, [SEL.direct], "only the enabled builder is batched");
  assert.equal(result.status, "available");

  // Default policy derives gating from the chain's enabled venues.
  const oneVenue = { venues: { uniswapV3: { enabled: true } } };
  assert.deepEqual(defaultRoutePolicy(oneVenue), {
    direct: true,
    multiHop: true,
    threeHop: true,
    split: false,
    hybrid: false,
  });
  const twoVenues = { venues: { uniswapV3: { enabled: true }, uniswapV4: { enabled: true } } };
  assert.equal(defaultRoutePolicy(twoVenues).split, true);
  assert.equal(defaultRoutePolicy({ venues: {} }).direct, false);
});

test("is unavailable when no route builders are enabled", async () => {
  const transport = fakeTransport();
  const result = await adapter(transport, { 1: { quoter: QUOTER, routes: only() } }).quote(request(), context());
  assert.equal(result.status, "unavailable");
  assert.equal(result.evidence[0].code, ZFI_ERROR_CODES.NO_ROUTES);
  assert.equal(transport.calls.length, 0);
});

test("is unavailable when the chain has no deployment binding", async () => {
  const transport = fakeTransport();
  // Configured for Base only; a request on Ethereum has no binding.
  const result = await adapter(transport, { 8453: { quoter: QUOTER, routes: only("direct") } }).quote(request(), context());
  assert.equal(result.status, "unavailable");
  assert.equal(result.evidence[0].code, ZFI_ERROR_CODES.NO_DEPLOYMENT);
});

test("records a block number in evidence when the transport provides one", async () => {
  const transport = fakeTransport({
    responses: { [SEL.direct]: ok(directReturn({ amountIn: "1000000000", amountOut: "1", amountLimit: "1" })) },
  });
  transport.getBlockNumber = async () => "24880000";
  const result = await adapter(transport, directDeployment()).quote(request(), context());
  assert.equal(result.evidence[0].blockNumber, "24880000");
});

test("reports a failed outcome when the Multicall itself reverts", async () => {
  const transport = fakeTransport();
  transport.call = async () => {
    throw new Error("execution reverted");
  };
  const result = await adapter(transport, directDeployment()).quote(request(), context());
  assert.equal(result.status, "unavailable");
  assert.equal(result.evidence[0].code, ZFI_ERROR_CODES.MULTICALL_FAILED);
});

test("probes transport health", async () => {
  const healthy = adapter(fakeTransport(), directDeployment());
  assert.equal((await healthy.health({ now: () => NOW })).status, "healthy");
  const broken = adapter(fakeTransport(), directDeployment());
  broken.transport.getChainId = async () => {
    throw new Error("down");
  };
  const probe = await broken.health({ now: () => NOW });
  assert.equal(probe.status, "unhealthy");
  assert.equal(probe.detail, "down");
});

test("produces a schema-valid firm response through the runner pipeline", async () => {
  const callData = "0xafeae12bdeadbeef";
  const transport = fakeTransport({
    responses: { [SEL.direct]: ok(directReturn({ amountIn: "1000000000", amountOut: "999335336", amountLimit: "989341982", callData })) },
  });
  const zfi = adapter(transport, directDeployment());
  const req = request();
  const { sources } = await runQuoteSources([zfi], req, { kind: "firm", now: () => NOW });
  assert.equal(sources[0].status, "available");
  assert.equal(sources[0].source.displayName, "ZFi");

  // Lift the adapter's executable transaction to the firm response envelope.
  const direct = await zfi.quote(req, context("firm"));
  const response = {
    apiVersion: "v1",
    requestId: "req_zfi_firm",
    chainId: 1,
    mode: "exact-input",
    kind: "firm",
    selectedSourceId: "zfi",
    sources,
    transaction: direct.transaction,
  };
  const validated = validateQuoteResponse(response, req);
  assert.equal(validated.transaction.to, req.router.address);
  assert.equal(validated.transaction.calldata, callData);
});

test("createRpcTransport issues the expected JSON-RPC reads", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body.method);
    const results = {
      eth_chainId: "0x1",
      eth_getCode: "0x6080",
      eth_call: "0xdeadbeef",
      eth_blockNumber: "0x17ba380",
      eth_estimateGas: "0x2dc6c0",
    };
    return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result: results[body.method] }) };
  };
  const transport = createRpcTransport("https://example.invalid", { fetchImpl });
  assert.equal(await transport.getChainId(), 1);
  assert.equal(await transport.getCode(QUOTER), "0x6080");
  assert.equal(await transport.call(QUOTER, "0x00"), "0xdeadbeef");
  assert.equal(await transport.getBlockNumber(), "24880000");
  assert.equal(await transport.estimateGas(QUOTER, "0x00", "0"), "3000000");
  assert.deepEqual(seen, ["eth_chainId", "eth_getCode", "eth_call", "eth_blockNumber", "eth_estimateGas"]);
});

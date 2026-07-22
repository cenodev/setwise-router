import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  ZeroExAdapter,
  ZeroExAdapterError,
  ZEROEX_CHAIN_IDS,
  ZEROEX_ERROR_CODES,
  runQuoteSources,
} from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "..", "fixtures", "zeroex");

function loadFixture(name) {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

const NOW = "2026-07-23T00:00:00.000Z";
const now = () => NOW;

const address = (suffix) => `0x${suffix.padStart(40, "0")}`;
const scoped = (chainId, suffix) => ({ chainId, address: address(suffix) });

function request(overrides = {}) {
  return {
    apiVersion: "v1",
    chainId: 1,
    tokenIn: scoped(1, "c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"),
    tokenOut: scoped(1, "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"),
    router: scoped(1, "33"),
    mode: "exact-input",
    amount: "1000000000000000000",
    recipient: scoped(1, "44"),
    funder: scoped(1, "55"),
    slippage: { maxBps: 50 },
    ...overrides,
  };
}

function mockFetch(fixture, status = 200) {
  return async (_url, _opts) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => fixture,
  });
}

function mockFetchError(error) {
  return async () => {
    throw error;
  };
}

test("declares support for all four target chains", () => {
  const adapter = new ZeroExAdapter({ fetch: mockFetch({}) });
  assert.deepEqual([...adapter.capabilities.chains], [1, 56, 8453, 4663]);
  assert.deepEqual([...ZEROEX_CHAIN_IDS], [1, 56, 8453, 4663]);
  for (const chainId of ZEROEX_CHAIN_IDS) {
    assert.ok(adapter.supports(chainId, "exact-input", "indicative"));
    assert.ok(adapter.supports(chainId, "exact-input", "firm"));
    assert.ok(adapter.supports(chainId, "exact-output", "indicative"));
    assert.ok(adapter.supports(chainId, "exact-output", "firm"));
  }
});

test("uses the aggregator source type and 0x display name", () => {
  const adapter = new ZeroExAdapter({ fetch: mockFetch({}) });
  assert.equal(adapter.type, "aggregator");
  assert.equal(adapter.displayName, "0x");
  assert.equal(adapter.id, "zeroex");
  assert.equal(adapter.poolId, null);
});

test("authenticates server-side via the 0x-api-key header", async () => {
  let capturedHeaders;
  const adapter = new ZeroExAdapter({
    apiKey: "test-key-123",
    fetch: async (_url, opts) => {
      capturedHeaders = opts.headers;
      return { ok: true, status: 200, json: async () => loadFixture("ethereum.exact-input.indicative.json") };
    },
  });
  await adapter.quote(request(), { kind: "indicative", now, signal: undefined, chainConfig: {} });
  assert.equal(capturedHeaders["0x-api-key"], "test-key-123");
});

test("includes the active chain id in every request", async () => {
  let capturedUrl;
  const adapter = new ZeroExAdapter({
    fetch: async (url) => {
      capturedUrl = url;
      return { ok: true, status: 200, json: async () => loadFixture("base.exact-input.firm.json") };
    },
  });
  const baseRequest = request({
    chainId: 8453,
    tokenIn: scoped(8453, "4200000000000000000000000000000000000006"),
    tokenOut: scoped(8453, "833589fcd6edb6e08f4c7c32d4f71b54bda02913"),
    router: scoped(8453, "33"),
    recipient: scoped(8453, "44"),
    funder: scoped(8453, "55"),
  });
  await adapter.quote(baseRequest, { kind: "firm", now, signal: undefined, chainConfig: {} });
  assert.ok(capturedUrl.includes("chainId=8453"), `expected chainId=8453 in ${capturedUrl}`);
});

test("preserves returned transaction target and calldata without rewriting", async () => {
  const fixture = loadFixture("ethereum.exact-input.firm.json");
  const adapter = new ZeroExAdapter({ fetch: mockFetch(fixture) });
  const result = await adapter.quote(request(), { kind: "firm", now, signal: undefined, chainConfig: {} });

  assert.equal(result.status, "available");
  assert.ok(result.quote);
  assert.equal(result.quote.kind, "firm");
  assert.ok(result.quote.expiresAt);
});

test("preserves the exact input amount on the correct side", async () => {
  const fixture = loadFixture("ethereum.exact-input.firm.json");
  const adapter = new ZeroExAdapter({ fetch: mockFetch(fixture) });
  const result = await adapter.quote(request(), { kind: "firm", now, signal: undefined, chainConfig: {} });

  assert.equal(result.quote.amounts.input, "1000000000000000000");
  assert.equal(result.quote.amounts.output, "2487500000");
  assert.equal(result.quote.amounts.limit, "2462625000");
});

test("supports AllowanceHolder approval targets", async () => {
  const fixture = loadFixture("ethereum.exact-input.firm.json");
  const adapter = new ZeroExAdapter({ fetch: mockFetch(fixture) });
  const result = await adapter.quote(request(), { kind: "firm", now, signal: undefined, chainConfig: {} });

  assert.ok(result.quote.approvalTarget);
  assert.equal(result.quote.approvalTarget.address, "0x0000000000001fF3684f28c67538d4D072C22734");
  assert.equal(result.quote.approvalTarget.chainId, 1);
});

test("indicative quotes do not include an approval target", async () => {
  const fixture = loadFixture("ethereum.exact-input.indicative.json");
  const adapter = new ZeroExAdapter({ fetch: mockFetch(fixture) });
  const result = await adapter.quote(request(), { kind: "indicative", now, signal: undefined, chainConfig: {} });

  assert.equal(result.status, "available");
  assert.equal(result.quote.approvalTarget, null);
  assert.equal(result.quote.expiresAt, null);
});

test("handles native-token sentinels in requests", async () => {
  let capturedUrl;
  const fixture = loadFixture("robinhood.exact-input.firm.json");
  const adapter = new ZeroExAdapter({
    fetch: async (url) => {
      capturedUrl = url;
      return { ok: true, status: 200, json: async () => fixture };
    },
  });
  const nativeRequest = request({
    chainId: 4663,
    tokenIn: scoped(4663, "0000000000000000000000000000000000000000"),
    tokenOut: scoped(4663, "833589fcd6edb6e08f4c7c32d4f71b54bda02913"),
    router: scoped(4663, "33"),
    recipient: scoped(4663, "44"),
    funder: scoped(4663, "55"),
  });
  await adapter.quote(nativeRequest, { kind: "firm", now, signal: undefined, chainConfig: {} });
  assert.ok(capturedUrl.includes("sellToken=NATIVE"), `expected NATIVE sentinel in ${capturedUrl}`);
});

test("normalizes insufficient-liquidity responses as unavailable", async () => {
  const fixture = loadFixture("error.insufficient-liquidity.json");
  const adapter = new ZeroExAdapter({ fetch: mockFetch(fixture) });
  const result = await adapter.quote(request(), { kind: "indicative", now, signal: undefined, chainConfig: {} });

  assert.equal(result.status, "unavailable");
  assert.equal(result.quote, null);
  assert.ok(result.evidence.length > 0);
  assert.equal(result.evidence[0].code, ZEROEX_ERROR_CODES.INSUFFICIENT_LIQUIDITY);
});

test("normalizes rate-limit errors", async () => {
  const fixture = loadFixture("error.rate-limited.json");
  const adapter = new ZeroExAdapter({ fetch: mockFetch(fixture, 429) });

  await assert.rejects(
    () => adapter.quote(request(), { kind: "indicative", now, signal: undefined, chainConfig: {} }),
    (err) => {
      assert.ok(err instanceof ZeroExAdapterError);
      assert.equal(err.code, ZEROEX_ERROR_CODES.RATE_LIMITED);
      return true;
    },
  );
});

test("normalizes tax-token errors", async () => {
  const fixture = loadFixture("error.tax-token.json");
  const adapter = new ZeroExAdapter({ fetch: mockFetch(fixture, 400) });

  await assert.rejects(
    () => adapter.quote(request(), { kind: "indicative", now, signal: undefined, chainConfig: {} }),
    (err) => {
      assert.ok(err instanceof ZeroExAdapterError);
      assert.equal(err.code, ZEROEX_ERROR_CODES.TAX_TOKEN);
      return true;
    },
  );
});

test("normalizes generic API errors", async () => {
  const adapter = new ZeroExAdapter({
    fetch: mockFetch({ reason: "Internal Server Error" }, 500),
  });

  await assert.rejects(
    () => adapter.quote(request(), { kind: "indicative", now, signal: undefined, chainConfig: {} }),
    (err) => {
      assert.ok(err instanceof ZeroExAdapterError);
      assert.equal(err.code, ZEROEX_ERROR_CODES.API_ERROR);
      return true;
    },
  );
});

test("normalizes network errors", async () => {
  const adapter = new ZeroExAdapter({
    fetch: mockFetchError(new Error("ECONNREFUSED")),
  });

  await assert.rejects(
    () => adapter.quote(request(), { kind: "indicative", now, signal: undefined, chainConfig: {} }),
    (err) => {
      assert.ok(err instanceof ZeroExAdapterError);
      assert.equal(err.code, ZEROEX_ERROR_CODES.NETWORK_ERROR);
      return true;
    },
  );
});

test("validates response token mismatch", async () => {
  const fixture = loadFixture("ethereum.exact-input.indicative.json");
  fixture.sellToken = "0x0000000000000000000000000000000000000099";
  const adapter = new ZeroExAdapter({ fetch: mockFetch(fixture) });

  await assert.rejects(
    () => adapter.quote(request(), { kind: "indicative", now, signal: undefined, chainConfig: {} }),
    (err) => {
      assert.ok(err instanceof ZeroExAdapterError);
      assert.equal(err.code, ZEROEX_ERROR_CODES.RESPONSE_MISMATCH);
      return true;
    },
  );
});

test("validates response amount mismatch for exact-input", async () => {
  const fixture = loadFixture("ethereum.exact-input.indicative.json");
  fixture.sellAmount = "999999999999999999";
  const adapter = new ZeroExAdapter({ fetch: mockFetch(fixture) });

  await assert.rejects(
    () => adapter.quote(request(), { kind: "indicative", now, signal: undefined, chainConfig: {} }),
    (err) => {
      assert.ok(err instanceof ZeroExAdapterError);
      assert.equal(err.code, ZEROEX_ERROR_CODES.RESPONSE_MISMATCH);
      return true;
    },
  );
});

test("the router can operate when 0x is unavailable", async () => {
  const failing = new ZeroExAdapter({
    fetch: mockFetchError(new Error("connection refused")),
  });
  const { sources } = await runQuoteSources([failing], request(), { now });

  assert.equal(sources.length, 1);
  assert.equal(sources[0].status, "failed");
  assert.equal(sources[0].quote, null);
  assert.ok(sources[0].evidence.length > 0);
  assert.equal(sources[0].source.type, "aggregator");
  assert.equal(sources[0].source.displayName, "0x");
});

test("0x failure does not block other sources in the runner", async () => {
  const { MockQuoteAdapter } = await import("../src/index.js");
  const failing = new ZeroExAdapter({
    fetch: mockFetchError(new Error("timeout")),
    timeoutMs: 100,
  });
  const healthy = new MockQuoteAdapter(
    { id: "zfi", type: "zfi", displayName: "ZFi" },
    { capabilities: { chains: [1] } },
  );
  const { sources } = await runQuoteSources([failing, healthy], request(), { now });

  const byId = Object.fromEntries(sources.map((s) => [s.source.id, s]));
  assert.equal(byId.zeroex.status, "failed");
  assert.equal(byId.zfi.status, "available");
  assert.ok(byId.zfi.quote);
});

test("BSC fixture produces a valid firm quote", async () => {
  const fixture = loadFixture("bsc.exact-input.firm.json");
  const adapter = new ZeroExAdapter({ fetch: mockFetch(fixture) });
  const bscRequest = request({
    chainId: 56,
    tokenIn: scoped(56, "55d398326f99059ff775485246999027b3197955"),
    tokenOut: scoped(56, "bb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c"),
    router: scoped(56, "33"),
    recipient: scoped(56, "44"),
    funder: scoped(56, "55"),
    amount: "300000000",
  });
  const result = await adapter.quote(bscRequest, { kind: "firm", now, signal: undefined, chainConfig: {} });

  assert.equal(result.status, "available");
  assert.equal(result.quote.amounts.input, "300000000");
  assert.equal(result.quote.amounts.output, "596200000000000000");
  assert.ok(result.quote.fees.length > 0);
});

test("Base fixture produces a valid firm quote", async () => {
  const fixture = loadFixture("base.exact-input.firm.json");
  const adapter = new ZeroExAdapter({ fetch: mockFetch(fixture) });
  const baseRequest = request({
    chainId: 8453,
    tokenIn: scoped(8453, "4200000000000000000000000000000000000006"),
    tokenOut: scoped(8453, "833589fcd6edb6e08f4c7c32d4f71b54bda02913"),
    router: scoped(8453, "33"),
    recipient: scoped(8453, "44"),
    funder: scoped(8453, "55"),
  });
  const result = await adapter.quote(baseRequest, { kind: "firm", now, signal: undefined, chainConfig: {} });

  assert.equal(result.status, "available");
  assert.equal(result.quote.amounts.input, "1000000000000000000");
  assert.equal(result.quote.amounts.output, "2487500000");
});

test("Robinhood Chain fixture with native token produces a valid firm quote", async () => {
  const fixture = loadFixture("robinhood.exact-input.firm.json");
  const adapter = new ZeroExAdapter({ fetch: mockFetch(fixture) });
  const rhRequest = request({
    chainId: 4663,
    tokenIn: scoped(4663, "0000000000000000000000000000000000000000"),
    tokenOut: scoped(4663, "833589fcd6edb6e08f4c7c32d4f71b54bda02913"),
    router: scoped(4663, "33"),
    recipient: scoped(4663, "44"),
    funder: scoped(4663, "55"),
  });
  const result = await adapter.quote(rhRequest, { kind: "firm", now, signal: undefined, chainConfig: {} });

  assert.equal(result.status, "available");
  assert.equal(result.quote.amounts.input, "1000000000000000000");
  assert.equal(result.quote.amounts.output, "2487500000");
});

test("health probe reports healthy on success", async () => {
  const adapter = new ZeroExAdapter({
    fetch: mockFetch({ liquidityAvailable: true }),
  });
  const health = await adapter.health({ now });
  assert.equal(health.status, "healthy");
  assert.equal(health.checkedAt, NOW);
});

test("health probe reports degraded on rate limit", async () => {
  const adapter = new ZeroExAdapter({
    fetch: mockFetch({}, 429),
  });
  const health = await adapter.health({ now });
  assert.equal(health.status, "degraded");
});

test("health probe reports unhealthy on network error", async () => {
  const adapter = new ZeroExAdapter({
    fetch: mockFetchError(new Error("DNS resolution failed")),
  });
  const health = await adapter.health({ now });
  assert.equal(health.status, "unhealthy");
});

test("maps 0x fees to normalized fee records", async () => {
  const fixture = loadFixture("ethereum.exact-input.firm.json");
  const adapter = new ZeroExAdapter({ fetch: mockFetch(fixture) });
  const result = await adapter.quote(request(), { kind: "firm", now, signal: undefined, chainConfig: {} });

  assert.ok(result.quote.fees.length >= 1);
  const protocolFee = result.quote.fees.find((f) => f.type === "protocol");
  assert.ok(protocolFee);
  assert.equal(protocolFee.amount, "1243750");
  const networkFee = result.quote.fees.find((f) => f.type === "network");
  assert.ok(networkFee);
  assert.equal(networkFee.amount, "222000000000000");
});

test("uses the price endpoint for indicative and quote endpoint for firm", async () => {
  const urls = [];
  const adapter = new ZeroExAdapter({
    fetch: async (url) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => loadFixture("ethereum.exact-input.indicative.json") };
    },
  });
  await adapter.quote(request(), { kind: "indicative", now, signal: undefined, chainConfig: {} });
  await adapter.quote(request(), { kind: "firm", now, signal: undefined, chainConfig: {} });

  assert.ok(urls[0].includes("/swap/v2/price"), `expected price endpoint, got ${urls[0]}`);
  assert.ok(urls[1].includes("/swap/v2/quote"), `expected quote endpoint, got ${urls[1]}`);
});

test("exact-output mode sends buyAmount and validates response", async () => {
  let capturedUrl;
  const fixture = {
    ...loadFixture("ethereum.exact-input.indicative.json"),
    buyAmount: "2500000000",
    sellAmount: "1005000000000000000",
  };
  const adapter = new ZeroExAdapter({
    fetch: async (url) => {
      capturedUrl = url;
      return { ok: true, status: 200, json: async () => fixture };
    },
  });
  const exactOutputRequest = request({ mode: "exact-output", amount: "2500000000" });
  const result = await adapter.quote(exactOutputRequest, { kind: "indicative", now, signal: undefined, chainConfig: {} });

  assert.ok(capturedUrl.includes("buyAmount=2500000000"));
  assert.equal(result.status, "available");
  assert.equal(result.quote.amounts.output, "2500000000");
  assert.equal(result.quote.amounts.input, "1005000000000000000");
});

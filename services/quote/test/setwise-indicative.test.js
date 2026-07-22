import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { MockQuoteAdapter } from "../src/mock-adapter.js";
import {
  MockSetwiseRfqClient,
} from "../src/setwise-rfq-client.js";
import {
  SetwiseIndicativeAdapter,
  createSetwiseIndicativeAdapter,
  createSetwiseIndicativeAdapters,
  discoverEligiblePools,
  loadPoolCatalog,
} from "../src/setwise-indicative-adapter.js";
import {
  isIndicativeQuoteStale,
  normalizeIndicativeQuote,
} from "../src/setwise-quote-normalize.js";
import {
  rejectSelfReferentialRoute,
  validatePoolIdentity,
  validateSupportedAssets,
} from "../src/setwise-pool-catalog.js";
import { runQuoteSources, validateQuoteResponse } from "../src/index.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = (name) =>
  JSON.parse(readFileSync(join(packageRoot, "fixtures/setwise", name), "utf8"));

const NOW = "2026-07-22T20:00:00.000Z";
const now = () => NOW;

const address = (suffix) => `0x${suffix.padStart(40, "0")}`;
const scoped = (chainId, suffix) => ({ chainId, address: address(suffix) });

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function request(overrides = {}) {
  return {
    apiVersion: "v1",
    chainId: 8453,
    tokenIn: scoped(8453, USDC.slice(2)),
    tokenOut: scoped(8453, WETH.slice(2)),
    router: scoped(8453, "33"),
    mode: "exact-input",
    amount: "1000000",
    recipient: scoped(8453, "44"),
    funder: scoped(8453, "55"),
    slippage: { maxBps: 50 },
    ...overrides,
  };
}

function availableRfq(overrides = {}) {
  return {
    ...fixture("indicative-exact-input.response.json"),
    ...overrides,
  };
}

function adapter(rfqResponse = availableRfq(), options = {}) {
  const catalog = loadPoolCatalog();
  const pool = catalog.find((entry) => entry.poolId === "bstock-ai");
  const rfqClient = new MockSetwiseRfqClient({
    "bstock-ai": rfqResponse,
  });
  return new SetwiseIndicativeAdapter(pool, { rfqClient, ...options });
}

test("discovers eligible Set pools per chain and skips disabled entries", () => {
  const catalog = loadPoolCatalog();
  const basePools = discoverEligiblePools(8453, {}, { catalog });
  assert.deepEqual(basePools.map((pool) => pool.poolId), ["bstock-ai"]);

  const ethPools = discoverEligiblePools(1, {}, { catalog });
  assert.deepEqual(ethPools.map((pool) => pool.poolId), ["eth-bluechip"]);
});

test("validates pool and chain identity before quoting", () => {
  const catalog = loadPoolCatalog();
  const pool = catalog.find((entry) => entry.poolId === "bstock-ai");
  assert.equal(validatePoolIdentity(pool, 8453).valid, true);
  assert.equal(validatePoolIdentity(pool, 1).valid, false);
});

test("rejects self-referential routes that trade the pool contract", () => {
  const catalog = loadPoolCatalog();
  const pool = catalog.find((entry) => entry.poolId === "bstock-ai");
  const rejection = rejectSelfReferentialRoute(pool, pool.poolAddress, USDC);
  assert.equal(rejection.valid, false);
  assert.equal(rejection.code, "SELF_REFERENTIAL_ROUTE");
});

test("rejects unsupported asset pairs with policy evidence", () => {
  const catalog = loadPoolCatalog();
  const pool = catalog.find((entry) => entry.poolId === "bstock-ai");
  const unsupported = validateSupportedAssets(pool, USDC, address("99"));
  assert.equal(unsupported.supported, false);
});

test("normalizes exact-input and exact-output indicative quotes with slippage limits", () => {
  const reqInput = request();
  const inputQuote = normalizeIndicativeQuote(reqInput, availableRfq());
  assert.equal(inputQuote.kind, "indicative");
  assert.equal(inputQuote.amounts.input, "1000000");
  assert.equal(inputQuote.amounts.output, "2510000");
  assert.equal(inputQuote.amounts.limit, "2497450");
  assert.equal(inputQuote.approvalTarget, null);
  assert.equal(inputQuote.expiresAt, null);

  const reqOutput = request({
    mode: "exact-output",
    amount: "2510000",
    tokenIn: scoped(8453, USDC.slice(2)),
    tokenOut: scoped(8453, WETH.slice(2)),
  });
  const outputQuote = normalizeIndicativeQuote(
    reqOutput,
    availableRfq({
      mode: "exact-output",
      amounts: { input: "1005000", output: "2510000" },
    }),
  );
  assert.equal(outputQuote.amounts.output, "2510000");
  assert.equal(outputQuote.amounts.limit, "1010025");
});

test("detects stale indicative inventory from validUntil and observedAt windows", () => {
  assert.equal(
    isIndicativeQuoteStale(
      "2026-07-22T19:59:00.000Z",
      "2026-07-22T19:59:30.000Z",
      30_000,
      now,
    ),
    true,
  );
  assert.equal(
    isIndicativeQuoteStale("2026-07-22T20:00:00.000Z", "2026-07-22T20:00:30.000Z", 30_000, now),
    false,
  );
});

test("reports trading-paused Set pools as unavailable", async () => {
  const set = adapter(
    availableRfq({ status: "paused", code: "TRADING_PAUSED", message: "paused" }),
  );
  const { status, quote, evidence } = await set.quote(request(), {
    kind: "indicative",
    now,
    chainConfig: { chainId: 8453 },
  });
  assert.equal(status, "unavailable");
  assert.equal(quote, null);
  assert.ok(evidence.some((entry) => entry.code === "TRADING_PAUSED"));
});

test("reports stale Set indicative quotes without making them selectable", async () => {
  const set = adapter(
    availableRfq({
      status: "stale",
      validUntil: "2026-07-22T19:59:00.000Z",
      inventory: {
        observedAt: "2026-07-22T19:58:00.000Z",
        blockNumber: "123400",
        balances: {},
      },
    }),
  );
  const { status, quote, evidence } = await set.quote(request(), {
    kind: "indicative",
    now,
    chainConfig: { chainId: 8453 },
  });
  assert.equal(status, "stale");
  assert.ok(quote);
  assert.equal(quote.approvalTarget, null);
  assert.ok(evidence.some((entry) => entry.code === "STALE_INVENTORY"));
});

test("includes Set indicative quotes in the unified comparison response", async () => {
  const zfi = new MockQuoteAdapter(
    { id: "zfi", type: "zfi", displayName: "ZFi" },
    { capabilities: { chains: [8453] } },
  );
  const set = adapter();
  const req = request({
    tokenIn: { chainId: 8453, address: USDC },
    tokenOut: { chainId: 8453, address: WETH },
  });
  const { sources } = await runQuoteSources([zfi, set], req, { now });

  const response = {
    apiVersion: "v1",
    requestId: "req_set_compare",
    chainId: 8453,
    mode: "exact-input",
    kind: "indicative",
    selectedSourceId: "set-bstock-ai",
    sources,
    transaction: null,
  };
  const validated = validateQuoteResponse(response, req);
  assert.equal(validated.sources.length, 2);
  const setOutcome = validated.sources.find((entry) => entry.source.id === "set-bstock-ai");
  assert.equal(setOutcome.source.displayName, "Set");
  assert.equal(setOutcome.source.poolId, "bstock-ai");
  assert.equal(setOutcome.status, "available");
  assert.equal(setOutcome.quote.kind, "indicative");
  assert.equal(validated.transaction, null);
});

test("skips firm quote requests for Set indicative-only adapters", async () => {
  const set = adapter();
  const { sources } = await runQuoteSources([set], request(), { kind: "firm", now });
  assert.equal(sources[0].status, "excluded");
  assert.equal(sources[0].evidence[0].code, "UNSUPPORTED_KIND");
});

test("factory helpers build adapters for one pool or an entire chain", () => {
  const catalog = loadPoolCatalog();
  const rfqClient = new MockSetwiseRfqClient({ "bstock-ai": availableRfq() });
  const single = createSetwiseIndicativeAdapter(8453, "bstock-ai", { catalog, rfqClient });
  assert.ok(single);
  assert.equal(single.poolId, "bstock-ai");

  const chainAdapters = createSetwiseIndicativeAdapters(8453, { catalog, rfqClient });
  assert.equal(chainAdapters.length, 1);
  assert.equal(chainAdapters[0].id, "set-bstock-ai");
});

test("preserves evidence for inventory, price decomposition, and warnings", async () => {
  const set = adapter(
    availableRfq({
      warnings: [{ code: "MIN_NOTIONAL", message: "Near minimum trade size" }],
    }),
  );
  const { evidence } = await set.quote(request({
    tokenIn: { chainId: 8453, address: USDC },
    tokenOut: { chainId: 8453, address: WETH },
  }), {
    kind: "indicative",
    now,
    chainConfig: { chainId: 8453 },
  });
  assert.ok(evidence.some((entry) => entry.code === "INVENTORY_SNAPSHOT"));
  assert.ok(evidence.some((entry) => entry.code === "PRICE_DECOMPOSITION"));
  assert.ok(evidence.some((entry) => entry.code === "MIN_NOTIONAL"));
});

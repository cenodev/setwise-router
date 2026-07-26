import assert from "node:assert/strict";
import test from "node:test";

import { SetwiseRfqClient } from "../src/setwise-rfq-client.js";
import {
  loadPoolCatalog,
  resolvePoolRfqAssets,
} from "../src/setwise-pool-catalog.js";

const POOL_ID = "bstock-ai-no-bnb-bsc-testnet";
const POOL = "0xA54D041eD831BBE2D6F97107Ab3aD9f9682C392a";
const USDT = "0x0827541D8d43Bb891865440B50e6713D4C55be5A";
const SPCX = "0x75D74Ab8EcFF5215bbad450103ceDF532C23Ae46";
const ROUTER = "0x1111111111111111111111111111111111111111";
const WALLET = "0x2222222222222222222222222222222222222222";

function request(overrides = {}) {
  const pool = loadPoolCatalog().find((entry) => entry.poolId === POOL_ID);
  const assets = resolvePoolRfqAssets(pool, USDT, SPCX);
  return {
    poolId: POOL_ID,
    chainId: 97,
    mode: "exact-input",
    tokenIn: USDT,
    tokenOut: SPCX,
    inputAsset: assets.input,
    outputAsset: assets.output,
    amount: "10000000000000000000",
    router: ROUTER,
    recipient: WALLET,
    funder: WALLET,
    slippageBps: 50,
    ttlMs: 60_000,
    ...overrides,
  };
}

function indicativeResponse(overrides = {}) {
  return {
    indicativeQuoteId: "quote-1",
    quoteType: "indicative",
    operation: "swap",
    intent: "exact-input",
    pricedAt: "2026-07-26T19:03:57.519Z",
    validUntil: "2026-07-26T19:04:07.519Z",
    stateSnapshot: {
      poolId: POOL_ID,
      chainId: 97,
      poolAddress: POOL,
      blockNumber: "121438592",
      blockHash: `0x${"11".repeat(32)}`,
      tradingPaused: false,
    },
    input: {
      asset: "USDT-BSC-TESTNET",
      amount: "10",
      atomicAmount: "10000000000000000000",
      decimals: 18,
    },
    output: {
      asset: "SPCXB-BSC-TESTNET",
      amount: "0.084",
      atomicAmount: "84000000000000000",
      decimals: 18,
    },
    economics: { effectiveRate: "0.0084" },
    pricing: {
      venues: [
        {
          sourceId: "binance:SPCXBUSDT",
          venue: "binance",
          eligible: true,
          gasEstimate: null,
        },
      ],
    },
    warnings: [],
    ...overrides,
  };
}

test("BSC testnet catalog binds the deployed Set to stable RFQ asset ids", () => {
  const pool = loadPoolCatalog().find((entry) => entry.poolId === POOL_ID);
  assert.ok(pool);
  assert.equal(pool.chainId, 97);
  assert.equal(pool.poolAddress, POOL);
  const assets = resolvePoolRfqAssets(pool, USDT, SPCX);
  assert.equal(assets.input.id, "USDT-BSC-TESTNET");
  assert.equal(assets.output.id, "SPCXB-BSC-TESTNET");
  assert.equal(assets.input.decimals, 18);
});

test("indicative client uses the deployed RFQ API contract and decimal amounts", async () => {
  let captured;
  const client = new SetwiseRfqClient({
    baseUrl: "https://rfq.example",
    fetchImpl: async (url, init) => {
      captured = { url, body: JSON.parse(init.body) };
      return { ok: true, json: async () => indicativeResponse() };
    },
  });

  const response = await client.requestIndicativeQuote(request());
  assert.equal(captured.url, "https://rfq.example/v1/quotes/swaps");
  assert.deepEqual(captured.body, {
    poolId: POOL_ID,
    inputAsset: "USDT-BSC-TESTNET",
    outputAsset: "SPCXB-BSC-TESTNET",
    inputAmount: "10",
  });
  assert.equal(response.status, "available");
  assert.deepEqual(response.amounts, {
    input: "10000000000000000000",
    output: "84000000000000000",
  });
  assert.equal(response.price.venues[0].venue, "binance");
});

test("paused live Set responses fail closed before route selection", async () => {
  const client = new SetwiseRfqClient({
    baseUrl: "https://rfq.example",
    fetchImpl: async () => ({
      ok: true,
      json: async () =>
        indicativeResponse({
          stateSnapshot: {
            ...indicativeResponse().stateSnapshot,
            tradingPaused: true,
          },
        }),
    }),
  });
  const response = await client.requestIndicativeQuote(request());
  assert.equal(response.status, "paused");
  assert.equal(response.code, "TRADING_PAUSED");
});

test("firm client requests router execution and normalizes executable calldata", async () => {
  let captured;
  const client = new SetwiseRfqClient({
    baseUrl: "https://rfq.example",
    fetchImpl: async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return {
        ok: true,
        json: async () => ({
          firmQuoteId: `0x${"22".repeat(32)}`,
          quoteType: "firm",
          status: "executable",
          operation: "swap",
          intent: "exact-input",
          createdAt: "2026-07-26T19:03:57.519Z",
          mustSubmitBy: "2026-07-26T19:04:57.519Z",
          stateSnapshot: indicativeResponse().stateSnapshot,
          input: indicativeResponse().input,
          output: indicativeResponse().output,
          requirements: {
            sender: WALLET,
            approvals: [
              {
                token: USDT,
                spender: ROUTER,
                minimumAtomicAmount: "10000000000000000000",
              },
            ],
          },
          warnings: [],
          transaction: {
            chainId: 97,
            to: ROUTER,
            data: "0xa6022e95",
            value: "0",
          },
        }),
      };
    },
  });

  const response = await client.requestFirmQuote({
    ...request(),
    idempotencyKey: "issue-28-canary",
  });
  assert.equal(captured.url, "https://rfq.example/v1/firm-quotes/swaps");
  assert.equal(captured.body.execution, "router");
  assert.equal(captured.body.payer, WALLET);
  assert.equal(captured.body.router, ROUTER);
  assert.equal(captured.init.headers["Idempotency-Key"], "issue-28-canary");
  assert.equal(response.status, "available");
  assert.equal(response.approvalTarget, ROUTER);
  assert.equal(response.transaction.to, ROUTER);
  assert.equal(response.transaction.calldata, "0xa6022e95");
});

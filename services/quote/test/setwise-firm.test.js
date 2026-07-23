import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { NATIVE_TOKEN_SENTINEL } from "../../../config/native.mjs";
import {
  MockSetwiseRfqClient,
  SetwiseRfqClient,
} from "../src/setwise-rfq-client.js";
import {
  SetwiseFirmAdapter,
  createSetwiseFirmAdapter,
} from "../src/setwise-firm-adapter.js";
import { loadPoolCatalog } from "../src/setwise-pool-catalog.js";
import { runQuoteSources } from "../src/runner.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = (name) =>
  JSON.parse(readFileSync(join(packageRoot, "fixtures/setwise", name), "utf8"));

const NOW = "2026-07-22T20:00:00.000Z";
const now = () => NOW;
const address = (suffix) => `0x${suffix.padStart(40, "0")}`;
const scoped = (chainId, value) => ({ chainId, address: value });
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function request(overrides = {}) {
  return {
    apiVersion: "v1",
    chainId: 8453,
    tokenIn: scoped(8453, USDC),
    tokenOut: scoped(8453, WETH),
    router: scoped(8453, address("33")),
    mode: "exact-input",
    amount: "1000000",
    recipient: scoped(8453, address("44")),
    funder: scoped(8453, address("55")),
    slippage: { maxBps: 50 },
    ...overrides,
  };
}

function firm(overrides = {}) {
  return { ...fixture("firm-exact-input.response.json"), ...overrides };
}

function adapter(response = firm(), options = {}) {
  const pool = loadPoolCatalog().find((entry) => entry.poolId === "bstock-ai");
  return new SetwiseFirmAdapter(pool, {
    rfqClient: new MockSetwiseRfqClient({ firm: { "bstock-ai": response } }),
    ...options,
  });
}

test("firm client uses the swaps endpoint and passes the router binding", async () => {
  let captured;
  const client = new SetwiseRfqClient({
    baseUrl: "https://rfq.example",
    fetchImpl: async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return { ok: true, json: async () => firm() };
    },
  });

  await client.requestFirmQuote({
    poolId: "bstock-ai",
    chainId: 8453,
    mode: "exact-input",
    tokenIn: USDC,
    tokenOut: WETH,
    amount: "1000000",
    router: address("33"),
    recipient: address("44"),
    funder: address("55"),
    slippageBps: 50,
    ttlMs: 60_000,
  });

  assert.equal(captured.url, "https://rfq.example/v1/quotes/swaps");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.body.poolId, "bstock-ai");
  assert.equal(captured.body.router, address("33"));
  assert.equal(captured.body.ttlMs, 60_000);
});

test("Set firm adapter is executable only for firm requests", async () => {
  const set = adapter();
  assert.equal(set.displayName, "Set");
  assert.equal(set.poolId, "bstock-ai");
  assert.equal(set.supports(8453, "exact-input", "firm"), true);
  assert.equal(set.supports(8453, "exact-input", "indicative"), false);

  const result = await set.quote(request(), {
    kind: "firm",
    now,
    chainConfig: { chainId: 8453 },
  });
  assert.equal(result.status, "available");
  assert.equal(result.quote.kind, "firm");
  assert.equal(result.quote.amounts.input, "1000000");
  assert.equal(result.quote.amounts.output, "2515000");
  assert.deepEqual(result.quote.approvalTarget, request().router);
  assert.equal(result.transaction.to, request().router.address);
});

test("preserves the exact-output side when normalizing a firm quote", async () => {
  const req = request({
    mode: "exact-output",
    amount: "2515000",
  });
  const result = await adapter(
    firm({
      mode: "exact-output",
      amounts: { input: "1005000", output: "2515000" },
    }),
  ).quote(req, {
    kind: "firm",
    now,
    chainConfig: { chainId: 8453 },
  });

  assert.equal(result.quote.amounts.output, "2515000");
  assert.equal(result.quote.amounts.limit, "1010025");
});

test("rejects stale, mismatched approval, signer, and inventory responses", async (t) => {
  const cases = [
    {
      name: "stale",
      response: firm({ expiresAt: "2026-07-22T19:59:59.000Z" }),
      status: "stale",
      code: "FIRM_QUOTE_STALE",
    },
    {
      name: "approval mismatch",
      response: firm({ approvalTarget: address("99") }),
      status: "unavailable",
      code: "APPROVAL_TARGET_MISMATCH",
    },
    {
      name: "signer",
      response: firm({
        status: "unavailable",
        code: "SIGNER_UNAVAILABLE",
        message: "signer unavailable",
      }),
      status: "unavailable",
      code: "SIGNER_UNAVAILABLE",
    },
    {
      name: "inventory",
      response: firm({
        status: "unavailable",
        code: "INSUFFICIENT_INVENTORY",
        message: "inventory unavailable",
      }),
      status: "unavailable",
      code: "INSUFFICIENT_INVENTORY",
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const result = await adapter(item.response).quote(request(), {
        kind: "firm",
        now,
        chainConfig: { chainId: 8453 },
      });
      assert.equal(result.status, item.status);
      assert.ok(result.evidence.some((entry) => entry.code === item.code));
    });
  }
});

test("native input never requires an approval target", async () => {
  const req = request({
    tokenIn: scoped(8453, NATIVE_TOKEN_SENTINEL),
    tokenOut: scoped(8453, USDC),
  });
  const result = await adapter(
    firm({
      amounts: { input: "1000000", output: "2515000" },
      approvalTarget: address("99"),
    }),
  ).quote(req, {
    kind: "firm",
    now,
    chainConfig: { chainId: 8453 },
  });
  assert.equal(result.status, "available");
  assert.equal(result.quote.approvalTarget, null);
});

test("runner keeps Set indicative attempts non-executable", async () => {
  const set = adapter();
  const { sources, transactions } = await runQuoteSources([set], request(), {
    kind: "indicative",
    now,
  });
  assert.equal(sources[0].status, "excluded");
  assert.deepEqual(transactions, {});
});

test("creates a firm adapter by internal poolId", () => {
  const set = createSetwiseFirmAdapter(8453, "bstock-ai", {
    rfqClient: new MockSetwiseRfqClient({}),
  });
  assert.ok(set);
  assert.equal(set.describe().displayName, "Set");
  assert.equal(set.describe().poolId, "bstock-ai");
});

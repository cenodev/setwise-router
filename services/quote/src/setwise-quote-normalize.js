/**
 * Normalize Setwise RFQ indicative responses into the unified quote schema (issue #19).
 */

import { resolveNativeAsset } from "../../../config/native.mjs";

/**
 * @typedef {Object} SetwiseRfqIndicativeResponse
 * @property {string} poolId
 * @property {number} chainId
 * @property {string} mode
 * @property {string} status
 * @property {{ input: string, output: string }} amounts
 * @property {{ estimatedUnits: string, estimatedCost: string }} [gas]
 * @property {Array<object>} [fees]
 * @property {object} [inventory]
 * @property {object} [price]
 * @property {Array<{ code: string, message: string }>} [warnings]
 * @property {string} [validUntil]
 * @property {string} [observedAt]
 * @property {string} [message]
 * @property {string} [code]
 */

function applySlippageLimit(mode, amounts, maxBps) {
  const input = BigInt(amounts.input);
  const output = BigInt(amounts.output);
  const bps = BigInt(maxBps);
  if (mode === "exact-input") {
    const limit = (output * (10_000n - bps)) / 10_000n;
    return { input: amounts.input, output: amounts.output, limit: limit.toString() };
  }
  const limit = (input * (10_000n + bps)) / 10_000n;
  return { input: amounts.input, output: amounts.output, limit: limit.toString() };
}

/**
 * @param {string} observedAt
 * @param {string} [validUntil]
 * @param {number} [staleAfterMs]
 * @param {() => string} now
 * @returns {boolean}
 */
export function isIndicativeQuoteStale(observedAt, validUntil, staleAfterMs, now) {
  const clock = Date.parse(now());
  if (validUntil && Number.isFinite(Date.parse(validUntil))) {
    return Date.parse(validUntil) < clock;
  }
  if (observedAt && Number.isFinite(Date.parse(observedAt)) && staleAfterMs > 0) {
    return Date.parse(observedAt) + staleAfterMs < clock;
  }
  return false;
}

/**
 * Map an RFQ indicative payload to a schema-shaped normalized quote.
 *
 * @param {object} request  Validated v1 quote request.
 * @param {SetwiseRfqIndicativeResponse} rfq
 * @returns {object}
 */
export function normalizeIndicativeQuote(request, rfq) {
  const amounts = applySlippageLimit(request.mode, rfq.amounts, request.slippage.maxBps);
  const exactSide = request.mode === "exact-input" ? "input" : "output";
  amounts[exactSide] = request.amount;

  return {
    kind: "indicative",
    amounts,
    gas: rfq.gas ?? { estimatedUnits: "0", estimatedCost: "0" },
    fees: rfq.fees ?? [],
    approvalTarget: null,
    expiresAt: null,
  };
}

/**
 * Build structured evidence for a Set indicative quote attempt.
 *
 * @param {object} params
 * @param {import("./setwise-pool-catalog.js").SetwisePoolRecord} params.pool
 * @param {SetwiseRfqIndicativeResponse} [params.rfq]
 * @param {string} params.observedAt
 * @param {string} [params.outcome] included | excluded | stale | paused | unavailable
 * @param {string} [params.code]
 * @param {string} [params.message]
 * @returns {Array<object>}
 */
export function buildSetwiseEvidence({
  pool,
  rfq,
  observedAt,
  outcome = "included",
  code,
  message,
}) {
  const evidence = [
    {
      kind: "http",
      observedAt,
      reference: `set:${pool.poolId}:indicative`,
      code: code ?? outcome.toUpperCase(),
      message:
        message ??
        `Set pool ${pool.poolId} indicative quote ${outcome} on chain ${pool.chainId}`,
    },
    {
      kind: "policy",
      observedAt,
      reference: `pool:${pool.poolId}@${pool.chainId}`,
      code: "POOL_IDENTITY",
      message: `poolAddress=${pool.poolAddress}`,
    },
  ];

  if (rfq?.inventory) {
    evidence.push({
      kind: "simulation",
      observedAt: rfq.inventory.observedAt ?? observedAt,
      reference: `inventory:${pool.poolId}`,
      blockNumber: rfq.inventory.blockNumber,
      code: "INVENTORY_SNAPSHOT",
      message: JSON.stringify(rfq.inventory.balances ?? {}),
    });
  }

  if (rfq?.price) {
    evidence.push({
      kind: "policy",
      observedAt,
      reference: `price:${pool.poolId}`,
      code: "PRICE_DECOMPOSITION",
      message: JSON.stringify(rfq.price),
    });
  }

  for (const warning of rfq?.warnings ?? []) {
    evidence.push({
      kind: "policy",
      observedAt,
      reference: `warning:${pool.poolId}:${warning.code}`,
      code: warning.code,
      message: warning.message,
    });
  }

  return evidence;
}

/**
 * Resolve request token addresses to the on-chain assets the RFQ API expects.
 *
 * @param {object} request
 * @returns {{ tokenIn: string, tokenOut: string }}
 */
export function resolveRfqAssets(request) {
  return {
    tokenIn: resolveNativeAsset(request.chainId, request.tokenIn.address),
    tokenOut: resolveNativeAsset(request.chainId, request.tokenOut.address),
  };
}

/**
 * Normalize Setwise RFQ indicative responses into the unified quote schema (issue #19).
 */

import { isNativeAsset, resolveNativeAsset } from "../../../config/native.mjs";
import { slippageLimit } from "./rounding.js";

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

/**
 * @typedef {SetwiseRfqIndicativeResponse & {
 *   expiresAt: string,
 *   approvalTarget?: string,
 *   transaction: { chainId?: number, to: string, calldata?: string, data?: string, value?: string }
 * }} SetwiseRfqFirmResponse
 */

function applySlippageLimit(mode, amounts, maxBps) {
  // exact-input protects the minimum output (floor); exact-output protects the
  // maximum input (ceil) so the limit never under-cuts the required input.
  const limit =
    mode === "exact-input"
      ? slippageLimit("exact-input", amounts.output, maxBps)
      : slippageLimit("exact-output", amounts.input, maxBps);
  return { input: amounts.input, output: amounts.output, limit };
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

function sameAddress(left, right) {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    left.toLowerCase() === right.toLowerCase()
  );
}

/**
 * Normalize a short-lived Set firm quote. ERC-20 input is approved only to the
 * requested router; native input never exposes an approval target.
 *
 * @param {object} request
 * @param {SetwiseRfqFirmResponse} rfq
 * @returns {object}
 */
export function normalizeFirmQuote(request, rfq) {
  if (!rfq?.amounts || typeof rfq.expiresAt !== "string") {
    throw new Error("Set firm quote requires amounts and expiresAt");
  }
  const nativeInput = isNativeAsset(request.tokenIn.address);
  const approvalTarget = nativeInput
    ? null
    : rfq.approvalTarget ?? request.router.address;
  if (!nativeInput && !sameAddress(approvalTarget, request.router.address)) {
    const error = new Error("Set firm approval target does not match the requested router");
    error.code = "APPROVAL_TARGET_MISMATCH";
    throw error;
  }

  const amounts = applySlippageLimit(
    request.mode,
    rfq.amounts,
    request.slippage.maxBps,
  );
  const exactSide = request.mode === "exact-input" ? "input" : "output";
  amounts[exactSide] = request.amount;

  return {
    kind: "firm",
    amounts,
    gas: rfq.gas ?? { estimatedUnits: "0", estimatedCost: "0" },
    fees: rfq.fees ?? [],
    approvalTarget: nativeInput ? null : request.router,
    expiresAt: rfq.expiresAt,
  };
}

/**
 * Normalize and bind the executable payload to the exact request router.
 *
 * @param {object} request
 * @param {SetwiseRfqFirmResponse} rfq
 * @returns {object}
 */
export function normalizeFirmTransaction(request, rfq) {
  const transaction = rfq?.transaction;
  if (!transaction || !sameAddress(transaction.to, request.router.address)) {
    const error = new Error("Set firm transaction target does not match the requested router");
    error.code = "ROUTER_MISMATCH";
    throw error;
  }
  if (
    transaction.chainId !== undefined &&
    transaction.chainId !== request.chainId
  ) {
    const error = new Error("Set firm transaction chain does not match the request");
    error.code = "CHAIN_MISMATCH";
    throw error;
  }
  return {
    chainId: request.chainId,
    to: request.router.address,
    calldata: transaction.calldata ?? transaction.data,
    value: transaction.value ?? "0",
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
 * @param {"indicative"|"firm"} [params.kind]
 * @returns {Array<object>}
 */
export function buildSetwiseEvidence({
  pool,
  rfq,
  observedAt,
  outcome = "included",
  code,
  message,
  kind = "indicative",
}) {
  const evidence = [
    {
      kind: "http",
      observedAt,
      reference: `set:${pool.poolId}:${kind}`,
      code: code ?? outcome.toUpperCase(),
      message:
        message ??
        `Set pool ${pool.poolId} ${kind} quote ${outcome} on chain ${pool.chainId}`,
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

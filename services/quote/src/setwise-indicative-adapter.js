/**
 * Setwise indicative pricing route-source adapter (issue #19).
 *
 * Discovers eligible Set pools per chain, requests exact-input and exact-output
 * indicative quotes from the external RFQ API, and normalizes pool identity,
 * inventory snapshots, price decomposition, warnings, and validity into the
 * unified comparison schema. Indicative quotes are never executable: the adapter
 * declares only the indicative quote kind and always returns approvalTarget=null.
 */

import { QuoteSourceAdapter } from "./adapter.js";
import {
  discoverEligiblePools,
  getPoolById,
  loadPoolCatalog,
  rejectSelfReferentialRoute,
  validatePoolIdentity,
  validateSupportedAssets,
} from "./setwise-pool-catalog.js";
import {
  buildSetwiseEvidence,
  isIndicativeQuoteStale,
  normalizeIndicativeQuote,
  resolveRfqAssets,
} from "./setwise-quote-normalize.js";
import { SetwiseRfqClient } from "./setwise-rfq-client.js";

/** Default staleness window when the RFQ omits validUntil. */
export const DEFAULT_INDICATIVE_STALE_MS = 30_000;

/**
 * @typedef {import("./setwise-pool-catalog.js").SetwisePoolRecord} SetwisePoolRecord
 * @typedef {import("./setwise-rfq-client.js").SetwiseRfqClient|import("./setwise-rfq-client.js").MockSetwiseRfqClient} RfqClient
 */

export class SetwiseIndicativeAdapter extends QuoteSourceAdapter {
  /**
   * @param {SetwisePoolRecord} pool
   * @param {object} [options]
   * @param {RfqClient} [options.rfqClient]
   * @param {number} [options.staleAfterMs]
   */
  constructor(pool, options = {}) {
    super(
      {
        id: `set-${pool.poolId}`,
        type: "setwise",
        displayName: "Set",
        poolId: pool.poolId,
      },
      {
        capabilities: {
          chains: [pool.chainId],
          modes: ["exact-input", "exact-output"],
          kinds: ["indicative"],
        },
        timeoutMs: options.timeoutMs,
      },
    );
    this.pool = pool;
    this.rfqClient = options.rfqClient ?? new SetwiseRfqClient(options);
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_INDICATIVE_STALE_MS;
  }

  async health(context) {
    const checkedAt = context?.now ? context.now() : new Date().toISOString();
    const identity = validatePoolIdentity(this.pool, context?.chainConfig?.chainId ?? this.pool.chainId);
    return {
      status: identity.valid ? "healthy" : "degraded",
      checkedAt,
      latencyMs: 0,
      detail: identity.valid ? undefined : identity.message,
    };
  }

  async quote(request, context) {
    const observedAt = context.now();
    const identity = validatePoolIdentity(this.pool, request.chainId);
    if (!identity.valid) {
      return {
        status: "unavailable",
        quote: null,
        evidence: buildSetwiseEvidence({
          pool: this.pool,
          observedAt,
          outcome: "excluded",
          code: identity.code,
          message: identity.message,
        }),
      };
    }

    const assets = resolveRfqAssets(request);
    const selfRef = rejectSelfReferentialRoute(
      this.pool,
      assets.tokenIn,
      assets.tokenOut,
    );
    if (!selfRef.valid) {
      return {
        status: "unavailable",
        quote: null,
        evidence: buildSetwiseEvidence({
          pool: this.pool,
          observedAt,
          outcome: "excluded",
          code: selfRef.code,
          message: selfRef.message,
        }),
      };
    }

    const supported = validateSupportedAssets(
      this.pool,
      assets.tokenIn,
      assets.tokenOut,
    );
    if (!supported.supported) {
      return {
        status: "unavailable",
        quote: null,
        evidence: buildSetwiseEvidence({
          pool: this.pool,
          observedAt,
          outcome: "excluded",
          code: supported.code,
          message: supported.message,
        }),
      };
    }

    let rfq;
    try {
      rfq = await this.rfqClient.requestIndicativeQuote(
        {
          poolId: this.pool.poolId,
          chainId: request.chainId,
          mode: request.mode,
          tokenIn: assets.tokenIn,
          tokenOut: assets.tokenOut,
          amount: request.amount,
          recipient: request.recipient.address,
          funder: request.funder.address,
        },
        context.signal,
      );
    } catch (error) {
      return {
        status: "unavailable",
        quote: null,
        evidence: buildSetwiseEvidence({
          pool: this.pool,
          observedAt,
          outcome: "unavailable",
          code: error?.code ?? "RFQ_ERROR",
          message: error?.message ?? "Set indicative quote request failed",
        }),
      };
    }

    if (rfq.chainId !== request.chainId || rfq.poolId !== this.pool.poolId) {
      return {
        status: "unavailable",
        quote: null,
        evidence: buildSetwiseEvidence({
          pool: this.pool,
          rfq,
          observedAt,
          outcome: "excluded",
          code: "POOL_IDENTITY_MISMATCH",
          message: "RFQ response pool or chain does not match the adapter",
        }),
      };
    }

    if (rfq.status === "paused" || rfq.code === "TRADING_PAUSED") {
      return {
        status: "unavailable",
        quote: null,
        evidence: buildSetwiseEvidence({
          pool: this.pool,
          rfq,
          observedAt,
          outcome: "paused",
          code: "TRADING_PAUSED",
          message: rfq.message ?? "Set pool trading is paused",
        }),
      };
    }

    if (rfq.status === "unavailable") {
      return {
        status: "unavailable",
        quote: null,
        evidence: buildSetwiseEvidence({
          pool: this.pool,
          rfq,
          observedAt,
          outcome: "unavailable",
          code: rfq.code ?? "NO_LIQUIDITY",
          message: rfq.message ?? "Set pool declined the indicative quote",
        }),
      };
    }

    const stale = isIndicativeQuoteStale(
      rfq.inventory?.observedAt ?? rfq.observedAt ?? observedAt,
      rfq.validUntil,
      this.staleAfterMs,
      context.now,
    );
    if (rfq.status === "stale" || stale) {
      return {
        status: "stale",
        quote: normalizeIndicativeQuote(request, rfq),
        evidence: buildSetwiseEvidence({
          pool: this.pool,
          rfq,
          observedAt,
          outcome: "stale",
          code: "STALE_INVENTORY",
          message: "Set indicative quote inventory is stale",
        }),
      };
    }

    if (rfq.status !== "available" || !rfq.amounts) {
      return {
        status: "unavailable",
        quote: null,
        evidence: buildSetwiseEvidence({
          pool: this.pool,
          rfq,
          observedAt,
          outcome: "unavailable",
          code: rfq.code ?? "INVALID_RFQ_RESPONSE",
          message: rfq.message ?? "Set indicative quote response was incomplete",
        }),
      };
    }

    return {
      status: "available",
      quote: normalizeIndicativeQuote(request, rfq),
      evidence: buildSetwiseEvidence({
        pool: this.pool,
        rfq,
        observedAt,
        outcome: "included",
      }),
      poolId: this.pool.poolId,
    };
  }
}

/**
 * Create one indicative adapter per eligible pool on a chain.
 *
 * @param {number} chainId
 * @param {object} [options]
 * @param {object} [options.chainConfig]
 * @param {readonly SetwisePoolRecord[]} [options.catalog]
 * @param {readonly string[]} [options.registryPools]
 * @param {RfqClient} [options.rfqClient]
 * @param {number} [options.staleAfterMs]
 * @returns {SetwiseIndicativeAdapter[]}
 */
export function createSetwiseIndicativeAdapters(chainId, options = {}) {
  const pools = discoverEligiblePools(chainId, options.chainConfig ?? {}, options);
  return pools.map((pool) => new SetwiseIndicativeAdapter(pool, options));
}

/**
 * Create indicative adapters for every enabled pool in the catalog.
 *
 * @param {object} [options]
 * @param {readonly SetwisePoolRecord[]} [options.catalog]
 * @param {RfqClient} [options.rfqClient]
 * @returns {SetwiseIndicativeAdapter[]}
 */
export function createAllSetwiseIndicativeAdapters(options = {}) {
  const catalog = options.catalog ?? loadPoolCatalog();
  const chainIds = [...new Set(catalog.filter((pool) => pool.enabled).map((p) => p.chainId))];
  return chainIds.flatMap((chainId) =>
    createSetwiseIndicativeAdapters(chainId, { ...options, catalog }),
  );
}

/**
 * Look up a single pool and build its indicative adapter.
 *
 * @param {number} chainId
 * @param {string} poolId
 * @param {object} [options]
 * @returns {SetwiseIndicativeAdapter|null}
 */
export function createSetwiseIndicativeAdapter(chainId, poolId, options = {}) {
  const catalog = options.catalog ?? loadPoolCatalog();
  const pool = getPoolById(catalog, chainId, poolId);
  if (!pool || !pool.enabled) return null;
  return new SetwiseIndicativeAdapter(pool, options);
}

export { discoverEligiblePools, getPoolById, loadPoolCatalog };

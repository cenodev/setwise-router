/**
 * Short-lived executable Set quote adapter (issue #23).
 *
 * This adapter is intentionally separate from indicative pricing so the
 * selection workflow can compare cheap indications first and invoke firming
 * only for a competitive Set.
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
  normalizeFirmQuote,
  normalizeFirmTransaction,
  resolveRfqAssets,
} from "./setwise-quote-normalize.js";
import { SetwiseRfqClient } from "./setwise-rfq-client.js";

/** Requested lifetime for a short-lived Set firm quote. */
export const DEFAULT_SET_FIRM_TTL_MS = 60_000;

function unavailable(pool, observedAt, code, message, rfq) {
  return {
    status: "unavailable",
    quote: null,
    evidence: buildSetwiseEvidence({
      pool,
      rfq,
      observedAt,
      outcome: "unavailable",
      code,
      message,
      kind: "firm",
    }),
  };
}

export class SetwiseFirmAdapter extends QuoteSourceAdapter {
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
          kinds: ["firm"],
        },
        timeoutMs: options.timeoutMs,
      },
    );
    this.pool = pool;
    this.rfqClient = options.rfqClient ?? new SetwiseRfqClient(options);
    this.firmTtlMs = options.firmTtlMs ?? DEFAULT_SET_FIRM_TTL_MS;
  }

  async health(context) {
    const checkedAt = context?.now ? context.now() : new Date().toISOString();
    const identity = validatePoolIdentity(
      this.pool,
      context?.chainConfig?.chainId ?? this.pool.chainId,
    );
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
      return unavailable(
        this.pool,
        observedAt,
        identity.code,
        identity.message,
      );
    }

    const assets = resolveRfqAssets(request);
    const selfRef = rejectSelfReferentialRoute(
      this.pool,
      assets.tokenIn,
      assets.tokenOut,
    );
    if (!selfRef.valid) {
      return unavailable(
        this.pool,
        observedAt,
        selfRef.code,
        selfRef.message,
      );
    }
    const supported = validateSupportedAssets(
      this.pool,
      assets.tokenIn,
      assets.tokenOut,
    );
    if (!supported.supported) {
      return unavailable(
        this.pool,
        observedAt,
        supported.code,
        supported.message,
      );
    }

    let rfq;
    try {
      rfq = await this.rfqClient.requestFirmQuote(
        {
          poolId: this.pool.poolId,
          chainId: request.chainId,
          mode: request.mode,
          tokenIn: assets.tokenIn,
          tokenOut: assets.tokenOut,
          amount: request.amount,
          router: request.router.address,
          recipient: request.recipient.address,
          funder: request.funder.address,
          slippageBps: request.slippage.maxBps,
          ttlMs: this.firmTtlMs,
        },
        context.signal,
      );
    } catch (error) {
      return unavailable(
        this.pool,
        observedAt,
        error?.code ?? "RFQ_ERROR",
        error?.message ?? "Set firm quote request failed",
      );
    }

    if (
      rfq.chainId !== request.chainId ||
      rfq.poolId !== this.pool.poolId ||
      rfq.mode !== request.mode
    ) {
      return unavailable(
        this.pool,
        observedAt,
        "POOL_IDENTITY_MISMATCH",
        "RFQ response pool, chain, or mode does not match the request",
        rfq,
      );
    }
    if (rfq.status !== "available") {
      return unavailable(
        this.pool,
        observedAt,
        rfq.code ?? "FIRM_QUOTE_UNAVAILABLE",
        rfq.message ?? "Set declined the firm quote",
        rfq,
      );
    }

    let quote;
    let transaction;
    try {
      quote = normalizeFirmQuote(request, rfq);
      transaction = normalizeFirmTransaction(request, rfq);
    } catch (error) {
      return unavailable(
        this.pool,
        observedAt,
        error?.code ?? "INVALID_FIRM_QUOTE",
        error?.message ?? "Set firm quote response was incomplete",
        rfq,
      );
    }

    const expiresAt = Date.parse(quote.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.parse(context.now())) {
      return {
        status: "stale",
        quote,
        transaction: null,
        evidence: buildSetwiseEvidence({
          pool: this.pool,
          rfq,
          observedAt,
          outcome: "stale",
          code: "FIRM_QUOTE_STALE",
          message: "Set firm quote has expired",
          kind: "firm",
        }),
      };
    }

    return {
      status: "available",
      quote,
      transaction,
      evidence: buildSetwiseEvidence({
        pool: this.pool,
        rfq,
        observedAt,
        outcome: "included",
        kind: "firm",
      }),
      poolId: this.pool.poolId,
    };
  }
}

export function createSetwiseFirmAdapters(chainId, options = {}) {
  const pools = discoverEligiblePools(chainId, options.chainConfig ?? {}, options);
  return pools.map((pool) => new SetwiseFirmAdapter(pool, options));
}

export function createAllSetwiseFirmAdapters(options = {}) {
  const catalog = options.catalog ?? loadPoolCatalog();
  const chainIds = [
    ...new Set(catalog.filter((pool) => pool.enabled).map((pool) => pool.chainId)),
  ];
  return chainIds.flatMap((chainId) =>
    createSetwiseFirmAdapters(chainId, { ...options, catalog }),
  );
}

export function createSetwiseFirmAdapter(chainId, poolId, options = {}) {
  const catalog = options.catalog ?? loadPoolCatalog();
  const pool = getPoolById(catalog, chainId, poolId);
  if (!pool || !pool.enabled) return null;
  return new SetwiseFirmAdapter(pool, options);
}

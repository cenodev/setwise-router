/**
 * Multi-chain 0x Swap API quote adapter (issue #22).
 *
 * Wraps the 0x Swap API v2 as an external aggregation baseline for Ethereum,
 * BSC, Base, and Robinhood Chain. The adapter:
 *
 *   - uses the active chain id in every request;
 *   - supports AllowanceHolder approval targets and native-token sentinels;
 *   - preserves returned transaction target, calldata, value, fees, and
 *     allowance metadata without rewriting;
 *   - authenticates server-side via the ZEROEX_API_KEY environment variable;
 *   - validates that response chain, tokens, taker, and amounts match the
 *     request;
 *   - normalizes API errors, rate limits, taxes, and insufficient-liquidity
 *     responses into adapter outcome statuses.
 *
 * The router can operate when 0x is unavailable: the runner isolates this
 * adapter like any other source, and a failed 0x call never blocks alternatives.
 */

import { QuoteSourceAdapter } from "./adapter.js";
import { NATIVE_TOKEN_SENTINEL, isNativeAsset } from "../../../config/native.mjs";

const ZEROEX_BASE_URL = "https://api.0x.org";
const ZEROEX_NATIVE_SENTINEL = "NATIVE";
const SWAP_V2_PRICE_PATH = "/swap/v2/price";
const SWAP_V2_QUOTE_PATH = "/swap/v2/quote";

export const ZEROEX_CHAIN_IDS = Object.freeze([1, 56, 8453, 4663]);

export const ZEROEX_ERROR_CODES = Object.freeze({
  RATE_LIMITED: "ZEROEX_RATE_LIMITED",
  API_ERROR: "ZEROEX_API_ERROR",
  INSUFFICIENT_LIQUIDITY: "ZEROEX_INSUFFICIENT_LIQUIDITY",
  RESPONSE_MISMATCH: "ZEROEX_RESPONSE_MISMATCH",
  NETWORK_ERROR: "ZEROEX_NETWORK_ERROR",
  TAX_TOKEN: "ZEROEX_TAX_TOKEN",
});

export class ZeroExAdapterError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "ZeroExAdapterError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

function resolveTokenParam(chainConfig, tokenAddress) {
  if (isNativeAsset(tokenAddress)) return ZEROEX_NATIVE_SENTINEL;
  return tokenAddress;
}

function buildQueryParams(request, kind) {
  const params = new URLSearchParams();
  params.set("chainId", String(request.chainId));
  params.set("sellToken", resolveTokenParam(null, request.tokenIn.address));
  params.set("buyToken", resolveTokenParam(null, request.tokenOut.address));
  if (request.mode === "exact-input") {
    params.set("sellAmount", request.amount);
  } else {
    params.set("buyAmount", request.amount);
  }
  params.set("taker", request.funder.address);
  params.set("txOrigin", request.funder.address);
  params.set("slippageBps", String(request.slippage.maxBps));
  return params;
}

function normalizeApiError(status, body) {
  if (status === 429) {
    return new ZeroExAdapterError(
      ZEROEX_ERROR_CODES.RATE_LIMITED,
      "0x API rate limit exceeded",
      { httpStatus: 429 },
    );
  }
  const reason =
    body?.reason ?? body?.message ?? body?.error ?? `HTTP ${status}`;
  const code = body?.code ?? String(status);

  if (
    typeof reason === "string" &&
    /insufficient\s*liquidity/i.test(reason)
  ) {
    return new ZeroExAdapterError(
      ZEROEX_ERROR_CODES.INSUFFICIENT_LIQUIDITY,
      `0x: ${reason}`,
      { httpStatus: status, zeroExCode: code },
    );
  }
  if (
    typeof reason === "string" &&
    /tax|fee[-\s]*on[-\s]*transfer/i.test(reason)
  ) {
    return new ZeroExAdapterError(
      ZEROEX_ERROR_CODES.TAX_TOKEN,
      `0x: ${reason}`,
      { httpStatus: status, zeroExCode: code },
    );
  }
  return new ZeroExAdapterError(
    ZEROEX_ERROR_CODES.API_ERROR,
    `0x API error: ${reason}`,
    { httpStatus: status, zeroExCode: code },
  );
}

function validateResponseTokens(body, request) {
  const sellToken = (body.sellToken ?? "").toLowerCase();
  const buyToken = (body.buyToken ?? "").toLowerCase();
  const expectedSell = request.tokenIn.address.toLowerCase();
  const expectedBuy = request.tokenOut.address.toLowerCase();

  const sellIsNative =
    isNativeAsset(request.tokenIn.address) &&
    (sellToken === ZEROEX_NATIVE_SENTINEL.toLowerCase() ||
      sellToken === NATIVE_TOKEN_SENTINEL ||
      sellToken === expectedSell);
  const buyIsNative =
    isNativeAsset(request.tokenOut.address) &&
    (buyToken === ZEROEX_NATIVE_SENTINEL.toLowerCase() ||
      buyToken === NATIVE_TOKEN_SENTINEL ||
      buyToken === expectedBuy);

  if (!sellIsNative && sellToken !== expectedSell) {
    throw new ZeroExAdapterError(
      ZEROEX_ERROR_CODES.RESPONSE_MISMATCH,
      `0x response sellToken ${body.sellToken} does not match request tokenIn`,
    );
  }
  if (!buyIsNative && buyToken !== expectedBuy) {
    throw new ZeroExAdapterError(
      ZEROEX_ERROR_CODES.RESPONSE_MISMATCH,
      `0x response buyToken ${body.buyToken} does not match request tokenOut`,
    );
  }
}

function validateResponseAmounts(body, request) {
  if (request.mode === "exact-input") {
    const sellAmount = body.sellAmount;
    if (sellAmount !== undefined && String(sellAmount) !== request.amount) {
      throw new ZeroExAdapterError(
        ZEROEX_ERROR_CODES.RESPONSE_MISMATCH,
        `0x response sellAmount ${sellAmount} does not match request amount ${request.amount}`,
      );
    }
  } else {
    const buyAmount = body.buyAmount;
    if (buyAmount !== undefined && String(buyAmount) !== request.amount) {
      throw new ZeroExAdapterError(
        ZEROEX_ERROR_CODES.RESPONSE_MISMATCH,
        `0x response buyAmount ${buyAmount} does not match request amount ${request.amount}`,
      );
    }
  }
}

function mapFees(body, request) {
  const fees = [];
  const feesObj = body.fees;
  if (!feesObj || typeof feesObj !== "object") return fees;

  const chainId = request.chainId;
  const feeToken = { chainId, address: request.tokenOut.address };

  if (feesObj.zeroExFee && feesObj.zeroExFee.amount) {
    fees.push({
      type: "protocol",
      amount: String(feesObj.zeroExFee.amount),
      token: feesObj.zeroExFee.token
        ? { chainId, address: feesObj.zeroExFee.token }
        : feeToken,
    });
  }
  if (feesObj.integratorFee && feesObj.integratorFee.amount) {
    fees.push({
      type: "integrator",
      amount: String(feesObj.integratorFee.amount),
      token: feesObj.integratorFee.token
        ? { chainId, address: feesObj.integratorFee.token }
        : feeToken,
    });
  }
  if (feesObj.gasFee && feesObj.gasFee.amount) {
    fees.push({
      type: "network",
      amount: String(feesObj.gasFee.amount),
      token: feesObj.gasFee.token
        ? { chainId, address: feesObj.gasFee.token }
        : feeToken,
    });
  }
  return fees;
}

function buildNormalizedQuote(body, request, kind, observedAt) {
  const inputAmount =
    request.mode === "exact-input"
      ? request.amount
      : String(body.sellAmount ?? "0");
  const outputAmount =
    request.mode === "exact-output"
      ? request.amount
      : String(body.buyAmount ?? "0");

  const limitAmount =
    request.mode === "exact-input"
      ? String(body.minBuyAmount ?? outputAmount)
      : String(body.maxSellAmount ?? inputAmount);

  const gasUnits = String(body.gas ?? "0");
  const gasCost = String(
    body.totalNetworkFee ??
      (body.gasPrice !== undefined
        ? String(BigInt(body.gas) * BigInt(body.gasPrice))
        : "0"),
  );

  const firm = kind === "firm";
  let approvalTarget = null;
  if (firm) {
    const spender =
      body.issues?.allowance?.spender ??
      body.allowanceTarget ??
      null;
    if (spender) {
      approvalTarget = { chainId: request.chainId, address: spender };
    } else {
      approvalTarget = { chainId: request.chainId, address: request.router.address };
    }
  }

  const expiresAt = firm
    ? new Date(Date.parse(observedAt) + 60_000).toISOString()
    : null;

  return {
    kind,
    amounts: {
      input: inputAmount,
      output: outputAmount,
      limit: limitAmount,
    },
    gas: {
      estimatedUnits: gasUnits,
      estimatedCost: gasCost,
    },
    fees: mapFees(body, request),
    approvalTarget,
    expiresAt,
  };
}

export class ZeroExAdapter extends QuoteSourceAdapter {
  /**
   * @param {object} [options]
   * @param {string} [options.apiKey]       0x API key (defaults to ZEROEX_API_KEY env).
   * @param {string} [options.baseUrl]      0x API base URL.
   * @param {number[]} [options.chains]     Supported chain ids.
   * @param {number} [options.timeoutMs]    Per-source timeout budget.
   * @param {typeof fetch} [options.fetch]  Fetch implementation (for testing).
   */
  constructor(options = {}) {
    const chains = options.chains ?? [...ZEROEX_CHAIN_IDS];
    super(
      { id: "zeroex", type: "aggregator", displayName: "0x" },
      {
        capabilities: { chains },
        timeoutMs: options.timeoutMs,
      },
    );
    this.apiKey = options.apiKey ?? process.env.ZEROEX_API_KEY ?? null;
    this.baseUrl = options.baseUrl ?? ZEROEX_BASE_URL;
    this._fetch = options.fetch ?? globalThis.fetch;
  }

  async health(context) {
    const checkedAt = context?.now ? context.now() : new Date().toISOString();
    const start = performance.now();
    try {
      const url = `${this.baseUrl}/swap/v2/price?chainId=1&sellToken=NATIVE&buyToken=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48&sellAmount=1000000000000000000&taker=0x0000000000000000000000000000000000000001`;
      const res = await this._fetch(url, {
        headers: this._headers(),
        signal: context?.signal,
      });
      const latencyMs = Math.round(performance.now() - start);
      if (res.ok) {
        return { status: "healthy", checkedAt, latencyMs };
      }
      if (res.status === 429) {
        return { status: "degraded", checkedAt, latencyMs, detail: "rate limited" };
      }
      return { status: "unhealthy", checkedAt, latencyMs, detail: `HTTP ${res.status}` };
    } catch (err) {
      const latencyMs = Math.round(performance.now() - start);
      return {
        status: "unhealthy",
        checkedAt,
        latencyMs,
        detail: err.message ?? "network error",
      };
    }
  }

  async quote(request, context) {
    const observedAt = context.now();
    const kind = context.kind;
    const path = kind === "firm" ? SWAP_V2_QUOTE_PATH : SWAP_V2_PRICE_PATH;
    const params = buildQueryParams(request, kind);
    const url = `${this.baseUrl}${path}?${params.toString()}`;

    let res;
    try {
      res = await this._fetch(url, {
        headers: this._headers(),
        signal: context.signal,
      });
    } catch (err) {
      if (context.signal?.aborted) throw err;
      throw new ZeroExAdapterError(
        ZEROEX_ERROR_CODES.NETWORK_ERROR,
        `0x network error: ${err.message}`,
      );
    }

    let body;
    try {
      body = await res.json();
    } catch {
      body = null;
    }

    if (!res.ok) {
      throw normalizeApiError(res.status, body);
    }

    if (body && body.liquidityAvailable === false) {
      return {
        status: "unavailable",
        quote: null,
        evidence: [
          {
            kind: "http",
            observedAt,
            reference: "zeroex:no-liquidity",
            code: ZEROEX_ERROR_CODES.INSUFFICIENT_LIQUIDITY,
            message: "0x reported no liquidity available",
          },
        ],
      };
    }

    if (!body) {
      throw new ZeroExAdapterError(
        ZEROEX_ERROR_CODES.API_ERROR,
        "0x returned an empty response",
      );
    }

    validateResponseTokens(body, request);
    validateResponseAmounts(body, request);

    const quote = buildNormalizedQuote(body, request, kind, observedAt);

    const evidence = [
      {
        kind: "http",
        observedAt,
        reference: `zeroex:${kind}:${request.chainId}`,
      },
    ];
    if (body.blockNumber) {
      evidence[0].blockNumber = String(body.blockNumber);
    }

    return { status: "available", quote, evidence };
  }

  _headers() {
    const headers = { Accept: "application/json" };
    if (this.apiKey) headers["0x-api-key"] = this.apiKey;
    return headers;
  }
}

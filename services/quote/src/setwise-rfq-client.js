/**
 * HTTP client for the external Setwise RFQ pricing API (issues #19 and #23).
 *
 * The RFQ service remains outside this repository; the client isolates transport,
 * timeout, and response parsing so adapters and tests can inject a mock fetch.
 */

/**
 * @typedef {import("./setwise-quote-normalize.js").SetwiseRfqIndicativeResponse} SetwiseRfqIndicativeResponse
 * @typedef {import("./setwise-quote-normalize.js").SetwiseRfqFirmResponse} SetwiseRfqFirmResponse
 */

/**
 * @typedef {Object} IndicativeQuoteRequest
 * @property {string} poolId
 * @property {number} chainId
 * @property {string} mode
 * @property {string} tokenIn
 * @property {string} tokenOut
 * @property {{ id: string, address: string, decimals: number }} [inputAsset]
 * @property {{ id: string, address: string, decimals: number }} [outputAsset]
 * @property {string} amount
 * @property {string} recipient
 * @property {string} funder
 */

/**
 * @typedef {IndicativeQuoteRequest & {
 *   router: string,
 *   inputNative?: boolean,
 *   outputNative?: boolean,
 *   slippageBps: number,
 *   ttlMs: number
 * }} FirmQuoteRequest
 */

export class SetwiseRfqClient {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl]  Defaults to SETWISE_RFQ_API_URL env var.
   * @param {typeof fetch} [options.fetchImpl]
   * @param {number} [options.timeoutMs]
   */
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.SETWISE_RFQ_API_URL ?? "").replace(
      /\/$/,
      "",
    );
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  /**
   * @param {IndicativeQuoteRequest} request
   * @param {AbortSignal} [signal]
   * @returns {Promise<SetwiseRfqIndicativeResponse>}
   */
  async requestIndicativeQuote(request, signal) {
    const response = await this.#request(
      "/v1/quotes/swaps",
      swapRequestBody(request),
      signal,
    );
    return normalizeIndicativeRfqResponse(response, request);
  }

  /**
   * Request a short-lived, executable quote only after the Set indicative
   * quote has won the first comparison stage.
   *
   * @param {FirmQuoteRequest} request
   * @param {AbortSignal} [signal]
   * @returns {Promise<SetwiseRfqFirmResponse>}
   */
  async requestFirmQuote(request, signal) {
    const response = await this.#request(
      "/v1/firm-quotes/swaps",
      {
        ...swapRequestBody(request),
        payer: request.funder,
        recipient: request.recipient,
        execution: "router",
        router: request.router,
        inputNative: request.inputNative ?? false,
        outputNative: request.outputNative ?? false,
      },
      signal,
      {
        "Idempotency-Key":
          request.idempotencyKey ??
          `set-router:${globalThis.crypto.randomUUID()}`,
      },
    );
    return normalizeFirmRfqResponse(response, request);
  }

  async #request(path, request, signal, headers = {}) {
    if (!this.baseUrl) {
      throw new Error("SETWISE_RFQ_API_URL is not configured");
    }
    if (!this.fetchImpl) {
      throw new Error("fetch is not available");
    }

    const controller = new AbortController();
    const timeout =
      Number.isFinite(this.timeoutMs) && this.timeoutMs > 0
        ? setTimeout(() => controller.abort(), this.timeoutMs)
        : null;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });

    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}${path}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            ...headers,
          },
          body: JSON.stringify(request),
          signal: controller.signal,
        },
      );
      const body = await response.json();
      if (!response.ok) {
        const error = new Error(
          body?.error?.message ??
            body?.message ??
            `RFQ request failed (${response.status})`,
        );
        error.code = body?.error?.code ?? body?.code ?? "RFQ_HTTP_ERROR";
        throw error;
      }
      return body;
    } finally {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
}

function atomicToDecimal(amount, decimals) {
  if (!/^(0|[1-9][0-9]*)$/.test(amount)) {
    throw new Error("RFQ amount must be a canonical unsigned integer");
  }
  if (!Number.isInteger(decimals) || decimals <= 0) return amount;
  const padded = amount.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function swapRequestBody(request) {
  const amountField =
    request.mode === "exact-input" ? "inputAmount" : "outputAmount";
  const exactAsset =
    request.mode === "exact-input" ? request.inputAsset : request.outputAsset;
  return {
    poolId: request.poolId,
    inputAsset: request.inputAsset?.id ?? request.tokenIn,
    outputAsset: request.outputAsset?.id ?? request.tokenOut,
    [amountField]: atomicToDecimal(request.amount, exactAsset?.decimals ?? 0),
  };
}

function responseIdentity(response, request) {
  return {
    poolId: response.stateSnapshot?.poolId ?? response.poolId ?? request.poolId,
    chainId: response.stateSnapshot?.chainId ?? response.chainId ?? request.chainId,
    mode: response.intent ?? response.mode ?? request.mode,
  };
}

/**
 * Normalize the live Setwise RFQ API response while retaining support for the
 * original adapter fixture shape.
 */
export function normalizeIndicativeRfqResponse(response, request) {
  if (response?.amounts) return response;
  const identity = responseIdentity(response, request);
  const paused = response?.stateSnapshot?.tradingPaused === true;
  return {
    ...identity,
    status: paused ? "paused" : "available",
    ...(paused
      ? { code: "TRADING_PAUSED", message: "Set trading is paused" }
      : {}),
    amounts: {
      input: response.input?.atomicAmount,
      output: response.output?.atomicAmount,
    },
    gas: {
      estimatedUnits:
        response.pricing?.venues?.find((venue) => venue.gasEstimate)?.gasEstimate ??
        "0",
      estimatedCost: "0",
    },
    fees: [],
    inventory: {
      observedAt: response.pricedAt,
      blockNumber: response.stateSnapshot?.blockNumber,
      blockHash: response.stateSnapshot?.blockHash,
    },
    price: {
      economics: response.economics,
      venues: response.pricing?.venues ?? [],
    },
    warnings: response.warnings ?? [],
    observedAt: response.pricedAt,
    validUntil: response.validUntil,
  };
}

/** Normalize an executable router-mode firm response from the live RFQ API. */
export function normalizeFirmRfqResponse(response, request) {
  if (response?.amounts) return response;
  const identity = responseIdentity(response, request);
  const executable = response?.status === "executable";
  const approval = response?.requirements?.approvals?.[0];
  return {
    ...identity,
    status: executable ? "available" : "unavailable",
    ...(!executable
      ? {
          code:
            response?.status === "awaiting-signature"
              ? "SIGNATURE_PENDING"
              : "FIRM_QUOTE_UNAVAILABLE",
          message:
            response?.status === "awaiting-signature"
              ? "Set firm quote is awaiting an operational signature"
              : "Set firm quote is not executable",
        }
      : {}),
    amounts: {
      input: response.input?.atomicAmount,
      output: response.output?.atomicAmount,
    },
    gas: { estimatedUnits: "0", estimatedCost: "0" },
    fees: [],
    approvalTarget: approval?.spender ?? request.router,
    expiresAt: response.mustSubmitBy,
    inventory: {
      observedAt: response.createdAt,
      blockNumber: response.stateSnapshot?.blockNumber,
      blockHash: response.stateSnapshot?.blockHash,
    },
    warnings: (response.warnings ?? []).map((warning) =>
      typeof warning === "string"
        ? { code: "SET_WARNING", message: warning }
        : warning,
    ),
    transaction: response.transaction
      ? {
          chainId: response.transaction.chainId,
          to: response.transaction.to,
          calldata: response.transaction.calldata ?? response.transaction.data,
          value: response.transaction.value ?? "0",
        }
      : null,
  };
}

/**
 * In-process RFQ stub for tests and local route-pipeline exercises.
 */
export class MockSetwiseRfqClient {
  /**
   * A flat response map remains backward-compatible and is used for both quote
   * kinds. New callers may pass `{ indicative: {...}, firm: {...} }`.
   *
   * @param {Record<string, unknown> | {indicative?: Record<string, unknown>, firm?: Record<string, unknown>}} responses
   */
  constructor(responses = {}) {
    const partitioned =
      Object.hasOwn(responses, "indicative") || Object.hasOwn(responses, "firm");
    this.responses = partitioned
      ? {
          indicative: responses.indicative ?? {},
          firm: responses.firm ?? {},
        }
      : { indicative: responses, firm: responses };
  }

  /**
   * @param {IndicativeQuoteRequest} request
   * @returns {Promise<SetwiseRfqIndicativeResponse>}
   */
  async requestIndicativeQuote(request) {
    return this.#resolve("indicative", request);
  }

  /**
   * @param {FirmQuoteRequest} request
   * @returns {Promise<SetwiseRfqFirmResponse>}
   */
  async requestFirmQuote(request) {
    return this.#resolve("firm", request);
  }

  async #resolve(kind, request) {
    const responses = this.responses[kind];
    const entry = responses[request.poolId] ?? responses["*"];
    if (!entry) {
      const error = new Error(`no mock RFQ response for pool ${request.poolId}`);
      error.code = "RFQ_NOT_CONFIGURED";
      throw error;
    }
    const resolved = typeof entry === "function" ? entry(request) : entry;
    if (resolved instanceof Error) throw resolved;
    return { ...resolved, poolId: request.poolId, chainId: request.chainId, mode: request.mode };
  }
}

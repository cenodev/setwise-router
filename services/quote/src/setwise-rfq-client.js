/**
 * HTTP client for the external Setwise RFQ indicative pricing API (issue #19).
 *
 * The RFQ service remains outside this repository; the client isolates transport,
 * timeout, and response parsing so adapters and tests can inject a mock fetch.
 */

/**
 * @typedef {import("./setwise-quote-normalize.js").SetwiseRfqIndicativeResponse} SetwiseRfqIndicativeResponse
 */

/**
 * @typedef {Object} IndicativeQuoteRequest
 * @property {string} poolId
 * @property {number} chainId
 * @property {string} mode
 * @property {string} tokenIn
 * @property {string} tokenOut
 * @property {string} amount
 * @property {string} recipient
 * @property {string} funder
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
        `${this.baseUrl}/v1/pools/${encodeURIComponent(request.poolId)}/indicative`,
        {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(request),
          signal: controller.signal,
        },
      );
      const body = await response.json();
      if (!response.ok) {
        const error = new Error(body?.message ?? `RFQ request failed (${response.status})`);
        error.code = body?.code ?? "RFQ_HTTP_ERROR";
        throw error;
      }
      return body;
    } finally {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
}

/**
 * In-process RFQ stub for tests and local route-pipeline exercises.
 */
export class MockSetwiseRfqClient {
  /**
   * @param {Record<string, SetwiseRfqIndicativeResponse | Error | ((request: IndicativeQuoteRequest) => SetwiseRfqIndicativeResponse | Error)>} responses
   */
  constructor(responses = {}) {
    this.responses = responses;
  }

  /**
   * @param {IndicativeQuoteRequest} request
   * @returns {Promise<SetwiseRfqIndicativeResponse>}
   */
  async requestIndicativeQuote(request) {
    const entry = this.responses[request.poolId] ?? this.responses["*"];
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

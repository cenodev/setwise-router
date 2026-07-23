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
 * @property {string} amount
 * @property {string} recipient
 * @property {string} funder
 */

/**
 * @typedef {IndicativeQuoteRequest & {
 *   router: string,
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
    return this.#request(
      `/v1/pools/${encodeURIComponent(request.poolId)}/indicative`,
      request,
      signal,
    );
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
    return this.#request("/v1/quotes/swaps", request, signal);
  }

  async #request(path, request, signal) {
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

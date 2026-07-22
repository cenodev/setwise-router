/**
 * Mock quote-source adapter (issue #18).
 *
 * A fully in-process adapter used to exercise the runner pipeline end to end
 * without any network or chain access. Its behavior is configurable so tests
 * can simulate latency, hard failures, declines, stale quotes, and the
 * indicative/firm distinction while still producing schema-valid output.
 */

import { QuoteSourceAdapter } from "./adapter.js";

/**
 * Resolve after `ms`, rejecting early if the signal aborts. Used to simulate
 * source latency that respects timeout and cancellation.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

function defaultEvidenceKind(type) {
  return type === "aggregator" ? "http" : "onchain";
}

/**
 * @typedef {Object} MockBehavior
 * @property {number} [latencyMs]      Simulated source latency.
 * @property {Error} [failWith]        Throw this error to simulate a failure.
 * @property {boolean} [decline]       Report the source as unavailable.
 * @property {boolean} [stale]         Report a stale (cached) quote.
 * @property {string} [inputAmount]    Non-exact input amount.
 * @property {string} [outputAmount]   Non-exact output amount.
 * @property {string} [limitAmount]    Limit amount.
 * @property {string} [gasUnits]       Estimated gas units.
 * @property {string} [gasCost]        Estimated gas cost.
 * @property {string} [healthStatus]   Status reported by health().
 */

export class MockQuoteAdapter extends QuoteSourceAdapter {
  /**
   * @param {object} descriptor  See {@link QuoteSourceAdapter}.
   * @param {object} [options]
   * @param {MockBehavior} [options.behavior]
   */
  constructor(descriptor, options = {}) {
    super(descriptor, options);
    /** @type {MockBehavior} */
    this.behavior = options.behavior ?? {};
  }

  async health(context) {
    const checkedAt = context?.now ? context.now() : new Date().toISOString();
    return {
      status: this.behavior.healthStatus ?? "healthy",
      checkedAt,
      latencyMs: 0,
    };
  }

  async quote(request, context) {
    const { behavior } = this;
    if (behavior.latencyMs) await delay(behavior.latencyMs, context.signal);
    if (context.signal?.aborted) throw new Error("aborted");
    if (behavior.failWith) throw behavior.failWith;

    const observedAt = context.now();
    const evidence = [
      {
        kind: defaultEvidenceKind(this.type),
        observedAt,
        reference: `${this.id}:mock`,
        blockNumber: "123456",
      },
    ];

    if (behavior.decline) {
      return { status: "unavailable", quote: null, evidence };
    }

    return {
      status: behavior.stale ? "stale" : "available",
      quote: this.buildQuote(request, context),
      evidence,
    };
  }

  /**
   * Build a schema-shaped normalized quote that preserves the request's exact
   * amount on the correct side.
   * @param {object} request
   * @param {import("./adapter.js").AdapterContext} context
   * @returns {object}
   */
  buildQuote(request, context) {
    const { behavior } = this;
    const firm = context.kind === "firm";
    const observed = Date.parse(context.now());
    const amounts = {
      input:
        request.mode === "exact-input"
          ? request.amount
          : behavior.inputAmount ?? "1000000",
      output:
        request.mode === "exact-output"
          ? request.amount
          : behavior.outputAmount ?? "2500000",
      limit: behavior.limitAmount ?? "2487500",
    };
    return {
      kind: context.kind,
      amounts,
      gas: {
        estimatedUnits: behavior.gasUnits ?? "180000",
        estimatedCost: behavior.gasCost ?? "24000000000000",
      },
      fees: [],
      approvalTarget: firm ? request.router : null,
      expiresAt: firm
        ? new Date(observed + 60_000).toISOString()
        : null,
    };
  }
}

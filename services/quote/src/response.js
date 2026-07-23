/**
 * Quote response assembler (issue #24).
 *
 * Turns the isolated per-source outcomes produced by the runner into a single
 * schema-valid v1 quote response:
 *
 *   - selects the best available route for the request's exact-mode (highest
 *     output for exact-input, lowest input for exact-output, with a
 *     deterministic source-id tie-break);
 *   - preserves every source outcome — selected and rejected — each with its
 *     own evidence, so the decision is auditable;
 *   - lifts the selected source's executable transaction to the top level for
 *     firm quotes (indicative quotes never carry a transaction);
 *   - validates the assembled envelope against the unified schema before
 *     returning it, so a response that leaves the assembler is always a valid
 *     `QuoteResponse`.
 *
 * The selected route is reconstructable from the response: the selected source
 * outcome carries the normalized quote (input/output/limit amounts, gas, fees,
 * approval target, expiry) plus route evidence (on-chain path and split
 * proportions for ZFi, pool identity/inventory/price for Set, HTTP reference
 * for aggregators).
 */

import { generateCorrelationId } from "./correlation.js";
import { runQuoteSources } from "./runner.js";
import {
  QUOTE_API_VERSION,
  QUOTE_KINDS,
  validateQuoteRequest,
  validateQuoteResponse,
} from "./schema.js";

const KIND_SET = new Set(QUOTE_KINDS);

/**
 * Select the id of the best available source for a quote mode.
 *
 * Ranking is mode-aware and conservative:
 *   - exact-input  → the source returning the highest `amounts.output`;
 *   - exact-output → the source requiring the lowest `amounts.input`.
 * Ties are broken deterministically by lexicographically smallest source id so
 * selection is reproducible from the same set of outcomes.
 *
 * @param {Array<object>} sources  Schema-shaped source outcomes.
 * @param {"exact-input"|"exact-output"} mode
 * @returns {string|null} the selected source id, or null when none is available.
 */
export function selectBestSource(sources, mode) {
  let bestId = null;
  let bestAmount = null;
  for (const outcome of sources) {
    if (outcome.status !== "available" || !outcome.quote) continue;
    const amount = BigInt(
      mode === "exact-input"
        ? outcome.quote.amounts.output
        : outcome.quote.amounts.input,
    );
    const better =
      bestAmount === null ||
      (mode === "exact-input" ? amount > bestAmount : amount < bestAmount) ||
      (amount === bestAmount && outcome.source.id < bestId);
    if (better) {
      bestAmount = amount;
      bestId = outcome.source.id;
    }
  }
  return bestId;
}

/**
 * Assemble and validate a v1 quote response from runner output.
 *
 * @param {object} params
 * @param {object} params.request    A v1 quote request (validated here).
 * @param {Array<object>} params.sources  Schema-shaped source outcomes.
 * @param {string} params.kind       Quote kind ("indicative" | "firm").
 * @param {string} [params.requestId]  Stable request id (generated if omitted).
 * @param {Record<string, object>} [params.transactions]  Per-source executable
 *   transactions keyed by source id (firm quotes only).
 * @returns {object} a validated `QuoteResponse`.
 */
export function assembleQuoteResponse({
  request,
  sources,
  kind,
  requestId,
  transactions = {},
}) {
  const validatedRequest = validateQuoteRequest(request);
  if (!KIND_SET.has(kind)) {
    throw new Error(`kind must be one of: ${QUOTE_KINDS.join(", ")}`);
  }
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error("sources must contain at least one source outcome");
  }

  const selectedSourceId = selectBestSource(sources, validatedRequest.mode);
  const transaction =
    kind === "firm" && selectedSourceId !== null
      ? transactions[selectedSourceId] ?? null
      : null;

  const response = {
    apiVersion: QUOTE_API_VERSION,
    requestId: requestId ?? generateCorrelationId(),
    chainId: validatedRequest.chainId,
    mode: validatedRequest.mode,
    kind,
    selectedSourceId,
    sources,
    transaction,
  };
  return validateQuoteResponse(response, validatedRequest);
}

/**
 * Fan a request out to every adapter, select the best route, and assemble a
 * schema-valid v1 quote response in one call.
 *
 * @param {Iterable<import("./adapter.js").QuoteSourceAdapter>} adapters
 * @param {object} request  A v1 quote request.
 * @param {object} [options]
 * @param {string} [options.kind="indicative"]  Quote kind to request.
 * @param {string} [options.requestId]  Stable request id (generated if omitted).
 * @param {AbortSignal} [options.signal]  Caller cancellation signal.
 * @param {() => string} [options.now]  Clock override for deterministic tests.
 * @returns {Promise<{response: object, sources: Array<object>, timings: Array<object>}>}
 */
export async function runQuote(adapters, request, options = {}) {
  const kind = options.kind ?? "indicative";
  const { sources, timings, transactions } = await runQuoteSources(adapters, request, {
    kind,
    signal: options.signal,
    now: options.now,
  });
  const response = assembleQuoteResponse({
    request,
    sources,
    kind,
    requestId: options.requestId,
    transactions,
  });
  return { response, sources, timings };
}

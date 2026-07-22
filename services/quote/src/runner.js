/**
 * Quote-source runner (issue #18).
 *
 * Fans a validated quote request out to every adapter in parallel and folds
 * the results into schema-shaped source outcomes plus per-source timing
 * telemetry. The runner guarantees source isolation: each adapter runs behind
 * its own capability gate, timeout budget, and error boundary, so one failed
 * source can never fail viable alternatives.
 *
 * Outcome semantics:
 *   - excluded: the source does not support the request chain/mode/kind and is
 *     skipped explicitly (policy evidence records the reason);
 *   - failed:   the source threw, exceeded its timeout, or was cancelled;
 *   - available/unavailable/stale: reported by the adapter itself.
 */

import { getChainConfig } from "../../../config/index.mjs";
import { QUOTE_KINDS, validateQuoteRequest } from "./schema.js";

const KIND_SET = new Set(QUOTE_KINDS);

function defaultEvidenceKind(type) {
  return type === "aggregator" ? "http" : "onchain";
}

function excludedOutcome(adapter, code, observedAt) {
  const messages = {
    UNSUPPORTED_CHAIN: `source does not support this chain`,
    UNSUPPORTED_MODE: `source does not support this exact-mode`,
    UNSUPPORTED_KIND: `source does not support this quote kind`,
  };
  return {
    source: adapter.describe(),
    status: "excluded",
    quote: null,
    evidence: [
      {
        kind: "policy",
        observedAt,
        reference: `${adapter.id}:capability`,
        code,
        message: messages[code] ?? "unsupported request",
      },
    ],
  };
}

function failedOutcome(adapter, code, message, observedAt) {
  return {
    source: adapter.describe(),
    status: "failed",
    quote: null,
    evidence: [
      {
        kind: code === "CANCELLED" ? "policy" : "http",
        observedAt,
        reference: `${adapter.id}:${code.toLowerCase()}`,
        code,
        message,
      },
    ],
  };
}

function errorOutcome(adapter, error, observedAt) {
  const code = (error && error.code) || "SOURCE_ERROR";
  const message = (error && error.message) || "quote source failed";
  return failedOutcome(adapter, String(code), String(message), observedAt);
}

/**
 * Coerce an adapter result into a schema-valid source outcome, guaranteeing a
 * non-empty evidence array and a status/quote pairing the schema accepts.
 */
function resultToOutcome(adapter, result, observedAt) {
  const declared = result && result.status;
  let status = ["available", "unavailable", "stale"].includes(declared)
    ? declared
    : "available";
  let quote = result && result.quote !== undefined ? result.quote : null;

  if (status === "available" && quote === null) status = "unavailable";
  if (status !== "available" && status !== "stale") quote = null;

  let evidence = Array.isArray(result?.evidence) ? result.evidence : [];
  if (evidence.length === 0) {
    evidence = [
      {
        kind: defaultEvidenceKind(adapter.type),
        observedAt,
        reference: `${adapter.id}:${status}`,
        code: "SOURCE_DECLINED",
        message: `source reported ${status}`,
      },
    ];
  }

  return { source: adapter.describe(), status, quote, evidence };
}

/**
 * Run a single adapter behind its capability gate, timeout, and error boundary.
 * Never throws; always resolves to `{ outcome, timing }`.
 */
async function runOne(adapter, request, ctx) {
  const startedAt = ctx.now();
  const start = performance.now();
  const timing = {
    sourceId: adapter.id,
    startedAt,
    finishedAt: startedAt,
    latencyMs: 0,
    status: "failed",
    timedOut: false,
    cancelled: false,
  };

  let outcome;
  try {
    if (ctx.signal?.aborted) {
      timing.cancelled = true;
      outcome = failedOutcome(
        adapter,
        "CANCELLED",
        "quote request was cancelled",
        ctx.now(),
      );
    } else if (!adapter.supports(request.chainId, request.mode, ctx.kind)) {
      const code = !adapter.capabilities.chains.includes(request.chainId)
        ? "UNSUPPORTED_CHAIN"
        : !adapter.capabilities.modes.includes(request.mode)
          ? "UNSUPPORTED_MODE"
          : "UNSUPPORTED_KIND";
      outcome = excludedOutcome(adapter, code, ctx.now());
    } else {
      outcome = await quoteWithTimeout(adapter, request, ctx, timing);
    }
  } catch (error) {
    outcome = errorOutcome(adapter, error, ctx.now());
  }

  timing.latencyMs = Math.round(performance.now() - start);
  timing.finishedAt = ctx.now();
  timing.status = outcome.status;
  return { outcome, timing };
}

async function quoteWithTimeout(adapter, request, ctx, timing) {
  const timeoutMs = adapter.timeoutMs;
  const timeoutSignal =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? AbortSignal.timeout(timeoutMs)
      : null;
  const signals = [ctx.signal, timeoutSignal].filter(Boolean);
  const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;

  let result;
  try {
    result = await adapter.quote(request, {
      kind: ctx.kind,
      signal,
      now: ctx.now,
      chainConfig: ctx.chainConfig,
    });
  } catch (error) {
    const observedAt = ctx.now();
    if (ctx.signal?.aborted) {
      timing.cancelled = true;
      return failedOutcome(
        adapter,
        "CANCELLED",
        "quote request was cancelled",
        observedAt,
      );
    }
    if (timeoutSignal?.aborted) {
      timing.timedOut = true;
      return failedOutcome(
        adapter,
        "UPSTREAM_TIMEOUT",
        `source exceeded ${timeoutMs}ms`,
        observedAt,
      );
    }
    return errorOutcome(adapter, error, observedAt);
  }
  return resultToOutcome(adapter, result, ctx.now());
}

/**
 * Fan a request out to every adapter and collect isolated outcomes.
 *
 * @param {Iterable<import("./adapter.js").QuoteSourceAdapter>} adapters
 * @param {object} request  A v1 quote request (validated here).
 * @param {object} [options]
 * @param {string} [options.kind="indicative"]  Quote kind to request.
 * @param {AbortSignal} [options.signal]  Caller cancellation signal.
 * @param {() => string} [options.now]  Clock override for deterministic tests.
 * @returns {Promise<{sources: Array<object>, timings: Array<object>}>}
 */
export async function runQuoteSources(adapters, request, options = {}) {
  const validated = validateQuoteRequest(request);
  const kind = options.kind ?? "indicative";
  if (!KIND_SET.has(kind)) {
    throw new Error(`kind must be one of: ${QUOTE_KINDS.join(", ")}`);
  }
  const ctx = {
    kind,
    signal: options.signal ?? null,
    now: options.now ?? (() => new Date().toISOString()),
    chainConfig: getChainConfig(validated.chainId),
  };

  const list = Array.isArray(adapters) ? adapters : [...adapters];
  const results = await Promise.all(
    list.map((adapter) => runOne(adapter, validated, ctx)),
  );
  return {
    sources: results.map((r) => r.outcome),
    timings: results.map((r) => r.timing),
  };
}

/**
 * Resilient quote-source runner (issue #25).
 *
 * Wraps the base runner with source caching, in-flight deduplication, circuit
 * breakers, and observability metrics. Produces the same source-outcome shape
 * as the base runner but adds structured exclusion reasons when a breaker is
 * open, and records latency/success/exclusion/fallback metrics for every call.
 */

import { buildCacheKey, QuoteCache } from "./cache.js";
import { CircuitBreakerRegistry } from "./circuit-breaker.js";
import { generateCorrelationId } from "./correlation.js";
import { CircuitOpenError } from "./errors.js";
import { MetricsCollector } from "./metrics.js";
import { runQuoteSources } from "./runner.js";

export class ResilientQuoteRunner {
  constructor(options = {}) {
    this.cache = options.cache ?? new QuoteCache(options.cacheOptions);
    this.breakers = options.breakers ?? new CircuitBreakerRegistry(options.breakerOptions);
    this.metrics = options.metrics ?? new MetricsCollector(options.metricsOptions);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async run(adapters, request, options = {}) {
    const correlationId = options.correlationId ?? generateCorrelationId();
    const kind = options.kind ?? "indicative";
    const list = Array.isArray(adapters) ? adapters : [...adapters];

    const eligible = [];
    const excluded = [];

    for (const adapter of list) {
      const breaker = this.breakers.get(adapter.id);
      if (!breaker.canExecute()) {
        this.metrics.recordCircuitBreaker(adapter.id, request.chainId, "open");
        this.metrics.recordExclusion(adapter.id, request.chainId, "CIRCUIT_OPEN");
        excluded.push({
          source: adapter.describe(),
          status: "excluded",
          quote: null,
          evidence: [
            {
              kind: "policy",
              observedAt: this.now(),
              reference: `${adapter.id}:circuit-breaker`,
              code: "CIRCUIT_OPEN",
              message: `circuit breaker open for source "${adapter.id}"`,
            },
          ],
        });
      } else {
        eligible.push(adapter);
      }
    }

    const { sources, timings } = await runQuoteSources(eligible, request, {
      ...options,
      kind,
      now: this.now,
    });

    for (let i = 0; i < sources.length; i++) {
      const outcome = sources[i];
      const timing = timings[i];
      const sourceId = outcome.source.id;
      const breaker = this.breakers.get(sourceId);

      this.metrics.recordLatency(sourceId, request.chainId, timing.latencyMs);

      if (outcome.status === "available") {
        breaker.recordSuccess();
        this.metrics.recordSuccess(sourceId, request.chainId);
      } else if (outcome.status === "failed") {
        breaker.recordFailure();
        const code = outcome.evidence?.[0]?.code ?? "SOURCE_ERROR";
        this.metrics.recordFailure(sourceId, request.chainId, code);
      } else if (outcome.status === "excluded") {
        const code = outcome.evidence?.[0]?.code ?? "EXCLUDED";
        this.metrics.recordExclusion(sourceId, request.chainId, code);
      }
    }

    const allSources = [...excluded, ...sources];
    const allTimings = [
      ...excluded.map((e) => ({
        sourceId: e.source.id,
        startedAt: this.now(),
        finishedAt: this.now(),
        latencyMs: 0,
        status: "excluded",
        timedOut: false,
        cancelled: false,
      })),
      ...timings,
    ];

    const available = allSources.filter((s) => s.status === "available");
    if (available.length === 0 && allSources.length > 0) {
      const failed = allSources.filter((s) => s.status === "failed");
      if (failed.length > 0 && failed.length === allSources.length) {
        this.metrics.recordFallback("router", request.chainId, "none");
      }
    }

    return { sources: allSources, timings: allTimings, correlationId };
  }

  async cachedRun(adapter, request, options = {}) {
    const key = buildCacheKey(request, adapter.id, options.cacheKeyOptions);
    const chainId = request.chainId;

    const result = await this.cache.dedupe(key, async () => {
      const { sources, timings } = await this.run([adapter], request, options);
      return { sources, timings };
    });

    if (result.fromCache) {
      this.metrics.recordCacheHit(adapter.id, chainId);
    } else if (result.deduplicated) {
      this.metrics.recordDeduplicated(adapter.id, chainId);
    } else {
      this.metrics.recordCacheMiss(adapter.id, chainId);
    }

    return result.value;
  }

  snapshot() {
    return {
      breakers: this.breakers.snapshot(),
      metrics: this.metrics.snapshot(),
      cache: { size: this.cache.size, inflight: this.cache.inflightCount },
    };
  }
}

/**
 * Quote-source observability metrics (issue #25).
 *
 * Emits latency, success, exclusion, fallback, and simulation counters and
 * histograms. All metric labels are sanitized to avoid wallet-address and
 * API-key leakage: only source ids, chain ids, and status codes appear as
 * label values.
 */

export class MetricsCollector {
  constructor(options = {}) {
    this.prefix = options.prefix ?? "quote";
    this.counters = new Map();
    this.histograms = new Map();
    this.now = options.now ?? (() => Date.now());
  }

  increment(name, labels = {}) {
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  observe(name, value, labels = {}) {
    const key = this.key(name, labels);
    let bucket = this.histograms.get(key);
    if (!bucket) {
      bucket = { count: 0, sum: 0, min: Infinity, max: -Infinity, values: [] };
      this.histograms.set(key, bucket);
    }
    bucket.count++;
    bucket.sum += value;
    bucket.min = Math.min(bucket.min, value);
    bucket.max = Math.max(bucket.max, value);
    bucket.values.push(value);
  }

  key(name, labels) {
    const parts = Object.keys(labels)
      .sort()
      .map((k) => `${k}=${labels[k]}`);
    return `${this.prefix}.${name}{${parts.join(",")}}`;
  }

  getCounter(name, labels = {}) {
    return this.counters.get(this.key(name, labels)) ?? 0;
  }

  getHistogram(name, labels = {}) {
    return this.histograms.get(this.key(name, labels)) ?? null;
  }

  recordLatency(sourceId, chainId, latencyMs) {
    this.observe("latency_ms", latencyMs, { source: sourceId, chain: String(chainId) });
  }

  recordSuccess(sourceId, chainId) {
    this.increment("success", { source: sourceId, chain: String(chainId) });
  }

  recordFailure(sourceId, chainId, code) {
    this.increment("failure", { source: sourceId, chain: String(chainId), code });
  }

  recordExclusion(sourceId, chainId, reason) {
    this.increment("exclusion", { source: sourceId, chain: String(chainId), reason });
  }

  recordFallback(sourceId, chainId, fallbackSourceId) {
    this.increment("fallback", {
      source: sourceId,
      chain: String(chainId),
      fallback: fallbackSourceId,
    });
  }

  recordSimulation(sourceId, chainId, outcome) {
    this.increment("simulation", { source: sourceId, chain: String(chainId), outcome });
  }

  recordCacheHit(sourceId, chainId) {
    this.increment("cache_hit", { source: sourceId, chain: String(chainId) });
  }

  recordCacheMiss(sourceId, chainId) {
    this.increment("cache_miss", { source: sourceId, chain: String(chainId) });
  }

  recordDeduplicated(sourceId, chainId) {
    this.increment("deduplicated", { source: sourceId, chain: String(chainId) });
  }

  recordCircuitBreaker(sourceId, chainId, state) {
    this.increment("circuit_breaker", { source: sourceId, chain: String(chainId), state });
  }

  snapshot() {
    return {
      counters: Object.fromEntries(this.counters),
      histograms: Object.fromEntries(
        [...this.histograms].map(([k, v]) => [
          k,
          { count: v.count, sum: v.sum, min: v.min, max: v.max },
        ]),
      ),
    };
  }

  reset() {
    this.counters.clear();
    this.histograms.clear();
  }
}

/**
 * Health and readiness reporting (issue #25).
 *
 * Aggregates per-source adapter health probes and circuit-breaker state into
 * service-level health and readiness signals suitable for load-balancer and
 * orchestrator endpoints.
 */

export class HealthReporter {
  constructor(options = {}) {
    this.breakerRegistry = options.breakerRegistry ?? null;
    this.metrics = options.metrics ?? null;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async checkSources(adapters, context = {}) {
    const results = [];
    for (const adapter of adapters) {
      const start = performance.now();
      let status = "healthy";
      let detail = null;
      try {
        const health = await adapter.health({
          now: typeof this.now === "function" ? this.now : () => new Date().toISOString(),
          ...context,
        });
        status = health.status;
        detail = health.detail ?? null;
      } catch (error) {
        status = "unhealthy";
        detail = error.message;
      }
      const latencyMs = Math.round(performance.now() - start);

      let breakerState = "closed";
      if (this.breakerRegistry) {
        const breaker = this.breakerRegistry.get(adapter.id);
        breakerState = breaker.state;
      }

      results.push({
        sourceId: adapter.id,
        displayName: adapter.displayName,
        status,
        breakerState,
        latencyMs,
        detail,
        checkedAt: typeof this.now === "function" ? this.now() : new Date().toISOString(),
      });
    }
    return results;
  }

  async health(adapters, context = {}) {
    const sources = await this.checkSources(adapters, context);
    const anyHealthy = sources.some(
      (s) => s.status === "healthy" && s.breakerState !== "open",
    );
    return {
      status: anyHealthy ? "healthy" : "unhealthy",
      checkedAt: typeof this.now === "function" ? this.now() : new Date().toISOString(),
      sources,
    };
  }

  async readiness(adapters, context = {}) {
    const sources = await this.checkSources(adapters, context);
    const available = sources.filter(
      (s) => s.status !== "unhealthy" && s.breakerState !== "open",
    );
    return {
      ready: available.length > 0,
      checkedAt: typeof this.now === "function" ? this.now() : new Date().toISOString(),
      availableSources: available.map((s) => s.sourceId),
      totalSources: sources.length,
    };
  }
}

import assert from "node:assert/strict";
import test from "node:test";

import { HealthReporter } from "../src/health.js";
import { CircuitBreakerRegistry } from "../src/circuit-breaker.js";
import { MockQuoteAdapter } from "../src/mock-adapter.js";

const NOW = "2026-07-22T20:00:00.000Z";

function mock(overrides = {}, behavior = {}, options = {}) {
  return new MockQuoteAdapter(
    { id: "zfi", type: "zfi", displayName: "ZFi", ...overrides },
    { capabilities: { chains: [8453] }, behavior, ...options },
  );
}

test("reports healthy when at least one source is healthy", async () => {
  const reporter = new HealthReporter({ now: () => NOW });
  const result = await reporter.health([mock()]);
  assert.equal(result.status, "healthy");
  assert.equal(result.checkedAt, NOW);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].sourceId, "zfi");
  assert.equal(result.sources[0].status, "healthy");
});

test("reports unhealthy when all sources are unhealthy", async () => {
  const reporter = new HealthReporter({ now: () => NOW });
  const unhealthy = mock({ id: "bad" }, { healthStatus: "unhealthy" });
  const result = await reporter.health([unhealthy]);
  assert.equal(result.status, "unhealthy");
});

test("reports unhealthy when breaker is open", async () => {
  const breakers = new CircuitBreakerRegistry({ failureThreshold: 1, now: () => 1000 });
  breakers.get("zfi").recordFailure();
  const reporter = new HealthReporter({ breakerRegistry: breakers, now: () => NOW });
  const result = await reporter.health([mock()]);
  assert.equal(result.status, "unhealthy");
  assert.equal(result.sources[0].breakerState, "open");
});

test("readiness reports available sources", async () => {
  const reporter = new HealthReporter({ now: () => NOW });
  const healthy = mock({ id: "zfi" });
  const degraded = mock({ id: "slow" }, { healthStatus: "degraded" });
  const result = await reporter.readiness([healthy, degraded]);
  assert.equal(result.ready, true);
  assert.equal(result.totalSources, 2);
  assert.ok(result.availableSources.includes("zfi"));
  assert.ok(result.availableSources.includes("slow"));
});

test("readiness excludes sources with open breakers", async () => {
  const breakers = new CircuitBreakerRegistry({ failureThreshold: 1, now: () => 1000 });
  breakers.get("zfi").recordFailure();
  const reporter = new HealthReporter({ breakerRegistry: breakers, now: () => NOW });
  const result = await reporter.readiness([mock({ id: "zfi" }), mock({ id: "ok" })]);
  assert.equal(result.ready, true);
  assert.ok(!result.availableSources.includes("zfi"));
  assert.ok(result.availableSources.includes("ok"));
});

test("readiness reports not ready when no sources available", async () => {
  const breakers = new CircuitBreakerRegistry({ failureThreshold: 1, now: () => 1000 });
  breakers.get("zfi").recordFailure();
  const reporter = new HealthReporter({ breakerRegistry: breakers, now: () => NOW });
  const result = await reporter.readiness([mock({ id: "zfi" })]);
  assert.equal(result.ready, false);
  assert.equal(result.availableSources.length, 0);
});

test("handles adapter health probe throwing", async () => {
  const adapter = mock();
  adapter.health = async () => { throw new Error("probe failed"); };
  const reporter = new HealthReporter({ now: () => NOW });
  const result = await reporter.health([adapter]);
  assert.equal(result.status, "unhealthy");
  assert.equal(result.sources[0].status, "unhealthy");
  assert.equal(result.sources[0].detail, "probe failed");
});

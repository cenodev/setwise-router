import assert from "node:assert/strict";
import test from "node:test";

import { MetricsCollector } from "../src/metrics.js";

test("increments counters with labels", () => {
  const m = new MetricsCollector();
  m.increment("success", { source: "zfi", chain: "8453" });
  m.increment("success", { source: "zfi", chain: "8453" });
  m.increment("success", { source: "set", chain: "1" });
  assert.equal(m.getCounter("success", { source: "zfi", chain: "8453" }), 2);
  assert.equal(m.getCounter("success", { source: "set", chain: "1" }), 1);
  assert.equal(m.getCounter("success", { source: "missing", chain: "1" }), 0);
});

test("observes histogram values", () => {
  const m = new MetricsCollector();
  m.observe("latency_ms", 100, { source: "zfi" });
  m.observe("latency_ms", 200, { source: "zfi" });
  m.observe("latency_ms", 300, { source: "zfi" });
  const h = m.getHistogram("latency_ms", { source: "zfi" });
  assert.equal(h.count, 3);
  assert.equal(h.sum, 600);
  assert.equal(h.min, 100);
  assert.equal(h.max, 300);
});

test("records latency, success, failure, exclusion, fallback, simulation", () => {
  const m = new MetricsCollector();
  m.recordLatency("zfi", 8453, 150);
  m.recordSuccess("zfi", 8453);
  m.recordFailure("zfi", 8453, "UPSTREAM_TIMEOUT");
  m.recordExclusion("eth-only", 8453, "UNSUPPORTED_CHAIN");
  m.recordFallback("zfi", 8453, "set-bstock-ai");
  m.recordSimulation("zfi", 8453, "pass");

  assert.ok(m.getHistogram("latency_ms", { source: "zfi", chain: "8453" }));
  assert.equal(m.getCounter("success", { source: "zfi", chain: "8453" }), 1);
  assert.equal(m.getCounter("failure", { source: "zfi", chain: "8453", code: "UPSTREAM_TIMEOUT" }), 1);
  assert.equal(m.getCounter("exclusion", { source: "eth-only", chain: "8453", reason: "UNSUPPORTED_CHAIN" }), 1);
  assert.equal(m.getCounter("fallback", { source: "zfi", chain: "8453", fallback: "set-bstock-ai" }), 1);
  assert.equal(m.getCounter("simulation", { source: "zfi", chain: "8453", outcome: "pass" }), 1);
});

test("records cache hit, miss, and deduplication", () => {
  const m = new MetricsCollector();
  m.recordCacheHit("zfi", 8453);
  m.recordCacheMiss("zfi", 8453);
  m.recordDeduplicated("zfi", 8453);
  assert.equal(m.getCounter("cache_hit", { source: "zfi", chain: "8453" }), 1);
  assert.equal(m.getCounter("cache_miss", { source: "zfi", chain: "8453" }), 1);
  assert.equal(m.getCounter("deduplicated", { source: "zfi", chain: "8453" }), 1);
});

test("records circuit breaker state changes", () => {
  const m = new MetricsCollector();
  m.recordCircuitBreaker("zfi", 8453, "open");
  assert.equal(m.getCounter("circuit_breaker", { source: "zfi", chain: "8453", state: "open" }), 1);
});

test("snapshot serializes counters and histograms without label leakage", () => {
  const m = new MetricsCollector({ prefix: "quote" });
  m.recordSuccess("zfi", 8453);
  m.recordLatency("zfi", 8453, 42);
  const snap = m.snapshot();
  assert.ok(snap.counters["quote.success{chain=8453,source=zfi}"]);
  assert.ok(snap.histograms["quote.latency_ms{chain=8453,source=zfi}"]);
  const json = JSON.stringify(snap);
  assert.ok(!json.includes("0x"));
});

test("reset clears all state", () => {
  const m = new MetricsCollector();
  m.recordSuccess("zfi", 8453);
  m.reset();
  assert.equal(m.getCounter("success", { source: "zfi", chain: "8453" }), 0);
});

test("metric labels avoid wallet-address and API-key leakage", () => {
  const m = new MetricsCollector();
  m.recordSuccess("zfi", 8453);
  const snap = JSON.stringify(m.snapshot());
  assert.ok(!snap.includes("0x1"));
  assert.ok(!snap.includes("api_key"));
  assert.ok(!snap.includes("secret"));
});

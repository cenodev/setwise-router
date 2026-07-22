import assert from "node:assert/strict";
import test from "node:test";

import { MockQuoteAdapter } from "../src/mock-adapter.js";
import { QuoteCache } from "../src/cache.js";
import { CircuitBreakerRegistry } from "../src/circuit-breaker.js";
import { MetricsCollector } from "../src/metrics.js";
import { ResilientQuoteRunner } from "../src/resilient-runner.js";

const NOW = "2026-07-22T20:00:00.000Z";
const now = () => NOW;

const address = (suffix) => `0x${suffix.padStart(40, "0")}`;
const scoped = (chainId, suffix) => ({ chainId, address: address(suffix) });

function request(overrides = {}) {
  return {
    apiVersion: "v1",
    chainId: 8453,
    tokenIn: scoped(8453, "11"),
    tokenOut: scoped(8453, "22"),
    router: scoped(8453, "33"),
    mode: "exact-input",
    amount: "1000000",
    recipient: scoped(8453, "44"),
    funder: scoped(8453, "55"),
    slippage: { maxBps: 50 },
    ...overrides,
  };
}

function mock(overrides = {}, behavior = {}, options = {}) {
  return new MockQuoteAdapter(
    { id: "zfi", type: "zfi", displayName: "ZFi", ...overrides },
    { capabilities: { chains: [8453] }, behavior, ...options },
  );
}

function runner(options = {}) {
  return new ResilientQuoteRunner({ now, ...options });
}

test("resilient runner produces outcomes with correlation id", async () => {
  const r = runner();
  const { sources, correlationId } = await r.run([mock()], request());
  assert.equal(sources.length, 1);
  assert.equal(sources[0].status, "available");
  assert.match(correlationId, /^[0-9a-f]{32}$/);
});

test("excludes sources with open circuit breakers", async () => {
  const breakers = new CircuitBreakerRegistry({ failureThreshold: 1, now: () => 1000 });
  breakers.get("zfi").recordFailure();
  const r = runner({ breakers });
  const { sources } = await r.run([mock()], request());
  assert.equal(sources.length, 1);
  assert.equal(sources[0].status, "excluded");
  assert.equal(sources[0].evidence[0].code, "CIRCUIT_OPEN");
});

test("records metrics for successful and failed sources", async () => {
  const metrics = new MetricsCollector();
  const r = runner({ metrics });
  const failing = mock({ id: "broken" }, { failWith: new Error("boom") });
  const healthy = mock({ id: "zfi" });
  await r.run([failing, healthy], request());

  assert.equal(metrics.getCounter("success", { source: "zfi", chain: "8453" }), 1);
  assert.equal(metrics.getCounter("failure", { source: "broken", chain: "8453", code: "SOURCE_ERROR" }), 1);
  assert.ok(metrics.getHistogram("latency_ms", { source: "zfi", chain: "8453" }));
});

test("opens breaker after repeated failures and isolates source", async () => {
  const breakers = new CircuitBreakerRegistry({ failureThreshold: 2, now: () => 1000 });
  const r = runner({ breakers });
  const failing = mock({ id: "flaky" }, { failWith: new Error("fail") });

  await r.run([failing], request());
  await r.run([failing], request());
  assert.equal(breakers.get("flaky").state, "open");

  const { sources } = await r.run([failing], request());
  assert.equal(sources[0].status, "excluded");
  assert.equal(sources[0].evidence[0].code, "CIRCUIT_OPEN");
});

test("probes recovery after cooldown and closes breaker on success", async () => {
  let time = 1000;
  const breakers = new CircuitBreakerRegistry({ failureThreshold: 1, cooldownMs: 5000, now: () => time });
  const r = runner({ breakers });
  const failing = mock({ id: "flaky" }, { failWith: new Error("fail") });

  await r.run([failing], request());
  assert.equal(breakers.get("flaky").state, "open");

  time = 6001;
  failing.behavior = {};
  const { sources } = await r.run([failing], request());
  assert.equal(sources[0].status, "available");
  assert.equal(breakers.get("flaky").state, "closed");
});

test("cachedRun returns cached results and records cache metrics", async () => {
  const metrics = new MetricsCollector();
  const r = runner({ metrics });
  const adapter = mock();

  await r.cachedRun(adapter, request());
  assert.equal(metrics.getCounter("cache_miss", { source: "zfi", chain: "8453" }), 1);

  await r.cachedRun(adapter, request());
  assert.equal(metrics.getCounter("cache_hit", { source: "zfi", chain: "8453" }), 1);
});

test("snapshot reports breakers, metrics, and cache state", async () => {
  const r = runner();
  await r.run([mock()], request());
  const snap = r.snapshot();
  assert.ok(snap.breakers);
  assert.ok(snap.metrics);
  assert.ok("size" in snap.cache);
});

test("failure-injection: all sources fail simultaneously", async () => {
  const r = runner();
  const sources = [
    mock({ id: "a" }, { failWith: new Error("a down") }),
    mock({ id: "b" }, { failWith: new Error("b down") }),
    mock({ id: "c" }, { failWith: new Error("c down") }),
  ];
  const { sources: outcomes } = await r.run(sources, request());
  assert.equal(outcomes.length, 3);
  for (const o of outcomes) {
    assert.equal(o.status, "failed");
    assert.equal(o.quote, null);
  }
});

test("failure-injection: timeout under load does not corrupt other sources", async () => {
  const r = runner();
  const slow = mock({ id: "slow" }, { latencyMs: 200 }, { timeoutMs: 20 });
  const fast = mock({ id: "fast" });
  const { sources } = await r.run([slow, fast], request());
  const byId = Object.fromEntries(sources.map((s) => [s.source.id, s]));
  assert.equal(byId.slow.status, "failed");
  assert.equal(byId.slow.evidence[0].code, "UPSTREAM_TIMEOUT");
  assert.equal(byId.fast.status, "available");
});

test("failure-injection: mixed exclusions and failures preserve isolation", async () => {
  const breakers = new CircuitBreakerRegistry({ failureThreshold: 1, now: () => 1000 });
  breakers.get("open-src").recordFailure();
  const metrics = new MetricsCollector();
  const r = runner({ breakers, metrics });

  const sources = [
    mock({ id: "open-src" }),
    mock({ id: "failing" }, { failWith: new Error("x") }),
    mock({ id: "healthy" }),
  ];
  const { sources: outcomes } = await r.run(sources, request());
  const byId = Object.fromEntries(outcomes.map((s) => [s.source.id, s]));
  assert.equal(byId["open-src"].status, "excluded");
  assert.equal(byId["failing"].status, "failed");
  assert.equal(byId["healthy"].status, "available");
});

test("load: handles concurrent requests without cross-contamination", async () => {
  const r = runner();
  const adapter = mock();
  const promises = [];
  for (let i = 0; i < 50; i++) {
    promises.push(r.run([adapter], request({ amount: String(i + 1) })));
  }
  const results = await Promise.all(promises);
  assert.equal(results.length, 50);
  for (let i = 0; i < 50; i++) {
    assert.equal(results[i].sources[0].status, "available");
    assert.equal(results[i].sources[0].quote.amounts.input, String(i + 1));
  }
});

test("load: concurrent cachedRun deduplicates in-flight requests", async () => {
  let callCount = 0;
  const adapter = mock();
  const originalQuote = adapter.quote.bind(adapter);
  adapter.quote = async (req, ctx) => {
    callCount++;
    await new Promise((r) => setTimeout(r, 30));
    return originalQuote(req, ctx);
  };

  const cache = new QuoteCache({ now: () => 1000 });
  const r = runner({ cache });
  const req = request();
  const promises = Array.from({ length: 10 }, () => r.cachedRun(adapter, req));
  const results = await Promise.all(promises);

  assert.equal(results.length, 10);
  assert.equal(callCount, 1);
});

test("load: sustained requests with intermittent failures", async () => {
  const breakers = new CircuitBreakerRegistry({ failureThreshold: 5, now: () => 1000 });
  const metrics = new MetricsCollector();
  const r = runner({ breakers, metrics });

  let shouldFail = false;
  const adapter = mock();
  const originalQuote = adapter.quote.bind(adapter);
  adapter.quote = async (req, ctx) => {
    if (shouldFail) throw new Error("intermittent");
    return originalQuote(req, ctx);
  };

  for (let i = 0; i < 20; i++) {
    shouldFail = i >= 5 && i < 8;
    const { sources } = await r.run([adapter], request({ amount: String(i + 1) }));
    if (shouldFail) {
      assert.equal(sources[0].status, "failed");
    } else {
      assert.equal(sources[0].status, "available");
    }
  }
  assert.equal(metrics.getCounter("success", { source: "zfi", chain: "8453" }), 17);
  assert.equal(metrics.getCounter("failure", { source: "zfi", chain: "8453", code: "SOURCE_ERROR" }), 3);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  BREAKER_STATES,
  CircuitBreaker,
  CircuitBreakerRegistry,
} from "../src/circuit-breaker.js";

test("defines breaker state vocabulary", () => {
  assert.deepEqual([...BREAKER_STATES], ["closed", "open", "half-open"]);
});

test("starts closed and allows execution", () => {
  const breaker = new CircuitBreaker();
  assert.equal(breaker.isClosed, true);
  assert.equal(breaker.canExecute(), true);
});

test("opens after reaching the failure threshold", () => {
  const breaker = new CircuitBreaker({ failureThreshold: 3, now: () => 1000 });
  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.isClosed, true);
  breaker.recordFailure();
  assert.equal(breaker.state, "open");
  assert.equal(breaker.canExecute(), false);
});

test("resets failure count on success", () => {
  const breaker = new CircuitBreaker({ failureThreshold: 3, now: () => 1000 });
  breaker.recordFailure();
  breaker.recordFailure();
  breaker.recordSuccess();
  assert.equal(breaker.failures, 0);
  assert.equal(breaker.isClosed, true);
});

test("transitions to half-open after cooldown", () => {
  let time = 1000;
  const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 5000, now: () => time });
  breaker.recordFailure();
  assert.equal(breaker.state, "open");
  assert.equal(breaker.canExecute(), false);
  time = 6001;
  assert.equal(breaker.canExecute(), true);
  assert.equal(breaker.state, "half-open");
});

test("closes from half-open on success", () => {
  let time = 1000;
  const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 5000, now: () => time });
  breaker.recordFailure();
  time = 6001;
  breaker.canExecute();
  assert.equal(breaker.state, "half-open");
  breaker.recordSuccess();
  assert.equal(breaker.state, "closed");
  assert.equal(breaker.failures, 0);
});

test("re-opens from half-open on failure", () => {
  let time = 1000;
  const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 5000, now: () => time });
  breaker.recordFailure();
  time = 6001;
  breaker.canExecute();
  assert.equal(breaker.state, "half-open");
  breaker.recordFailure();
  assert.equal(breaker.state, "open");
});

test("isolates a degraded source and probes for recovery", () => {
  let time = 0;
  const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 10000, now: () => time });

  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.canExecute(), false);

  time = 10001;
  assert.equal(breaker.canExecute(), true);
  assert.equal(breaker.isHalfOpen, true);

  breaker.recordSuccess();
  assert.equal(breaker.isClosed, true);
  assert.equal(breaker.canExecute(), true);
});

test("snapshot reports current state", () => {
  const breaker = new CircuitBreaker({ now: () => 42 });
  breaker.recordFailure();
  const snap = breaker.snapshot();
  assert.equal(snap.state, "closed");
  assert.equal(snap.failures, 1);
  assert.equal(snap.successes, 0);
});

test("reset restores initial state", () => {
  const breaker = new CircuitBreaker({ failureThreshold: 1, now: () => 1000 });
  breaker.recordFailure();
  assert.equal(breaker.state, "open");
  breaker.reset();
  assert.equal(breaker.state, "closed");
  assert.equal(breaker.failures, 0);
});

test("registry creates and retrieves per-source breakers", () => {
  const registry = new CircuitBreakerRegistry({ failureThreshold: 3 });
  const a = registry.get("zfi");
  const b = registry.get("set-bstock-ai");
  assert.notEqual(a, b);
  assert.equal(registry.get("zfi"), a);
  assert.equal(registry.has("zfi"), true);
  assert.equal(registry.has("missing"), false);
});

test("registry snapshot reports all breakers", () => {
  const registry = new CircuitBreakerRegistry({ now: () => 1000 });
  registry.get("a").recordFailure();
  registry.get("b").recordSuccess();
  const snap = registry.snapshot();
  assert.equal(snap.a.failures, 1);
  assert.equal(snap.b.successes, 1);
});

test("registry remove and clear work", () => {
  const registry = new CircuitBreakerRegistry();
  registry.get("a");
  registry.get("b");
  registry.remove("a");
  assert.equal(registry.has("a"), false);
  registry.clear();
  assert.equal(registry.has("b"), false);
});

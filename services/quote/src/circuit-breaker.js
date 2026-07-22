/**
 * Per-source circuit breaker with error budgets and recovery probing (issue #25).
 *
 * Each source gets an isolated breaker that tracks consecutive failures against
 * a configurable error budget. When the budget is exhausted the breaker opens and
 * the source is isolated. After a cooldown the breaker enters half-open state and
 * probes the source with a single trial request; success closes the breaker,
 * failure re-opens it.
 */

export const BREAKER_STATES = Object.freeze(["closed", "open", "half-open"]);

export class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.halfOpenMaxProbes = options.halfOpenMaxProbes ?? 1;
    this.now = options.now ?? (() => Date.now());

    this.state = "closed";
    this.failures = 0;
    this.successes = 0;
    this.lastFailureAt = 0;
    this.lastStateChange = this.now();
    this.halfOpenProbes = 0;
  }

  get isOpen() {
    if (this.state === "open") {
      if (this.now() - this.lastFailureAt >= this.cooldownMs) {
        this.transition("half-open");
        return false;
      }
      return true;
    }
    return false;
  }

  get isClosed() {
    return this.state === "closed";
  }

  get isHalfOpen() {
    return this.state === "half-open";
  }

  canExecute() {
    if (this.state === "closed") return true;
    if (this.state === "open") {
      if (this.now() - this.lastFailureAt >= this.cooldownMs) {
        this.transition("half-open");
        return true;
      }
      return false;
    }
    return this.halfOpenProbes < this.halfOpenMaxProbes;
  }

  recordSuccess() {
    this.successes++;
    if (this.state === "half-open") {
      this.transition("closed");
    }
    this.failures = 0;
  }

  recordFailure() {
    this.failures++;
    this.lastFailureAt = this.now();
    if (this.state === "half-open") {
      this.transition("open");
    } else if (this.failures >= this.failureThreshold) {
      this.transition("open");
    }
  }

  transition(newState) {
    this.state = newState;
    this.lastStateChange = this.now();
    if (newState === "closed") {
      this.failures = 0;
      this.halfOpenProbes = 0;
    } else if (newState === "half-open") {
      this.halfOpenProbes = 0;
    }
  }

  reset() {
    this.state = "closed";
    this.failures = 0;
    this.successes = 0;
    this.lastFailureAt = 0;
    this.halfOpenProbes = 0;
    this.lastStateChange = this.now();
  }

  snapshot() {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailureAt: this.lastFailureAt,
      lastStateChange: this.lastStateChange,
    };
  }
}

export class CircuitBreakerRegistry {
  constructor(options = {}) {
    this.options = options;
    this.breakers = new Map();
  }

  get(sourceId) {
    let breaker = this.breakers.get(sourceId);
    if (!breaker) {
      breaker = new CircuitBreaker(this.options);
      this.breakers.set(sourceId, breaker);
    }
    return breaker;
  }

  has(sourceId) {
    return this.breakers.has(sourceId);
  }

  remove(sourceId) {
    this.breakers.delete(sourceId);
  }

  clear() {
    this.breakers.clear();
  }

  snapshot() {
    const result = {};
    for (const [id, breaker] of this.breakers) {
      result[id] = breaker.snapshot();
    }
    return result;
  }
}

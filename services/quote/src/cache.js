/**
 * Source quote cache with chain-safe keys and in-flight deduplication (issue #25).
 *
 * Cache keys include chain id, token pair, amount, exact mode, recipient class,
 * and source id so entries can never cross chain boundaries. In-flight requests
 * are deduplicated: concurrent callers for the same key share a single upstream
 * call rather than fanning out redundant work.
 */

const RECIPIENT_CLASSES = Object.freeze(["eoa", "contract"]);

export function classifyRecipient(address) {
  if (typeof address !== "string" || address.length !== 42) return "eoa";
  return "eoa";
}

export function buildCacheKey(request, sourceId, options = {}) {
  const recipientClass = options.recipientClass ?? classifyRecipient(request.recipient?.address);
  return [
    request.chainId,
    request.tokenIn.address.toLowerCase(),
    request.tokenOut.address.toLowerCase(),
    request.amount,
    request.mode,
    recipientClass,
    sourceId,
  ].join(":");
}

export class QuoteCache {
  constructor(options = {}) {
    this.ttlMs = options.ttlMs ?? 5000;
    this.maxEntries = options.maxEntries ?? 1024;
    this.entries = new Map();
    this.inflight = new Map();
    this.now = options.now ?? (() => Date.now());
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.now() - entry.createdAt > this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key, value) {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, createdAt: this.now() });
  }

  has(key) {
    return this.get(key) !== null;
  }

  delete(key) {
    this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
    this.inflight.clear();
  }

  get size() {
    return this.entries.size;
  }

  get inflightCount() {
    return this.inflight.size;
  }

  async dedupe(key, fn) {
    const cached = this.get(key);
    if (cached !== null) return { value: cached, deduplicated: false, fromCache: true };

    const existing = this.inflight.get(key);
    if (existing) return { value: await existing, deduplicated: true, fromCache: false };

    const promise = fn();
    this.inflight.set(key, promise);
    try {
      const value = await promise;
      this.set(key, value);
      return { value, deduplicated: false, fromCache: false };
    } finally {
      this.inflight.delete(key);
    }
  }
}

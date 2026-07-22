import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCacheKey,
  QuoteCache,
} from "../src/cache.js";

const NOW = "2026-07-22T20:00:00.000Z";

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

test("buildCacheKey includes chain, tokens, amount, mode, recipient class, and source", () => {
  const key = buildCacheKey(request(), "zfi");
  const parts = key.split(":");
  assert.equal(parts[0], "8453");
  assert.equal(parts[1], address("11").toLowerCase());
  assert.equal(parts[2], address("22").toLowerCase());
  assert.equal(parts[3], "1000000");
  assert.equal(parts[4], "exact-input");
  assert.equal(parts[5], "eoa");
  assert.equal(parts[6], "zfi");
});

test("cache keys never cross chain ids", () => {
  const keyA = buildCacheKey(request({ chainId: 8453 }), "zfi");
  const keyB = buildCacheKey(request({ chainId: 1 }), "zfi");
  assert.notEqual(keyA, keyB);
  assert.ok(keyA.startsWith("8453:"));
  assert.ok(keyB.startsWith("1:"));
});

test("cache keys differ by source id", () => {
  const keyA = buildCacheKey(request(), "zfi");
  const keyB = buildCacheKey(request(), "set-bstock-ai");
  assert.notEqual(keyA, keyB);
});

test("cache keys differ by mode and amount", () => {
  const keyA = buildCacheKey(request(), "zfi");
  const keyB = buildCacheKey(request({ mode: "exact-output", amount: "2500000" }), "zfi");
  assert.notEqual(keyA, keyB);
});

test("QuoteCache stores and retrieves within ttl", () => {
  let time = 1000;
  const cache = new QuoteCache({ ttlMs: 5000, now: () => time });
  cache.set("k", { quote: "abc" });
  assert.deepEqual(cache.get("k"), { quote: "abc" });
  time = 6001;
  assert.equal(cache.get("k"), null);
});

test("QuoteCache evicts oldest entry when maxEntries exceeded", () => {
  const cache = new QuoteCache({ maxEntries: 2, now: () => 1000 });
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  assert.equal(cache.get("a"), null);
  assert.equal(cache.get("b"), 2);
  assert.equal(cache.get("c"), 3);
  assert.equal(cache.size, 2);
});

test("QuoteCache.dedupe returns cached value without calling fn", async () => {
  const cache = new QuoteCache({ now: () => 1000 });
  cache.set("k", "cached");
  let called = false;
  const result = await cache.dedupe("k", async () => { called = true; return "fresh"; });
  assert.equal(result.value, "cached");
  assert.equal(result.fromCache, true);
  assert.equal(called, false);
});

test("QuoteCache.dedupe deduplicates concurrent in-flight requests", async () => {
  const cache = new QuoteCache({ now: () => 1000 });
  let callCount = 0;
  const fn = async () => {
    callCount++;
    await new Promise((r) => setTimeout(r, 50));
    return "result";
  };
  const [r1, r2] = await Promise.all([cache.dedupe("k", fn), cache.dedupe("k", fn)]);
  assert.equal(r1.value, "result");
  assert.equal(r2.value, "result");
  assert.equal(callCount, 1);
  assert.equal(r2.deduplicated, true);
});

test("QuoteCache.dedupe removes inflight entry on failure", async () => {
  const cache = new QuoteCache({ now: () => 1000 });
  await assert.rejects(() => cache.dedupe("k", async () => { throw new Error("boom"); }));
  assert.equal(cache.inflightCount, 0);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  ADAPTER_HEALTH_STATUSES,
  ADAPTER_OUTCOME_STATUSES,
  DEFAULT_ADAPTER_TIMEOUT_MS,
  MockQuoteAdapter,
  QuoteSourceAdapter,
  QuoteSourceRegistry,
  normalizeCapabilities,
  runQuoteSources,
  validateQuoteResponse,
} from "../src/index.js";

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

test("defines adapter outcome and health status vocabularies", () => {
  assert.deepEqual([...ADAPTER_OUTCOME_STATUSES], ["available", "unavailable", "stale"]);
  assert.deepEqual([...ADAPTER_HEALTH_STATUSES], ["healthy", "degraded", "unhealthy"]);
  assert.ok(DEFAULT_ADAPTER_TIMEOUT_MS > 0);
});

test("requires explicit chain capabilities and validates modes/kinds", () => {
  assert.throws(() => normalizeCapabilities({}), /chains/);
  assert.throws(() => normalizeCapabilities({ chains: [] }), /chains/);
  assert.throws(
    () => normalizeCapabilities({ chains: [8453], modes: ["bogus"] }),
    /mode/,
  );
  const caps = normalizeCapabilities({ chains: [8453] });
  assert.deepEqual(caps.modes, ["exact-input", "exact-output"]);
  assert.deepEqual(caps.kinds, ["indicative", "firm"]);
});

test("enforces the Set user-facing name and internal poolId rule", () => {
  assert.throws(
    () => new QuoteSourceAdapter({ id: "s", type: "setwise", displayName: "Setwise", poolId: "p" }, { capabilities: { chains: [8453] } }),
    /Set/,
  );
  assert.throws(
    () => new QuoteSourceAdapter({ id: "s", type: "setwise", displayName: "Set" }, { capabilities: { chains: [8453] } }),
    /poolId/,
  );
  assert.throws(
    () => new QuoteSourceAdapter({ id: "z", type: "zfi", displayName: "ZFi", poolId: "p" }, { capabilities: { chains: [8453] } }),
    /poolId/,
  );
  const set = new QuoteSourceAdapter(
    { id: "set-bstock-ai", type: "setwise", displayName: "Set", poolId: "bstock-ai" },
    { capabilities: { chains: [8453] } },
  );
  assert.deepEqual(set.describe(), {
    id: "set-bstock-ai",
    type: "setwise",
    displayName: "Set",
    poolId: "bstock-ai",
  });
});

test("exposes a default health probe and a per-source timeout budget", async () => {
  const adapter = mock();
  const health = await adapter.health({ now });
  assert.equal(health.status, "healthy");
  assert.equal(health.checkedAt, NOW);
  assert.equal(adapter.timeoutMs, DEFAULT_ADAPTER_TIMEOUT_MS);
  assert.equal(mock({}, {}, { timeoutMs: 250 }).timeoutMs, 250);
});

test("registry rejects duplicate ids and looks adapters up", () => {
  const registry = new QuoteSourceRegistry([mock()]);
  assert.throws(() => registry.register(mock()), /duplicate/);
  assert.equal(registry.get("zfi"), registry.list()[0]);
  assert.equal(registry.get("missing"), null);
  assert.equal([...registry].length, 1);
});

test("a mock adapter exercises the full indicative route pipeline", async () => {
  const { sources, timings } = await runQuoteSources([mock()], request(), { now });
  assert.equal(sources.length, 1);
  const response = {
    apiVersion: "v1",
    requestId: "req_pipeline",
    chainId: 8453,
    mode: "exact-input",
    kind: "indicative",
    selectedSourceId: sources[0].source.id,
    sources,
    transaction: null,
  };
  assert.equal(validateQuoteResponse(response, request()).sources[0].status, "available");
  assert.equal(timings[0].sourceId, "zfi");
  assert.equal(timings[0].status, "available");
  assert.ok(timings[0].latencyMs >= 0);
});

test("preserves the exact amount on the correct side for both modes", async () => {
  const exactInput = await runQuoteSources([mock()], request(), { now });
  assert.equal(exactInput.sources[0].quote.amounts.input, "1000000");

  const exactOutputRequest = request({ mode: "exact-output", amount: "2500000" });
  const exactOutput = await runQuoteSources([mock()], exactOutputRequest, { now });
  assert.equal(exactOutput.sources[0].quote.amounts.output, "2500000");
});

test("produces a firm quote with expiry and approval target", async () => {
  const { sources } = await runQuoteSources([mock()], request(), { kind: "firm", now });
  const quote = sources[0].quote;
  assert.equal(quote.kind, "firm");
  assert.equal(quote.approvalTarget.address, address("33"));
  assert.ok(quote.expiresAt);
});

test("one failed source does not fail viable alternatives", async () => {
  const failing = mock({ id: "broken", displayName: "Broken" }, { failWith: new Error("boom") });
  const healthy = mock({ id: "zfi" });
  const { sources } = await runQuoteSources([failing, healthy], request(), { now });

  const byId = Object.fromEntries(sources.map((s) => [s.source.id, s]));
  assert.equal(byId.broken.status, "failed");
  assert.equal(byId.broken.quote, null);
  assert.equal(byId.broken.evidence[0].code, "SOURCE_ERROR");
  assert.equal(byId.broken.evidence[0].message, "boom");
  assert.equal(byId.zfi.status, "available");
  assert.ok(byId.zfi.quote);
});

test("skips unsupported chain and exact-mode combinations explicitly", async () => {
  const ethOnly = mock(
    { id: "eth-only", displayName: "ETH only" },
    {},
    { capabilities: { chains: [1] } },
  );
  const exactInputOnly = mock(
    { id: "input-only", displayName: "Input only" },
    {},
    { capabilities: { chains: [8453], modes: ["exact-input"] } },
  );

  const { sources } = await runQuoteSources(
    [ethOnly, exactInputOnly],
    request({ mode: "exact-output", amount: "2500000" }),
    { now },
  );
  const byId = Object.fromEntries(sources.map((s) => [s.source.id, s]));
  assert.equal(byId["eth-only"].status, "excluded");
  assert.equal(byId["eth-only"].evidence[0].code, "UNSUPPORTED_CHAIN");
  assert.equal(byId["input-only"].status, "excluded");
  assert.equal(byId["input-only"].evidence[0].code, "UNSUPPORTED_MODE");
});

test("skips unsupported quote kinds explicitly", async () => {
  const indicativeOnly = mock(
    { id: "indicative-only", displayName: "Indicative only" },
    {},
    { capabilities: { chains: [8453], kinds: ["indicative"] } },
  );
  const { sources } = await runQuoteSources([indicativeOnly], request(), {
    kind: "firm",
    now,
  });
  assert.equal(sources[0].status, "excluded");
  assert.equal(sources[0].evidence[0].code, "UNSUPPORTED_KIND");
});

test("enforces the per-source timeout budget", async () => {
  const slow = mock({ id: "slow" }, { latencyMs: 300 }, { timeoutMs: 20 });
  const { sources, timings } = await runQuoteSources([slow], request(), { now });
  assert.equal(sources[0].status, "failed");
  assert.equal(sources[0].evidence[0].code, "UPSTREAM_TIMEOUT");
  assert.equal(timings[0].timedOut, true);
  assert.equal(timings[0].cancelled, false);
});

test("cancels in-flight sources when the caller aborts", async () => {
  const controller = new AbortController();
  const fast = mock({ id: "fast" });
  const slow = mock({ id: "slow" }, { latencyMs: 300 });
  const promise = runQuoteSources([fast, slow], request(), {
    signal: controller.signal,
    now,
  });
  setTimeout(() => controller.abort(), 20);
  const { sources, timings } = await promise;

  const byId = Object.fromEntries(sources.map((s) => [s.source.id, s]));
  assert.equal(byId.fast.status, "available");
  assert.equal(byId.slow.status, "failed");
  assert.equal(byId.slow.evidence[0].code, "CANCELLED");
  const slowTiming = timings.find((t) => t.sourceId === "slow");
  assert.equal(slowTiming.cancelled, true);
});

test("fans out in parallel and preserves input order", async () => {
  const slow = mock({ id: "slow" }, { latencyMs: 60 });
  const fast = mock({ id: "fast" });
  const started = performance.now();
  const { sources } = await runQuoteSources([slow, fast], request(), { now });
  const elapsed = performance.now() - started;

  assert.deepEqual(sources.map((s) => s.source.id), ["slow", "fast"]);
  assert.ok(elapsed < 120, `expected parallel fan-out, took ${elapsed}ms`);
});

test("records a Set source with its internal poolId through the pipeline", async () => {
  const set = new MockQuoteAdapter(
    { id: "set-bstock-ai", type: "setwise", displayName: "Set", poolId: "bstock-ai" },
    { capabilities: { chains: [8453] } },
  );
  const { sources } = await runQuoteSources([set], request(), { now });
  const response = {
    apiVersion: "v1",
    requestId: "req_set",
    chainId: 8453,
    mode: "exact-input",
    kind: "indicative",
    selectedSourceId: "set-bstock-ai",
    sources,
    transaction: null,
  };
  const validated = validateQuoteResponse(response, request());
  assert.equal(validated.sources[0].source.displayName, "Set");
  assert.equal(validated.sources[0].source.poolId, "bstock-ai");
});

test("reports adapter declines as unavailable with evidence", async () => {
  const declining = mock({ id: "dry" }, { decline: true });
  const { sources } = await runQuoteSources([declining], request(), { now });
  assert.equal(sources[0].status, "unavailable");
  assert.equal(sources[0].quote, null);
  assert.ok(sources[0].evidence.length > 0);
});

test("validates the request and kind before fanning out", async () => {
  await assert.rejects(() => runQuoteSources([mock()], request({ chainId: 137 }), { now }));
  await assert.rejects(() => runQuoteSources([mock()], request(), { kind: "bogus", now }));
});

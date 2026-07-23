import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  assembleQuoteResponse,
  buildRouteRanking,
  rankQuoteSources,
} from "../src/index.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = join(packageRoot, "fixtures", "ranking");
const NOW = "2026-07-23T12:00:00.000Z";

const address = (suffix) => `0x${suffix.padStart(40, "0")}`;
const scoped = (chainId, tokenAddress) => ({ chainId, address: tokenAddress });

function loadFixtures() {
  return readdirSync(fixtureDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({
      name,
      ...JSON.parse(readFileSync(join(fixtureDir, name), "utf8")),
    }));
}

function requestFor(fixture) {
  const exactRoute = fixture.routes[0];
  return {
    apiVersion: "v1",
    chainId: fixture.chainId,
    tokenIn: scoped(fixture.chainId, fixture.tokenIn),
    tokenOut: scoped(fixture.chainId, fixture.tokenOut),
    router: scoped(fixture.chainId, address("33")),
    mode: fixture.mode,
    amount:
      fixture.mode === "exact-input" ? exactRoute.input : exactRoute.output,
    recipient: scoped(fixture.chainId, address("44")),
    funder: scoped(fixture.chainId, address("55")),
    slippage: { maxBps: 50 },
  };
}

function outcomeFor(fixture, route, overrides = {}) {
  const comparisonToken =
    fixture.mode === "exact-input" ? fixture.tokenOut : fixture.tokenIn;
  return {
    source: { id: route.id, type: "zfi", displayName: route.id },
    status: "available",
    quote: {
      kind: overrides.kind ?? "indicative",
      amounts: {
        input: route.input,
        output: route.output,
        limit: fixture.mode === "exact-input" ? route.output : route.input,
      },
      gas: {
        estimatedUnits: route.gasUnits,
        estimatedCost: route.gasCost,
      },
      fees: route.fees.map((fee) => ({
        ...fee,
        token: scoped(fixture.chainId, fee.token ?? comparisonToken),
      })),
      approvalTarget: overrides.approvalTarget ?? null,
      expiresAt: overrides.kind === "firm" ? "2026-07-23T12:01:00.000Z" : null,
    },
    evidence: [
      {
        kind: "onchain",
        observedAt: NOW,
        reference: `${route.id}:fixture`,
      },
    ],
  };
}

function rankingOptions(fixture, overrides = {}) {
  return {
    conversions: [
      {
        fromToken: scoped(fixture.chainId, fixture.conversion.fromToken),
        toToken: scoped(fixture.chainId, fixture.conversion.toToken),
        fromAmount: fixture.conversion.fromAmount,
        toAmount: fixture.conversion.toAmount,
      },
    ],
    ...overrides,
  };
}

test("ranking fixtures cover every chain-native gas token and token-decimal mix", () => {
  const fixtures = loadFixtures();
  assert.deepEqual(
    fixtures.map(({ chainId }) => chainId).sort((a, b) => a - b),
    [1, 56, 4663, 8453],
  );
  assert.deepEqual(
    [...new Set(fixtures.map(({ nativeSymbol }) => nativeSymbol))].sort(),
    ["BNB", "ETH"],
  );
  assert.deepEqual(
    [...new Set(fixtures.flatMap((f) => [f.inputDecimals, f.outputDecimals]))].sort(
      (a, b) => a - b,
    ),
    [6, 8, 18],
  );

  for (const fixture of fixtures) {
    const request = requestFor(fixture);
    const sources = fixture.routes.map((route) => outcomeFor(fixture, route));
    const response = assembleQuoteResponse({
      request,
      sources,
      kind: "indicative",
      requestId: `ranking_${fixture.chainId}`,
      ranking: rankingOptions(fixture),
    });
    assert.equal(
      response.selectedSourceId,
      fixture.expectedSourceId,
      `${fixture.name}: adjusted outcome selects the expected route`,
    );
    for (const source of response.sources) {
      assert.equal(source.ranking.status, "complete", `${fixture.name}: pricing is complete`);
      assert.ok(source.ranking.adjustedAmount !== null);
      assert.equal(source.ranking.comparisonToken.chainId, fixture.chainId);
      assert.ok(
        source.evidence.some((entry) => entry.reference === `ranking:${source.source.id}`),
        `${fixture.name}: raw and adjusted amounts are retained in ranking evidence`,
      );
    }
  }
});

test("exact-input subtracts protocol, integrator, gas, and approval costs", () => {
  const fixture = loadFixtures().find((item) => item.chainId === 1);
  const request = requestFor(fixture);
  const route = fixture.routes[1];
  const outcome = outcomeFor(fixture, route, {
    kind: "firm",
    approvalTarget: scoped(1, address("99")),
  });
  const ranking = buildRouteRanking(
    outcome,
    request,
    rankingOptions(fixture),
  );
  const byType = Object.groupBy(ranking.adjustments, ({ type }) => type);

  assert.equal(byType["protocol-fee"][0].comparisonAmount, "100000");
  assert.equal(byType["integrator-fee"][0].comparisonAmount, "50000");
  assert.equal(byType.gas[0].comparisonAmount, "200000");
  assert.equal(byType.approval[0].amount, "46000000000000");
  assert.equal(byType.approval[0].comparisonAmount, "92000");
  assert.equal(ranking.rawAmount, "2499000000");
  assert.equal(ranking.adjustedAmount, "2498558000");
});

test("exact-output adds all priced costs to required input", () => {
  const fixture = loadFixtures().find((item) => item.chainId === 8453);
  const request = requestFor(fixture);
  const ranked = rankQuoteSources(
    fixture.routes.map((route) => outcomeFor(fixture, route)),
    request,
    rankingOptions(fixture),
  );
  const selected = ranked.sources.find(
    (source) => source.source.id === ranked.selectedSourceId,
  );
  assert.equal(ranked.selectedSourceId, "net-best");
  assert.ok(BigInt(selected.ranking.adjustedAmount) > BigInt(selected.ranking.rawAmount));
});

test("minimum improvement bands use a deterministic source-id tie-break", () => {
  const fixture = loadFixtures().find((item) => item.chainId === 1);
  const request = requestFor(fixture);
  const routes = [
    { ...fixture.routes[0], id: "zeta", output: "2500000000", gasCost: "100000000000000" },
    { ...fixture.routes[0], id: "alpha", output: "2499900000", gasCost: "100000000000000" },
  ];
  const withinBand = rankQuoteSources(
    routes.map((route) => outcomeFor(fixture, route)),
    request,
    rankingOptions(fixture, {
      minimumImprovementBps: 1,
      minimumImprovementAmount: "1",
    }),
  );
  assert.equal(withinBand.selectedSourceId, "alpha");

  const outsideBand = rankQuoteSources(
    routes.map((route) => outcomeFor(fixture, route)),
    request,
    rankingOptions(fixture, {
      minimumImprovementBps: 0,
      minimumImprovementAmount: "0",
    }),
  );
  assert.equal(outsideBand.selectedSourceId, "zeta");
});

test("missing prices are explicit, deprioritized, and fall back to raw amounts", () => {
  const fixture = loadFixtures().find((item) => item.chainId === 1);
  const request = requestFor(fixture);
  const sources = fixture.routes.map((route) => outcomeFor(fixture, route));

  const mixed = rankQuoteSources(sources, request, rankingOptions(fixture));
  const unpricedSource = structuredClone(sources[0]);
  unpricedSource.source.id = "unpriced";
  unpricedSource.quote.fees.push({
    type: "protocol",
    amount: "1",
    token: scoped(1, address("77")),
  });
  unpricedSource.quote.amounts.output = "999999999999";
  const withUnknown = rankQuoteSources(
    [unpricedSource, ...sources],
    request,
    rankingOptions(fixture),
  );
  assert.equal(
    withUnknown.selectedSourceId,
    mixed.selectedSourceId,
    "a route with unknown costs cannot beat fully priced routes",
  );
  const unknown = withUnknown.sources.find((source) => source.source.id === "unpriced");
  assert.equal(unknown.ranking.status, "unpriced");
  assert.equal(unknown.ranking.adjustedAmount, null);
  assert.equal(unknown.ranking.fallback, "raw-amount");
  assert.ok(
    unknown.ranking.adjustments.some((item) => item.status === "missing-price"),
  );
  assert.equal(
    unknown.evidence.find((entry) => entry.reference === "ranking:unpriced").code,
    "UNPRICED_ADJUSTMENTS",
  );

  const allUnpriced = rankQuoteSources(sources, request, { conversions: [] });
  assert.equal(
    allUnpriced.selectedSourceId,
    "raw-best",
    "when no route is fully priced, raw exact-input output is the documented fallback",
  );
});

test("RWA price warnings remain visible and never trigger an inferred price", () => {
  const fixture = loadFixtures().find((item) => item.chainId === 4663);
  const request = requestFor(fixture);
  const source = outcomeFor(fixture, fixture.routes[0]);
  source.evidence.push({
    kind: "policy",
    observedAt: NOW,
    reference: "warning:set-rwa:RWA_PRICE_UNAVAILABLE",
    code: "RWA_PRICE_UNAVAILABLE",
    message: "No reviewed native-to-RWA conversion is available",
  });
  const ranked = rankQuoteSources([source], request, { conversions: [] });
  const result = ranked.sources[0];
  assert.equal(result.ranking.status, "unpriced");
  assert.equal(result.ranking.adjustedAmount, null);
  assert.ok(result.evidence.some((entry) => entry.code === "RWA_PRICE_UNAVAILABLE"));
  assert.ok(result.evidence.some((entry) => entry.code === "UNPRICED_ADJUSTMENTS"));
});

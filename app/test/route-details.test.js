import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SETWISE_UI_LABEL } from "../src/constants.js";
import {
  ROUTE_VIEW_STATES,
  ROUTE_WARNING_CODES,
  buildRouteAccessibility,
  collectWarnings,
  describeQuoteFetchState,
  describeRouteDetailsView,
  formatRouteAddress,
  parseRoutePath,
  parseZfiRoutePath,
  summarizeAlternatives,
} from "../src/route-details.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtures = join(root, "services/quote/fixtures/v1");

function loadRouteFixture(name) {
  const raw = JSON.parse(readFileSync(join(fixtures, "routes", name), "utf8"));
  return raw.response;
}

function loadFixture(name) {
  return JSON.parse(readFileSync(join(fixtures, name), "utf8"));
}

test("formatRouteAddress shortens addresses and handles empty values", () => {
  assert.equal(
    formatRouteAddress("0x0000000000000000000000000000000000000033"),
    "0x0000…0033",
  );
  assert.equal(formatRouteAddress(null), "None");
});

test("describeQuoteFetchState exposes accessible loading state", () => {
  const view = describeQuoteFetchState({ phase: "loading" });
  assert.equal(view.status, ROUTE_VIEW_STATES.loading);
  assert.equal(view.accessibility.role, "region");
  assert.equal(view.accessibility.ariaLive, "polite");
  assert.equal(view.accessibility.ariaBusy, true);
  assert.match(view.accessibility.ariaLabel, /Finding best route/i);
});

test("describeQuoteFetchState surfaces API errors with alert semantics", () => {
  const errorFixture = loadFixture("error.response.json");
  const view = describeQuoteFetchState({
    phase: "error",
    error: errorFixture.error,
  });
  assert.equal(view.status, ROUTE_VIEW_STATES.error);
  assert.equal(view.code, "QUOTE_CHAIN_MISMATCH");
  assert.equal(view.accessibility.role, "alert");
  assert.equal(view.accessibility.ariaLive, "assertive");
  assert.match(view.message, /8453/);
});

test("describeQuoteFetchState reports no-route with alternative evidence", () => {
  const response = loadFixture("source-states.response.json");
  const noRoute = { ...response, selectedSourceId: null };
  const view = describeQuoteFetchState({ phase: "success", response: noRoute });
  assert.equal(view.status, ROUTE_VIEW_STATES.noRoute);
  assert.ok(view.alternatives.length > 0);
  assert.equal(view.accessibility.role, "region");
});

test("describeQuoteFetchState reports fallback when firm was requested but indicative returned", () => {
  const response = loadRouteFixture("setwise.exact-input.json");
  const view = describeQuoteFetchState({
    phase: "success",
    response,
    requestedKind: "firm",
  });
  assert.equal(view.status, ROUTE_VIEW_STATES.fallback);
  assert.ok(view.route);
  assert.equal(view.route.setwise.quoteState, "indicative");
});

test("describeRouteDetailsView makes selected source and execution target unambiguous", () => {
  const response = loadFixture("firm.response.json");
  const view = describeRouteDetailsView(response);
  assert.equal(view.status, ROUTE_VIEW_STATES.ready);
  assert.equal(view.selected.sourceId, "set-bstock-ai");
  assert.equal(view.selected.displayName, SETWISE_UI_LABEL);
  assert.equal(view.selected.poolId, "bstock-ai");
  assert.equal(view.execution.target.address, response.transaction.to);
  assert.equal(view.execution.approvalTarget.address, response.sources[0].quote.approvalTarget.address);
  assert.equal(view.execution.targetLabel, "0x0000…0033");
});

test("describeRouteDetailsView distinguishes Set indicative and firm states", () => {
  const indicative = describeRouteDetailsView(loadRouteFixture("setwise.exact-input.json"));
  assert.equal(indicative.setwise.quoteState, "indicative");
  assert.equal(indicative.setwise.stateSeverity, "info");
  assert.match(indicative.setwise.stateLabel, /Indicative Set quote/);
  assert.equal(indicative.setwise.expiresAt, null);

  const firm = describeRouteDetailsView(loadFixture("firm.response.json"), {
    now: "2026-07-22T20:00:30.000Z",
  });
  assert.equal(firm.setwise.quoteState, "firm");
  assert.equal(firm.setwise.stateSeverity, "ok");
  assert.match(firm.setwise.stateLabel, /Firm Set quote/);
  assert.equal(firm.setwise.expiresAt, "2026-07-22T20:01:00.000Z");
  assert.match(firm.setwise.expiresLabel, /Expires in 30s/);
});

test("describeRouteDetailsView reports ZFi hops and split proportions", () => {
  const direct = describeRouteDetailsView(loadRouteFixture("direct.exact-input.json"));
  assert.equal(direct.routePath.builder, "direct");
  assert.equal(direct.routePath.hops.length, 1);
  assert.equal(direct.routePath.hops[0].splitBps, 10000);

  const composite = describeRouteDetailsView(loadRouteFixture("composite.exact-input.json"));
  assert.equal(composite.routePath.builder, "split");
  assert.equal(composite.routePath.hops.length, 2);
  assert.deepEqual(
    composite.routePath.hops.map((hop) => hop.splitBps),
    [6000, 4000],
  );
});

test("describeRouteDetailsView preserves comparable alternative routes", () => {
  const response = loadFixture("source-states.response.json");
  const view = describeRouteDetailsView(response);
  assert.equal(view.alternatives.length, response.sources.length - 1);
  const zeroEx = view.alternatives.find((entry) => entry.sourceId === "zero-ex");
  assert.equal(zeroEx.status, "unavailable");
  assert.ok(zeroEx.evidence.some((item) => item.code === "NO_LIQUIDITY"));
});

test("collectWarnings surfaces API warning codes including RWA conditions", () => {
  const evidence = [
    { code: "POOL_IDENTITY", message: "poolAddress=0xabc" },
    { code: ROUTE_WARNING_CODES.MARKET_SESSION, message: "Outside market hours" },
    { code: ROUTE_WARNING_CODES.STALE_PRICE, message: "Price feed is stale" },
    { code: ROUTE_WARNING_CODES.STALE_INVENTORY, message: "Inventory snapshot is stale" },
    { code: ROUTE_WARNING_CODES.NATIVE_OUTPUT, message: "Output will be delivered as native asset" },
    { code: ROUTE_WARNING_CODES.MIN_NOTIONAL, message: "Near minimum trade size", reference: "warning:bstock-ai:MIN_NOTIONAL" },
  ];
  const warnings = collectWarnings(evidence);
  assert.equal(warnings.length, 5);
  assert.deepEqual(
    warnings.map((warning) => warning.category),
    ["market-session", "stale-price", "inventory", "native-output", "general"],
  );
});

test("parseZfiRoutePath decodes builder legs from on-chain evidence", () => {
  const response = loadRouteFixture("composite.exact-input.json");
  const evidence = response.sources[0].evidence;
  const path = parseZfiRoutePath(evidence);
  assert.equal(path.builder, "split");
  assert.equal(path.hops.length, 2);
});

test("parseRoutePath maps Set pool identity without renaming poolId", () => {
  const response = loadRouteFixture("setwise.exact-input.json");
  const evidence = response.sources[0].evidence;
  const path = parseRoutePath("setwise", evidence);
  assert.equal(path.builder, "set-direct");
  assert.equal(path.poolId, "bstock-ai");
  assert.match(path.poolAddress, /^0x[a-fA-F0-9]{40}$/);
});

test("summarizeAlternatives keeps rejected source evidence for comparison", () => {
  const response = loadFixture("source-states.response.json");
  const alternatives = summarizeAlternatives(response);
  const excluded = alternatives.find((entry) => entry.sourceId === "set-policy");
  assert.equal(excluded.status, "excluded");
  assert.match(excluded.summary, /minimum size/i);
});

test("buildRouteAccessibility reflects warning count on ready routes", () => {
  const view = describeRouteDetailsView(loadRouteFixture("setwise.exact-input.json"));
  const a11y = buildRouteAccessibility(view);
  assert.equal(a11y.role, "region");
  assert.match(a11y.ariaLabel, /Route details for Set/);
  assert.equal(a11y.ariaBusy, false);
});

test("accessibility tests cover route details and error states", () => {
  const states = [
    describeQuoteFetchState({ phase: "loading" }),
    describeQuoteFetchState({
      phase: "error",
      error: { code: "QUOTE_INVALID_REQUEST", message: "bad request" },
    }),
    describeRouteDetailsView(loadRouteFixture("direct.exact-input.json")),
  ];

  for (const view of states) {
    const a11y = buildRouteAccessibility(view);
    assert.ok(a11y.role, `${view.status} missing role`);
    assert.ok(a11y.ariaLabel, `${view.status} missing ariaLabel`);
    assert.ok(["off", "polite", "assertive"].includes(a11y.ariaLive), `${view.status} ariaLive`);
    assert.equal(typeof a11y.ariaBusy, "boolean", `${view.status} ariaBusy`);
  }
});

test("describeRouteDetailsView labels exact-output limits as maximum sent", () => {
  const view = describeRouteDetailsView(loadRouteFixture("setwise.exact-output.json"));
  assert.equal(view.mode, "exact-output");
  assert.equal(view.amounts.limitLabel, "Maximum sent");
});

test("describeRouteDetailsView includes gas, fees, and aggregator reference", () => {
  const view = describeRouteDetailsView(loadRouteFixture("external.exact-input.json"));
  assert.equal(view.gas.estimatedUnits, "185000");
  assert.equal(view.fees.length, 2);
  assert.equal(view.routePath.reference, "zeroex:indicative:8453");
});

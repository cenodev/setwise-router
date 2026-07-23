import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  QUOTE_SOURCE_TYPES,
  validateQuoteRequest,
  validateQuoteResponse,
} from "../src/index.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const routesDir = join(packageRoot, "fixtures/v1/routes");

function loadGoldenFixtures() {
  return readdirSync(routesDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({
      name,
      ...JSON.parse(readFileSync(join(routesDir, name), "utf8")),
    }));
}

const fixtures = loadGoldenFixtures();

test("golden route fixtures cover direct, composite, external, and Setwise routes", () => {
  const routes = new Set(fixtures.map((f) => f.meta.route));
  assert.deepEqual(
    [...routes].sort(),
    ["composite", "direct", "external", "setwise"],
    "every route shape has a golden fixture",
  );
});

test("golden fixtures cover exact-input and exact-output for every enabled source", () => {
  for (const mode of ["exact-input", "exact-output"]) {
    const types = new Set(
      fixtures
        .filter((f) => f.request.mode === mode)
        .map((f) => f.response.sources.find((s) => s.status === "available").source.type),
    );
    for (const type of QUOTE_SOURCE_TYPES) {
      assert.ok(
        types.has(type),
        `expected a ${mode} fixture selecting a ${type} source, saw ${[...types].join(", ")}`,
      );
    }
  }
});

test("every golden fixture request and response validates against the schema", () => {
  for (const fixture of fixtures) {
    validateQuoteRequest(fixture.request);
    validateQuoteResponse(fixture.response, fixture.request);
  }
});

test("golden fixtures preserve the exact request amount on the correct side", () => {
  for (const { name, request, response } of fixtures) {
    const selected = response.sources.find((s) => s.source.id === response.selectedSourceId);
    assert.ok(selected, `${name}: selectedSourceId must identify a source`);
    assert.equal(selected.status, "available", `${name}: selected source must be available`);
    const exactSide = request.mode === "exact-input" ? "input" : "output";
    assert.equal(
      selected.quote.amounts[exactSide],
      request.amount,
      `${name}: ${exactSide} must equal the request amount`,
    );
  }
});

test("golden fixtures use conservative slippage limits for token decimals", () => {
  for (const { name, request, response } of fixtures) {
    const selected = response.sources.find((s) => s.source.id === response.selectedSourceId);
    const { input, output, limit } = selected.quote.amounts;
    if (request.mode === "exact-input") {
      assert.ok(
        BigInt(limit) <= BigInt(output),
        `${name}: exact-input limit ${limit} must not exceed quoted output ${output}`,
      );
    } else {
      assert.ok(
        BigInt(limit) >= BigInt(input),
        `${name}: exact-output limit ${limit} must not fall below required input ${input}`,
      );
    }
  }
});

test("the selected route is reconstructable from response evidence", () => {
  for (const { name, response } of fixtures) {
    const selected = response.sources.find((s) => s.source.id === response.selectedSourceId);
    assert.ok(selected.quote, `${name}: selected source carries a normalized quote`);
    assert.ok(selected.evidence.length > 0, `${name}: selected source carries evidence`);
    for (const field of ["amounts", "gas", "fees", "approvalTarget", "expiresAt"]) {
      assert.ok(field in selected.quote, `${name}: selected quote reports ${field}`);
    }
    if (selected.source.type === "zfi") {
      const path = selected.evidence.find((e) => e.reference.startsWith("zfi:"));
      const decoded = JSON.parse(path.message);
      assert.ok(decoded.builder, `${name}: ZFi route evidence names the builder`);
      assert.ok(Array.isArray(decoded.legs) && decoded.legs.length > 0, `${name}: ZFi route evidence lists legs`);
      if ("proportionBps" in decoded.legs[0]) {
        const total = decoded.legs.reduce((sum, leg) => sum + leg.proportionBps, 0);
        assert.equal(total, 10000, `${name}: split proportions sum to the full input`);
      }
    }
    if (selected.source.type === "setwise") {
      assert.ok(selected.source.poolId, `${name}: Set source retains its internal poolId`);
      assert.equal(selected.source.displayName, "Set", `${name}: Set source uses the user-facing name`);
    }
  }
});

test("unsupported exact-output sources are clearly excluded with policy evidence", () => {
  const fixture = fixtures.find((f) => f.name === "composite.exact-output.json");
  assert.ok(fixture, "composite.exact-output.json exists");
  const excluded = fixture.response.sources.filter((s) => s.status === "excluded");
  assert.ok(excluded.length > 0, "an exact-input-only source is excluded for exact-output");
  for (const source of excluded) {
    assert.equal(source.quote, null, "excluded sources carry no quote");
    assert.equal(source.evidence[0].code, "UNSUPPORTED_MODE");
    assert.equal(source.evidence[0].kind, "policy");
  }
  assert.equal(fixture.response.selectedSourceId, "zfi", "only the capable source is selected");
});

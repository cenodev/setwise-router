import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  QUOTE_API_VERSION,
  QUOTE_ERROR_CODES,
  QUOTE_KINDS,
  QUOTE_MODES,
  QUOTE_SOURCE_STATUSES,
  QUOTE_SOURCE_TYPES,
  QuoteSchemaError,
  quoteErrorResponse,
  validateQuoteError,
  validateQuoteRequest,
  validateQuoteResponse,
} from "../src/index.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(packageRoot, "../..");
const fixture = (name) =>
  JSON.parse(readFileSync(join(packageRoot, "fixtures/v1", name), "utf8"));

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

function evidence(overrides = {}) {
  return {
    kind: "onchain",
    observedAt: "2026-07-22T20:00:00.000Z",
    reference: "base:123456",
    blockNumber: "123456",
    ...overrides,
  };
}

function quote(kind = "indicative", overrides = {}) {
  return {
    kind,
    amounts: { input: "1000000", output: "2500000", limit: "2487500" },
    gas: { estimatedUnits: "180000", estimatedCost: "24000000000000" },
    fees: [
      { type: "source", amount: "1000", token: scoped(8453, "11") },
    ],
    approvalTarget: kind === "firm" ? scoped(8453, "33") : null,
    expiresAt: kind === "firm" ? "2026-07-22T20:01:00.000Z" : null,
    ...overrides,
  };
}

function source(overrides = {}) {
  return {
    source: { id: "zfi", type: "zfi", displayName: "ZFi" },
    status: "available",
    quote: quote(),
    evidence: [evidence()],
    ...overrides,
  };
}

function response(overrides = {}) {
  return {
    apiVersion: "v1",
    requestId: "req_01",
    chainId: 8453,
    mode: "exact-input",
    kind: "indicative",
    selectedSourceId: "zfi",
    sources: [source()],
    transaction: null,
    ...overrides,
  };
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof QuoteSchemaError);
    assert.equal(error.code, code);
    return true;
  });
}

test("validates exact-input and exact-output requests", () => {
  assert.equal(validateQuoteRequest(request()).mode, "exact-input");
  const exactOutput = request({ mode: "exact-output", amount: "2500000" });
  assert.equal(validateQuoteRequest(exactOutput).mode, "exact-output");
});

test("requires every request field and rejects unknown fields", () => {
  const missing = request();
  delete missing.funder;
  expectCode(() => validateQuoteRequest(missing), QUOTE_ERROR_CODES.INVALID_REQUEST);
  expectCode(
    () => validateQuoteRequest({ ...request(), transactions: [] }),
    QUOTE_ERROR_CODES.INVALID_REQUEST,
  );
});

test("rejects unsupported chains and cross-chain token references", () => {
  expectCode(
    () => validateQuoteRequest(request({ chainId: 137 })),
    QUOTE_ERROR_CODES.UNSUPPORTED_CHAIN,
  );
  expectCode(
    () => validateQuoteRequest(request({ tokenOut: scoped(1, "22") })),
    QUOTE_ERROR_CODES.CHAIN_MISMATCH,
  );
});

test("rejects cross-chain router references and malformed amounts", () => {
  expectCode(
    () => validateQuoteRequest(request({ router: scoped(1, "33") })),
    QUOTE_ERROR_CODES.CHAIN_MISMATCH,
  );
  for (const amount of [0, "0", "01", "-1", "1.2"]) {
    expectCode(
      () => validateQuoteRequest(request({ amount })),
      QUOTE_ERROR_CODES.INVALID_AMOUNT,
    );
  }
});

test("validates indicative source outcomes without an executable transaction", () => {
  assert.equal(validateQuoteResponse(response(), request()).kind, "indicative");
});

test("validates one firm transaction targeting the requested router", () => {
  const firmSource = source({ quote: quote("firm") });
  const firm = response({
    kind: "firm",
    sources: [firmSource],
    transaction: {
      chainId: 8453,
      to: address("33"),
      calldata: "0x1234",
      value: "0",
    },
  });
  assert.equal(validateQuoteResponse(firm, request()).transaction.to, address("33"));
});

test("keeps indicative and executable firm responses distinct", () => {
  expectCode(
    () =>
      validateQuoteResponse(
        response({
          transaction: {
            chainId: 8453,
            to: address("33"),
            calldata: "0x",
            value: "0",
          },
        }),
        request(),
      ),
    QUOTE_ERROR_CODES.AMBIGUOUS_EXECUTION,
  );
  expectCode(
    () => validateQuoteResponse(response({ kind: "firm" }), request()),
    QUOTE_ERROR_CODES.INVALID_RESPONSE,
  );
});

test("rejects ambiguous and wrong-router firm transactions", () => {
  const firmSource = source({ quote: quote("firm") });
  const base = response({ kind: "firm", sources: [firmSource] });
  expectCode(
    () => validateQuoteResponse({ ...base, transaction: [] }, request()),
    QUOTE_ERROR_CODES.AMBIGUOUS_EXECUTION,
  );
  expectCode(
    () =>
      validateQuoteResponse(
        {
          ...base,
          transaction: {
            chainId: 8453,
            to: address("99"),
            calldata: "0x1234",
            value: "0",
          },
        },
        request(),
      ),
    QUOTE_ERROR_CODES.ROUTER_MISMATCH,
  );
});

test("represents unavailable, excluded, stale, and failed sources with evidence", () => {
  const states = ["unavailable", "excluded", "stale", "failed"].map((status) =>
    source({
      source: { id: status, type: "aggregator", displayName: status },
      status,
      quote: status === "stale" ? quote() : null,
      evidence: [evidence({ kind: "http", reference: `provider:${status}` })],
    }),
  );
  const result = validateQuoteResponse(
    response({ sources: [source(), ...states] }),
    request(),
  );
  assert.deepEqual(
    result.sources.slice(1).map(({ status }) => status),
    ["unavailable", "excluded", "stale", "failed"],
  );
});

test("requires evidence for every source state", () => {
  expectCode(
    () => validateQuoteResponse(response({ sources: [source({ evidence: [] })] }), request()),
    QUOTE_ERROR_CODES.SOURCE_EVIDENCE_REQUIRED,
  );
});

test("uses Set in user-facing source names while retaining poolId internally", () => {
  const setSource = source({
    source: {
      id: "set-bstock-ai",
      type: "setwise",
      displayName: "Set",
      poolId: "bstock-ai",
    },
  });
  assert.equal(
    validateQuoteResponse(response({ sources: [setSource], selectedSourceId: "set-bstock-ai" }), request())
      .sources[0].source.poolId,
    "bstock-ai",
  );
  setSource.source.displayName = "Setwise";
  expectCode(
    () => validateQuoteResponse(response({ sources: [setSource] }), request()),
    QUOTE_ERROR_CODES.INVALID_RESPONSE,
  );
});

test("preserves exact request amounts in normalized source quotes", () => {
  const exactOutputRequest = request({ mode: "exact-output", amount: "2500000" });
  const exactOutputResponse = response({
    mode: "exact-output",
    sources: [source()],
  });
  assert.equal(
    validateQuoteResponse(exactOutputResponse, exactOutputRequest).sources[0].quote.amounts.output,
    "2500000",
  );
  expectCode(
    () =>
      validateQuoteResponse(
        response({ sources: [source({ quote: quote("indicative", { amounts: { input: "999", output: "2500000", limit: "2487500" } }) })] }),
        request(),
      ),
    QUOTE_ERROR_CODES.INVALID_RESPONSE,
  );
});

test("serializes schema failures into the stable v1 error envelope", () => {
  let error;
  try {
    validateQuoteRequest(request({ apiVersion: "v2" }));
  } catch (caught) {
    error = caught;
  }
  const envelope = quoteErrorResponse(error);
  assert.equal(envelope.error.code, QUOTE_ERROR_CODES.UNSUPPORTED_API_VERSION);
  assert.equal(validateQuoteError(envelope), envelope);
});

test("committed v1 request and response fixtures validate", () => {
  const exactInput = fixture("exact-input.request.json");
  const exactOutput = fixture("exact-output.request.json");
  validateQuoteRequest(exactInput);
  validateQuoteRequest(exactOutput);
  validateQuoteResponse(fixture("indicative.response.json"), exactInput);
  validateQuoteResponse(fixture("firm.response.json"), exactInput);
  validateQuoteResponse(fixture("source-states.response.json"), exactInput);
  validateQuoteError(fixture("error.response.json"));
});

test("OpenAPI v1 enums and error codes stay aligned with runtime validation", () => {
  const api = JSON.parse(
    readFileSync(join(repositoryRoot, "docs/api/quote-v1.openapi.json"), "utf8"),
  );
  const schemas = api.components.schemas;
  assert.equal(api.openapi, "3.1.0");
  assert.equal(schemas.ApiVersion.const, QUOTE_API_VERSION);
  assert.deepEqual(schemas.QuoteRequest.properties.mode.enum, [...QUOTE_MODES]);
  assert.deepEqual(schemas.QuoteResponse.properties.kind.enum, [...QUOTE_KINDS]);
  assert.deepEqual(schemas.Source.properties.type.enum, [...QUOTE_SOURCE_TYPES]);
  assert.deepEqual(
    schemas.SourceOutcome.properties.status.enum,
    [...QUOTE_SOURCE_STATUSES],
  );
  assert.deepEqual(
    schemas.ErrorResponse.properties.error.properties.code.enum,
    Object.values(QUOTE_ERROR_CODES),
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  AllSourcesFailedError,
  CircuitOpenError,
  SERVICE_ERROR_CODES,
  ServiceError,
  SourceTimeoutError,
} from "../src/errors.js";

test("defines stable service error codes", () => {
  assert.ok(SERVICE_ERROR_CODES.SOURCE_TIMEOUT);
  assert.ok(SERVICE_ERROR_CODES.CIRCUIT_OPEN);
  assert.ok(SERVICE_ERROR_CODES.ALL_SOURCES_FAILED);
  assert.ok(SERVICE_ERROR_CODES.INTERNAL);
});

test("ServiceError carries code, correlationId, and retryable flag", () => {
  const err = new ServiceError("TEST_CODE", "something broke", { retryable: true });
  assert.equal(err.code, "TEST_CODE");
  assert.equal(err.message, "something broke");
  assert.equal(err.retryable, true);
  assert.match(err.correlationId, /^[0-9a-f]{32}$/);
  assert.equal(err.name, "ServiceError");
});

test("ServiceError redacts secrets from messages", () => {
  const err = new ServiceError("X", "failed with api_key=sk_live_abc123");
  assert.ok(!err.message.includes("sk_live_abc123"));
  assert.ok(err.message.includes("[REDACTED_SECRET]"));
});

test("ServiceError.toJSON produces a safe envelope", () => {
  const err = new ServiceError("X", "msg", { sourceId: "zfi" });
  const json = err.toJSON();
  assert.equal(json.code, "X");
  assert.equal(json.sourceId, "zfi");
  assert.ok(json.correlationId);
  assert.ok(!("cause" in json));
});

test("SourceTimeoutError carries timeout and is retryable", () => {
  const err = new SourceTimeoutError("zfi", 5000);
  assert.equal(err.code, SERVICE_ERROR_CODES.SOURCE_TIMEOUT);
  assert.equal(err.sourceId, "zfi");
  assert.equal(err.timeoutMs, 5000);
  assert.equal(err.retryable, true);
  assert.ok(err.message.includes("zfi"));
  assert.ok(err.message.includes("5000ms"));
});

test("CircuitOpenError identifies the isolated source", () => {
  const err = new CircuitOpenError("set-bstock-ai");
  assert.equal(err.code, SERVICE_ERROR_CODES.CIRCUIT_OPEN);
  assert.equal(err.sourceId, "set-bstock-ai");
  assert.equal(err.retryable, true);
  assert.ok(err.message.includes("set-bstock-ai"));
});

test("AllSourcesFailedError lists failed source ids", () => {
  const err = new AllSourcesFailedError([
    { sourceId: "zfi" },
    { sourceId: "set-bstock-ai" },
  ]);
  assert.equal(err.code, SERVICE_ERROR_CODES.ALL_SOURCES_FAILED);
  assert.equal(err.failures.length, 2);
  assert.ok(err.message.includes("zfi"));
  assert.ok(err.message.includes("set-bstock-ai"));
  assert.equal(err.retryable, true);
});

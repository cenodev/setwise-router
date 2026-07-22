import assert from "node:assert/strict";
import test from "node:test";

import {
  generateCorrelationId,
  redact,
  redactAddresses,
  redactApiKeys,
  redactCalldata,
  redactObject,
} from "../src/correlation.js";

test("generates unique 32-char hex correlation ids", () => {
  const a = generateCorrelationId();
  const b = generateCorrelationId();
  assert.equal(a.length, 32);
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});

test("redacts wallet addresses", () => {
  const input = "swap from 0x1234567890abcdef1234567890abcdef12345678 to 0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const result = redactAddresses(input);
  assert.ok(!result.includes("0x1234567890abcdef"));
  assert.ok(result.includes("0x[REDACTED]"));
});

test("redacts API keys and secrets", () => {
  const input = "api_key=sk_live_abc123 token: bearer xyz";
  const result = redactApiKeys(input);
  assert.ok(!result.includes("sk_live_abc123"));
  assert.ok(!result.includes("bearer xyz"));
  assert.ok(result.includes("[REDACTED_SECRET]"));
});

test("redacts calldata preserving selector", () => {
  const input = "calldata 0xabcdef011234567890abcdef1234567890abcdef";
  const result = redactCalldata(input);
  assert.ok(result.includes("0xabcdef01[REDACTED_CALLDATA]"));
  assert.ok(!result.includes("1234567890abcdef1234567890abcdef"));
});

test("redact applies all redaction passes", () => {
  const input = "api_key=secret123 addr 0x1234567890abcdef1234567890abcdef12345678 data 0xabcdef01deadbeef";
  const result = redact(input);
  assert.ok(!result.includes("secret123"));
  assert.ok(!result.includes("0x1234567890abcdef"));
  assert.ok(!result.includes("deadbeef"));
});

test("redactObject strips sensitive fields", () => {
  const obj = {
    calldata: "0xabcdef011234567890abcdef",
    apiKey: "sk_live_secret",
    address: "0x1234567890abcdef1234567890abcdef12345678",
    amount: "1000",
    nested: { secret: "hidden", value: 42 },
  };
  const result = redactObject(obj);
  assert.ok(result.calldata.includes("[REDACTED_CALLDATA]"));
  assert.equal(result.apiKey, "[REDACTED_SECRET]");
  assert.equal(result.address, "0x[REDACTED]");
  assert.equal(result.amount, "1000");
  assert.equal(result.nested.secret, "[REDACTED_SECRET]");
  assert.equal(result.nested.value, 42);
});

test("redactObject handles arrays and null", () => {
  assert.equal(redactObject(null), null);
  assert.equal(redactObject(undefined), undefined);
  assert.deepEqual(redactObject(["a", "b"]), ["a", "b"]);
});

test("redact handles non-string input gracefully", () => {
  assert.equal(redactAddresses(42), 42);
  assert.equal(redactApiKeys(null), null);
  assert.equal(redactCalldata(undefined), undefined);
});

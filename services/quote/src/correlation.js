/**
 * Correlation IDs and secret/calldata redaction (issue #25).
 *
 * Generates opaque correlation ids for request tracing and provides redaction
 * helpers that strip wallet addresses, API keys, and raw calldata from
 * log/metric payloads before they leave the service boundary.
 */

import { randomBytes } from "node:crypto";

export function generateCorrelationId() {
  return randomBytes(16).toString("hex");
}

const ADDRESS_RE = /0x[0-9a-fA-F]{40}/g;
const API_KEY_RE = /(?:api[_-]?key|apikey|token|secret|authorization)\s*[=:]\s*\S+/gi;
const CALLDATA_RE = /0x[0-9a-fA-F]{8,}/g;

export function redactAddresses(text) {
  if (typeof text !== "string") return text;
  return text.replace(ADDRESS_RE, "0x[REDACTED]");
}

export function redactApiKeys(text) {
  if (typeof text !== "string") return text;
  return text.replace(API_KEY_RE, "[REDACTED_SECRET]");
}

export function redactCalldata(text) {
  if (typeof text !== "string") return text;
  return text.replace(CALLDATA_RE, (match) => {
    if (match.length <= 10) return match;
    return `${match.slice(0, 10)}[REDACTED_CALLDATA]`;
  });
}

export function redact(text) {
  return redactCalldata(redactApiKeys(redactAddresses(text)));
}

export function redactObject(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return redact(obj);
  if (Array.isArray(obj)) return obj.map(redactObject);
  if (typeof obj === "object") {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      const lower = key.toLowerCase();
      if (lower === "calldata" || lower === "data") {
        result[key] = typeof value === "string" && value.length > 10
          ? `${value.slice(0, 10)}[REDACTED_CALLDATA]`
          : "[REDACTED]";
      } else if (lower.includes("key") || lower.includes("secret") || lower.includes("authorization")) {
        result[key] = "[REDACTED_SECRET]";
      } else if (lower === "address" && typeof value === "string" && ADDRESS_RE.test(value)) {
        ADDRESS_RE.lastIndex = 0;
        result[key] = "0x[REDACTED]";
      } else {
        result[key] = redactObject(value);
      }
    }
    return result;
  }
  return obj;
}

/**
 * Structured errors for the quote service (issue #25).
 *
 * Extends the schema-level QuoteSchemaError with operational error types that
 * carry machine-readable codes, source attribution, and correlation ids so
 * operators can identify why a route was excluded or a source failed without
 * leaking secrets or wallet addresses.
 */

import { generateCorrelationId, redact } from "./correlation.js";

export const SERVICE_ERROR_CODES = Object.freeze({
  SOURCE_TIMEOUT: "SERVICE_SOURCE_TIMEOUT",
  SOURCE_UNAVAILABLE: "SERVICE_SOURCE_UNAVAILABLE",
  CIRCUIT_OPEN: "SERVICE_CIRCUIT_OPEN",
  CACHE_ERROR: "SERVICE_CACHE_ERROR",
  ALL_SOURCES_FAILED: "SERVICE_ALL_SOURCES_FAILED",
  INTERNAL: "SERVICE_INTERNAL",
});

export class ServiceError extends Error {
  constructor(code, message, options = {}) {
    super(redact(message));
    this.name = "ServiceError";
    this.code = code;
    this.sourceId = options.sourceId ?? null;
    this.correlationId = options.correlationId ?? generateCorrelationId();
    this.cause = options.cause ?? null;
    this.retryable = options.retryable ?? false;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      sourceId: this.sourceId,
      correlationId: this.correlationId,
      retryable: this.retryable,
    };
  }
}

export class SourceTimeoutError extends ServiceError {
  constructor(sourceId, timeoutMs, options = {}) {
    super(
      SERVICE_ERROR_CODES.SOURCE_TIMEOUT,
      `source "${sourceId}" exceeded ${timeoutMs}ms timeout`,
      { sourceId, retryable: true, ...options },
    );
    this.name = "SourceTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class CircuitOpenError extends ServiceError {
  constructor(sourceId, options = {}) {
    super(
      SERVICE_ERROR_CODES.CIRCUIT_OPEN,
      `circuit breaker open for source "${sourceId}"`,
      { sourceId, retryable: true, ...options },
    );
    this.name = "CircuitOpenError";
  }
}

export class AllSourcesFailedError extends ServiceError {
  constructor(failures, options = {}) {
    const ids = failures.map((f) => f.sourceId ?? "unknown").join(", ");
    super(
      SERVICE_ERROR_CODES.ALL_SOURCES_FAILED,
      `all quote sources failed: ${ids}`,
      { retryable: true, ...options },
    );
    this.name = "AllSourcesFailedError";
    this.failures = failures;
  }
}

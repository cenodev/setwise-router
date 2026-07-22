export const SERVICE_NAME = "setwise-router-quote";

export {
  buildSetwiseAuthorizationTypedData,
  SETWISE_AUTHORIZATION_DOMAIN,
  SETWISE_AUTHORIZATION_PRIMARY_TYPE,
  SETWISE_AUTHORIZATION_TYPES,
} from "./setwise-authorization.js";
export const VERSION = "0.0.0";

export {
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
} from "./schema.js";

export {
  ADAPTER_HEALTH_STATUSES,
  ADAPTER_OUTCOME_STATUSES,
  DEFAULT_ADAPTER_TIMEOUT_MS,
  QuoteSourceAdapter,
  normalizeCapabilities,
} from "./adapter.js";
export { MockQuoteAdapter } from "./mock-adapter.js";
export { QuoteSourceRegistry } from "./registry.js";
export { runQuoteSources } from "./runner.js";

export { buildCacheKey, classifyRecipient, QuoteCache } from "./cache.js";
export {
  BREAKER_STATES,
  CircuitBreaker,
  CircuitBreakerRegistry,
} from "./circuit-breaker.js";
export {
  generateCorrelationId,
  redact,
  redactAddresses,
  redactApiKeys,
  redactCalldata,
  redactObject,
} from "./correlation.js";
export {
  AllSourcesFailedError,
  CircuitOpenError,
  SERVICE_ERROR_CODES,
  ServiceError,
  SourceTimeoutError,
} from "./errors.js";
export { HealthReporter } from "./health.js";
export { MetricsCollector } from "./metrics.js";
export { ResilientQuoteRunner } from "./resilient-runner.js";

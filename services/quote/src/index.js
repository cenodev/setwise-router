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
export {
  assembleQuoteResponse,
  runQuote,
  selectBestSource,
} from "./response.js";
export { mulDivCeil, mulDivFloor, slippageLimit } from "./rounding.js";

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

export {
  DEFAULT_INDICATIVE_STALE_MS,
  SetwiseIndicativeAdapter,
  createAllSetwiseIndicativeAdapters,
  createSetwiseIndicativeAdapter,
  createSetwiseIndicativeAdapters,
  discoverEligiblePools,
  getPoolById,
  loadPoolCatalog,
} from "./setwise-indicative-adapter.js";
export {
  MockSetwiseRfqClient,
  SetwiseRfqClient,
} from "./setwise-rfq-client.js";
export {
  buildSetwiseEvidence,
  isIndicativeQuoteStale,
  normalizeIndicativeQuote,
  resolveRfqAssets,
} from "./setwise-quote-normalize.js";
export {
  normalizePoolRecord,
  rejectSelfReferentialRoute,
  validatePoolIdentity,
  validateSupportedAssets,
} from "./setwise-pool-catalog.js";
export {
  ZeroExAdapter,
  ZeroExAdapterError,
  ZEROEX_CHAIN_IDS,
  ZEROEX_ERROR_CODES,
} from "./zeroex-adapter.js";

export {
  ZFI_ERROR_CODES,
  ZFI_ROUTE_BUILDERS,
  ZfiQuoteAdapter,
  createRpcTransport,
  defaultRoutePolicy,
} from "./zfi-adapter.js";
export {
  MULTICALL3_AGGREGATE3_SELECTOR,
  decodeAggregate3,
  decodeAggregate3Calls,
  decodeQuoterResult,
  encodeAggregate3,
  encodeAggregate3Result,
  encodeQuoterCall,
  encodeQuoterResult,
  quoterErrorName,
  quoterFunction,
  quoterFunctionNames,
  quoterSelector,
} from "./zfi-abi.js";

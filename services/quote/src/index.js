export const SERVICE_NAME = "setwise-router-quote";
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

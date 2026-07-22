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

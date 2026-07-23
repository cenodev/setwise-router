import { getChainConfig, isAddress } from "../../../config/index.mjs";

export const QUOTE_API_VERSION = "v1";

export const QUOTE_MODES = Object.freeze(["exact-input", "exact-output"]);
export const QUOTE_KINDS = Object.freeze(["indicative", "firm"]);
export const QUOTE_SOURCE_TYPES = Object.freeze(["zfi", "aggregator", "setwise"]);
export const QUOTE_SOURCE_STATUSES = Object.freeze([
  "available",
  "unavailable",
  "excluded",
  "stale",
  "failed",
]);

export const QUOTE_ERROR_CODES = Object.freeze({
  INVALID_REQUEST: "QUOTE_INVALID_REQUEST",
  INVALID_RESPONSE: "QUOTE_INVALID_RESPONSE",
  UNSUPPORTED_API_VERSION: "QUOTE_UNSUPPORTED_API_VERSION",
  UNSUPPORTED_CHAIN: "QUOTE_UNSUPPORTED_CHAIN",
  CHAIN_MISMATCH: "QUOTE_CHAIN_MISMATCH",
  ROUTER_MISMATCH: "QUOTE_ROUTER_MISMATCH",
  INVALID_ADDRESS: "QUOTE_INVALID_ADDRESS",
  INVALID_AMOUNT: "QUOTE_INVALID_AMOUNT",
  INVALID_SLIPPAGE: "QUOTE_INVALID_SLIPPAGE",
  SOURCE_EVIDENCE_REQUIRED: "QUOTE_SOURCE_EVIDENCE_REQUIRED",
  AMBIGUOUS_EXECUTION: "QUOTE_AMBIGUOUS_EXECUTION",
});

const ERROR_CODE_VALUES = Object.freeze(Object.values(QUOTE_ERROR_CODES));
const SOURCE_STATUS_SET = new Set(QUOTE_SOURCE_STATUSES);
const SOURCE_TYPE_SET = new Set(QUOTE_SOURCE_TYPES);
const QUOTE_KIND_SET = new Set(QUOTE_KINDS);
const QUOTE_MODE_SET = new Set(QUOTE_MODES);
const UINT_RE = /^(0|[1-9][0-9]*)$/;
const BYTES_RE = /^0x(?:[0-9a-fA-F]{2})*$/;

export class QuoteSchemaError extends Error {
  constructor(code, message, path = "$") {
    super(message);
    this.name = "QuoteSchemaError";
    this.code = code;
    this.path = path;
  }
}

function fail(code, message, path) {
  throw new QuoteSchemaError(code, message, path);
}

function object(value, path, code) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(code, `${path} must be an object`, path);
  }
  return value;
}

function keys(value, required, optional, path, code) {
  for (const key of required) {
    if (!(key in value)) fail(code, `${path}.${key} is required`, `${path}.${key}`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(code, `${path}.${key} is not supported`, `${path}.${key}`);
  }
}

function nonEmptyString(value, path, code) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(code, `${path} must be a non-empty string`, path);
  }
}

function uint(value, path, { positive = false, code = QUOTE_ERROR_CODES.INVALID_AMOUNT } = {}) {
  if (typeof value !== "string" || !UINT_RE.test(value)) {
    fail(code, `${path} must be a canonical unsigned integer string`, path);
  }
  if (positive && value === "0") fail(code, `${path} must be greater than zero`, path);
}

function chainId(value, path, code) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(code, `${path} must be a positive safe integer`, path);
  }
}

function supportedChain(value, path) {
  chainId(value, path, QUOTE_ERROR_CODES.UNSUPPORTED_CHAIN);
  try {
    return getChainConfig(value);
  } catch {
    fail(QUOTE_ERROR_CODES.UNSUPPORTED_CHAIN, `unsupported chain id ${value}`, path);
  }
}

function chainAddress(value, expectedChainId, path) {
  object(value, path, QUOTE_ERROR_CODES.INVALID_ADDRESS);
  keys(
    value,
    ["chainId", "address"],
    [],
    path,
    QUOTE_ERROR_CODES.INVALID_ADDRESS,
  );
  chainId(value.chainId, `${path}.chainId`, QUOTE_ERROR_CODES.CHAIN_MISMATCH);
  if (value.chainId !== expectedChainId) {
    fail(
      QUOTE_ERROR_CODES.CHAIN_MISMATCH,
      `${path}.chainId ${value.chainId} does not match quote chain ${expectedChainId}`,
      `${path}.chainId`,
    );
  }
  if (!isAddress(value.address)) {
    fail(
      QUOTE_ERROR_CODES.INVALID_ADDRESS,
      `${path}.address must be a non-zero 20-byte address`,
      `${path}.address`,
    );
  }
}

function timestamp(value, path, code) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail(code, `${path} must be an ISO 8601 timestamp`, path);
  }
}

function validateSlippage(value, path) {
  object(value, path, QUOTE_ERROR_CODES.INVALID_SLIPPAGE);
  keys(value, ["maxBps"], [], path, QUOTE_ERROR_CODES.INVALID_SLIPPAGE);
  if (!Number.isInteger(value.maxBps) || value.maxBps < 0 || value.maxBps > 10_000) {
    fail(
      QUOTE_ERROR_CODES.INVALID_SLIPPAGE,
      `${path}.maxBps must be an integer from 0 through 10000`,
      `${path}.maxBps`,
    );
  }
}

/** Validate and return a chain-aware v1 quote request. */
export function validateQuoteRequest(input) {
  const path = "$";
  object(input, path, QUOTE_ERROR_CODES.INVALID_REQUEST);
  keys(
    input,
    [
      "apiVersion",
      "chainId",
      "tokenIn",
      "tokenOut",
      "router",
      "mode",
      "amount",
      "recipient",
      "funder",
      "slippage",
    ],
    [],
    path,
    QUOTE_ERROR_CODES.INVALID_REQUEST,
  );

  if (input.apiVersion !== QUOTE_API_VERSION) {
    fail(
      QUOTE_ERROR_CODES.UNSUPPORTED_API_VERSION,
      `apiVersion must be ${QUOTE_API_VERSION}`,
      "$.apiVersion",
    );
  }
  const config = supportedChain(input.chainId, "$.chainId");
  chainAddress(input.tokenIn, input.chainId, "$.tokenIn");
  chainAddress(input.tokenOut, input.chainId, "$.tokenOut");
  chainAddress(input.router, input.chainId, "$.router");
  chainAddress(input.recipient, input.chainId, "$.recipient");
  chainAddress(input.funder, input.chainId, "$.funder");

  if (
    input.tokenIn.address.toLowerCase() === input.tokenOut.address.toLowerCase()
  ) {
    fail(
      QUOTE_ERROR_CODES.INVALID_REQUEST,
      "tokenIn and tokenOut must be different",
      "$.tokenOut.address",
    );
  }
  if (
    config.router !== null &&
    config.router.toLowerCase() !== input.router.address.toLowerCase()
  ) {
    fail(
      QUOTE_ERROR_CODES.ROUTER_MISMATCH,
      `router does not match the configured router for chain ${input.chainId}`,
      "$.router.address",
    );
  }
  if (!QUOTE_MODE_SET.has(input.mode)) {
    fail(
      QUOTE_ERROR_CODES.INVALID_REQUEST,
      `mode must be one of: ${QUOTE_MODES.join(", ")}`,
      "$.mode",
    );
  }
  uint(input.amount, "$.amount", { positive: true });
  validateSlippage(input.slippage, "$.slippage");
  return input;
}

function validateSource(source, chain, path) {
  object(source, path, QUOTE_ERROR_CODES.INVALID_RESPONSE);
  keys(
    source,
    ["id", "type", "displayName"],
    ["poolId"],
    path,
    QUOTE_ERROR_CODES.INVALID_RESPONSE,
  );
  nonEmptyString(source.id, `${path}.id`, QUOTE_ERROR_CODES.INVALID_RESPONSE);
  if (!SOURCE_TYPE_SET.has(source.type)) {
    fail(
      QUOTE_ERROR_CODES.INVALID_RESPONSE,
      `${path}.type must be one of: ${QUOTE_SOURCE_TYPES.join(", ")}`,
      `${path}.type`,
    );
  }
  nonEmptyString(
    source.displayName,
    `${path}.displayName`,
    QUOTE_ERROR_CODES.INVALID_RESPONSE,
  );
  if (source.type === "setwise") {
    if (source.displayName !== "Set") {
      fail(
        QUOTE_ERROR_CODES.INVALID_RESPONSE,
        `${path}.displayName must use the user-facing name "Set"`,
        `${path}.displayName`,
      );
    }
    nonEmptyString(source.poolId, `${path}.poolId`, QUOTE_ERROR_CODES.INVALID_RESPONSE);
  } else if ("poolId" in source) {
    fail(
      QUOTE_ERROR_CODES.INVALID_RESPONSE,
      `${path}.poolId is only valid for a Set source`,
      `${path}.poolId`,
    );
  }
  void chain;
}

function validateEvidence(value, path) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(
      QUOTE_ERROR_CODES.SOURCE_EVIDENCE_REQUIRED,
      `${path} must contain at least one evidence record`,
      path,
    );
  }
  value.forEach((entry, index) => {
    const itemPath = `${path}[${index}]`;
    object(entry, itemPath, QUOTE_ERROR_CODES.INVALID_RESPONSE);
    keys(
      entry,
      ["kind", "observedAt", "reference"],
      ["blockNumber", "code", "message"],
      itemPath,
      QUOTE_ERROR_CODES.INVALID_RESPONSE,
    );
    if (!["onchain", "http", "simulation", "policy"].includes(entry.kind)) {
      fail(
        QUOTE_ERROR_CODES.INVALID_RESPONSE,
        `${itemPath}.kind is not supported`,
        `${itemPath}.kind`,
      );
    }
    timestamp(entry.observedAt, `${itemPath}.observedAt`, QUOTE_ERROR_CODES.INVALID_RESPONSE);
    nonEmptyString(
      entry.reference,
      `${itemPath}.reference`,
      QUOTE_ERROR_CODES.INVALID_RESPONSE,
    );
    if ("blockNumber" in entry) uint(entry.blockNumber, `${itemPath}.blockNumber`);
    if ("code" in entry) {
      nonEmptyString(entry.code, `${itemPath}.code`, QUOTE_ERROR_CODES.INVALID_RESPONSE);
    }
    if ("message" in entry) {
      nonEmptyString(entry.message, `${itemPath}.message`, QUOTE_ERROR_CODES.INVALID_RESPONSE);
    }
  });
}

function validateFee(value, chain, path) {
  object(value, path, QUOTE_ERROR_CODES.INVALID_RESPONSE);
  keys(
    value,
    ["type", "amount", "token"],
    [],
    path,
    QUOTE_ERROR_CODES.INVALID_RESPONSE,
  );
  if (!["network", "protocol", "source", "integrator"].includes(value.type)) {
    fail(
      QUOTE_ERROR_CODES.INVALID_RESPONSE,
      `${path}.type must be network, protocol, source, or integrator`,
      `${path}.type`,
    );
  }
  uint(value.amount, `${path}.amount`);
  chainAddress(value.token, chain, `${path}.token`);
}

function validateRanking(value, quote, request, path) {
  object(value, path, QUOTE_ERROR_CODES.INVALID_RESPONSE);
  keys(
    value,
    [
      "status",
      "comparisonToken",
      "rawAmount",
      "adjustedAmount",
      "adjustments",
      "thresholds",
      "fallback",
    ],
    [],
    path,
    QUOTE_ERROR_CODES.INVALID_RESPONSE,
  );
  if (!["complete", "unpriced"].includes(value.status)) {
    fail(
      QUOTE_ERROR_CODES.INVALID_RESPONSE,
      `${path}.status must be complete or unpriced`,
      `${path}.status`,
    );
  }
  chainAddress(value.comparisonToken, request.chainId, `${path}.comparisonToken`);
  const expectedToken =
    request.mode === "exact-input" ? request.tokenOut : request.tokenIn;
  if (
    value.comparisonToken.address.toLowerCase() !==
    expectedToken.address.toLowerCase()
  ) {
    fail(
      QUOTE_ERROR_CODES.INVALID_RESPONSE,
      `${path}.comparisonToken must match the exact-mode comparison token`,
      `${path}.comparisonToken`,
    );
  }
  uint(value.rawAmount, `${path}.rawAmount`, { positive: true });
  const expectedRaw =
    request.mode === "exact-input" ? quote.amounts.output : quote.amounts.input;
  if (value.rawAmount !== expectedRaw) {
    fail(
      QUOTE_ERROR_CODES.INVALID_RESPONSE,
      `${path}.rawAmount must preserve the quoted exact-mode amount`,
      `${path}.rawAmount`,
    );
  }
  if (value.adjustedAmount !== null) {
    uint(value.adjustedAmount, `${path}.adjustedAmount`);
  }
  if (
    (value.status === "complete" && value.adjustedAmount === null) ||
    (value.status === "unpriced" && value.adjustedAmount !== null)
  ) {
    fail(
      QUOTE_ERROR_CODES.INVALID_RESPONSE,
      `${path}.adjustedAmount must be present only for complete rankings`,
      `${path}.adjustedAmount`,
    );
  }
  if (!Array.isArray(value.adjustments) || value.adjustments.length < 4) {
    fail(
      QUOTE_ERROR_CODES.INVALID_RESPONSE,
      `${path}.adjustments must expose protocol, integrator, gas, and approval costs`,
      `${path}.adjustments`,
    );
  }
  value.adjustments.forEach((item, index) => {
    const itemPath = `${path}.adjustments[${index}]`;
    object(item, itemPath, QUOTE_ERROR_CODES.INVALID_RESPONSE);
    keys(
      item,
      ["type", "amount", "token", "comparisonAmount", "status"],
      [],
      itemPath,
      QUOTE_ERROR_CODES.INVALID_RESPONSE,
    );
    if (!["protocol-fee", "integrator-fee", "gas", "approval"].includes(item.type)) {
      fail(
        QUOTE_ERROR_CODES.INVALID_RESPONSE,
        `${itemPath}.type is not a ranking adjustment`,
        `${itemPath}.type`,
      );
    }
    if (item.amount !== null) uint(item.amount, `${itemPath}.amount`);
    chainAddress(item.token, request.chainId, `${itemPath}.token`);
    if (item.comparisonAmount !== null) {
      uint(item.comparisonAmount, `${itemPath}.comparisonAmount`);
    }
    if (
      !["applied", "not-required", "missing-estimate", "missing-price"].includes(
        item.status,
      )
    ) {
      fail(
        QUOTE_ERROR_CODES.INVALID_RESPONSE,
        `${itemPath}.status is not supported`,
        `${itemPath}.status`,
      );
    }
  });
  object(value.thresholds, `${path}.thresholds`, QUOTE_ERROR_CODES.INVALID_RESPONSE);
  keys(
    value.thresholds,
    ["minimumImprovementBps", "minimumImprovementAmount"],
    [],
    `${path}.thresholds`,
    QUOTE_ERROR_CODES.INVALID_RESPONSE,
  );
  if (
    !Number.isInteger(value.thresholds.minimumImprovementBps) ||
    value.thresholds.minimumImprovementBps < 0 ||
    value.thresholds.minimumImprovementBps > 10_000
  ) {
    fail(
      QUOTE_ERROR_CODES.INVALID_RESPONSE,
      `${path}.thresholds.minimumImprovementBps must be an integer from 0 through 10000`,
      `${path}.thresholds.minimumImprovementBps`,
    );
  }
  uint(
    value.thresholds.minimumImprovementAmount,
    `${path}.thresholds.minimumImprovementAmount`,
  );
  if (!["none", "raw-amount"].includes(value.fallback)) {
    fail(
      QUOTE_ERROR_CODES.INVALID_RESPONSE,
      `${path}.fallback must be none or raw-amount`,
      `${path}.fallback`,
    );
  }
}

function validateNormalizedQuote(value, request, responseKind, path) {
  object(value, path, QUOTE_ERROR_CODES.INVALID_RESPONSE);
  keys(
    value,
    ["kind", "amounts", "gas", "fees", "approvalTarget", "expiresAt"],
    [],
    path,
    QUOTE_ERROR_CODES.INVALID_RESPONSE,
  );
  if (!QUOTE_KIND_SET.has(value.kind) || value.kind !== responseKind) {
    fail(
      QUOTE_ERROR_CODES.INVALID_RESPONSE,
      `${path}.kind must match response kind ${responseKind}`,
      `${path}.kind`,
    );
  }

  object(value.amounts, `${path}.amounts`, QUOTE_ERROR_CODES.INVALID_RESPONSE);
  keys(
    value.amounts,
    ["input", "output", "limit"],
    [],
    `${path}.amounts`,
    QUOTE_ERROR_CODES.INVALID_RESPONSE,
  );
  uint(value.amounts.input, `${path}.amounts.input`, { positive: true });
  uint(value.amounts.output, `${path}.amounts.output`, { positive: true });
  uint(value.amounts.limit, `${path}.amounts.limit`, { positive: true });
  const exactAmount =
    request.mode === "exact-input" ? value.amounts.input : value.amounts.output;
  if (exactAmount !== request.amount) {
    fail(
      QUOTE_ERROR_CODES.INVALID_RESPONSE,
      `${path}.amounts does not preserve the request's exact amount`,
      `${path}.amounts`,
    );
  }

  object(value.gas, `${path}.gas`, QUOTE_ERROR_CODES.INVALID_RESPONSE);
  keys(
    value.gas,
    ["estimatedUnits", "estimatedCost"],
    [],
    `${path}.gas`,
    QUOTE_ERROR_CODES.INVALID_RESPONSE,
  );
  uint(value.gas.estimatedUnits, `${path}.gas.estimatedUnits`);
  uint(value.gas.estimatedCost, `${path}.gas.estimatedCost`);

  if (!Array.isArray(value.fees)) {
    fail(
      QUOTE_ERROR_CODES.INVALID_RESPONSE,
      `${path}.fees must be an array`,
      `${path}.fees`,
    );
  }
  value.fees.forEach((fee, index) =>
    validateFee(fee, request.chainId, `${path}.fees[${index}]`),
  );

  if (value.approvalTarget !== null) {
    chainAddress(value.approvalTarget, request.chainId, `${path}.approvalTarget`);
  }
  if (value.expiresAt !== null) {
    timestamp(value.expiresAt, `${path}.expiresAt`, QUOTE_ERROR_CODES.INVALID_RESPONSE);
  }
  if (responseKind === "indicative" && value.approvalTarget !== null) {
    fail(
      QUOTE_ERROR_CODES.AMBIGUOUS_EXECUTION,
      "indicative quotes cannot specify an approval target",
      `${path}.approvalTarget`,
    );
  }
  if (responseKind === "firm" && value.expiresAt === null) {
    fail(
      QUOTE_ERROR_CODES.INVALID_RESPONSE,
      "firm quotes require expiresAt",
      `${path}.expiresAt`,
    );
  }
}

function validateTransaction(value, request, path) {
  object(value, path, QUOTE_ERROR_CODES.AMBIGUOUS_EXECUTION);
  keys(
    value,
    ["chainId", "to", "calldata", "value"],
    [],
    path,
    QUOTE_ERROR_CODES.AMBIGUOUS_EXECUTION,
  );
  chainId(value.chainId, `${path}.chainId`, QUOTE_ERROR_CODES.CHAIN_MISMATCH);
  if (value.chainId !== request.chainId) {
    fail(
      QUOTE_ERROR_CODES.CHAIN_MISMATCH,
      "transaction chain does not match request chain",
      `${path}.chainId`,
    );
  }
  if (!isAddress(value.to)) {
    fail(
      QUOTE_ERROR_CODES.INVALID_ADDRESS,
      `${path}.to must be a non-zero 20-byte address`,
      `${path}.to`,
    );
  }
  if (value.to.toLowerCase() !== request.router.address.toLowerCase()) {
    fail(
      QUOTE_ERROR_CODES.ROUTER_MISMATCH,
      "transaction target does not match the requested router",
      `${path}.to`,
    );
  }
  if (typeof value.calldata !== "string" || !BYTES_RE.test(value.calldata)) {
    fail(
      QUOTE_ERROR_CODES.INVALID_RESPONSE,
      `${path}.calldata must be even-length hex bytes`,
      `${path}.calldata`,
    );
  }
  uint(value.value, `${path}.value`);
}

/** Validate a normalized v1 quote response against its validated request. */
export function validateQuoteResponse(input, requestInput) {
  const request = validateQuoteRequest(requestInput);
  object(input, "$", QUOTE_ERROR_CODES.INVALID_RESPONSE);
  keys(
    input,
    [
      "apiVersion",
      "requestId",
      "chainId",
      "mode",
      "kind",
      "selectedSourceId",
      "sources",
      "transaction",
    ],
    [],
    "$",
    QUOTE_ERROR_CODES.INVALID_RESPONSE,
  );
  if (input.apiVersion !== QUOTE_API_VERSION) {
    fail(
      QUOTE_ERROR_CODES.UNSUPPORTED_API_VERSION,
      `apiVersion must be ${QUOTE_API_VERSION}`,
      "$.apiVersion",
    );
  }
  nonEmptyString(input.requestId, "$.requestId", QUOTE_ERROR_CODES.INVALID_RESPONSE);
  if (input.chainId !== request.chainId) {
    fail(
      QUOTE_ERROR_CODES.CHAIN_MISMATCH,
      "response chain does not match request chain",
      "$.chainId",
    );
  }
  if (input.mode !== request.mode) {
    fail(QUOTE_ERROR_CODES.INVALID_RESPONSE, "response mode does not match request", "$.mode");
  }
  if (!QUOTE_KIND_SET.has(input.kind)) {
    fail(
      QUOTE_ERROR_CODES.INVALID_RESPONSE,
      `kind must be one of: ${QUOTE_KINDS.join(", ")}`,
      "$.kind",
    );
  }
  if (!Array.isArray(input.sources) || input.sources.length === 0) {
    fail(
      QUOTE_ERROR_CODES.INVALID_RESPONSE,
      "$.sources must contain at least one source outcome",
      "$.sources",
    );
  }

  const ids = new Set();
  const selectable = new Set();
  input.sources.forEach((outcome, index) => {
    const path = `$.sources[${index}]`;
    object(outcome, path, QUOTE_ERROR_CODES.INVALID_RESPONSE);
    keys(
      outcome,
      ["source", "status", "quote", "evidence"],
      ["ranking"],
      path,
      QUOTE_ERROR_CODES.INVALID_RESPONSE,
    );
    validateSource(outcome.source, request.chainId, `${path}.source`);
    if (ids.has(outcome.source.id)) {
      fail(
        QUOTE_ERROR_CODES.INVALID_RESPONSE,
        `duplicate source id ${outcome.source.id}`,
        `${path}.source.id`,
      );
    }
    ids.add(outcome.source.id);
    if (!SOURCE_STATUS_SET.has(outcome.status)) {
      fail(
        QUOTE_ERROR_CODES.INVALID_RESPONSE,
        `${path}.status must be one of: ${QUOTE_SOURCE_STATUSES.join(", ")}`,
        `${path}.status`,
      );
    }
    validateEvidence(outcome.evidence, `${path}.evidence`);

    if (outcome.status === "available") {
      if (outcome.quote === null) {
        fail(
          QUOTE_ERROR_CODES.INVALID_RESPONSE,
          "available sources require a normalized quote",
          `${path}.quote`,
        );
      }
      validateNormalizedQuote(outcome.quote, request, input.kind, `${path}.quote`);
      if ("ranking" in outcome) {
        validateRanking(outcome.ranking, outcome.quote, request, `${path}.ranking`);
      }
      selectable.add(outcome.source.id);
    } else if (outcome.status === "stale" && outcome.quote !== null) {
      validateNormalizedQuote(outcome.quote, request, input.kind, `${path}.quote`);
      if ("ranking" in outcome) {
        validateRanking(outcome.ranking, outcome.quote, request, `${path}.ranking`);
      }
    } else if (outcome.quote !== null) {
      fail(
        QUOTE_ERROR_CODES.INVALID_RESPONSE,
        `${outcome.status} sources must use a null quote`,
        `${path}.quote`,
      );
    } else if ("ranking" in outcome) {
      fail(
        QUOTE_ERROR_CODES.INVALID_RESPONSE,
        `${outcome.status} sources cannot carry ranking data`,
        `${path}.ranking`,
      );
    }
  });

  if (input.selectedSourceId !== null) {
    nonEmptyString(
      input.selectedSourceId,
      "$.selectedSourceId",
      QUOTE_ERROR_CODES.INVALID_RESPONSE,
    );
    if (!selectable.has(input.selectedSourceId)) {
      fail(
        QUOTE_ERROR_CODES.INVALID_RESPONSE,
        "selectedSourceId must identify an available source",
        "$.selectedSourceId",
      );
    }
  }

  if (input.kind === "indicative") {
    if (input.transaction !== null) {
      fail(
        QUOTE_ERROR_CODES.AMBIGUOUS_EXECUTION,
        "indicative responses cannot contain a transaction",
        "$.transaction",
      );
    }
  } else {
    if (input.selectedSourceId === null) {
      fail(
        QUOTE_ERROR_CODES.AMBIGUOUS_EXECUTION,
        "firm responses require one selected source",
        "$.selectedSourceId",
      );
    }
    if (input.transaction === null || Array.isArray(input.transaction)) {
      fail(
        QUOTE_ERROR_CODES.AMBIGUOUS_EXECUTION,
        "firm responses require exactly one transaction object",
        "$.transaction",
      );
    }
    validateTransaction(input.transaction, request, "$.transaction");
  }
  return input;
}

/** Validate the stable public error envelope used by the v1 API. */
export function validateQuoteError(input) {
  object(input, "$", QUOTE_ERROR_CODES.INVALID_RESPONSE);
  keys(
    input,
    ["apiVersion", "error"],
    [],
    "$",
    QUOTE_ERROR_CODES.INVALID_RESPONSE,
  );
  if (input.apiVersion !== QUOTE_API_VERSION) {
    fail(
      QUOTE_ERROR_CODES.UNSUPPORTED_API_VERSION,
      `apiVersion must be ${QUOTE_API_VERSION}`,
      "$.apiVersion",
    );
  }
  object(input.error, "$.error", QUOTE_ERROR_CODES.INVALID_RESPONSE);
  keys(
    input.error,
    ["code", "message"],
    ["path", "details"],
    "$.error",
    QUOTE_ERROR_CODES.INVALID_RESPONSE,
  );
  if (!ERROR_CODE_VALUES.includes(input.error.code)) {
    fail(
      QUOTE_ERROR_CODES.INVALID_RESPONSE,
      "$.error.code is not a stable quote error code",
      "$.error.code",
    );
  }
  nonEmptyString(input.error.message, "$.error.message", QUOTE_ERROR_CODES.INVALID_RESPONSE);
  if ("path" in input.error) {
    nonEmptyString(input.error.path, "$.error.path", QUOTE_ERROR_CODES.INVALID_RESPONSE);
  }
  return input;
}

/** Convert a QuoteSchemaError into the stable v1 API error envelope. */
export function quoteErrorResponse(error) {
  if (!(error instanceof QuoteSchemaError)) throw error;
  return {
    apiVersion: QUOTE_API_VERSION,
    error: { code: error.code, message: error.message, path: error.path },
  };
}

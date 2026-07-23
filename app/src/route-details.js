import { SETWISE_UI_LABEL } from "./constants.js";

/**
 * Present route provenance, Set quote details, and execution warnings for the dapp.
 *
 * User-facing copy uses "Set"; internal identifiers keep `pool` / `poolId`.
 */

export const ROUTE_VIEW_STATES = Object.freeze({
  loading: "loading",
  error: "error",
  noRoute: "no-route",
  fallback: "fallback",
  ready: "ready",
});

/** Evidence codes that are informational context, not user warnings. */
const INFORMATIONAL_EVIDENCE_CODES = new Set([
  "POOL_IDENTITY",
  "PRICE_DECOMPOSITION",
  "INVENTORY_SNAPSHOT",
  "INCLUDED",
]);

/** Known execution and RWA warning codes surfaced to users. */
export const ROUTE_WARNING_CODES = Object.freeze({
  MARKET_SESSION: "MARKET_SESSION",
  STALE_PRICE: "STALE_PRICE",
  STALE_INVENTORY: "STALE_INVENTORY",
  NATIVE_OUTPUT: "NATIVE_OUTPUT",
  MIN_NOTIONAL: "MIN_NOTIONAL",
  BELOW_MINIMUM: "BELOW_MINIMUM",
  STALE_BLOCK: "STALE_BLOCK",
});

const WARNING_CODE_SET = new Set(Object.values(ROUTE_WARNING_CODES));

/**
 * @typedef {Object} RouteAccessibility
 * @property {string} role
 * @property {string} ariaLabel
 * @property {"off"|"polite"|"assertive"} ariaLive
 * @property {boolean} ariaBusy
 */

/**
 * @param {string|null|undefined} address
 * @returns {string}
 */
export function formatRouteAddress(address) {
  if (!address || address.toLowerCase() === "0x0000000000000000000000000000000000000000") {
    return "None";
  }
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Describe the quote-fetch lifecycle before route details are available.
 *
 * @param {{
 *   phase: "loading"|"success"|"error",
 *   error?: { code?: string, message?: string }|null,
 *   response?: object|null,
 *   requestedKind?: "indicative"|"firm",
 * }} input
 */
export function describeQuoteFetchState(input) {
  if (input.phase === "loading") {
    return {
      status: ROUTE_VIEW_STATES.loading,
      title: "Finding best route",
      message: "Comparing sources and checking Set liquidity.",
      accessibility: buildAccessibility({
        status: ROUTE_VIEW_STATES.loading,
        title: "Finding best route",
      }),
    };
  }

  if (input.phase === "error" || input.error) {
    const code = input.error?.code ?? "QUOTE_INVALID_REQUEST";
    const message = input.error?.message ?? "Unable to fetch a quote.";
    return {
      status: ROUTE_VIEW_STATES.error,
      title: "Quote unavailable",
      message,
      code,
      accessibility: buildAccessibility({
        status: ROUTE_VIEW_STATES.error,
        title: "Quote unavailable",
        message,
      }),
    };
  }

  const response = input.response;
  if (!response) {
    return {
      status: ROUTE_VIEW_STATES.error,
      title: "Quote unavailable",
      message: "No quote response was returned.",
      code: "QUOTE_INVALID_RESPONSE",
      accessibility: buildAccessibility({
        status: ROUTE_VIEW_STATES.error,
        title: "Quote unavailable",
        message: "No quote response was returned.",
      }),
    };
  }

  if (response.selectedSourceId === null) {
    return {
      status: ROUTE_VIEW_STATES.noRoute,
      title: "No route available",
      message: "No source could fill this trade on the selected network.",
      alternatives: summarizeAlternatives(response),
      accessibility: buildAccessibility({
        status: ROUTE_VIEW_STATES.noRoute,
        title: "No route available",
        message: "No source could fill this trade on the selected network.",
      }),
    };
  }

  if (input.requestedKind === "firm" && response.kind === "indicative") {
    const details = describeRouteDetailsView(response);
    return {
      status: ROUTE_VIEW_STATES.fallback,
      title: "Showing indicative route",
      message:
        "A firm executable quote is unavailable. Review the indicative route before continuing.",
      route: details,
      accessibility: buildAccessibility({
        status: ROUTE_VIEW_STATES.fallback,
        title: "Showing indicative route",
        message:
          "A firm executable quote is unavailable. Review the indicative route before continuing.",
      }),
    };
  }

  return describeRouteDetailsView(response);
}

/**
 * Build the full route-details presentation for a successful quote response.
 *
 * @param {object} response  Validated v1 quote response.
 * @param {{ now?: string }} [options]
 */
export function describeRouteDetailsView(response, options = {}) {
  const selected = response.sources.find(
    (entry) => entry.source.id === response.selectedSourceId,
  );
  if (!selected?.quote) {
    return {
      status: ROUTE_VIEW_STATES.noRoute,
      title: "No route available",
      message: "The selected source does not include quote details.",
      accessibility: buildAccessibility({
        status: ROUTE_VIEW_STATES.noRoute,
        title: "No route available",
      }),
    };
  }

  const { quote } = selected;
  const limitLabel =
    response.mode === "exact-input" ? "Minimum received" : "Maximum sent";
  const executionTarget = resolveExecutionTarget(response, selected);
  const routePath = parseRoutePath(selected.source.type, selected.evidence ?? []);
  const setwise = buildSetwiseDetails(selected, quote, options.now);
  const warnings = collectWarnings(selected.evidence ?? [], selected.status);

  return {
    status: ROUTE_VIEW_STATES.ready,
    mode: response.mode,
    quoteKind: response.kind,
    selected: {
      sourceId: selected.source.id,
      displayName: selected.source.displayName,
      type: selected.source.type,
      poolId: selected.source.poolId ?? null,
    },
    execution: {
      target: executionTarget,
      approvalTarget: quote.approvalTarget,
      transaction: response.transaction ?? null,
      targetLabel: executionTarget
        ? formatRouteAddress(executionTarget.address)
        : "Not executable",
    },
    amounts: {
      input: quote.amounts.input,
      output: quote.amounts.output,
      limit: quote.amounts.limit,
      limitLabel,
    },
    gas: quote.gas,
    fees: quote.fees ?? [],
    routePath,
    setwise,
    warnings,
    alternatives: summarizeAlternatives(response),
    accessibility: buildAccessibility({
      status: ROUTE_VIEW_STATES.ready,
      title: `Route via ${selected.source.displayName}`,
      message: `${limitLabel}: ${quote.amounts.limit}`,
      selectedName: selected.source.displayName,
      warningCount: warnings.length,
    }),
  };
}

/**
 * @param {object} view
 * @returns {RouteAccessibility}
 */
export function buildRouteAccessibility(view) {
  return view.accessibility ?? buildAccessibility({ status: view.status, title: view.title ?? "Route" });
}

/**
 * @param {Array<object>} evidence
 * @param {string} [sourceStatus]
 */
export function collectWarnings(evidence, sourceStatus) {
  const warnings = [];
  const seen = new Set();

  for (const entry of evidence) {
    if (!entry.code || INFORMATIONAL_EVIDENCE_CODES.has(entry.code)) continue;
    if (entry.reference?.startsWith("warning:") || WARNING_CODE_SET.has(entry.code)) {
      pushWarning(warnings, seen, entry.code, entry.message ?? entry.code, categorizeWarning(entry.code));
    }
  }

  if (sourceStatus === "stale") {
    pushWarning(
      warnings,
      seen,
      "STALE_BLOCK",
      "This quote is stale and cannot be executed.",
      "stale-price",
    );
  }

  return warnings;
}

/**
 * @param {string} sourceType
 * @param {Array<object>} evidence
 */
export function parseRoutePath(sourceType, evidence) {
  if (sourceType === "zfi") {
    return parseZfiRoutePath(evidence);
  }
  if (sourceType === "aggregator") {
    const http = evidence.find((entry) => entry.kind === "http");
    return http
      ? {
          builder: "aggregator",
          reference: http.reference,
          blockNumber: http.blockNumber ?? null,
          hops: [],
        }
      : null;
  }
  if (sourceType === "setwise") {
    return {
      builder: "set-direct",
      hops: [],
      poolId: parsePoolIdFromEvidence(evidence),
      poolAddress: parsePoolAddress(evidence),
    };
  }
  return null;
}

/**
 * @param {Array<object>} evidence
 */
export function parseZfiRoutePath(evidence) {
  const onchain = evidence.find((entry) => entry.kind === "onchain" && entry.message);
  if (!onchain?.message) return null;

  try {
    const parsed = JSON.parse(onchain.message);
    const hops = (parsed.legs ?? []).map((leg) => ({
      venue: leg.source,
      feeBps: leg.feeBps,
      amountIn: leg.amountIn,
      amountOut: leg.amountOut,
      splitBps: leg.proportionBps ?? null,
    }));
    return {
      builder: parsed.builder ?? "unknown",
      hops,
      blockNumber: onchain.blockNumber ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * @param {object} response
 */
export function summarizeAlternatives(response) {
  return response.sources
    .filter((entry) => entry.source.id !== response.selectedSourceId)
    .map((entry) => ({
      sourceId: entry.source.id,
      displayName: entry.source.displayName,
      type: entry.source.type,
      poolId: entry.source.poolId ?? null,
      status: entry.status,
      summary: summarizeAlternativeOutcome(entry),
      evidence: (entry.evidence ?? []).map((item) => ({
        kind: item.kind,
        code: item.code ?? null,
        message: item.message ?? null,
        reference: item.reference,
      })),
    }));
}

function buildSetwiseDetails(selected, quote, now) {
  if (selected.source.type !== "setwise") return null;

  const evidence = selected.evidence ?? [];
  const poolAddress = parsePoolAddress(evidence);
  const price = parsePriceDecomposition(evidence);
  const inventory = parseInventorySnapshot(evidence);
  const isFirm = quote.kind === "firm";

  return {
    poolId: selected.source.poolId ?? null,
    poolAddress,
    quoteState: isFirm ? "firm" : "indicative",
    stateLabel: isFirm ? `Firm ${SETWISE_UI_LABEL} quote` : `Indicative ${SETWISE_UI_LABEL} quote`,
    stateSeverity: isFirm ? "ok" : "info",
    expiresAt: quote.expiresAt,
    expiresLabel: quote.expiresAt ? formatExpiryLabel(quote.expiresAt, now) : null,
    price,
    inventory,
  };
}

function resolveExecutionTarget(response, selected) {
  if (response.transaction?.to) {
    return {
      chainId: response.transaction.chainId,
      address: response.transaction.to,
      kind: "transaction",
    };
  }
  if (selected.quote?.approvalTarget) {
    return {
      chainId: selected.quote.approvalTarget.chainId,
      address: selected.quote.approvalTarget.address,
      kind: "approval",
    };
  }
  return null;
}

function summarizeAlternativeOutcome(entry) {
  if (entry.status === "available" && entry.quote) {
    return `Quoted ${entry.quote.amounts.output} output`;
  }
  const policy = entry.evidence?.find((item) => item.code || item.message);
  if (policy?.message) return policy.message;
  if (policy?.code) return policy.code;
  return `Source ${entry.status}`;
}

function parsePoolAddress(evidence) {
  const identity = evidence.find((entry) => entry.code === "POOL_IDENTITY");
  if (!identity?.message) return null;
  const match = identity.message.match(/poolAddress=(0x[a-fA-F0-9]{40})/);
  return match ? match[1] : null;
}

function parsePoolIdFromEvidence(evidence) {
  const identity = evidence.find((entry) => entry.reference?.startsWith("pool:"));
  if (!identity?.reference) return null;
  const match = identity.reference.match(/^pool:([^@]+)@/);
  return match ? match[1] : null;
}

function parsePriceDecomposition(evidence) {
  const entry = evidence.find((entry) => entry.code === "PRICE_DECOMPOSITION");
  if (!entry?.message) return null;
  try {
    return JSON.parse(entry.message);
  } catch {
    return null;
  }
}

function parseInventorySnapshot(evidence) {
  const entry = evidence.find((entry) => entry.code === "INVENTORY_SNAPSHOT");
  if (!entry?.message) return null;
  try {
    return {
      blockNumber: entry.blockNumber ?? null,
      balances: JSON.parse(entry.message),
    };
  } catch {
    return null;
  }
}

function categorizeWarning(code) {
  switch (code) {
    case "MARKET_SESSION":
      return "market-session";
    case "STALE_PRICE":
    case "STALE_BLOCK":
      return "stale-price";
    case "STALE_INVENTORY":
      return "inventory";
    case "NATIVE_OUTPUT":
      return "native-output";
    default:
      return "general";
  }
}

function pushWarning(target, seen, code, message, category) {
  if (seen.has(code)) return;
  seen.add(code);
  target.push({
    code,
    message,
    category,
    severity: "warning",
  });
}

function formatExpiryLabel(expiresAt, now) {
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry)) return `Expires ${expiresAt}`;
  const clock = now ? Date.parse(now) : Date.now();
  const seconds = Math.max(0, Math.round((expiry - clock) / 1000));
  return seconds > 0 ? `Expires in ${seconds}s` : "Quote expired";
}

function buildAccessibility({ status, title, message, selectedName, warningCount = 0 }) {
  const ariaLive =
    status === ROUTE_VIEW_STATES.error
      ? "assertive"
      : status === ROUTE_VIEW_STATES.loading
        ? "polite"
        : "off";

  let ariaLabel = title;
  if (status === ROUTE_VIEW_STATES.ready && selectedName) {
    ariaLabel = `Route details for ${selectedName}`;
    if (warningCount > 0) {
      ariaLabel += `, ${warningCount} warning${warningCount === 1 ? "" : "s"}`;
    }
  } else if (message) {
    ariaLabel = `${title}. ${message}`;
  }

  return {
    role: status === ROUTE_VIEW_STATES.error ? "alert" : "region",
    ariaLabel,
    ariaLive,
    ariaBusy: status === ROUTE_VIEW_STATES.loading,
  };
}

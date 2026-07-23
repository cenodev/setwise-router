/**
 * Gas- and fee-adjusted route ranking (issue #26).
 *
 * All arithmetic is integer-only. Prices are supplied as explicit rational
 * conversions so token decimals never pass through JavaScript numbers:
 *
 *   fromAmount units of fromToken == toAmount units of toToken
 *
 * Only direct conversions are used. Missing gas estimates, gas prices, or
 * conversions make a route `unpriced`; no price is inferred through another
 * token. Fully priced routes are preferred. If every route is unpriced, the
 * deterministic fallback is the raw exact-mode amount.
 */

import { getChainConfig } from "../../../config/index.mjs";
import { NATIVE_TOKEN_SENTINEL } from "../../../config/native.mjs";
import { mulDivCeil } from "./rounding.js";

export const DEFAULT_APPROVAL_GAS_UNITS = "46000";
export const DEFAULT_MINIMUM_IMPROVEMENT_BPS = 1;
export const DEFAULT_MINIMUM_IMPROVEMENT_AMOUNT = "1";

const NATIVE_DISPLAY_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const UINT_RE = /^(0|[1-9][0-9]*)$/;
const COMPLETE_STATUSES = new Set(["applied", "not-required"]);

function uint(value, name, { positive = false } = {}) {
  if (typeof value !== "string" || !UINT_RE.test(value)) {
    throw new TypeError(`${name} must be a canonical unsigned integer string`);
  }
  if (positive && value === "0") {
    throw new TypeError(`${name} must be greater than zero`);
  }
  return value;
}

function thresholds(options) {
  const bps =
    options.minimumImprovementBps ?? DEFAULT_MINIMUM_IMPROVEMENT_BPS;
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new TypeError("minimumImprovementBps must be an integer from 0 through 10000");
  }
  return {
    minimumImprovementBps: bps,
    minimumImprovementAmount: uint(
      options.minimumImprovementAmount ?? DEFAULT_MINIMUM_IMPROVEMENT_AMOUNT,
      "minimumImprovementAmount",
    ),
  };
}

function nativeToken(chainId, chainConfig) {
  return {
    chainId,
    address: chainConfig.wrappedNative.address ?? NATIVE_DISPLAY_ADDRESS,
  };
}

function tokenKey(token, chainConfig) {
  const address = token.address.toLowerCase();
  const wrapped = chainConfig.wrappedNative.address?.toLowerCase();
  if (
    address === NATIVE_TOKEN_SENTINEL ||
    address === NATIVE_DISPLAY_ADDRESS.toLowerCase() ||
    (wrapped !== undefined && address === wrapped)
  ) {
    return "native";
  }
  return address;
}

function sameToken(left, right, chainConfig) {
  return (
    left.chainId === right.chainId &&
    tokenKey(left, chainConfig) === tokenKey(right, chainConfig)
  );
}

function findConversion(conversions, fromToken, toToken, chainConfig) {
  return conversions.find(
    (conversion) =>
      conversion.fromToken?.chainId === fromToken.chainId &&
      conversion.toToken?.chainId === toToken.chainId &&
      sameToken(conversion.fromToken, fromToken, chainConfig) &&
      sameToken(conversion.toToken, toToken, chainConfig),
  );
}

function convert(amount, fromToken, toToken, context) {
  uint(amount, "adjustment amount");
  if (amount === "0" || sameToken(fromToken, toToken, context.chainConfig)) {
    return { comparisonAmount: amount, status: "applied" };
  }

  const conversion = findConversion(
    context.conversions,
    fromToken,
    toToken,
    context.chainConfig,
  );
  if (!conversion) {
    return { comparisonAmount: null, status: "missing-price" };
  }
  const fromAmount = uint(conversion.fromAmount, "conversion.fromAmount", {
    positive: true,
  });
  const toAmount = uint(conversion.toAmount, "conversion.toAmount", {
    positive: true,
  });
  return {
    comparisonAmount: mulDivCeil(amount, toAmount, fromAmount),
    status: "applied",
  };
}

function adjustment(type, amount, token, comparisonAmount, status) {
  return { type, amount, token, comparisonAmount, status };
}

function feeAdjustments(quote, type, comparisonToken, context) {
  const acceptedTypes =
    type === "integrator-fee" ? new Set(["integrator", "source"]) : new Set(["protocol"]);
  const fees = quote.fees.filter((fee) => acceptedTypes.has(fee.type));
  if (fees.length === 0) {
    return [adjustment(type, "0", comparisonToken, "0", "applied")];
  }
  return fees.map((fee) => {
    const converted = convert(fee.amount, fee.token, comparisonToken, context);
    return adjustment(
      type,
      fee.amount,
      fee.token,
      converted.comparisonAmount,
      converted.status,
    );
  });
}

function routeGasPrice(quote, options) {
  if (options.gasPrice !== undefined) {
    return uint(options.gasPrice, "gasPrice", { positive: true });
  }
  const units = BigInt(quote.gas.estimatedUnits);
  const cost = BigInt(quote.gas.estimatedCost);
  if (units === 0n || cost === 0n) return null;
  return ((cost + units - 1n) / units).toString();
}

function gasAdjustment(quote, comparisonToken, context) {
  const token = context.nativeToken;
  const units = BigInt(quote.gas.estimatedUnits);
  let amount = quote.gas.estimatedCost;
  if (amount === "0") {
    if (units === 0n) {
      return adjustment("gas", null, token, null, "missing-estimate");
    }
    if (context.gasPrice === null) {
      return adjustment("gas", null, token, null, "missing-price");
    }
    amount = (units * BigInt(context.gasPrice)).toString();
  }
  const converted = convert(amount, token, comparisonToken, context);
  return adjustment(
    "gas",
    amount,
    token,
    converted.comparisonAmount,
    converted.status,
  );
}

function approvalAdjustment(outcome, comparisonToken, context) {
  const token = context.nativeToken;
  if (outcome.quote.approvalTarget === null) {
    return adjustment("approval", "0", token, "0", "not-required");
  }

  const sourceUnits = context.approvalGasUnitsBySource[outcome.source.id];
  const gasUnits = sourceUnits ?? context.approvalGasUnits;
  if (gasUnits === null) {
    return adjustment("approval", null, token, null, "missing-estimate");
  }
  if (context.gasPrice === null) {
    return adjustment("approval", null, token, null, "missing-price");
  }
  const amount = (BigInt(gasUnits) * BigInt(context.gasPrice)).toString();
  const converted = convert(amount, token, comparisonToken, context);
  return adjustment(
    "approval",
    amount,
    token,
    converted.comparisonAmount,
    converted.status,
  );
}

function rankingContext(outcome, request, options) {
  const chainConfig = getChainConfig(request.chainId);
  const configuredApprovalUnits =
    options.approvalGasUnits === null
      ? null
      : uint(
          options.approvalGasUnits ?? DEFAULT_APPROVAL_GAS_UNITS,
          "approvalGasUnits",
        );
  const approvalGasUnitsBySource = options.approvalGasUnitsBySource ?? {};
  for (const [sourceId, gasUnits] of Object.entries(approvalGasUnitsBySource)) {
    uint(gasUnits, `approvalGasUnitsBySource.${sourceId}`);
  }
  return {
    chainConfig,
    nativeToken: nativeToken(request.chainId, chainConfig),
    conversions: options.conversions ?? [],
    gasPrice: routeGasPrice(outcome.quote, options),
    approvalGasUnits: configuredApprovalUnits,
    approvalGasUnitsBySource,
  };
}

/**
 * Build the structured, auditable net-outcome record for one quoted route.
 */
export function buildRouteRanking(outcome, request, options = {}) {
  if (!outcome?.quote) return null;
  const comparisonToken =
    request.mode === "exact-input" ? request.tokenOut : request.tokenIn;
  const rawAmount =
    request.mode === "exact-input"
      ? outcome.quote.amounts.output
      : outcome.quote.amounts.input;
  const context = rankingContext(outcome, request, options);
  const policy = thresholds(options);

  const adjustments = [
    ...feeAdjustments(
      outcome.quote,
      "protocol-fee",
      comparisonToken,
      context,
    ),
    ...feeAdjustments(
      outcome.quote,
      "integrator-fee",
      comparisonToken,
      context,
    ),
    gasAdjustment(outcome.quote, comparisonToken, context),
    approvalAdjustment(outcome, comparisonToken, context),
  ];
  const complete = adjustments.every((item) => COMPLETE_STATUSES.has(item.status));
  const totalCost = adjustments.reduce(
    (sum, item) => sum + BigInt(item.comparisonAmount ?? "0"),
    0n,
  );
  const raw = BigInt(rawAmount);
  const adjusted =
    request.mode === "exact-input"
      ? raw > totalCost
        ? raw - totalCost
        : 0n
      : raw + totalCost;

  return {
    status: complete ? "complete" : "unpriced",
    comparisonToken,
    rawAmount,
    adjustedAmount: complete ? adjusted.toString() : null,
    adjustments,
    thresholds: policy,
    fallback: complete ? "none" : "raw-amount",
  };
}

function selectionAmount(outcome, useAdjusted, mode) {
  if (useAdjusted) return BigInt(outcome.ranking.adjustedAmount);
  return BigInt(
    mode === "exact-input"
      ? outcome.quote.amounts.output
      : outcome.quote.amounts.input,
  );
}

function chooseWithinThreshold(candidates, mode, useAdjusted, policy) {
  let bestAmount = selectionAmount(candidates[0], useAdjusted, mode);
  for (const candidate of candidates.slice(1)) {
    const amount = selectionAmount(candidate, useAdjusted, mode);
    if (
      (mode === "exact-input" && amount > bestAmount) ||
      (mode === "exact-output" && amount < bestAmount)
    ) {
      bestAmount = amount;
    }
  }

  const relativeTolerance = BigInt(
    mulDivCeil(
      bestAmount.toString(),
      String(policy.minimumImprovementBps),
      "10000",
    ),
  );
  const absoluteTolerance = BigInt(policy.minimumImprovementAmount);
  const tolerance =
    relativeTolerance > absoluteTolerance ? relativeTolerance : absoluteTolerance;
  const equivalent = candidates.filter((candidate) => {
    const amount = selectionAmount(candidate, useAdjusted, mode);
    return mode === "exact-input"
      ? bestAmount - amount <= tolerance
      : amount - bestAmount <= tolerance;
  });
  equivalent.sort((left, right) =>
    left.source.id.localeCompare(right.source.id),
  );
  return equivalent[0].source.id;
}

/**
 * Enrich quote outcomes with ranking evidence and select the best route.
 *
 * Fully priced routes are ranked before unpriced routes. If no fully priced
 * route exists, all available routes use the explicit raw-amount fallback.
 */
export function rankQuoteSources(sources, request, options = {}) {
  const policy = thresholds(options);
  const rankedSources = sources.map((outcome) => {
    if (!outcome.quote) return outcome;
    const ranking = buildRouteRanking(outcome, request, options);
    const observedAt =
      outcome.evidence?.[0]?.observedAt ?? new Date(0).toISOString();
    return {
      ...outcome,
      ranking,
      evidence: [
        ...outcome.evidence,
        {
          kind: "policy",
          observedAt,
          reference: `ranking:${outcome.source.id}`,
          code:
            ranking.status === "complete"
              ? "NET_EXECUTABLE_OUTCOME"
              : "UNPRICED_ADJUSTMENTS",
          message: JSON.stringify(ranking),
        },
      ],
    };
  });

  const available = rankedSources.filter(
    (outcome) => outcome.status === "available" && outcome.quote,
  );
  if (available.length === 0) {
    return { sources: rankedSources, selectedSourceId: null };
  }
  const complete = available.filter(
    (outcome) => outcome.ranking.status === "complete",
  );
  const candidates = complete.length > 0 ? complete : available;
  return {
    sources: rankedSources,
    selectedSourceId: chooseWithinThreshold(
      candidates,
      request.mode,
      complete.length > 0,
      policy,
    ),
  };
}

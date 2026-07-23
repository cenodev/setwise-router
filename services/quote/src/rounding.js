/**
 * Conservative amount rounding for the unified quote schema (issue #24).
 *
 * Every source normalizes amounts as canonical unsigned-integer strings in a
 * token's smallest unit. Slippage limits are derived from a quoted amount and a
 * basis-point tolerance, and the rounding direction is chosen so a limit never
 * over-promises:
 *
 *   - exact-input  → `limit` is the minimum acceptable output. It is rounded
 *     DOWN (floor): a fill that returns at least the floored minimum is always
 *     achievable, so the limit never claims more output than the route can pay.
 *   - exact-output → `limit` is the maximum acceptable input. It is rounded UP
 *     (ceil): the limit is never below the input the route actually requires,
 *     which prevents exact-output "phantom liquidity" where a quote looks
 *     fillable but reverts because the protected maximum input was truncated.
 *
 * All math is BigInt so token-decimal precision is never lost to floating point.
 */

const BPS_BASE = 10_000n;

function toBigInt(value, label) {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
    return BigInt(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw new Error(`${label} must be a canonical unsigned integer`);
}

/**
 * Floor `(value * multiplier) / divisor` using arbitrary-precision integers.
 * @param {bigint|string|number} value
 * @param {bigint|string|number} multiplier
 * @param {bigint|string|number} divisor
 * @returns {string} canonical unsigned-integer string
 */
export function mulDivFloor(value, multiplier, divisor) {
  const numerator = toBigInt(value, "value") * toBigInt(multiplier, "multiplier");
  const denominator = toBigInt(divisor, "divisor");
  if (denominator === 0n) throw new Error("divisor must be greater than zero");
  return (numerator / denominator).toString();
}

/**
 * Ceil `(value * multiplier) / divisor` using arbitrary-precision integers.
 * @param {bigint|string|number} value
 * @param {bigint|string|number} multiplier
 * @param {bigint|string|number} divisor
 * @returns {string} canonical unsigned-integer string
 */
export function mulDivCeil(value, multiplier, divisor) {
  const numerator = toBigInt(value, "value") * toBigInt(multiplier, "multiplier");
  const denominator = toBigInt(divisor, "divisor");
  if (denominator === 0n) throw new Error("divisor must be greater than zero");
  return ((numerator + denominator - 1n) / denominator).toString();
}

/**
 * Compute the conservative slippage limit for a quoted amount.
 *
 * @param {"exact-input"|"exact-output"} mode
 * @param {bigint|string|number} amount  The quoted amount the limit protects
 *   (output for exact-input, input for exact-output).
 * @param {number} maxBps  Slippage tolerance in basis points (0..10000).
 * @returns {string} canonical unsigned-integer string
 */
export function slippageLimit(mode, amount, maxBps) {
  if (!Number.isInteger(maxBps) || maxBps < 0 || maxBps > 10_000) {
    throw new Error("maxBps must be an integer from 0 through 10000");
  }
  const bps = BigInt(maxBps);
  if (mode === "exact-input") {
    return mulDivFloor(amount, BPS_BASE - bps, BPS_BASE);
  }
  if (mode === "exact-output") {
    return mulDivCeil(amount, BPS_BASE + bps, BPS_BASE);
  }
  throw new Error(`mode must be exact-input or exact-output`);
}

/**
 * Pluggable quote-source adapter framework (issue #18).
 *
 * Defines the common lifecycle every quote source implements so on-chain
 * quoters (ZFi), HTTP aggregators (0x), and signed RFQ sources (Set) can be
 * fanned out uniformly by the runner in `runner.js`:
 *
 *   - capability interface: which chains, exact-modes, and quote kinds a
 *     source supports, declared explicitly (no implicit fallback);
 *   - quote interface: produce an indicative or firm normalized quote that
 *     matches the unified schema from `schema.js` (issue #20);
 *   - health interface: a lightweight liveness probe for monitoring;
 *   - timeout interface: a per-source budget enforced by the runner.
 *
 * Adapters never throw out of the runner: the runner isolates each source so a
 * single failure cannot take down viable alternatives. User-facing source
 * names use "Set" while the internal `poolId` is retained for Set sources.
 */

import { QUOTE_KINDS, QUOTE_MODES, QUOTE_SOURCE_TYPES } from "./schema.js";

/** Default per-source timeout budget, in milliseconds. */
export const DEFAULT_ADAPTER_TIMEOUT_MS = 5000;

/** Health states an adapter may report from {@link QuoteSourceAdapter.health}. */
export const ADAPTER_HEALTH_STATUSES = Object.freeze([
  "healthy",
  "degraded",
  "unhealthy",
]);

/**
 * Outcome statuses an adapter may declare from {@link QuoteSourceAdapter.quote}.
 * The runner reserves `excluded` (capability gate) and `failed` (error,
 * timeout, or cancellation) for itself; adapters only report the result of a
 * quote attempt that actually ran.
 */
export const ADAPTER_OUTCOME_STATUSES = Object.freeze([
  "available",
  "unavailable",
  "stale",
]);

const SOURCE_TYPE_SET = new Set(QUOTE_SOURCE_TYPES);
const MODE_SET = new Set(QUOTE_MODES);
const KIND_SET = new Set(QUOTE_KINDS);

/**
 * @typedef {Object} AdapterCapabilities
 * @property {readonly number[]} chains  Chain ids the source supports.
 * @property {readonly string[]} modes   Exact-modes ("exact-input"/"exact-output").
 * @property {readonly string[]} kinds   Quote kinds ("indicative"/"firm").
 */

/**
 * @typedef {Object} AdapterHealth
 * @property {string} status     One of {@link ADAPTER_HEALTH_STATUSES}.
 * @property {string} checkedAt  ISO 8601 timestamp of the probe.
 * @property {number} latencyMs  Probe round-trip time in milliseconds.
 * @property {string} [detail]   Optional human-readable detail.
 */

/**
 * @typedef {Object} AdapterQuoteResult
 * @property {string} status                 One of {@link ADAPTER_OUTCOME_STATUSES}.
 * @property {object|null} quote             Normalized quote (schema-shaped) or null.
 * @property {Array<object>} evidence        Non-empty structured evidence records.
 * @property {string} [poolId]               Internal Set pool id (Set sources only).
 * @property {object|null} [transaction]     Executable transaction for firm on-chain
 *   quotes (schema-shaped `{chainId, to, calldata, value}`); null/absent for
 *   indicative quotes, which cannot carry an executable transaction.
 */

/**
 * @typedef {Object} AdapterContext
 * @property {string} kind        Quote kind being requested.
 * @property {AbortSignal} [signal]  Aborted on timeout or caller cancellation.
 * @property {() => string} now    Returns the current ISO 8601 timestamp.
 * @property {object} chainConfig  The explicit chain config for the request chain.
 */

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

/**
 * Normalize and freeze an adapter capability declaration. Chains must be
 * declared explicitly; modes and kinds default to the full schema set.
 *
 * @param {Partial<AdapterCapabilities>} capabilities
 * @returns {AdapterCapabilities}
 */
export function normalizeCapabilities(capabilities) {
  if (
    !capabilities ||
    !Array.isArray(capabilities.chains) ||
    capabilities.chains.length === 0
  ) {
    throw new Error("adapter capabilities.chains must be a non-empty array");
  }
  for (const chainId of capabilities.chains) {
    if (!Number.isSafeInteger(chainId) || chainId <= 0) {
      throw new Error(`adapter capability chain id "${chainId}" is invalid`);
    }
  }
  const modes = capabilities.modes ?? [...QUOTE_MODES];
  const kinds = capabilities.kinds ?? [...QUOTE_KINDS];
  for (const mode of modes) {
    if (!MODE_SET.has(mode)) throw new Error(`unknown adapter mode "${mode}"`);
  }
  for (const kind of kinds) {
    if (!KIND_SET.has(kind)) throw new Error(`unknown adapter kind "${kind}"`);
  }
  return Object.freeze({
    chains: Object.freeze([...capabilities.chains]),
    modes: Object.freeze([...modes]),
    kinds: Object.freeze([...kinds]),
  });
}

/**
 * Base class for all quote-source adapters. Concrete adapters override
 * {@link QuoteSourceAdapter.quote} (and optionally
 * {@link QuoteSourceAdapter.health}).
 */
export class QuoteSourceAdapter {
  /**
   * @param {object} descriptor
   * @param {string} descriptor.id           Stable source id (unique per registry).
   * @param {string} descriptor.type         One of the schema source types.
   * @param {string} descriptor.displayName  User-facing name ("Set" for Set sources).
   * @param {string} [descriptor.poolId]     Internal Set pool id (Set sources only).
   * @param {object} [options]
   * @param {Partial<AdapterCapabilities>} options.capabilities
   * @param {number} [options.timeoutMs]
   */
  constructor(descriptor, options = {}) {
    nonEmptyString(descriptor?.id, "adapter id");
    nonEmptyString(descriptor?.displayName, "adapter displayName");
    if (!SOURCE_TYPE_SET.has(descriptor?.type)) {
      throw new Error(
        `adapter type must be one of: ${QUOTE_SOURCE_TYPES.join(", ")}`,
      );
    }
    if (descriptor.type === "setwise") {
      if (descriptor.displayName !== "Set") {
        throw new Error('Set sources must use the user-facing name "Set"');
      }
      nonEmptyString(descriptor.poolId, "Set adapter poolId");
    } else if (descriptor.poolId !== undefined) {
      throw new Error("poolId is only valid for a Set source");
    }

    this.id = descriptor.id;
    this.type = descriptor.type;
    this.displayName = descriptor.displayName;
    this.poolId = descriptor.type === "setwise" ? descriptor.poolId : null;
    this.timeoutMs =
      options.timeoutMs === undefined
        ? DEFAULT_ADAPTER_TIMEOUT_MS
        : options.timeoutMs;
    this.capabilities = normalizeCapabilities(options.capabilities);
  }

  /**
   * Schema-shaped source descriptor used in quote responses.
   * @returns {{id: string, type: string, displayName: string, poolId?: string}}
   */
  describe() {
    const source = {
      id: this.id,
      type: this.type,
      displayName: this.displayName,
    };
    if (this.type === "setwise") source.poolId = this.poolId;
    return source;
  }

  /**
   * Capability gate used by the runner to skip unsupported combinations.
   * @param {number} chainId
   * @param {string} mode
   * @param {string} kind
   * @returns {boolean}
   */
  supports(chainId, mode, kind) {
    return (
      this.capabilities.chains.includes(chainId) &&
      this.capabilities.modes.includes(mode) &&
      this.capabilities.kinds.includes(kind)
    );
  }

  /**
   * Liveness probe. The default implementation reports healthy; adapters that
   * wrap a remote endpoint should override this.
   * @param {AdapterContext} _context
   * @returns {Promise<AdapterHealth>}
   */
  async health(_context) {
    return { status: "healthy", checkedAt: new Date().toISOString(), latencyMs: 0 };
  }

  /**
   * Produce a normalized quote. Concrete adapters must override this.
   * @param {object} _request  A validated v1 quote request.
   * @param {AdapterContext} _context
   * @returns {Promise<AdapterQuoteResult>}
   */
  async quote(_request, _context) {
    throw new Error(`adapter "${this.id}" does not implement quote()`);
  }
}

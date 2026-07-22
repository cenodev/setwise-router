import { SETWISE_UI_LABEL } from "./constants.js";

/**
 * Governance and emergency-control state for services and UI.
 *
 * User-facing surfaces describe liquidity venues as "Sets"; internal
 * identifiers retain `pool` and `poolId` terminology.
 */

export const GOVERNANCE_ROLES = Object.freeze({
  owner: "owner",
  pendingOwner: "pendingOwner",
  emergencyGuardian: "emergencyGuardian",
  proposer: "proposer",
});

export const CONTROL_LEVELS = Object.freeze({
  global: "global",
  chain: "chain",
  source: "source",
});

export const TIMELOCK_BOUNDS = Object.freeze({
  MIN_DELAY_SECONDS: 3600,
  MAX_DELAY_SECONDS: 2592000,
  GRACE_PERIOD_SECONDS: 1209600,
});

/**
 * @typedef {Object} GovernanceState
 * @property {string} owner
 * @property {string|null} pendingOwner
 * @property {string} emergencyGuardian
 * @property {boolean} paused
 * @property {number[]} disabledChains
 * @property {Array<{ chainId: number, sourceId: string }>} disabledSources
 */

/**
 * @typedef {Object} TimelockState
 * @property {string} proposer
 * @property {string} guardian
 * @property {number} delaySeconds
 * @property {Array<{ id: string, target: string, readyAt: number, deadline: number, state: string }>} operations
 */

/**
 * Describe the current governance state for UI display.
 *
 * @param {GovernanceState} state
 * @returns {{ title: string, description: string, severity: "ok"|"warning"|"critical" }}
 */
export function describeGovernanceState(state) {
  if (state.paused) {
    return {
      title: "Router paused",
      description: "All routing is temporarily disabled by governance or the emergency guardian.",
      severity: "critical",
    };
  }

  if (state.disabledChains.length > 0) {
    return {
      title: "Some chains unavailable",
      description: `Routing is disabled on ${state.disabledChains.length} chain(s). Other chains remain operational.`,
      severity: "warning",
    };
  }

  if (state.disabledSources.length > 0) {
    return {
      title: `Some ${SETWISE_UI_LABEL}s unavailable`,
      description: `${state.disabledSources.length} source(s) disabled. Healthy routes remain available.`,
      severity: "warning",
    };
  }

  return {
    title: "All systems operational",
    description: "No governance restrictions are active.",
    severity: "ok",
  };
}

/**
 * Determine whether a specific route is eligible given the current state.
 *
 * @param {GovernanceState} state
 * @param {number} chainId
 * @param {string} sourceId
 * @returns {{ eligible: boolean, reason: string|null }}
 */
export function checkRouteEligibility(state, chainId, sourceId) {
  if (state.paused) {
    return { eligible: false, reason: "Router is paused by governance." };
  }

  if (state.disabledChains.includes(chainId)) {
    return { eligible: false, reason: `Chain ${chainId} is disabled.` };
  }

  const sourceDisabled = state.disabledSources.some(
    (s) => s.chainId === chainId && s.sourceId === sourceId,
  );
  if (sourceDisabled) {
    return { eligible: false, reason: `${SETWISE_UI_LABEL} "${sourceId}" is disabled on chain ${chainId}.` };
  }

  return { eligible: true, reason: null };
}

/**
 * Describe timelock operation status for monitoring.
 *
 * @param {{ readyAt: number, deadline: number, state: string }} operation
 * @param {number} nowSeconds
 * @returns {{ label: string, actionable: boolean, expired: boolean }}
 */
export function describeTimelockOperation(operation, nowSeconds) {
  if (operation.state === "executed") {
    return { label: "Executed", actionable: false, expired: false };
  }
  if (operation.state === "cancelled") {
    return { label: "Cancelled", actionable: false, expired: false };
  }
  if (nowSeconds > operation.deadline) {
    return { label: "Expired", actionable: false, expired: true };
  }
  if (nowSeconds >= operation.readyAt) {
    return { label: "Ready to execute", actionable: true, expired: false };
  }
  const remaining = operation.readyAt - nowSeconds;
  return { label: `Pending (${remaining}s remaining)`, actionable: false, expired: false };
}

/**
 * Format a governance role address for display, masking all but the
 * first and last 4 hex characters.
 *
 * @param {string} address
 * @returns {string}
 */
export function formatGovernanceAddress(address) {
  if (!address || address === "0x0000000000000000000000000000000000000000") {
    return "None";
  }
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Build a monitoring alert payload for a control change event.
 *
 * @param {string} eventType
 * @param {Record<string, unknown>} params
 * @returns {{ alert: string, eventType: string, timestamp: number, params: Record<string, unknown> }}
 */
export function buildControlChangeAlert(eventType, params) {
  return {
    alert: `governance:${eventType}`,
    eventType,
    timestamp: Date.now(),
    params,
  };
}

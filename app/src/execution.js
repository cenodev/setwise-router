import { NATIVE_TOKEN_ADDRESS, SETWISE_UI_LABEL } from "./constants.js";
import { formatRouteAddress } from "./route-details.js";

/**
 * Approval, preflight revalidation, and transaction submission UX for the dapp.
 *
 * User-facing copy uses "Set"; internal identifiers keep `pool` / `poolId`.
 * The wallet boundary must prevent stale or mismatched transactions, so
 * submission is gated on chain, account, quote identity, expiry, balances,
 * allowances, and a final client-side preflight/simulation result.
 */

export const APPROVAL_FLOWS = Object.freeze({
  none: "none",
  setwiseRouter: "setwise-router",
  permit2: "permit2",
  aggregator: "aggregator",
});

export const PREFLIGHT_CHECKS = Object.freeze({
  chainMatch: "CHAIN_MATCH",
  accountMatch: "ACCOUNT_MATCH",
  quoteIdentity: "QUOTE_IDENTITY",
  quoteKind: "QUOTE_KIND",
  quoteExpiry: "QUOTE_EXPIRY",
  transactionPresent: "TRANSACTION_PRESENT",
  approvalTarget: "APPROVAL_TARGET",
  allowance: "ALLOWANCE",
  balance: "BALANCE",
  simulation: "SIMULATION",
});

export const TX_STATES = Object.freeze({
  idle: "idle",
  submitting: "submitting",
  pending: "pending",
  confirming: "confirming",
  confirmed: "confirmed",
  replaced: "replaced",
  rejected: "rejected",
  reverted: "reverted",
  failed: "failed",
  reorged: "reorged",
});

export const TX_EVENTS = Object.freeze({
  submit: "SUBMIT",
  hash: "HASH",
  mined: "MINED",
  confirmed: "CONFIRMED",
  replaced: "REPLACED",
  rejected: "REJECTED",
  reverted: "REVERTED",
  error: "ERROR",
  reorg: "REORG",
  reset: "RESET",
});

/**
 * @typedef {{ chainId: number, address: string }} ChainAddress
 */

/**
 * @typedef {{
 *   chainId: number,
 *   quoteId: string,
 *   kind: "firm"|"indicative",
 *   mode: "exact-input"|"exact-output",
 *   sourceType: "setwise"|"zfi"|"aggregator",
 *   sourceId: string,
 *   poolId: string|null,
 *   inputToken: string|null,
 *   amounts: { input: string, output: string, limit: string },
 *   approvalTarget: ChainAddress|null,
 *   transaction: { chainId: number, to: string, calldata: string, value: string }|null,
 *   expiresAt: string|null,
 * }} ExecutableRoute
 */

/**
 * @typedef {{ router: string|null, permit2: string|null }} ApprovalContracts
 */

/**
 * @typedef {{ chainId: number|null, account: string|null }} WalletContext
 */

/**
 * @typedef {{
 *   blockNumber?: number|null,
 *   balance?: string|null,
 *   allowance?: string|null,
 *   nonce?: number|null,
 * }} ChainState
 */

/**
 * Normalize a validated v1 firm quote response into an executable route plan.
 *
 * @param {object} response
 * @param {{ inputToken?: string|null }} [options]
 * @returns {ExecutableRoute|null}
 */
export function buildExecutableRoute(response, options = {}) {
  const selected = (response.sources ?? []).find(
    (entry) => entry.source.id === response.selectedSourceId,
  );
  if (!selected?.quote) return null;

  const { quote } = selected;
  return {
    chainId: response.chainId,
    quoteId: response.requestId,
    kind: response.kind,
    mode: response.mode,
    sourceType: selected.source.type,
    sourceId: selected.source.id,
    poolId: selected.source.poolId ?? null,
    inputToken: options.inputToken ?? null,
    amounts: {
      input: quote.amounts.input,
      output: quote.amounts.output,
      limit: quote.amounts.limit,
    },
    approvalTarget: quote.approvalTarget ?? null,
    transaction: response.transaction ?? null,
    expiresAt: quote.expiresAt ?? null,
  };
}

/**
 * Determine the allowance flow and the exact approval target/amount for a route.
 *
 * @param {ExecutableRoute} route
 * @param {ApprovalContracts} [contracts]
 */
export function resolveApprovalFlow(route, contracts = {}) {
  const amount = approvalAmount(route);
  const shared = {
    chainId: route.chainId,
    sourceType: route.sourceType,
    poolId: route.poolId,
  };

  if (!route.inputToken || isNativeAddress(route.inputToken)) {
    return nonePlan(shared, "native-input");
  }
  const target = route.approvalTarget;
  if (!target) {
    return nonePlan(shared, "no-approval-target");
  }

  const spender = target.address;
  let flow;
  if (contracts.permit2 && sameAddress(spender, contracts.permit2)) {
    flow = APPROVAL_FLOWS.permit2;
  } else if (contracts.router && sameAddress(spender, contracts.router)) {
    flow = APPROVAL_FLOWS.setwiseRouter;
  } else {
    flow = APPROVAL_FLOWS.aggregator;
  }

  return {
    flow,
    required: true,
    reason: null,
    chainId: route.chainId,
    sourceType: route.sourceType,
    poolId: route.poolId,
    token: route.inputToken,
    spender,
    amount,
    permit2:
      flow === APPROVAL_FLOWS.permit2
        ? { spender: route.transaction?.to ?? contracts.router ?? null, amount }
        : null,
  };
}

/**
 * Acceptance gate: the approval the wallet signs must target the selected route.
 *
 * @param {ReturnType<typeof resolveApprovalFlow>} plan
 * @param {ExecutableRoute} route
 */
export function approvalMatchesRoute(plan, route) {
  if (plan.flow === APPROVAL_FLOWS.none) {
    return !route.approvalTarget || isNativeAddress(route.inputToken);
  }
  return (
    !!route.approvalTarget &&
    plan.chainId === route.chainId &&
    route.approvalTarget.chainId === route.chainId &&
    sameAddress(plan.spender, route.approvalTarget.address)
  );
}

/**
 * Build the user-facing approval request description.
 *
 * @param {ReturnType<typeof resolveApprovalFlow>} plan
 * @param {{ tokenSymbol?: string|null }} [options]
 */
export function describeApprovalRequest(plan, options = {}) {
  if (plan.flow === APPROVAL_FLOWS.none) {
    const detail = "This route does not require a token approval.";
    return {
      flow: plan.flow,
      required: false,
      title: "No approval needed",
      flowLabel: "No approval required",
      spender: null,
      targetLabel: "None",
      amount: null,
      amountLabel: null,
      detail,
      accessibility: buildAccessibility("No approval needed", "region", "off"),
    };
  }

  const amountLabel = formatAmount(plan.amount, options.tokenSymbol ?? null);
  const detail = describeApprovalDetail(plan, amountLabel);
  const title = "Approval needed";
  return {
    flow: plan.flow,
    required: true,
    title,
    flowLabel: APPROVAL_FLOW_LABELS[plan.flow] ?? "Approval",
    spender: plan.spender,
    targetLabel: formatRouteAddress(plan.spender),
    amount: plan.amount,
    amountLabel,
    detail,
    accessibility: buildAccessibility(`${title}. ${detail}`, "region", "polite"),
  };
}

/**
 * Revalidate chain, account, balances, allowances, expiry, quote identity, and
 * an optional client-side simulation immediately before submission.
 *
 * @param {ExecutableRoute} route
 * @param {WalletContext} wallet
 * @param {ChainState} [chain]
 * @param {{
 *   now?: string,
 *   expectedQuoteId?: string|null,
 *   contracts?: ApprovalContracts|null,
 *   simulation?: { success: boolean, message?: string|null }|null,
 * }} [options]
 */
export function runPreflightChecks(route, wallet, chain = {}, options = {}) {
  const now = options.now ? Date.parse(options.now) : Date.now();
  const checks = [];

  const chainOk = wallet.chainId != null && wallet.chainId === route.chainId;
  checks.push(
    buildCheck(
      PREFLIGHT_CHECKS.chainMatch,
      chainOk,
      chainOk
        ? `Wallet is on chain ${route.chainId}.`
        : `Wallet chain ${wallet.chainId ?? "unknown"} does not match route chain ${route.chainId}.`,
    ),
  );

  const accountOk = typeof wallet.account === "string" && wallet.account.length > 0;
  checks.push(
    buildCheck(
      PREFLIGHT_CHECKS.accountMatch,
      accountOk,
      accountOk ? "Wallet account connected." : "No wallet account connected.",
    ),
  );

  const quoteIdentityOk =
    options.expectedQuoteId == null || route.quoteId === options.expectedQuoteId;
  checks.push(
    buildCheck(
      PREFLIGHT_CHECKS.quoteIdentity,
      quoteIdentityOk,
      quoteIdentityOk
        ? "Quote identity matches the selected route."
        : `Quote ${route.quoteId} does not match the selected quote ${options.expectedQuoteId}.`,
    ),
  );

  const kindOk = route.kind === "firm";
  checks.push(
    buildCheck(
      PREFLIGHT_CHECKS.quoteKind,
      kindOk,
      kindOk
        ? "Quote is executable (firm)."
        : "Indicative quotes cannot be submitted. Request a firm quote.",
    ),
  );

  const expiry = route.expiresAt ? Date.parse(route.expiresAt) : Number.NaN;
  const expiryOk = Number.isFinite(expiry) && expiry > now;
  checks.push(
    buildCheck(
      PREFLIGHT_CHECKS.quoteExpiry,
      expiryOk,
      !Number.isFinite(expiry)
        ? "Quote has no valid expiry."
        : expiryOk
          ? "Quote is still valid."
          : "Quote expired. Request a fresh quote.",
    ),
  );

  const tx = route.transaction;
  const routerOk = options.contracts?.router
    ? sameAddress(tx?.to, options.contracts.router)
    : true;
  const txOk = !!tx && isAddressLike(tx.to) && routerOk;
  checks.push(
    buildCheck(
      PREFLIGHT_CHECKS.transactionPresent,
      txOk,
      !tx
        ? "Route is not executable (no transaction)."
        : !isAddressLike(tx.to)
          ? "Transaction target is invalid."
          : !routerOk
            ? "Transaction target does not match the router."
            : "Executable transaction present.",
    ),
  );

  const approvalTargetOk =
    !route.approvalTarget || route.approvalTarget.chainId === route.chainId;
  checks.push(
    buildCheck(
      PREFLIGHT_CHECKS.approvalTarget,
      approvalTargetOk,
      approvalTargetOk
        ? "Approval target is consistent with the route chain."
        : "Approval target chain does not match the route chain.",
    ),
  );

  const needsAllowance =
    !!route.inputToken &&
    !isNativeAddress(route.inputToken) &&
    !!route.approvalTarget;
  if (!needsAllowance) {
    checks.push(buildCheck(PREFLIGHT_CHECKS.allowance, true, "No allowance required."));
  } else {
    const allowance = toBigInt(chain.allowance);
    const needed = toBigInt(approvalAmount(route));
    const allowanceOk = allowance != null && needed != null && allowance >= needed;
    checks.push(
      buildCheck(
        PREFLIGHT_CHECKS.allowance,
        allowanceOk,
        allowance == null
          ? "Allowance not available."
          : allowanceOk
            ? "Existing allowance covers the trade."
            : "Insufficient allowance. Approve before submitting.",
      ),
    );
  }

  const balance = toBigInt(chain.balance);
  const neededInput = toBigInt(route.amounts.input);
  const balanceOk = balance != null && neededInput != null && balance >= neededInput;
  checks.push(
    buildCheck(
      PREFLIGHT_CHECKS.balance,
      balanceOk,
      balance == null
        ? "Balance not available."
        : balanceOk
          ? "Balance covers the input amount."
          : "Insufficient balance for the input amount.",
    ),
  );

  const simulation = options.simulation ?? null;
  const simulationOk = !simulation || simulation.success === true;
  checks.push(
    buildCheck(
      PREFLIGHT_CHECKS.simulation,
      simulationOk,
      !simulation
        ? "No simulation run."
        : simulationOk
          ? "Preflight simulation succeeded."
          : simulation.message ?? "Preflight simulation failed.",
    ),
  );

  const failures = checks.filter((entry) => !entry.passed);
  return {
    passed: failures.length === 0,
    checks,
    failures,
    simulationRan: !!simulation,
  };
}

/**
 * @param {ReturnType<typeof runPreflightChecks>} result
 */
export function describePreflightResult(result) {
  if (result.passed) {
    return {
      passed: true,
      title: "Ready to submit",
      message: "All preflight checks passed.",
      failures: [],
      accessibility: buildAccessibility("Ready to submit", "status", "polite"),
    };
  }
  const messages = result.failures.map((entry) => entry.message);
  const message = `Resolve ${result.failures.length} issue${
    result.failures.length === 1 ? "" : "s"
  } before submitting.`;
  return {
    passed: false,
    title: "Cannot submit",
    message,
    failures: messages,
    accessibility: buildAccessibility(
      `Cannot submit. ${messages.join(" ")}`,
      "alert",
      "assertive",
    ),
  };
}

/**
 * Wallet-boundary submission gate. Account/chain/quote changes and failed
 * preflight all disable submission through the normal flow.
 *
 * @param {ExecutableRoute} route
 * @param {WalletContext} wallet
 * @param {ReturnType<typeof runPreflightChecks>} preflight
 * @param {{ now?: string, expectedQuoteId?: string|null }} [options]
 */
export function canSubmitExecution(route, wallet, preflight, options = {}) {
  if (!preflight || preflight.passed !== true) return false;
  if (route.kind !== "firm") return false;
  if (wallet.chainId == null || wallet.chainId !== route.chainId) return false;
  if (!wallet.account) return false;

  const now = options.now ? Date.parse(options.now) : Date.now();
  const expiry = route.expiresAt ? Date.parse(route.expiresAt) : Number.NaN;
  if (!Number.isFinite(expiry) || expiry <= now) return false;

  if (options.expectedQuoteId != null && route.quoteId !== options.expectedQuoteId) {
    return false;
  }
  return true;
}

/** @returns {TxLifecycle} */
export function createTxLifecycle() {
  return {
    status: TX_STATES.idle,
    txHash: null,
    blockNumber: null,
    replacedBy: null,
    error: null,
    attempts: 0,
    history: [],
  };
}

/**
 * Advance the transaction lifecycle state machine. Invalid transitions are
 * recorded with `ok: false` and leave the status unchanged.
 *
 * @param {TxLifecycle} lifecycle
 * @param {{ type: string, txHash?: string, blockNumber?: number, replacedBy?: string, message?: string, at?: number }} event
 */
export function transitionTx(lifecycle, event) {
  const from = lifecycle.status;
  const at = event.at ?? Date.now();

  if (event.type === TX_EVENTS.reset) {
    applyReset(lifecycle);
    return record(lifecycle, from, TX_STATES.idle, event.type, at, true);
  }

  const handler = NEXT_TRANSITIONS[from]?.[event.type];
  if (!handler) {
    return record(lifecycle, from, from, event.type, at, false);
  }
  handler(lifecycle, event);
  return record(lifecycle, from, lifecycle.status, event.type, at, true);
}

/**
 * Normal-flow submission entry point: refuses to advance when the wallet
 * boundary gate (preflight + wallet context) is not satisfied.
 *
 * @param {TxLifecycle} lifecycle
 * @param {{
 *   route: ExecutableRoute,
 *   wallet: WalletContext,
 *   preflight: ReturnType<typeof runPreflightChecks>,
 *   options?: { now?: string, expectedQuoteId?: string|null },
 * }} input
 */
export function submitExecution(lifecycle, input) {
  const options = input.options ?? {};
  const allowed = canSubmitExecution(
    input.route,
    input.wallet,
    input.preflight,
    options,
  );
  if (!allowed) {
    return { allowed: false, lifecycle };
  }
  const at = options.now ? Date.parse(options.now) : Date.now();
  transitionTx(lifecycle, { type: TX_EVENTS.submit, at });
  return { allowed: true, lifecycle };
}

/**
 * Force-fail an in-flight transaction when the wallet context changes.
 *
 * @param {TxLifecycle} lifecycle
 * @param {string} [reason]
 */
export function invalidateTx(lifecycle, reason) {
  const from = lifecycle.status;
  const at = Date.now();
  if (from === TX_STATES.confirmed || from === TX_STATES.replaced) {
    return record(lifecycle, from, from, TX_EVENTS.error, at, false);
  }
  lifecycle.error = reason ?? "Transaction invalidated.";
  lifecycle.status = TX_STATES.failed;
  return record(lifecycle, from, TX_STATES.failed, TX_EVENTS.error, at, true);
}

/** @param {TxLifecycle} lifecycle */
export function canResubmit(lifecycle) {
  return RESUBMITTABLE_STATES.has(lifecycle.status);
}

/**
 * @param {TxLifecycle} lifecycle
 * @param {{ explorerTxUrl?: string|null }} [options]
 */
export function describeTxState(lifecycle, options = {}) {
  const meta = TX_STATE_META[lifecycle.status];
  const status = lifecycle.status;
  let message = meta.message;

  if (status === TX_STATES.pending && lifecycle.txHash) {
    message = `${message} (${formatRouteAddress(lifecycle.txHash)}).`;
  } else if (status === TX_STATES.confirming && lifecycle.blockNumber != null) {
    message = `${message} at block ${lifecycle.blockNumber}.`;
  } else if (status === TX_STATES.replaced && lifecycle.replacedBy) {
    message = `${message} (${formatRouteAddress(lifecycle.replacedBy)}).`;
  } else if (
    (status === TX_STATES.failed || status === TX_STATES.reverted) &&
    lifecycle.error
  ) {
    message = `${message}: ${lifecycle.error}`;
  } else if (status === TX_STATES.reorged) {
    message = `${message} Resubmit to continue.`;
  }

  return {
    status,
    title: meta.title,
    message,
    txHash: lifecycle.txHash,
    blockNumber: lifecycle.blockNumber,
    replacedBy: lifecycle.replacedBy,
    error: lifecycle.error,
    attempts: lifecycle.attempts,
    terminal: meta.terminal,
    accessibility: buildAccessibility(
      `${meta.title}. ${message}`,
      meta.alert ? "alert" : "status",
      meta.alert ? "assertive" : meta.live ? "polite" : "off",
      status === TX_STATES.submitting ||
        status === TX_STATES.pending ||
        status === TX_STATES.confirming,
    ),
  };
}

/**
 * @typedef {{
 *   status: string,
 *   txHash: string|null,
 *   blockNumber: number|null,
 *   replacedBy: string|null,
 *   error: string|null,
 *   attempts: number,
 *   history: Array<{ from: string, to: string, type: string, at: number, ok: boolean }>,
 * }} TxLifecycle
 */

const APPROVAL_FLOW_LABELS = Object.freeze({
  [APPROVAL_FLOWS.setwiseRouter]: "Setwise Router approval",
  [APPROVAL_FLOWS.permit2]: "Permit2 approval",
  [APPROVAL_FLOWS.aggregator]: "Aggregator approval",
});

const RESUBMITTABLE_STATES = new Set([
  TX_STATES.reorged,
  TX_STATES.rejected,
  TX_STATES.failed,
  TX_STATES.reverted,
]);

const NEXT_TRANSITIONS = {
  [TX_STATES.idle]: {
    [TX_EVENTS.submit]: (lc) => beginSubmit(lc),
  },
  [TX_STATES.submitting]: {
    [TX_EVENTS.hash]: (lc, e) => {
      lc.txHash = e.txHash ?? null;
      lc.status = TX_STATES.pending;
    },
    [TX_EVENTS.rejected]: (lc) => {
      lc.status = TX_STATES.rejected;
    },
    [TX_EVENTS.error]: (lc, e) => {
      lc.error = e.message ?? "Submission failed.";
      lc.status = TX_STATES.failed;
    },
  },
  [TX_STATES.pending]: {
    [TX_EVENTS.mined]: (lc, e) => {
      lc.blockNumber = e.blockNumber ?? null;
      lc.status = TX_STATES.confirming;
    },
    [TX_EVENTS.replaced]: (lc, e) => {
      lc.replacedBy = e.replacedBy ?? null;
      lc.status = TX_STATES.replaced;
    },
    [TX_EVENTS.rejected]: (lc) => {
      lc.status = TX_STATES.rejected;
    },
    [TX_EVENTS.error]: (lc, e) => {
      lc.error = e.message ?? "Transaction dropped.";
      lc.status = TX_STATES.failed;
    },
  },
  [TX_STATES.confirming]: {
    [TX_EVENTS.confirmed]: (lc) => {
      lc.status = TX_STATES.confirmed;
    },
    [TX_EVENTS.reverted]: (lc, e) => {
      if (e.blockNumber != null) lc.blockNumber = e.blockNumber;
      lc.status = TX_STATES.reverted;
    },
    [TX_EVENTS.reorg]: (lc) => {
      lc.status = TX_STATES.reorged;
    },
    [TX_EVENTS.replaced]: (lc, e) => {
      lc.replacedBy = e.replacedBy ?? null;
      lc.status = TX_STATES.replaced;
    },
  },
  [TX_STATES.confirmed]: {
    [TX_EVENTS.reorg]: (lc) => {
      lc.status = TX_STATES.reorged;
    },
  },
  [TX_STATES.reorged]: { [TX_EVENTS.submit]: (lc) => beginSubmit(lc) },
  [TX_STATES.rejected]: { [TX_EVENTS.submit]: (lc) => beginSubmit(lc) },
  [TX_STATES.failed]: { [TX_EVENTS.submit]: (lc) => beginSubmit(lc) },
  [TX_STATES.reverted]: { [TX_EVENTS.submit]: (lc) => beginSubmit(lc) },
  [TX_STATES.replaced]: {},
};

const TX_STATE_META = Object.freeze({
  [TX_STATES.idle]: {
    title: "Ready to submit",
    message: "Review the route and submit when ready.",
    terminal: false,
    alert: false,
    live: false,
  },
  [TX_STATES.submitting]: {
    title: "Confirm in your wallet",
    message: "Approve the transaction in your wallet.",
    terminal: false,
    alert: false,
    live: true,
  },
  [TX_STATES.pending]: {
    title: "Transaction pending",
    message: "Waiting for the transaction to be mined",
    terminal: false,
    alert: false,
    live: true,
  },
  [TX_STATES.confirming]: {
    title: "Confirming transaction",
    message: "Confirming",
    terminal: false,
    alert: false,
    live: true,
  },
  [TX_STATES.confirmed]: {
    title: "Transaction confirmed",
    message: "Your transaction was confirmed.",
    terminal: true,
    alert: false,
    live: false,
  },
  [TX_STATES.replaced]: {
    title: "Transaction replaced",
    message: "This transaction was replaced by a newer one",
    terminal: true,
    alert: true,
    live: false,
  },
  [TX_STATES.rejected]: {
    title: "Transaction rejected",
    message: "The transaction was rejected.",
    terminal: true,
    alert: true,
    live: false,
  },
  [TX_STATES.reverted]: {
    title: "Transaction reverted",
    message: "The transaction reverted on-chain",
    terminal: true,
    alert: true,
    live: false,
  },
  [TX_STATES.failed]: {
    title: "Transaction failed",
    message: "The transaction failed",
    terminal: true,
    alert: true,
    live: false,
  },
  [TX_STATES.reorged]: {
    title: "Transaction reorged",
    message: "The transaction was removed by a chain reorganization.",
    terminal: true,
    alert: true,
    live: false,
  },
});

function beginSubmit(lc) {
  lc.status = TX_STATES.submitting;
  lc.txHash = null;
  lc.blockNumber = null;
  lc.replacedBy = null;
  lc.error = null;
  lc.attempts += 1;
}

function applyReset(lc) {
  lc.status = TX_STATES.idle;
  lc.txHash = null;
  lc.blockNumber = null;
  lc.replacedBy = null;
  lc.error = null;
}

function record(lifecycle, from, to, type, at, ok) {
  lifecycle.history.push({ from, to, type, at, ok });
  return lifecycle;
}

function nonePlan(shared, reason) {
  return {
    flow: APPROVAL_FLOWS.none,
    required: false,
    reason,
    chainId: shared.chainId,
    sourceType: shared.sourceType,
    poolId: shared.poolId,
    token: null,
    spender: null,
    amount: null,
    permit2: null,
  };
}

function approvalAmount(route) {
  return route.mode === "exact-output" ? route.amounts.limit : route.amounts.input;
}

function describeApprovalDetail(plan, amountLabel) {
  const spend = amountLabel ?? "the required amount";
  switch (plan.flow) {
    case APPROVAL_FLOWS.setwiseRouter:
      return `Approve the Setwise Router to spend ${spend}. The router executes your ${SETWISE_UI_LABEL} pool route.`;
    case APPROVAL_FLOWS.permit2:
      return `Approve Permit2 to spend ${spend}. Permit2 releases the tokens to the Setwise Router.`;
    case APPROVAL_FLOWS.aggregator:
      return `Approve the aggregator to spend ${spend}.`;
    default:
      return `Approve ${spend}.`;
  }
}

function formatAmount(amount, symbol) {
  if (amount == null) return null;
  return symbol ? `${amount} ${symbol}` : amount;
}

function buildCheck(code, passed, message) {
  return { code, passed, severity: passed ? "ok" : "error", message };
}

function buildAccessibility(ariaLabel, role, ariaLive, ariaBusy = false) {
  return { role, ariaLabel, ariaLive, ariaBusy };
}

function isNativeAddress(address) {
  return sameAddress(address, NATIVE_TOKEN_ADDRESS);
}

function sameAddress(a, b) {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

function isAddressLike(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function toBigInt(value) {
  if (value == null) return null;
  try {
    return BigInt(String(value));
  } catch {
    return null;
  }
}

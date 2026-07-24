import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { NATIVE_TOKEN_ADDRESS, SETWISE_UI_LABEL } from "../src/constants.js";
import {
  APPROVAL_FLOWS,
  PREFLIGHT_CHECKS,
  TX_EVENTS,
  TX_STATES,
  approvalMatchesRoute,
  buildExecutableRoute,
  canResubmit,
  canSubmitExecution,
  createTxLifecycle,
  describeApprovalRequest,
  describePreflightResult,
  describeTxState,
  invalidateTx,
  resolveApprovalFlow,
  runPreflightChecks,
  submitExecution,
  transitionTx,
} from "../src/execution.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const NOW = "2026-07-22T20:00:00.000Z";

const ROUTER = "0x0000000000000000000000000000000000000033";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const AGGREGATOR = "0x0000000000001fF3684f28c67538d4D072C22734";
const TOKEN = "0x0000000000000000000000000000000000000011";
const ACCOUNT = "0xAbC0000000000000000000000000000000000001";

const CONTRACTS = { router: ROUTER, permit2: PERMIT2 };

function loadFirmResponse() {
  return JSON.parse(
    readFileSync(join(root, "services/quote/fixtures/v1/firm.response.json"), "utf8"),
  );
}

function validRoute(overrides = {}) {
  return {
    chainId: 8453,
    quoteId: "req_firm_01",
    kind: "firm",
    mode: "exact-input",
    sourceType: "setwise",
    sourceId: "set-bstock-ai",
    poolId: "bstock-ai",
    inputToken: TOKEN,
    amounts: { input: "1000000", output: "2510000", limit: "2497450" },
    approvalTarget: { chainId: 8453, address: ROUTER },
    transaction: { chainId: 8453, to: ROUTER, calldata: "0x1234", value: "0" },
    expiresAt: "2026-07-22T20:01:00.000Z",
    ...overrides,
  };
}

function matchingWallet(overrides = {}) {
  return { chainId: 8453, account: ACCOUNT, ...overrides };
}

function sufficientChain(overrides = {}) {
  return { blockNumber: 100, balance: "2000000", allowance: "1000000", ...overrides };
}

function passingPreflight(route = validRoute(), wallet = matchingWallet(), chain = sufficientChain()) {
  return runPreflightChecks(route, wallet, chain, { now: NOW, contracts: CONTRACTS });
}

test("buildExecutableRoute normalizes a firm quote response", () => {
  const response = loadFirmResponse();
  const route = buildExecutableRoute(response, { inputToken: TOKEN });
  assert.equal(route.chainId, 8453);
  assert.equal(route.quoteId, "req_firm_01");
  assert.equal(route.kind, "firm");
  assert.equal(route.sourceType, "setwise");
  assert.equal(route.poolId, "bstock-ai");
  assert.equal(route.inputToken, TOKEN);
  assert.equal(route.amounts.input, "1000000");
  assert.equal(route.approvalTarget.address, ROUTER);
  assert.equal(route.transaction.to, ROUTER);
  assert.equal(buildExecutableRoute({ ...response, selectedSourceId: "missing" }), null);
});

test("resolveApprovalFlow skips approval for native input", () => {
  const route = validRoute({ inputToken: NATIVE_TOKEN_ADDRESS, approvalTarget: null });
  const plan = resolveApprovalFlow(route, CONTRACTS);
  assert.equal(plan.flow, APPROVAL_FLOWS.none);
  assert.equal(plan.required, false);
  assert.equal(plan.reason, "native-input");
  assert.equal(plan.spender, null);
});

test("resolveApprovalFlow distinguishes router, permit2, and aggregator spenders", () => {
  const routerPlan = resolveApprovalFlow(validRoute(), CONTRACTS);
  assert.equal(routerPlan.flow, APPROVAL_FLOWS.setwiseRouter);
  assert.equal(routerPlan.spender, ROUTER);

  const permit2Plan = resolveApprovalFlow(
    validRoute({ approvalTarget: { chainId: 8453, address: PERMIT2 } }),
    CONTRACTS,
  );
  assert.equal(permit2Plan.flow, APPROVAL_FLOWS.permit2);
  assert.equal(permit2Plan.permit2.spender, ROUTER);

  const aggregatorPlan = resolveApprovalFlow(
    validRoute({
      sourceType: "aggregator",
      approvalTarget: { chainId: 8453, address: AGGREGATOR },
    }),
    CONTRACTS,
  );
  assert.equal(aggregatorPlan.flow, APPROVAL_FLOWS.aggregator);
  assert.equal(aggregatorPlan.spender, AGGREGATOR);
  assert.equal(aggregatorPlan.permit2, null);
});

test("resolveApprovalFlow approves the max sent for exact-output routes", () => {
  const route = validRoute({ mode: "exact-output" });
  const plan = resolveApprovalFlow(route, CONTRACTS);
  assert.equal(plan.amount, route.amounts.limit);
});

test("approvalMatchesRoute enforces the selected executable route target", () => {
  const route = validRoute();
  const plan = resolveApprovalFlow(route, CONTRACTS);
  assert.equal(approvalMatchesRoute(plan, route), true);

  const tampered = validRoute({
    approvalTarget: { chainId: 8453, address: AGGREGATOR },
  });
  assert.equal(approvalMatchesRoute(plan, tampered), false);

  const wrongChain = validRoute({
    approvalTarget: { chainId: 1, address: ROUTER },
  });
  assert.equal(approvalMatchesRoute(plan, wrongChain), false);
});

test("describeApprovalRequest uses Set branding and retains internal poolId", () => {
  const route = validRoute();
  const plan = resolveApprovalFlow(route, CONTRACTS);
  const view = describeApprovalRequest(plan, { tokenSymbol: "USDC" });
  assert.equal(view.required, true);
  assert.equal(view.flowLabel, "Setwise Router approval");
  assert.equal(view.targetLabel, "0x0000…0033");
  assert.equal(view.amountLabel, "1000000 USDC");
  assert.match(view.detail, new RegExp(SETWISE_UI_LABEL));
  assert.equal(plan.poolId, "bstock-ai");
  assert.doesNotMatch(view.detail, /bstock-ai/);
});

test("runPreflightChecks passes with a consistent wallet, chain, and quote", () => {
  const result = passingPreflight();
  assert.equal(result.passed, true);
  assert.equal(result.failures.length, 0);
  const codes = result.checks.map((entry) => entry.code);
  assert.ok(codes.includes(PREFLIGHT_CHECKS.chainMatch));
  assert.ok(codes.includes(PREFLIGHT_CHECKS.allowance));
  assert.ok(codes.includes(PREFLIGHT_CHECKS.balance));
});

test("runPreflightChecks fails closed on wallet, balance, allowance, and expiry", () => {
  assert.equal(passingPreflight(validRoute(), matchingWallet({ chainId: 1 })).passed, false);
  assert.equal(passingPreflight(validRoute(), matchingWallet({ account: null })).passed, false);
  assert.equal(passingPreflight(validRoute(), matchingWallet(), sufficientChain({ balance: "5" })).passed, false);
  assert.equal(passingPreflight(validRoute(), matchingWallet(), sufficientChain({ allowance: "5" })).passed, false);
  assert.equal(
    passingPreflight(validRoute({ expiresAt: "2026-07-22T19:00:00.000Z" })).passed,
    false,
  );
  assert.equal(passingPreflight(validRoute({ kind: "indicative" })).passed, false);
});

test("runPreflightChecks revalidates quote identity and simulation outcome", () => {
  const route = validRoute();
  const wallet = matchingWallet();
  const chain = sufficientChain();

  const identityFail = runPreflightChecks(route, wallet, chain, {
    now: NOW,
    contracts: CONTRACTS,
    expectedQuoteId: "a-different-quote",
  });
  assert.equal(identityFail.passed, false);
  assert.ok(identityFail.failures.some((f) => f.code === PREFLIGHT_CHECKS.quoteIdentity));

  const simulationFail = runPreflightChecks(route, wallet, chain, {
    now: NOW,
    contracts: CONTRACTS,
    simulation: { success: false, message: "execution reverted" },
  });
  assert.equal(simulationFail.passed, false);
  assert.ok(simulationFail.failures.some((f) => f.code === PREFLIGHT_CHECKS.simulation));

  const simulationOk = runPreflightChecks(route, wallet, chain, {
    now: NOW,
    contracts: CONTRACTS,
    simulation: { success: true },
  });
  assert.equal(simulationOk.passed, true);
  assert.equal(simulationOk.simulationRan, true);
});

test("describePreflightResult surfaces failures with alert semantics", () => {
  const failed = describePreflightResult(passingPreflight(validRoute(), matchingWallet({ chainId: 1 })));
  assert.equal(failed.passed, false);
  assert.equal(failed.accessibility.role, "alert");
  assert.equal(failed.accessibility.ariaLive, "assertive");
  assert.ok(failed.failures.length > 0);

  const ok = describePreflightResult(passingPreflight());
  assert.equal(ok.passed, true);
  assert.equal(ok.title, "Ready to submit");
});

test("canSubmitExecution disables submission when preflight fails or context changes", () => {
  const route = validRoute();
  const wallet = matchingWallet();
  const preflight = passingPreflight(route, wallet);
  assert.equal(canSubmitExecution(route, wallet, preflight, { now: NOW }), true);

  const failedPreflight = passingPreflight(route, matchingWallet({ chainId: 1 }));
  assert.equal(canSubmitExecution(route, wallet, failedPreflight, { now: NOW }), false);

  assert.equal(canSubmitExecution(route, matchingWallet({ chainId: 1 }), preflight, { now: NOW }), false);
  assert.equal(canSubmitExecution(route, matchingWallet({ account: null }), preflight, { now: NOW }), false);
  assert.equal(
    canSubmitExecution(validRoute({ expiresAt: "2026-07-22T19:00:00.000Z" }), wallet, preflight, { now: NOW }),
    false,
  );
  assert.equal(
    canSubmitExecution(route, wallet, preflight, { now: NOW, expectedQuoteId: "other" }),
    false,
  );
});

test("submitExecution refuses to advance when preflight has failed", () => {
  const route = validRoute();
  const wallet = matchingWallet({ chainId: 1 });
  const preflight = runPreflightChecks(route, wallet, sufficientChain(), {
    now: NOW,
    contracts: CONTRACTS,
  });
  const lifecycle = createTxLifecycle();
  const outcome = submitExecution(lifecycle, { route, wallet, preflight, options: { now: NOW } });
  assert.equal(outcome.allowed, false);
  assert.equal(lifecycle.status, TX_STATES.idle);
  assert.equal(lifecycle.attempts, 0);
});

test("transaction lifecycle covers the happy path to confirmation", () => {
  const lc = createTxLifecycle();
  transitionTx(lc, { type: TX_EVENTS.submit });
  assert.equal(lc.status, TX_STATES.submitting);
  assert.equal(lc.attempts, 1);

  transitionTx(lc, { type: TX_EVENTS.hash, txHash: "0xabc" });
  assert.equal(lc.status, TX_STATES.pending);
  assert.equal(lc.txHash, "0xabc");

  transitionTx(lc, { type: TX_EVENTS.mined, blockNumber: 101 });
  assert.equal(lc.status, TX_STATES.confirming);
  assert.equal(lc.blockNumber, 101);

  transitionTx(lc, { type: TX_EVENTS.confirmed });
  assert.equal(lc.status, TX_STATES.confirmed);
  assert.equal(describeTxState(lc).terminal, true);
});

test("transaction lifecycle handles replacement from pending and confirming", () => {
  const pending = createTxLifecycle();
  transitionTx(pending, { type: TX_EVENTS.submit });
  transitionTx(pending, { type: TX_EVENTS.hash, txHash: "0xold" });
  transitionTx(pending, { type: TX_EVENTS.replaced, replacedBy: "0xnew" });
  assert.equal(pending.status, TX_STATES.replaced);
  assert.equal(pending.replacedBy, "0xnew");
  assert.equal(canResubmit(pending), false);

  const confirming = createTxLifecycle();
  transitionTx(confirming, { type: TX_EVENTS.submit });
  transitionTx(confirming, { type: TX_EVENTS.hash, txHash: "0xold" });
  transitionTx(confirming, { type: TX_EVENTS.mined, blockNumber: 5 });
  transitionTx(confirming, { type: TX_EVENTS.replaced, replacedBy: "0xnewer" });
  assert.equal(confirming.status, TX_STATES.replaced);
});

test("transaction lifecycle handles reorg with resubmission", () => {
  const lc = createTxLifecycle();
  transitionTx(lc, { type: TX_EVENTS.submit });
  transitionTx(lc, { type: TX_EVENTS.hash, txHash: "0xabc" });
  transitionTx(lc, { type: TX_EVENTS.mined, blockNumber: 101 });
  transitionTx(lc, { type: TX_EVENTS.confirmed });
  transitionTx(lc, { type: TX_EVENTS.reorg });
  assert.equal(lc.status, TX_STATES.reorged);
  assert.equal(canResubmit(lc), true);
  assert.match(describeTxState(lc).message, /Resubmit/i);

  transitionTx(lc, { type: TX_EVENTS.submit });
  assert.equal(lc.status, TX_STATES.submitting);
  assert.equal(lc.attempts, 2);
  assert.equal(lc.txHash, null);
});

test("transaction lifecycle handles rejection, revert, and invalid transitions", () => {
  const rejected = createTxLifecycle();
  transitionTx(rejected, { type: TX_EVENTS.submit });
  transitionTx(rejected, { type: TX_EVENTS.rejected });
  assert.equal(rejected.status, TX_STATES.rejected);
  assert.equal(canResubmit(rejected), true);

  const reverted = createTxLifecycle();
  transitionTx(reverted, { type: TX_EVENTS.submit });
  transitionTx(reverted, { type: TX_EVENTS.hash, txHash: "0xabc" });
  transitionTx(reverted, { type: TX_EVENTS.mined, blockNumber: 9 });
  transitionTx(reverted, { type: TX_EVENTS.reverted, blockNumber: 9 });
  assert.equal(reverted.status, TX_STATES.reverted);
  assert.equal(canResubmit(reverted), true);

  const idle = createTxLifecycle();
  transitionTx(idle, { type: TX_EVENTS.confirmed });
  assert.equal(idle.status, TX_STATES.idle);
  const last = idle.history[idle.history.length - 1];
  assert.equal(last.ok, false);
});

test("invalidateTx fails an in-flight transaction but not a confirmed one", () => {
  const inflight = createTxLifecycle();
  transitionTx(inflight, { type: TX_EVENTS.submit });
  transitionTx(inflight, { type: TX_EVENTS.hash, txHash: "0xabc" });
  invalidateTx(inflight, "Wallet account changed.");
  assert.equal(inflight.status, TX_STATES.failed);
  assert.equal(inflight.error, "Wallet account changed.");

  const confirmed = createTxLifecycle();
  transitionTx(confirmed, { type: TX_EVENTS.submit });
  transitionTx(confirmed, { type: TX_EVENTS.hash, txHash: "0xabc" });
  transitionTx(confirmed, { type: TX_EVENTS.mined, blockNumber: 1 });
  transitionTx(confirmed, { type: TX_EVENTS.confirmed });
  invalidateTx(confirmed, "Wallet account changed.");
  assert.equal(confirmed.status, TX_STATES.confirmed);
});

test("describeTxState reports accessible pending and failure states", () => {
  const lc = createTxLifecycle();
  transitionTx(lc, { type: TX_EVENTS.submit });
  transitionTx(lc, { type: TX_EVENTS.hash, txHash: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" });
  const pending = describeTxState(lc);
  assert.equal(pending.accessibility.ariaLive, "polite");
  assert.match(pending.message, /0xabcd/);

  transitionTx(lc, { type: TX_EVENTS.error, message: "rpc failed" });
  const failed = describeTxState(lc);
  assert.equal(failed.accessibility.role, "alert");
  assert.equal(failed.accessibility.ariaLive, "assertive");
  assert.match(failed.message, /rpc failed/);
});

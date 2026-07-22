import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_LEVELS,
  GOVERNANCE_ROLES,
  TIMELOCK_BOUNDS,
  buildControlChangeAlert,
  checkRouteEligibility,
  describeGovernanceState,
  describeTimelockOperation,
  formatGovernanceAddress,
} from "../src/governance.js";

function makeState(overrides = {}) {
  return {
    owner: "0x5AFE000000000000000000000000000000000001",
    pendingOwner: null,
    emergencyGuardian: "0x600D000000000000000000000000000000000002",
    paused: false,
    disabledChains: [],
    disabledSources: [],
    ...overrides,
  };
}

test("constants expose expected roles, levels, and bounds", () => {
  assert.deepEqual(Object.keys(GOVERNANCE_ROLES), ["owner", "pendingOwner", "emergencyGuardian", "proposer"]);
  assert.deepEqual(Object.keys(CONTROL_LEVELS), ["global", "chain", "source"]);
  assert.equal(TIMELOCK_BOUNDS.MIN_DELAY_SECONDS, 3600);
  assert.equal(TIMELOCK_BOUNDS.MAX_DELAY_SECONDS, 2592000);
  assert.equal(TIMELOCK_BOUNDS.GRACE_PERIOD_SECONDS, 1209600);
});

test("describeGovernanceState reports ok when unrestricted", () => {
  const result = describeGovernanceState(makeState());
  assert.equal(result.severity, "ok");
  assert.match(result.title, /operational/i);
});

test("describeGovernanceState reports critical when paused", () => {
  const result = describeGovernanceState(makeState({ paused: true }));
  assert.equal(result.severity, "critical");
  assert.match(result.title, /paused/i);
});

test("describeGovernanceState reports warning for disabled chains", () => {
  const result = describeGovernanceState(makeState({ disabledChains: [1, 56] }));
  assert.equal(result.severity, "warning");
  assert.match(result.description, /2 chain/);
});

test("describeGovernanceState reports warning for disabled sources", () => {
  const result = describeGovernanceState(
    makeState({ disabledSources: [{ chainId: 1, sourceId: "setwise" }] }),
  );
  assert.equal(result.severity, "warning");
  assert.match(result.description, /1 source/);
});

test("checkRouteEligibility passes when no restrictions", () => {
  const { eligible, reason } = checkRouteEligibility(makeState(), 1, "setwise");
  assert.equal(eligible, true);
  assert.equal(reason, null);
});

test("checkRouteEligibility blocks when paused", () => {
  const { eligible, reason } = checkRouteEligibility(makeState({ paused: true }), 1, "setwise");
  assert.equal(eligible, false);
  assert.match(reason, /paused/i);
});

test("checkRouteEligibility blocks disabled chain", () => {
  const { eligible, reason } = checkRouteEligibility(makeState({ disabledChains: [56] }), 56, "setwise");
  assert.equal(eligible, false);
  assert.match(reason, /Chain 56/);
});

test("checkRouteEligibility blocks disabled source only on that chain", () => {
  const state = makeState({ disabledSources: [{ chainId: 1, sourceId: "setwise" }] });

  const blocked = checkRouteEligibility(state, 1, "setwise");
  assert.equal(blocked.eligible, false);

  const otherChain = checkRouteEligibility(state, 56, "setwise");
  assert.equal(otherChain.eligible, true);

  const otherSource = checkRouteEligibility(state, 1, "uniswapV3");
  assert.equal(otherSource.eligible, true);
});

test("describeTimelockOperation reports pending with remaining time", () => {
  const op = { readyAt: 2000, deadline: 5000, state: "pending" };
  const result = describeTimelockOperation(op, 1500);
  assert.equal(result.actionable, false);
  assert.equal(result.expired, false);
  assert.match(result.label, /500s remaining/);
});

test("describeTimelockOperation reports ready to execute", () => {
  const op = { readyAt: 2000, deadline: 5000, state: "pending" };
  const result = describeTimelockOperation(op, 2500);
  assert.equal(result.actionable, true);
  assert.match(result.label, /Ready/i);
});

test("describeTimelockOperation reports expired", () => {
  const op = { readyAt: 2000, deadline: 5000, state: "pending" };
  const result = describeTimelockOperation(op, 6000);
  assert.equal(result.expired, true);
  assert.equal(result.actionable, false);
});

test("describeTimelockOperation reports executed and cancelled", () => {
  assert.equal(describeTimelockOperation({ readyAt: 0, deadline: 0, state: "executed" }, 0).label, "Executed");
  assert.equal(describeTimelockOperation({ readyAt: 0, deadline: 0, state: "cancelled" }, 0).label, "Cancelled");
});

test("formatGovernanceAddress masks middle characters", () => {
  assert.equal(formatGovernanceAddress("0x5AFE000000000000000000000000000000000001"), "0x5AFE…0001");
});

test("formatGovernanceAddress returns None for zero address", () => {
  assert.equal(formatGovernanceAddress("0x0000000000000000000000000000000000000000"), "None");
  assert.equal(formatGovernanceAddress(null), "None");
});

test("buildControlChangeAlert produces monitoring payload", () => {
  const alert = buildControlChangeAlert("ChainDisabled", { chainId: 56, caller: "0xabc" });
  assert.equal(alert.alert, "governance:ChainDisabled");
  assert.equal(alert.eventType, "ChainDisabled");
  assert.equal(alert.params.chainId, 56);
  assert.equal(typeof alert.timestamp, "number");
});

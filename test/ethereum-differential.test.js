import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSnapshots,
  compareSnapshots,
  loadDifferentialInputs,
  validateManifest,
} from "../scripts/lib/ethereum-differential.mjs";

const inputs = loadDifferentialInputs();

function compare(upstream, setwise, allowlist = inputs.allowlist, gasPolicy = inputs.manifest.gasPolicy) {
  return compareSnapshots(upstream, setwise, allowlist, gasPolicy);
}

test("Ethereum differential manifest is pinned and covers every preserved route category", () => {
  assert.deepEqual(validateManifest(inputs), []);
  assert.equal(inputs.manifest.fork.chainId, 1);
  assert.equal(inputs.manifest.fork.block, 24_880_000);
  assert.deepEqual(
    new Set(inputs.manifest.requiredCategories),
    new Set(["direct", "two-hop", "three-hop", "split", "hybrid", "curve", "lido", "zamm", "native"]),
  );
});

test("Setwise compatibility results match the pinned ZFi oracle", () => {
  const snapshots = buildSnapshots(inputs);
  const result = compare(snapshots.upstream, snapshots.setwise);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.ok(result.gas.length >= 3, "expected quote, execution, and Lido gas samples");
  assert.equal(result.allowlisted, 0);
});

test("unexplained calldata, output, source, recipient, and revert differences fail", () => {
  const fields = [
    ["direct-quote-and-calldata", "requestCalldata", "0xdeadbeef"],
    ["direct-quote-and-calldata", "amounts", { amountIn: "1", amountOut: "2" }],
    ["direct-quote-and-calldata", "selectedSources", ["7"]],
    ["direct-recipient-balance", "recipientDelta", "0"],
    ["revert-no-route", "revert", { selector: "0x00000000", name: null }],
  ];
  for (const [caseId, field, value] of fields) {
    const { upstream, setwise } = buildSnapshots(inputs);
    setwise[caseId][field] = value;
    const result = compare(upstream, setwise);
    assert.equal(result.ok, false, `${caseId}.${field} should fail`);
    assert.ok(result.errors.some((error) => error.startsWith(`${caseId}.${field}:`)));
  }
});

test("an exact reviewed allowlist entry permits only its documented difference", () => {
  const { upstream, setwise } = buildSnapshots(inputs);
  setwise["direct-recipient-balance"].recipientDelta = "1";
  const allowlist = {
    schema: inputs.allowlist.schema,
    deviations: [
      {
        caseId: "direct-recipient-balance",
        field: "recipientDelta",
        upstream: upstream["direct-recipient-balance"].recipientDelta,
        setwise: "1",
        rationale: "The Setwise recipient accounting intentionally excludes a documented rebate.",
        approvedBy: "router-reviewers",
        approvedAt: "2026-07-23T00:00:00Z",
      },
    ],
  };
  assert.equal(compare(upstream, setwise, allowlist).ok, true);

  setwise["direct-recipient-balance"].recipientDelta = "2";
  const changed = compare(upstream, setwise, allowlist);
  assert.equal(changed.ok, false, "an allowlist entry cannot cover a different result");
  assert.ok(changed.errors.some((error) => error.includes("stale allowlist entry")));
});

test("stale, wildcard, or unreviewed allowlist entries fail", () => {
  const { upstream, setwise } = buildSnapshots(inputs);
  const base = {
    caseId: "direct-quote-and-calldata",
    field: "amounts",
    upstream: upstream["direct-quote-and-calldata"].amounts,
    setwise: setwise["direct-quote-and-calldata"].amounts,
    rationale: "This is deliberately long enough to explain the reviewed difference.",
    approvedBy: "router-reviewers",
    approvedAt: "2026-07-23T00:00:00Z",
  };
  assert.equal(compare(upstream, setwise, { deviations: [base] }).ok, false, "stale entry");
  assert.throws(
    () => compare(upstream, setwise, { deviations: [{ ...base, field: "*" }] }),
    /wildcards/,
  );
  assert.throws(
    () => compare(upstream, setwise, { deviations: [{ ...base, rationale: "short" }] }),
    /rationale/,
  );
});

test("gas regressions are reported and policy-gated", () => {
  const { upstream, setwise } = buildSnapshots(inputs);
  const caseId = "direct-quote-and-calldata";
  setwise[caseId].gas = Math.ceil(upstream[caseId].gas * 1.06);
  const warning = compare(upstream, setwise);
  assert.equal(warning.ok, true);
  assert.equal(warning.warnings.length, 1);

  setwise[caseId].gas = Math.ceil(upstream[caseId].gas * 1.16);
  const failure = compare(upstream, setwise);
  assert.equal(failure.ok, false);
  assert.ok(failure.errors.some((error) => error.includes(".gas:")));
});

test("fork fixture refresh refuses implicit writes", async () => {
  const source = await import("node:fs").then(({ readFileSync }) =>
    readFileSync(new URL("../scripts/capture-execution-fixtures.mjs", import.meta.url), "utf8"),
  );
  assert.match(source, /process\.argv\.includes\("--write"\)/);
  assert.match(source, /Refusing to refresh the pinned fork fixture/);
});

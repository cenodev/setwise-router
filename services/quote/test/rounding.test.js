import assert from "node:assert/strict";
import test from "node:test";

import { mulDivCeil, mulDivFloor, slippageLimit } from "../src/index.js";

test("mulDivFloor truncates toward zero and mulDivCeil rounds up", () => {
  // 10 / 4 = 2.5 → floor 2, ceil 3.
  assert.equal(mulDivFloor(10, 1, 4), "2");
  assert.equal(mulDivCeil(10, 1, 4), "3");
  // Exact divisions agree.
  assert.equal(mulDivFloor(10, 1, 5), "2");
  assert.equal(mulDivCeil(10, 1, 5), "2");
});

test("mulDiv accepts canonical strings and bigints interchangeably", () => {
  assert.equal(mulDivFloor("1000000000000000000", "9950", "10000"), "995000000000000000");
  assert.equal(mulDivCeil(1_000_000n, 10_050n, 10_000n), "1005000");
});

test("mulDiv rejects zero divisors and malformed amounts", () => {
  assert.throws(() => mulDivFloor(1, 1, 0), /divisor/);
  assert.throws(() => mulDivCeil("01", 1, 2), /canonical unsigned integer/);
  assert.throws(() => mulDivFloor(-1, 1, 2), /canonical unsigned integer/);
});

test("exact-input limit floors the minimum acceptable output", () => {
  // 2_510_000 * 9950 / 10000 = 2_497_450 exactly.
  assert.equal(slippageLimit("exact-input", "2510000", 50), "2497450");
  // 1_000_001 * 9950 / 10000 = 995_000.995 → floor 995_000 (never over-promises output).
  assert.equal(slippageLimit("exact-input", "1000001", 50), "995000");
});

test("exact-output limit ceils the maximum acceptable input", () => {
  // 1_005_000 * 10050 / 10000 = 1_010_025 exactly.
  assert.equal(slippageLimit("exact-output", "1005000", 50), "1010025");
  // 1_000_001 * 10050 / 10000 = 1_005_001.005 → ceil 1_005_002.
  // A floor here (1_005_001) would sit below the required input and revert:
  // the ceil is what prevents exact-output phantom liquidity.
  assert.equal(slippageLimit("exact-output", "1000001", 50), "1005002");
});

test("the exact-output ceil is never below the unrounded requirement", () => {
  for (const input of ["1", "999", "1000001", "123456789", "999999999999999999"]) {
    for (const bps of [0, 1, 50, 137, 10000]) {
      const limit = BigInt(slippageLimit("exact-output", input, bps));
      const required = (BigInt(input) * (10_000n + BigInt(bps))) / 10_000n;
      assert.ok(limit >= required, `limit ${limit} < required ${required}`);
    }
  }
});

test("the exact-input floor is never above the unrounded protection", () => {
  for (const output of ["1", "999", "1000001", "123456789", "999999999999999999"]) {
    for (const bps of [0, 1, 50, 137, 10000]) {
      const limit = BigInt(slippageLimit("exact-input", output, bps));
      const protected_ = (BigInt(output) * (10_000n - BigInt(bps)) + 9_999n) / 10_000n;
      assert.ok(limit <= protected_, `limit ${limit} > protected ${protected_}`);
    }
  }
});

test("zero slippage returns the amount unchanged", () => {
  assert.equal(slippageLimit("exact-input", "123456789", 0), "123456789");
  assert.equal(slippageLimit("exact-output", "123456789", 0), "123456789");
});

test("rejects out-of-range slippage and unknown modes", () => {
  assert.throws(() => slippageLimit("exact-input", "1", -1), /maxBps/);
  assert.throws(() => slippageLimit("exact-input", "1", 10_001), /maxBps/);
  assert.throws(() => slippageLimit("exact-input", "1", 1.5), /maxBps/);
  assert.throws(() => slippageLimit("bogus", "1", 50), /mode/);
});

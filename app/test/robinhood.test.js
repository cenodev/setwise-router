import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCanonicalRobinhoodToken,
  isCanonicalRobinhoodStockToken,
  loadRobinhoodCanonicalMetadata,
} from "../src/robinhood.js";
import { ROBINHOOD_TOKEN_SOURCE } from "../src/constants.js";

test("Robinhood canonical metadata cites the official contracts page", () => {
  const metadata = loadRobinhoodCanonicalMetadata();
  assert.equal(metadata.source, ROBINHOOD_TOKEN_SOURCE);
  assert.equal(metadata.chainId, 4663);
  assert.ok(metadata.stockTokens.length > 0);
});

test("canonical Robinhood stock tokens are recognized by registry snapshot", () => {
  const metadata = loadRobinhoodCanonicalMetadata();
  const nvda = metadata.stockTokens.find((token) => token.symbol === "NVDA");
  assert.ok(nvda);
  assert.equal(isCanonicalRobinhoodStockToken(nvda), true);
  assert.doesNotThrow(() => assertCanonicalRobinhoodToken(nvda));
});

test("non-canonical lookalike tickers are rejected", () => {
  assert.equal(
    isCanonicalRobinhoodStockToken({
      symbol: "NVDA",
      name: "Fake NVDA",
      address: "0x0000000000000000000000000000000000000001",
    }),
    false,
  );
});

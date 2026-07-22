import assert from "node:assert/strict";
import test from "node:test";

import { supportedChainIds } from "../../config/index.mjs";
import { NATIVE_TOKEN_ADDRESS } from "../src/constants.js";
import {
  formatTokenLabel,
  getNativeAssets,
  resolveQuoteTokenAddress,
} from "../src/native.js";
import {
  findToken,
  getTokensForChain,
  isTokenOnChain,
  loadTokenList,
  TokenListError,
  validateTokenList,
} from "../src/tokens.js";

const SUPPORTED = supportedChainIds();

test("each supported chain loads a validated token list", () => {
  for (const chainId of SUPPORTED) {
    const list = loadTokenList(chainId);
    assert.equal(list.chainId, chainId);
    assert.ok(list.tokens.length > 0);
  }
});

test("tokens never leak across chains", () => {
  const ethUsdc = findToken(1, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
  assert.ok(ethUsdc);
  assert.equal(findToken(8453, ethUsdc.address), undefined);
  assert.throws(() => validateTokenList({
    chainId: 1,
    tokens: [{ ...ethUsdc, chainId: 8453 }],
  }, 1), TokenListError);
});

test("native and wrapped-native assets match chain registry metadata", () => {
  const { native, wrapped } = getNativeAssets(56);
  assert.equal(native.symbol, "BNB");
  assert.equal(native.address, NATIVE_TOKEN_ADDRESS);
  assert.equal(wrapped?.symbol, "WBNB");

  const list = getTokensForChain(56);
  assert.ok(list.some((token) => token.kind === "native"));
  assert.ok(list.some((token) => token.kind === "wrapped-native"));
});

test("native assets label and resolve wrapped addresses for quotes", () => {
  const eth = getNativeAssets(1).native;
  assert.equal(formatTokenLabel(eth), "ETH");
  assert.equal(
    resolveQuoteTokenAddress(eth, { useWrappedNative: true }),
    "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  );
});

test("isTokenOnChain only accepts tokens from the active list", () => {
  const baseUsdc = findToken(8453, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  assert.ok(baseUsdc);
  assert.equal(isTokenOnChain(baseUsdc, 8453), true);
  assert.equal(isTokenOnChain(baseUsdc, 1), false);
});

test("Robinhood token list includes canonical stock tokens", () => {
  const nvda = findToken(4663, "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC");
  assert.equal(nvda?.kind, "robinhood-stock");
  assert.match(nvda?.name ?? "", /Robinhood Token/);
});

test("supportedChainIds matches token list coverage", () => {
  assert.deepEqual(supportedChainIds(), SUPPORTED);
});

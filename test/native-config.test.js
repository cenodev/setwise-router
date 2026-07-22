import assert from "node:assert/strict";
import test from "node:test";

import {
  NATIVE_TOKEN_SENTINEL,
  isNativeAsset,
  getNativeConfig,
  requireWrappedNative,
  resolveNativeAsset,
} from "../config/index.mjs";
import { UnsupportedChainError } from "../config/registry.mjs";

// Canonical native / wrapped-native pairs per target chain, as selected from the
// verified chain configuration (no hardcoded WETH/WBNB downstream).
const EXPECTED = {
  1: {
    native: { symbol: "ETH", decimals: 18 },
    wrapped: { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
    verified: true,
  },
  56: {
    native: { symbol: "BNB", decimals: 18 },
    wrapped: { symbol: "WBNB", address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" },
    verified: true,
  },
  8453: {
    native: { symbol: "ETH", decimals: 18 },
    wrapped: { symbol: "WETH", address: "0x4200000000000000000000000000000000000006" },
    verified: true,
  },
  4663: {
    native: { symbol: "ETH", decimals: 18 },
    wrapped: { symbol: "WETH", address: null },
    verified: false,
  },
};

test("native sentinel is the canonical zero address", () => {
  assert.equal(NATIVE_TOKEN_SENTINEL, "0x0000000000000000000000000000000000000000");
  assert.ok(isNativeAsset(NATIVE_TOKEN_SENTINEL));
  assert.ok(isNativeAsset("0x0000000000000000000000000000000000000000".toUpperCase().replace("0X", "0x")));
  assert.ok(!isNativeAsset("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"));
  assert.ok(!isNativeAsset(undefined));
});

test("native behavior is selected from verified chain configuration on every target chain", () => {
  for (const [chainId, expected] of Object.entries(EXPECTED)) {
    const cfg = getNativeConfig(Number(chainId));
    assert.equal(cfg.chainId, Number(chainId), `chainId ${chainId}`);
    assert.equal(cfg.native.symbol, expected.native.symbol, `${chainId} native symbol`);
    assert.equal(cfg.native.decimals, expected.native.decimals, `${chainId} native decimals`);
    assert.equal(cfg.native.sentinel, NATIVE_TOKEN_SENTINEL, `${chainId} native sentinel`);
    assert.equal(cfg.wrapped.symbol, expected.wrapped.symbol, `${chainId} wrapped symbol`);
    assert.equal(cfg.wrapped.decimals, expected.native.decimals, `${chainId} wrapped decimals`);
    assert.equal(cfg.addressesVerified, expected.verified, `${chainId} addressesVerified`);
    if (expected.wrapped.address === null) {
      assert.equal(cfg.wrapped.address, null, `${chainId} wrapped address null when unverified`);
    } else {
      assert.equal(
        cfg.wrapped.address.toLowerCase(),
        expected.wrapped.address.toLowerCase(),
        `${chainId} wrapped address`,
      );
    }
  }
});

test("ETH/WETH on Ethereum, Base and Robinhood Chain; BNB/WBNB on BSC", () => {
  assert.equal(getNativeConfig(1).wrapped.symbol, "WETH");
  assert.equal(getNativeConfig(8453).wrapped.symbol, "WETH");
  assert.equal(getNativeConfig(4663).wrapped.symbol, "WETH");
  assert.equal(getNativeConfig(56).wrapped.symbol, "WBNB");
  assert.equal(getNativeConfig(56).native.symbol, "BNB");
});

test("resolveNativeAsset maps the sentinel to the chain wrapped-native token", () => {
  assert.equal(
    resolveNativeAsset(1, NATIVE_TOKEN_SENTINEL).toLowerCase(),
    EXPECTED[1].wrapped.address.toLowerCase(),
  );
  assert.equal(
    resolveNativeAsset(56, NATIVE_TOKEN_SENTINEL).toLowerCase(),
    EXPECTED[56].wrapped.address.toLowerCase(),
  );
  assert.equal(
    resolveNativeAsset(8453, NATIVE_TOKEN_SENTINEL).toLowerCase(),
    EXPECTED[8453].wrapped.address.toLowerCase(),
  );
});

test("resolveNativeAsset leaves non-native assets unchanged", () => {
  const usdc = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  assert.equal(resolveNativeAsset(1, usdc), usdc);
});

test("requireWrappedNative throws on an unverified chain", () => {
  assert.throws(() => requireWrappedNative(4663), /no verified wrapped-native address/);
  assert.throws(() => resolveNativeAsset(4663, NATIVE_TOKEN_SENTINEL), /no verified wrapped-native/);
});

test("native config has no implicit fallback for unsupported chains", () => {
  assert.throws(() => getNativeConfig(999), UnsupportedChainError);
  assert.throws(() => resolveNativeAsset(999, NATIVE_TOKEN_SENTINEL), UnsupportedChainError);
});

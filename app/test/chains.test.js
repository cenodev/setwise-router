import assert from "node:assert/strict";
import test from "node:test";

import { supportedChainIds } from "../../config/index.mjs";
import {
  buildAddChainParams,
  getChainOption,
  listSupportedChains,
  requestChainSwitch,
  resolveNetworkState,
} from "../src/chains.js";

const SUPPORTED = supportedChainIds();

test("lists all four supported chains for selection", () => {
  assert.deepEqual(
    listSupportedChains().map((chain) => chain.chainId),
    SUPPORTED,
  );
  assert.equal(getChainOption(8453).displayName, "Base");
});

test("resolveNetworkState reports unsupported wallet networks", () => {
  const state = resolveNetworkState(137);
  assert.equal(state.status, "unsupported");
  assert.equal(state.recoverable, true);
  assert.match(state.message, /Unsupported network/);
});

test("resolveNetworkState reports wrong-chain when selection differs", () => {
  const state = resolveNetworkState(1, 8453);
  assert.equal(state.status, "wrong-chain");
  assert.match(state.message, /Base/);
});

test("resolveNetworkState is ready when wallet matches selection", () => {
  const state = resolveNetworkState(56, 56);
  assert.equal(state.status, "ready");
  assert.equal(state.supported, true);
});

test("buildAddChainParams includes native currency and explorer", () => {
  const params = buildAddChainParams(8453);
  assert.equal(params.chainId, "0x2105");
  assert.equal(params.nativeCurrency.symbol, "ETH");
  assert.ok(params.rpcUrls.length > 0);
  assert.ok(params.blockExplorerUrls.length > 0);
});

test("buildAddChainParams falls back to public RPC for Robinhood Chain", () => {
  const params = buildAddChainParams(4663);
  assert.equal(params.chainName, "Robinhood Chain");
  assert.equal(params.rpcUrls[0], "https://rpc.mainnet.chain.robinhood.com");
});

test("requestChainSwitch succeeds on first switch", async () => {
  const calls = [];
  const wallet = {
    switchChain: async (args) => {
      calls.push(["switch", args]);
    },
    addChain: async (args) => {
      calls.push(["add", args]);
    },
  };

  const result = await requestChainSwitch(wallet, 8453);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [["switch", { chainId: "0x2105" }]]);
});

test("requestChainSwitch adds chain when wallet reports 4902", async () => {
  const calls = [];
  const wallet = {
    switchChain: async (args) => {
      calls.push(["switch", args]);
      if (calls.filter(([type]) => type === "switch").length === 1) {
        const error = new Error("Unrecognized chain");
        error.code = 4902;
        throw error;
      }
    },
    addChain: async (args) => {
      calls.push(["add", args]);
    },
  };

  const result = await requestChainSwitch(wallet, 56);
  assert.equal(result.ok, true);
  assert.equal(result.added, true);
  assert.equal(calls.length, 3);
});

test("requestChainSwitch treats user rejection as recoverable", async () => {
  const wallet = {
    switchChain: async () => {
      const error = new Error("User rejected");
      error.code = 4001;
      throw error;
    },
    addChain: async () => {},
  };

  const result = await requestChainSwitch(wallet, 1);
  assert.equal(result.ok, false);
  assert.equal(result.recoverable, true);
  assert.equal(result.code, "USER_REJECTED");
});

test("requestChainSwitch rejects unsupported chains", async () => {
  const wallet = {
    switchChain: async () => {},
    addChain: async () => {},
  };
  const result = await requestChainSwitch(wallet, 137);
  assert.equal(result.ok, false);
  assert.equal(result.recoverable, false);
});

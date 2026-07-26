import assert from "node:assert/strict";
import test from "node:test";

import { findToken } from "../src/tokens.js";
import {
  TX_EVENTS,
  TX_STATES,
  buildExecutableRoute,
  createTxLifecycle,
  runPreflightChecks,
  submitExecution,
  transitionTx,
} from "../src/execution.js";

const ROUTER = "0x1111111111111111111111111111111111111111";
const ACCOUNT = "0x2222222222222222222222222222222222222222";
const TX_HASH = `0x${"33".repeat(32)}`;
const NOW = "2026-07-26T19:03:57.519Z";

test("BSC testnet dapp flow reaches a confirmed Set swap after faucet funding", () => {
  const input = findToken(97, "0x0827541D8d43Bb891865440B50e6713D4C55be5A");
  const output = findToken(97, "0x75D74Ab8EcFF5215bbad450103ceDF532C23Ae46");
  assert.equal(input?.symbol, "mUSDT");
  assert.equal(output?.symbol, "mbSPCX");

  const response = {
    apiVersion: "v1",
    requestId: "bsc-testnet-canary",
    chainId: 97,
    mode: "exact-input",
    kind: "firm",
    selectedSourceId: "set-bstock-ai-no-bnb-bsc-testnet",
    sources: [
      {
        source: {
          id: "set-bstock-ai-no-bnb-bsc-testnet",
          type: "setwise",
          displayName: "Set",
          poolId: "bstock-ai-no-bnb-bsc-testnet",
        },
        status: "available",
        quote: {
          kind: "firm",
          amounts: {
            input: "10000000000000000000",
            output: "84000000000000000",
            limit: "83580000000000000",
          },
          approvalTarget: { chainId: 97, address: ROUTER },
          expiresAt: "2026-07-26T19:04:57.519Z",
        },
        evidence: [],
      },
    ],
    transaction: {
      chainId: 97,
      to: ROUTER,
      calldata: "0xa6022e95",
      value: "0",
    },
  };

  const route = buildExecutableRoute(response, { inputToken: input.address });
  assert.equal(route.poolId, "bstock-ai-no-bnb-bsc-testnet");
  const wallet = { chainId: 97, account: ACCOUNT };
  const preflight = runPreflightChecks(
    route,
    wallet,
    {
      balance: "1000000000000000000000",
      allowance: "10000000000000000000",
    },
    {
      now: NOW,
      expectedQuoteId: "bsc-testnet-canary",
      contracts: { router: ROUTER, permit2: null },
      simulation: { success: true },
    },
  );
  assert.equal(preflight.passed, true);

  const lifecycle = createTxLifecycle();
  assert.equal(
    submitExecution(lifecycle, {
      route,
      wallet,
      preflight,
      options: { now: NOW, expectedQuoteId: "bsc-testnet-canary" },
    }).allowed,
    true,
  );
  transitionTx(lifecycle, { type: TX_EVENTS.hash, txHash: TX_HASH });
  transitionTx(lifecycle, { type: TX_EVENTS.mined, blockNumber: 121438600 });
  transitionTx(lifecycle, { type: TX_EVENTS.confirmed });
  assert.equal(lifecycle.status, TX_STATES.confirmed);
  assert.equal(lifecycle.txHash, TX_HASH);
});

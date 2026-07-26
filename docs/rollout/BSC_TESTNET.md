# BSC testnet integration runbook

This is the first full Set Router staging environment. User-facing surfaces call
Setwise liquidity **Set**; contract, RFQ, manifest, and service identifiers keep
`pool` and `poolId`.

## Recorded environment

| Component | Value |
| --- | --- |
| Chain | BNB Smart Chain Testnet (`97`) |
| RPC role | `RPC_URL_BSC_TESTNET` |
| Explorer | `https://testnet.bscscan.com` |
| Set `poolId` | `bstock-ai-no-bnb-bsc-testnet` |
| Set proxy | `0xA54D041eD831BBE2D6F97107Ab3aD9f9682C392a` |
| Quote signer | `0x0B37DDA72EbC2E9Cd177D1455139e7355d3a9e50` |
| Mock wrapped BNB | `0x119FF2a8b74dfCE4c378CE4bd2c10201bf47e395` |
| Mock-token faucet | `0x357B4Ba272421de4A0067EF2A830103Afa038F3C` |
| RFQ API | `https://setwise-rfq-api.datadex.workers.dev` |

The source-controlled operational record is
`deployments/bsc-testnet-97.rollout.json`. The canonical chain registry and
wallet token list are `config/chains/97.json` and `app/data/tokens/97.json`.
Never replace an address from chat, an unverified explorer page, or a local
environment variable without checking its code and live contract views.

## Release gates

Run the deterministic suite first:

```sh
npm run check
npm run check:bsc-testnet
```

`npm run check:bsc-testnet -- --require-ready` is the final fail-closed gate. It
must remain red until the deployment manifest contains the real Set Router,
registry, and quoter deployments; every required canary has a confirmed
chain-97 transaction hash; and every safety check has evidence.

Before broadcasting any deployment or canary:

1. Verify `eth_chainId == 0x61`.
2. Verify code at Multicall3, the Set proxy, wrapped BNB, and faucet addresses.
3. Compare the live Set `QUOTE_SIGNER`, wrapped-native token, trading state,
   block number, and block hash with the rollout record.
4. Request a fresh indicative quote and confirm its chain, `poolId`, pool proxy,
   asset ids, validity, inventory block, and external-route evidence.
5. Use a dedicated, capped testnet deployer. Never place its key in the
   manifest, shell history, `.env.example`, PR, or CI logs.

## Deployment order

Broadcasts are an operator action and are deliberately not part of
`npm run check`.

1. Deploy and initialize the governed Set pool registry.
2. Register the permanent Set proxy and confirm it is enabled.
3. Deploy and initialize router control with the approved owner and guardian.
4. Deploy the Set Router bound to chain `97`, mock wrapped BNB, the registry,
   and router control.
5. Deploy the required quoter components against the same chain-specific
   addresses.
6. Verify source and runtime bytecode, then replace only the corresponding
   `pending` manifest entries with addresses, constructor inputs, compiler
   metadata, transactions, blocks, bytecode hashes, and explorer links.
7. Configure the RFQ pool's `routerAddress` to the verified router. Confirm the
   RFQ service reads the router domain separator before enabling router-mode
   firm quotes.

Do not enable the Set venue in `config/chains/97.json` until the manifest,
on-chain verification, RFQ router binding, and canaries all agree.

## Canary matrix

Use a fresh faucet-funded wallet and small fixed amounts. Simulate immediately
before every broadcast. Record the confirmed transaction in
`deployments/bsc-testnet-97.rollout.json`; never record a pending transaction as
confirmed.

| Canary | Required observations |
| --- | --- |
| ERC-20 → ERC-20 | Faucet mUSDT, exact router approval, firm Set quote, output delta, zero router token balance and pool allowance |
| Native → ERC-20 | Exact call-scoped tBNB value, no token approval, output delta, surplus refund, zero router balance |
| ERC-20 → native | Exact router approval, native recipient delta, zero token balance and pool allowance |
| Competing external route | Current Set and external evidence, gas/fee-adjusted winner, rejected-route reason, simulated selected calldata |

For the dapp gate, start with an unfunded wallet, claim the mock basket from the
faucet, obtain test BNB from the official BNB Chain faucet, select chain `97`,
request an indicative quote, firm the selected Set route, approve only the
displayed router and exact amount, pass preflight, and wait for a confirmed
receipt.

## Negative and cleanup checks

- Wrong chain: mutate the wallet and request chain; no funds or approvals may
  move.
- Stale: wait past indicative validity and firm submission deadlines; the dapp
  must require a new quote.
- Replay: resubmit a consumed quote id; the transaction must revert.
- Pause: pause router or disable the Set source; quoting/execution must fail
  closed before transfers.
- Cleanup: after every success and revert, check router native/token balances
  and token allowance from router to pool are zero.

The deterministic counterparts live in
`contracts/test/SetwiseExecutionAdapter.t.sol`,
`contracts/test/RouterControl.t.sol`,
`services/quote/test/bsc-testnet-rfq.test.js`, and
`app/test/bsc-testnet-flow.test.js`.

## Recovery

1. Pause the router globally for an unknown asset-safety failure, or disable
   only the Set source for an RFQ/Set-specific failure.
2. Stop firming and invalidate quote caches on stale state, signer mismatch,
   RPC divergence, or reorg.
3. Preserve the failing request, response, simulation block, transaction,
   receipt, and balance/allowance snapshots.
4. Revoke only the affected router-to-pool allowance. Recover residual assets
   only through approved governance after identifying the invariant failure.
5. Roll back service configuration to the previous verified manifest. Never
   reuse quote ids or silently substitute another chain, router, pool, funder,
   or recipient.
6. Re-run the full canary and negative matrix before re-enabling execution.

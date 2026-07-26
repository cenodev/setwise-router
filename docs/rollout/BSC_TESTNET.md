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
must remain red until the deployment manifest contains the real Set Router and
registry deployments, the rollout record contains router-control and governance
evidence, every required canary has a confirmed chain-97 transaction hash, and
every safety check has evidence.

## Chain-97 architecture

The executable on-chain path is:

```
SetwiseExecutionAdapter -> SetwisePoolRegistry -> existing Set proxy
                        -> RouterControl
```

`SetwiseExecutionAdapter` is the internal `setwiseRouter` deployment role and
the UI calls it **Set Router**. Set pricing is RFQ-based: indicative and firm
quotes come from the recorded RFQ API, so chain 97 does not deploy a fake
on-chain `setwiseQuoter`. The existing Set proxy owns its token inventory, so
the router deployment also does not require a separate `setwiseTokenHub`. Those
generic manifest roles remain pending for other chain architectures and are not
chain-97 release requirements.

Before broadcasting any deployment or canary:

1. Verify `eth_chainId == 0x61`.
2. Verify code at Multicall3, the Set proxy, wrapped BNB, and faucet addresses.
3. Compare the live Set `QUOTE_SIGNER`, wrapped-native token, trading state,
   block number, and block hash with the rollout record.
4. Request a fresh indicative quote and confirm its chain, `poolId`, pool proxy,
   asset ids, validity, inventory block, and external-route evidence.
5. Use a dedicated, capped testnet deployer. Never place its key in the
   manifest, shell history, `.env.example`, PR, or CI logs.

## Deployment credentials

Use an encrypted Foundry keystore. Never put a private key in `.env`, a command
argument, the manifest, or shell history.

```sh
cast wallet import setwise-bsc-testnet-deployer --interactive
cast wallet address --account setwise-bsc-testnet-deployer
```

Set only public addresses and the RPC URL:

```sh
export RPC_URL_BSC_TESTNET=https://data-seed-prebsc-1-s1.bnbchain.org:8545
export DEPLOYER_ADDRESS=<address printed by cast>
export GOVERNANCE_ADDRESS=<approved testnet owner or Safe>
export EMERGENCY_GUARDIAN_ADDRESS=<approved disable-only guardian>
```

The deployer must be funded with a capped amount of tBNB. If governance is a
Safe, prepare its registry-ownership acceptance transaction before broadcast.

## Deployment order and commands

Broadcasts are an operator action and are deliberately not part of
`npm run check`.

The Foundry script performs these transactions in order:

1. Deploy `SetwisePoolRegistry` implementation and ERC-1967 proxy.
2. Initialize the registry to the deployer, register the permanent Set proxy,
   and start the two-step transfer when governance differs from the deployer.
3. Deploy `RouterControl` implementation and ERC-1967 proxy initialized to the
   approved governance owner and guardian.
4. Deploy `SetwiseExecutionAdapter` as the Set Router, immutably bound to chain
   `97`, mock wrapped BNB, the registry, router control, and governance.

Simulate first with the same keystore account:

```sh
npm run deploy:bsc-testnet:simulate -- \
  --account setwise-bsc-testnet-deployer
```

Review the trace, derived addresses, signer balance, and chain ID. Broadcast
only after that review:

```sh
npm run deploy:bsc-testnet -- \
  --account setwise-bsc-testnet-deployer
```

The script writes public addresses to
`contracts/broadcast/bsc-testnet-97.addresses.json`; Foundry writes confirmed
transactions and receipts to
`contracts/broadcast/DeployBscTestnet.s.sol/97/run-latest.json`.

Preview the source-controlled records derived from those confirmed receipts:

```sh
npm run record:bsc-testnet
```

The recorder rechecks chain ID 97, reads deployed runtime code, and verifies
both EIP-1967 implementation slots before producing actual on-chain bytecode
hashes. After checking every address, transaction, and block on BscScan, write
the candidate chain config, deployment manifest, and rollout record:

```sh
npm run record:bsc-testnet -- --write
```

Then:

5. If the registry has a pending owner, have the governance address or Safe call
   `acceptOwnership()` and record its confirmed transaction in the rollout
   record.
6. Run `npm run verify:deployments:on-chain` to verify code, bytecode hashes,
   and the registry's EIP-1967 implementation slot.
7. Configure the RFQ pool's `routerAddress` to the verified router. Confirm the
   RFQ service reads the router domain separator before enabling router-mode
   firm quotes.
8. Execute and record the canary and negative matrices below.

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

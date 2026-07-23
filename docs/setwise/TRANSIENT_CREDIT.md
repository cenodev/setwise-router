# Set transient credit and composition

Issue #17 lets a Set leg consume or create router **transient credit** inside a
single transaction, without enabling unsafe variable-amount composition. A leg
whose signed recipient is the router stages its measured output delta as
credit; a later leg in the same transaction whose signed funder is the router
consumes exactly its signed fixed input from that credit. User-facing surfaces
describe the venue as a **Set**; contract, service, and API identifiers retain
`pool` / `poolId` terminology.

- Ledger: [`contracts/src/setwise/NativeToken.sol`](../../contracts/src/setwise/NativeToken.sol)
  (`NativeAccounting`)
- Execution: [`contracts/src/setwise/SetwiseExecutionAdapter.sol`](../../contracts/src/setwise/SetwiseExecutionAdapter.sol)
- Tests: [`contracts/test/SetwiseTransientCredit.t.sol`](../../contracts/test/SetwiseTransientCredit.t.sol)

## Credit model

All credit state lives in **transient storage** (Cancun `TSTORE`/`TLOAD`), so
it is scoped to one transaction and discarded on revert:

- **Frame.** The outermost call (`multicall` or a standalone entry) opens the
  frame and records the **frame payer** — the `msg.sender` that opened it.
  Nested top-level frames revert (`NativeFrameActive`).
- **Create.** When the router is the signed recipient of a Set leg, the
  measured output **balance delta** — which must equal the signed fixed
  `amountOut` — is staged as credit (`_creditToken` for ERC-20 output,
  `_creditNative` for native output). Credit is never created from a quoted or
  returned amount, only from a verified measurement.
- **Consume.** A Set leg signed with `funder == address(this)` consumes exactly
  its fixed `amountIn` from the staged credit (`_spendTokenCredit`,
  `_spendNative`). The leg never pulls from an external wallet, and its router
  authorization binds the router as funder, so the RFQ signature explicitly
  approves credit funding for that exact calldata.
- **Settle.** The frame settles when the outermost call returns: every staged
  credit must be fully consumed (`ResidualTokenCredit` /
  `ResidualNativeCredit` otherwise) and the unspent portion of the caller's
  `msg.value` is refunded by per-call delta.

## Why credits cannot cross transactions or users

- **Transactions**: transient storage is erased at transaction end, and
  settlement *reverts* on any unconsumed credit, so a staged balance can never
  persist. A consume-only leg in a later transaction finds zero credit
  (`InsufficientTokenCredit`).
- **Users**: every token-credit spend requires `msg.sender == frame payer`
  (`CreditUserMismatch`). `multicall` sub-calls are `delegatecall`s, so all
  legs of one composition share the opening caller; a mid-frame callback from a
  token or pool is additionally stopped by the per-execution lock
  (`ReentrantSetwiseExecution`). The router authorization independently binds a
  credit-funded leg to the frame payer.

## Composition constraints for fixed-amount Set quotes

A composite route may chain Set legs **only** under these constraints, all
enforced on-chain:

1. **Fixed amounts only.** Every Set leg carries a signed `amountIn` and
   `amountOut`; both are enforced by balance-delta measurement. A pool that
   delivers more or less than the signed output reverts the whole transaction
   (`SetwiseOutputMismatch`) — no credit is ever staged from a variable
   measurement.
2. **Exact sizing.** A consuming leg debits exactly its signed `amountIn`.
   Staging more than is consumed reverts at settlement; consuming more than is
   staged reverts at the leg. Composite routes must therefore be sized so each
   leg's output equals the next leg's input.
3. **Measured credit only.** Credit exists solely from a verified delta at the
   router; there is no path to mint credit from allowances, pre-existing
   balances, or quoted amounts.
4. **Same-venue credit today.** Only Set legs can stage credit, so only
   Set→Set composition is reachable.

**Variable-output → Set composition is rejected** by construction: a
predecessor whose output is not fixed and signed cannot stage the exact credit
a Set leg requires, and any shortfall or surplus reverts atomically.

## Capability gate for mixed routes

Mixed Set composite routes — a Set leg consuming credit staged by a
**different** venue — are gated behind the `setwiseComposition` capability
("Set composite routes" in the UI), which every chain declares as **disabled**
(see [`docs/config/CAPABILITIES.md`](../config/CAPABILITIES.md)). The registry
rejects enabling it without the `setwise` venue, and while disabled it
surfaces no service wiring or deploy inputs, so the quote service cannot build
a mixed composite route. The capability stays disabled until the composition
audit lands.

## Allowed future patterns

These patterns are designed to satisfy the constraints above when predecessor
venues gain credit staging:

- **Set-first.** A signed, fixed-output Set leg stages exact credit; later legs
  (any venue) consume it. Safe because the Set leg's output is verified by
  balance delta before any downstream leg runs.
- **Exact-output predecessor.** A venue leg with a signed, fixed output (an
  exact-output AMM quote enforced by the same balance-delta measurement)
  stages credit for a following Set leg. The Set leg's fixed input must equal
  that verified output.
- **Fixed split.** Several fixed-amount legs stage credit in one transaction
  and a final fixed-amount Set leg consumes the exact sum. Each contributor is
  individually measured; the consumer reverts unless the total matches its
  signed input exactly.

Exact-**input** (variable-output) predecessors remain excluded: they cannot
know their output at signing time, so they can never satisfy a Set leg's fixed
input without the exact-sizing checks reverting.

## Tests

```bash
cd contracts && forge test --match-contract SetwiseTransientCreditTest
```

The suite covers composition across every settlement-mode pair
(ERC-20→ERC-20, native→ERC-20, ERC-20→native in both create/consume roles),
cross-transaction and cross-user credit rejection, under- and over-paid output
staging rejection, over- and under-consumption sizing reverts, mid-frame
callback locking, the ledger's frame-active requirement, and a fuzz campaign
over one-to-four-leg create/consume orderings where only exactly balanced
sequences may succeed. `SetwiseExecutionInvariant.t.sol` additionally fuzzes
composition ordering inside the stateful invariant suite, requiring router
balances and allowances to remain at their snapshots after every sequence.

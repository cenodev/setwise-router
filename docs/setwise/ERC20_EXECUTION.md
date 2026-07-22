# Set ERC-20 → ERC-20 execution

Issue #15 adds `SetwiseExecutionAdapter`, the first asset-moving Set path on
the router. It executes a signed, fixed-amount ERC-20 → ERC-20 swap against a
registered Set pool. User-facing surfaces describe the venue as a **Set**;
contract, service, and API identifiers retain `pool` / `poolId` terminology.

Native input/output settlement is issue #13, router transient credit and
composition are issue #17, and allowance/residual hardening across every Set
path is issue #14. This path already leaves zero balance delta and zero
allowance after a direct execution.

- Adapter: [`contracts/src/setwise/SetwiseExecutionAdapter.sol`](../../contracts/src/setwise/SetwiseExecutionAdapter.sol)
- Tests: [`contracts/test/SetwiseExecutionAdapter.t.sol`](../../contracts/test/SetwiseExecutionAdapter.t.sol)

## Call flow

`swapSetwise(swap, funder, authorizationSignature)` runs its guards in a fixed
order. Every check precedes any approval, token pull, or pool interaction, so
a failure never leaves partial state:

1. `onlyConfiguredChain` — the deployment is bound to one `block.chainid`.
2. `nativeFrame(true)` — ERC-20-only entry; attached native value reverts on a
   standalone call (`UnexpectedNativeValue`) while `multicall` sub-calls still
   share the caller's native frame.
3. `onlyEnabledSetwisePool` — the governed
   [pool registry](./POOL_REGISTRY.md) must list `swap.pool` as enabled
   (`requireEnabledPool`) and [router control](./GOVERNANCE.md) must not have
   paused the router, disabled the chain, or disabled the Set source
   (`requireRouteEligible(chainId, keccak256("setwise"))`). This runs before
   the pool address is otherwise touched.
4. `onlyValidSetwiseAuthorization` — the RFQ-issued
   [EIP-712 authorization](./ROUTER_AUTHORIZATION.md) binds `msg.sender`, the
   funding wallet, recipient, assets, native flags, fixed amounts, quote ID,
   and deadline against the pool's current `QUOTE_SIGNER`.

The body then:

1. Requires the `ERC20_TO_ERC20` settlement mode, consistent asset
   normalization, a nonzero recipient, and nonzero fixed amounts.
2. Pulls exactly the authorized input from the funding wallet.
3. Grants the registered pool the **exact per-swap allowance**
   (`approve(amountIn)`), calls `swapExactAssetForAsset` with the signed pool
   quote, then clears the allowance (`approve(0)`).
4. Measures the recipient's output **balance delta** and requires it to equal
   the signed fixed output (`SetwiseOutputMismatch` otherwise).
5. Emits `SetwiseSwapExecuted` with the complete execution metadata: pool,
   `quoteId`, funder, recipient, input/output assets, and both amounts.

## Security invariants

- **Exact input**: the funding wallet is debited exactly the signed
  `amountIn`; the pool receives exactly `amountIn`.
- **Signed recipient**: output is delivered only to the recipient bound by both
  signatures; modifying any calldata field fails the authorization before
  funds move.
- **Replay**: a successful pool call consumes the shared `quoteId`, so replay
  reverts at the pool with `QuoteAlreadyUsed`; the router keeps no second nonce
  store. Caller substitution reverts with `SetwiseAuthorizationWrongCaller`.
- **Zero residue**: after a direct execution the router holds no input or
  output tokens and no pool allowance. A revert anywhere discards the pull,
  the allowance, and the quote consumption, so no partial state survives.
- **Fixed result**: the output is enforced by balance-delta measurement, not
  by trusting the pool's return path.

## Recipient modes

- **Direct user receipt** (`recipient = user`): output settles straight to the
  user; the router ends with zero balance and zero allowance.
- **Router receipt** (`recipient = address(this)`): the measured output stays
  in the router, staging it as input for a future composition leg (issue #17).
  The same balance-delta enforcement applies.

## Deployment

One adapter is deployed per chain with immutable configuration: `chainId`
(must equal `block.chainid` at deploy time), the chain's wrapped-native token,
the governance role (for the inherited governed `sweep`), the pool registry,
and router control. Constructor misconfiguration reverts (`WrongChain`,
`InvalidAdapterConfig`).

## Tests

```bash
cd contracts && forge test --match-contract SetwiseExecutionAdapterTest
```

The suite runs against the real governed registry and router control (both
behind ERC-1967 proxies) and a pool mock that faithfully verifies the EIP-712
`SwapQuote`, enforces the deadline, and consumes quote IDs. It covers exact
input consumption, signed-recipient delivery, quote replay, caller
substitution, zero router balance/allowance, revert atomicity, registry and
kill-switch guard ordering, native-mode rejection, output-delta mismatch,
router receipt, multicall framing, expiry, modified calldata, wrong chain,
token transfer/approval failures, complete event metadata, and constructor
validation.

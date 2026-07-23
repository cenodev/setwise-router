# Set native execution

Issue #13 extends `SetwiseExecutionAdapter` (introduced for ERC-20 → ERC-20 in
issue #15) with the two native settlement modes: **native → ERC-20** and
**ERC-20 → native**. Native → native has no Setwise pool entry point and reverts
in mode resolution (`NativeToNativeUnsupported`). User-facing surfaces describe
the venue as a **Set**; contract, service, and API identifiers retain
`pool` / `poolId` terminology.

The chain-agnostic wrap/unwrap primitives and call-scoped native value
accounting live in [`NATIVE_HANDLING.md`](./NATIVE_HANDLING.md) (issue #9); this
document covers how the execution adapter drives them through the pool's native
entry points.

- Adapter: [`contracts/src/setwise/SetwiseExecutionAdapter.sol`](../../contracts/src/setwise/SetwiseExecutionAdapter.sol)
- Pool interface: [`contracts/src/setwise/ISetwisePool.sol`](../../contracts/src/setwise/ISetwisePool.sol)
- Tests: [`contracts/test/SetwiseExecutionAdapter.t.sol`](../../contracts/test/SetwiseExecutionAdapter.t.sol)

## Asset normalization

A native leg is expressed in the signed quote as the chain's **wrapped-native**
token, never the `address(0)` sentinel. `swap.assetIn` / `swap.assetOut` carry
that wrapped-native address, and the `nativeIn` / `nativeOut` flags select the
pool entry point. `SetwiseSwapLib.validateNormalization` enforces this before
any funds move:

- a native leg (`nativeIn`/`nativeOut`) must be the wrapped-native token;
- an ERC-20 leg must not be the `address(0)` sentinel.

A mismatch reverts with `AssetNormalizationMismatch`. The sentinel is normalized
to wrapped-native off-chain (RFQ API / UI) before signing.

## Mode dispatch

`swapSetwise` opens the native frame with `nativeFrame(!swap.nativeIn)`:

- **Native input** (`nativeIn = true`): the frame accepts the attached
  `msg.value`, which funds the input.
- **Every other mode**: attached native value reverts on a standalone call
  (`UnexpectedNativeValue`), while `multicall` sub-calls still share the
  caller's frame.

The body resolves the mode and dispatches to a mode-specific helper. The guards
(chain binding, frame, governed registry, router control, EIP-712
authorization) all run first, exactly as in the ERC-20 path, so a failure never
leaves partial state.

## Native → ERC-20

`_executeNativeToErc20`:

1. `_spendNative(amountIn)` — accounts the spend against the frame bound
   (`msg.value` + transient credit). A shortfall reverts
   (`InsufficientNativeValue`); a surplus is refunded by the frame as a
   per-call delta. The spend is bound to this call's value, **never**
   `address(this).balance`, so a pre-existing router balance can never
   subsidize the input.
2. Calls `pool.swapExactNativeForAsset{value: amountIn}(...)`. The pool wraps
   the native input internally and transfers the ERC-20 output to the recipient.
3. Measures the recipient's ERC-20 **balance delta** and requires it to equal the
   signed `amountOut` (`SetwiseOutputMismatch` otherwise).

## ERC-20 → native

`_executeErc20ToNative`:

1. Pulls exactly `amountIn` of the input ERC-20 from the funding wallet and
   grants the pool the exact per-swap allowance.
2. Calls `pool.swapExactAssetForNative(...)`. The pool pulls the input, unwraps
   `amountOut` of wrapped-native, and sends native currency to the recipient.
3. Clears the allowance, measures the recipient's **native balance delta**, and
   requires it to equal the signed `amountOut`.

No native value is attached to this mode; the native output comes from the pool's
unwrap, not from the router, so the router ends with zero native balance.

## Recipient modes

- **EOA recipient**: native output settles straight to the address; the balance
  delta equals `amountOut`.
- **Contract recipient that accepts native**: same, via its receive/fallback.
- **Contract recipient that rejects native**: the pool's native transfer reverts
  the whole swap with no partial state (input restored, allowance cleared, quote
  unconsumed). Such a recipient settles via a **wrapped-native route** instead —
  an ERC-20 → ERC-20 swap whose `assetOut` is the wrapped-native token, so the
  output arrives as an ERC-20 the recipient can hold.
- **Router receipt** (`recipient = address(this)`): the measured output stays in
  the router, staging it for a future composition leg (issue #17). The same
  balance-delta enforcement applies.

## Security invariants

- **Exact call-scoped native input**: the native input is bound to the current
  call's `msg.value` plus transient credit; it can never be subsidized by a
  pre-existing router balance.
- **Per-call deltas**: native refunds (surplus `msg.value`) and native outputs
  are measured as per-call deltas, never from `address(this).balance`.
- **Wrong flags / addresses revert**: a native leg that is not the wrapped-native
  token, or an ERC-20 leg that is the sentinel, reverts
  (`AssetNormalizationMismatch`); native → native reverts
  (`NativeToNativeUnsupported`).
- **Fixed result**: every mode enforces the signed output by balance-delta
  measurement, not by trusting the pool's return path.

## Tests

```bash
cd contracts && forge test --match-contract SetwiseExecutionAdapterTest
```

The native suite covers EOA recipients, accepting contract recipients, and
rejecting contract recipients (revert plus the wrapped-native workaround);
insufficient native value; surplus refund by per-call delta with a pre-funded
router left untouched; output-delta mismatch in both native directions;
router-receipt staging; wrong wrapped-native / sentinel asset reverts;
native → native revert; attached-value rejection on the ERC-20 → native mode;
and complete event metadata.

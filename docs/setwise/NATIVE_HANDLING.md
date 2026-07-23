# Native and wrapped-native handling

Issue #9 removes the assumption that native currency is always ETH with
Ethereum-mainnet WETH. It defines one canonical internal native-token
representation and a chain-aware native-value accounting layer that the Setwise
execution paths (issues #13/#15) build on.

- Library & accounting: [`contracts/src/setwise/NativeToken.sol`](../../contracts/src/setwise/NativeToken.sol)
- Canonical sentinel & data types: [`contracts/src/setwise/SetwiseSwap.sol`](../../contracts/src/setwise/SetwiseSwap.sol)
- Config-selected native tokens: [`config/native.mjs`](../../config/native.mjs)
- Unit tests: [`contracts/test/NativeToken.t.sol`](../../contracts/test/NativeToken.t.sol), [`test/native-config.test.js`](../../test/native-config.test.js)

## Canonical representation

A native leg is represented internally by the zero-address sentinel
`SETWISE_NATIVE_TOKEN` (`address(0)`), shared by the data-type layer and the
native-handling layer. On-chain a native leg always settles through the chain's
**wrapped-native token**, which is selected from verified chain configuration —
never a hardcoded constant:

| Chain | Native | Wrapped native |
| --- | --- | --- |
| Ethereum (`1`) | ETH | WETH `0xC02a…Cc2` |
| BNB Smart Chain (`56`) | BNB | WBNB `0xbb4C…95c` |
| Base (`8453`) | ETH | WETH `0x4200…006` |
| Robinhood Chain (`4663`) | ETH | WETH (unverified — `null` until addresses are confirmed) |

`config/native.mjs` resolves these from the registry, exposes the sentinel, and
normalizes the sentinel to the chain's wrapped-native address (mirroring
`SetwiseSwapLib.normalizeAsset`). Unverified chains and unsupported chain ids
fail explicitly; there is no implicit Ethereum fallback.

## Primitives (`NativeTokenLib`)

Chain-agnostic helpers parameterized by the wrapped-native token:

- `isNative(asset)` — true for the sentinel.
- `wrap(wrappedNative, amount)` — send native to the token (its receive hook
  mints 1:1).
- `unwrap(wrappedNative, amount, recipient)` — call `withdraw` and forward the
  freed native currency.
- `transferNative(to, amount)` — safe native send.

## Call-scoped native value accounting (`NativeAccounting`)

Native spending is bound to the value attached to the current top-level call
(`msg.value`) plus any **transient credit** earned earlier in the same
transaction. Accounting state lives in transient storage (Cancun), so it is
scoped to one transaction and discarded on revert.

- `_spendNative(amount)` reverts (`InsufficientNativeValue`) when a spend would
  exceed `msg.value + credit`. A standalone exact-input entry can also require an
  exact `msg.value` (`NativeValueMismatch`).
- `_creditNative(amount)` reserves native received mid-call (e.g. an unwrap whose
  output feeds a later leg) so a subsequent spend needs no new `msg.value`.
- `multicall(bytes[])` runs sub-calls under one shared native frame; ERC-20-only
  sub-calls share the caller's value without rejecting it, while a standalone
  ERC-20-only call that attaches value still reverts (`UnexpectedNativeValue`).
- Settlement refunds the **unspent portion of the caller's `msg.value`** — a
  per-call delta, never `address(this).balance` — so a pre-existing router
  balance is never swept out to a caller. Any transient credit that was not
  consumed reverts (`ResidualNativeCredit`) rather than leaving a residual
  balance.

This deliberately reworks the inherited ZFi findings around total-balance
refunds and permissionless sweeps:

- **Refunds** are computed from the call's own value delta, not the router's
  total balance.
- **`sweep(token, to, amount)`** is gated to the `governance` role (a placeholder
  for the Safe/timelock wired up in issue #37) and moves an explicit amount; it
  is not permissionless.

The general transient-credit composition system (issue #17) builds on this
layer; see [`TRANSIENT_CREDIT.md`](./TRANSIENT_CREDIT.md).

## Coverage

`contracts/test/NativeToken.t.sol` covers wrap/unwrap, native→ERC-20,
ERC-20→native (pool-side and router-side unwrap), ERC-20→ERC-20, exact-input
mismatch and insufficient-value reverts, per-call delta refunds that leave a
pre-existing balance untouched, multicall with transient-credit carry and
residual-credit/nested-multicall reverts, governed sweep, and config-selected
wrapped-native tokens (no hardcoded WETH).

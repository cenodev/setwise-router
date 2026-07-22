# Setwise pool interface and fixed swap data types

Issue #7 defines the minimal on-chain surface the Setwise Router needs to
execute signed, fixed-amount Setwise swaps, plus the typed calldata structures
the router accepts. It vendors **only the interface and data types** — not the
upgradeable Setwise implementation — so the router never imports the full pool.

- Interfaces & data types: [`contracts/src/setwise/`](../../contracts/src/setwise)
- ABI baseline fixture: [`baseline/abi/setwisePool.json`](../../baseline/abi/setwisePool.json)
- RFQ-API calldata fixtures: [`baseline/setwise/calldata.json`](../../baseline/setwise/calldata.json)
- Compatibility tests: [`contracts/test/SetwiseDataTypes.t.sol`](../../contracts/test/SetwiseDataTypes.t.sol), [`test/setwise-pool.test.js`](../../test/setwise-pool.test.js)

The selectors, `SwapExecuted` event, revert surface, and EIP-712 `SwapQuote`
typehash mirror the deployed `SetwisePoolBase` / `SetwisePool` swap surface from
[`cenodev/setwise-contracts`](https://github.com/cenodev/setwise-contracts)
(`contracts/SetwisePoolBase.sol`, `contracts/SetwisePool.sol`). That repository
remains external (see [`docs/upstream/FORK_MAP.md`](../upstream/FORK_MAP.md));
this repo does not vendor it.

## How a Setwise swap works

A Setwise pool has no on-chain AMM curve. A swap is an RFQ execution:

1. The RFQ service signs an EIP-712 `SwapQuote` binding the **payer** (the
   caller the pool observes — the router, since `msg.sender == router`), the
   input/output assets, the fixed input/output amounts, a one-time `quoteId`, a
   `deadline`, and the `recipient`.
2. The router calls the pool entry point that matches the settlement mode,
   forwarding the signed quote.
3. The pool verifies the signature against its `QUOTE_SIGNER` (with ERC-1271
   support) and consumes the one-time `quoteId`, then settles the fixed amounts.

The pool independently verifies its own quote; the router-level execution
authorization that also binds the funding wallet is issue #10.

## ISetwisePool — minimal interface

### Swap entry points (one per settlement mode)

| Selector | Signature | Mutability | Mode |
| --- | --- | --- | --- |
| `0x24266baa` | `swapExactAssetForAsset(address inputAsset,address outputAsset,uint256 inputAmount,uint256 outputAmount,bytes32 quoteId,uint256 deadline,address recipient,bytes signature,bytes auxiliaryData)` | nonpayable | ERC-20 → ERC-20 |
| `0xdcf8b279` | `swapExactNativeForAsset(address outputAsset,uint256 inputAmount,uint256 outputAmount,bytes32 quoteId,uint256 deadline,address recipient,bytes signature,bytes auxiliaryData)` | payable | native → ERC-20 |
| `0x695d9b7f` | `swapExactAssetForNative(address inputAsset,uint256 inputAmount,uint256 outputAmount,bytes32 quoteId,uint256 deadline,address recipient,bytes signature,bytes auxiliaryData)` | nonpayable | ERC-20 → native |

### Views

| Selector | Signature | Role |
| --- | --- | --- |
| `0xd0e15ba4` | `QUOTE_SIGNER()` | Address `SwapQuote` signatures are verified against |
| `0x1b3f8c5e` | `WRAPPED_NATIVE_TOKEN()` | On-chain representation of a native leg |
| `0x03ea8003` | `usedQuoteIds(bytes32)` | One-time `quoteId` consumption flag |
| `0x9be918e6` | `isSupportedAsset(address)` | Pool asset allowlist membership |
| `0x7102ae2a` | `quoteDomainSeparator()` | EIP-712 domain separator for `SwapQuote` |
| `0x5089331d` | `recordedBalance(address)` | Pool's internally recorded asset balance |

### Event

| Topic hash | Event |
| --- | --- |
| `0xa2fe6ab887b4a569b99c1b733c36e55e75e395f7aee85044820ab8155716c9e6` | `SwapExecuted(address indexed inputAsset,address indexed outputAsset,address indexed recipient,uint256 inAmount,uint256 outAmount,bytes auxiliaryData)` |

For a native leg, the emitted asset is the wrapped-native token, matching the
signed quote.

### Errors (revert surface)

| Selector | Error | Raised when |
| --- | --- | --- |
| `0xe6b79916` | `QuoteAlreadyUsed(bytes32 quoteId)` | The `quoteId` was already consumed (replay guard). |
| `0x140dcdb5` | `InvalidQuoteId()` | The `quoteId` is the zero hash. |
| `0xcfdff0eb` | `InvalidNativeAmount(uint256 expected,uint256 provided)` | `msg.value` != signed native input amount. |
| `0x8baa579f` | `InvalidSignature()` | The `SwapQuote` signature fails verification. |
| `0x02b874a6` | `TradingPaused()` | The pool has paused trading. |

## EIP-712 SwapQuote

```text
SwapQuote(address payer,address inputAsset,address outputAsset,uint256 inputAmount,uint256 outputAmount,bytes32 quoteId,uint256 deadline,address recipient)
```

- Typehash: `0x05f457dcd915199b3c456f83a601d28b8a9c57b952c20f6b13c56eec1b203c13`
- Domain: `name = "SetwisePool"`, `version = "2.0.0"`, `chainId`, `verifyingContract = pool`.
- `payer` is the caller the pool observes. When the router executes, `payer` is
  the router (`msg.sender == router`).

## Token normalization (native ↔ wrapped-native)

The single most important encoding rule: **the signed `SwapQuote` and the pool's
balance accounting always express a native leg as `WRAPPED_NATIVE_TOKEN`, never
as `address(0)`.** The `address(0)` sentinel (`SETWISE_NATIVE_TOKEN`) is only
used at the RFQ-API / UI boundary to denote native currency.

| Settlement mode | Entry point | `msg.value` | Quote `inputAsset` | Quote `outputAsset` |
| --- | --- | --- | --- | --- |
| ERC-20 → ERC-20 | `swapExactAssetForAsset` | `0` | the input ERC-20 | the output ERC-20 |
| native → ERC-20 | `swapExactNativeForAsset` | `inputAmount` | `WRAPPED_NATIVE_TOKEN` | the output ERC-20 |
| ERC-20 → native | `swapExactAssetForNative` | `0` | the input ERC-20 | `WRAPPED_NATIVE_TOKEN` |

Consequences for the router adapter (issue #15):

- **native → ERC-20**: attach `inputAmount` as `msg.value`; the pool wraps it
  into `WRAPPED_NATIVE_TOKEN`. The quote's `inputAsset` is the wrapped token.
- **ERC-20 → native**: the quote's `outputAsset` is `WRAPPED_NATIVE_TOKEN`; the
  pool unwraps and sends native currency to the `recipient`.
- **native → native** is not a valid Setwise swap and has no entry point; the
  data types reject it (`SetwiseSwapLib.NativeToNativeUnsupported`).
- The wrapped-native token is *also* a valid ERC-20 asset on a non-native leg
  (e.g. a direct WETH → USDC swap), so normalization keys off the native flags,
  not the asset address alone.

`SetwiseSwapLib.normalizeAsset(asset, wrappedNative)` maps the RFQ/UI sentinel
to the wrapped-native token and leaves every other asset unchanged;
`quoteInputAsset` / `quoteOutputAsset` return the asset that must appear in the
signed quote for each leg; `validateNormalization` enforces that a native leg
carries the wrapped-native token and an ERC-20 leg is not the sentinel.

## SetwiseSwap calldata structure

`SetwiseSwap` (in [`contracts/src/setwise/SetwiseSwap.sol`](../../contracts/src/setwise/SetwiseSwap.sol))
is the fixed-amount calldata the router's Setwise execution path accepts:

| Field | Type | Bound by quote | Notes |
| --- | --- | --- | --- |
| `pool` | `address` | no | Whitelisted Setwise pool proxy (UUPS); registry is issue #8. |
| `assetIn` | `address` | yes | Input asset as it appears in the quote (wrapped-native for a native leg). |
| `assetOut` | `address` | yes | Output asset as it appears in the quote (wrapped-native for a native leg). |
| `nativeIn` | `bool` | no | Input leg settles in native currency; selects the entry point. |
| `nativeOut` | `bool` | no | Output leg settles in native currency; selects the entry point. |
| `amountIn` | `uint256` | yes | Fixed signed input amount. |
| `amountOut` | `uint256` | yes | Fixed signed output amount. |
| `quoteId` | `bytes32` | yes | One-time quote / inventory guard (replay protection). |
| `deadline` | `uint256` | yes | Packed inventory/deadline guard; the pool requires `block.timestamp <= deadline`. |
| `recipient` | `address` | yes | Output recipient. |
| `signature` | `bytes` | — | Pool EIP-712 `SwapQuote` signature. |
| `auxiliaryData` | `bytes` | no | Opaque data forwarded to the pool and emitted in `SwapExecuted`. |

`SetwiseAssetMode` (`ERC20_TO_ERC20`, `NATIVE_TO_ERC20`, `ERC20_TO_NATIVE`) and
`SetwiseSwapLib.entrySelector` make the mode → entry-point mapping explicit and
unambiguous. The router-level EIP-712 execution authorization (which also binds
the funding wallet, chain, and router) is added by issue #10.

## Terminology

User-facing UI copy says **Set** when referring to Setwise liquidity; internal
identifiers, contract fields, and RFQ field names keep `pool` / `poolId`.

## Regenerate

```bash
node scripts/build-setwise-abi.mjs        # forge build contracts/ + rewrite baseline/abi/setwisePool.json
node scripts/build-setwise-calldata.mjs   # rewrite baseline/setwise/calldata.json via cast
forge test                                # in contracts/: data-types + selector compatibility
node --test test/setwise-pool.test.js     # fixture/drift/calldata verification
```

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISetwisePool} from "./ISetwisePool.sol";

// The native-currency sentinel used by the RFQ API and UI. On-chain, a native
// leg is always expressed as the pool's wrapped-native token.
address constant SETWISE_NATIVE_TOKEN = address(0);

/// @notice Asset settlement modes for a Setwise swap. Native -> native is not a
///         valid Setwise swap and has no representation here.
enum SetwiseAssetMode {
    ERC20_TO_ERC20,
    NATIVE_TO_ERC20,
    ERC20_TO_NATIVE
}

/// @notice Fixed-amount Setwise swap calldata accepted by the router's Setwise
///         execution path (issue #15). The pool's EIP-712 `SwapQuote` binds the
///         quote fields. The router authorization additionally binds `pool`,
///         the native flags, the funding wallet, chain, and router.
/// @dev `assetIn` / `assetOut` carry the asset address exactly as it appears in
///      the signed quote: the wrapped-native token for a native leg, never
///      `SETWISE_NATIVE_TOKEN`. The native flags select the pool entry point and
///      record that the leg settles in native currency.
struct SetwiseSwap {
    address pool;
    address assetIn;
    address assetOut;
    bool nativeIn;
    bool nativeOut;
    uint256 amountIn;
    uint256 amountOut;
    bytes32 quoteId;
    uint256 deadline;
    address recipient;
    bytes signature;
    bytes auxiliaryData;
}

/// @title SetwiseSwapLib
/// @notice Pure helpers that keep `SetwiseSwap` unambiguous across asset modes:
///         mode resolution, native/wrapped-native normalization, and the
///         mode -> pool-entry-point mapping.
library SetwiseSwapLib {
    /// @notice The EIP-712 typehash the pool hashes `SwapQuote` payloads with.
    ///         `payer` is the caller the pool observes (the router).
    bytes32 internal constant SWAP_QUOTE_TYPEHASH = keccak256(
        "SwapQuote(address payer,address inputAsset,address outputAsset,uint256 inputAmount,"
        "uint256 outputAmount,bytes32 quoteId,uint256 deadline,address recipient)"
    );

    /// @notice Both legs requested native settlement; Setwise has no such entry point.
    error NativeToNativeUnsupported();
    /// @notice A native leg's asset is not the wrapped-native token, or an
    ///         ERC-20 leg's asset is the native sentinel.
    error AssetNormalizationMismatch();

    /// @notice Resolve the settlement mode from the native flags.
    function mode(SetwiseSwap calldata swap) internal pure returns (SetwiseAssetMode) {
        if (swap.nativeIn) {
            if (swap.nativeOut) revert NativeToNativeUnsupported();
            return SetwiseAssetMode.NATIVE_TO_ERC20;
        }
        if (swap.nativeOut) return SetwiseAssetMode.ERC20_TO_NATIVE;
        return SetwiseAssetMode.ERC20_TO_ERC20;
    }

    /// @notice Normalize an RFQ/UI asset into the on-chain quote asset: the
    ///         native sentinel maps to `wrappedNative`, every other asset is
    ///         returned unchanged.
    function normalizeAsset(address asset, address wrappedNative) internal pure returns (address) {
        return asset == SETWISE_NATIVE_TOKEN ? wrappedNative : asset;
    }

    /// @notice The input asset that must appear in the signed quote for `swap`.
    function quoteInputAsset(SetwiseSwap calldata swap, address wrappedNative) internal pure returns (address) {
        return swap.nativeIn ? wrappedNative : swap.assetIn;
    }

    /// @notice The output asset that must appear in the signed quote for `swap`.
    function quoteOutputAsset(SetwiseSwap calldata swap, address wrappedNative) internal pure returns (address) {
        return swap.nativeOut ? wrappedNative : swap.assetOut;
    }

    /// @notice The pool entry-point selector for `swap`'s settlement mode.
    function entrySelector(SetwiseSwap calldata swap) internal pure returns (bytes4) {
        SetwiseAssetMode m = mode(swap);
        if (m == SetwiseAssetMode.NATIVE_TO_ERC20) return ISetwisePool.swapExactNativeForAsset.selector;
        if (m == SetwiseAssetMode.ERC20_TO_NATIVE) return ISetwisePool.swapExactAssetForNative.selector;
        return ISetwisePool.swapExactAssetForAsset.selector;
    }

    /// @notice Assert that `swap`'s asset fields are consistent with its native
    ///         flags and the pool's `wrappedNative` token. A native leg must be
    ///         the wrapped-native token; an ERC-20 leg must not be the native
    ///         sentinel. The wrapped-native token remains a valid ERC-20 asset
    ///         for a non-native leg (e.g. a direct WETH swap).
    function validateNormalization(SetwiseSwap calldata swap, address wrappedNative) internal pure {
        if (swap.nativeIn) {
            if (swap.assetIn != wrappedNative) revert AssetNormalizationMismatch();
        } else if (swap.assetIn == SETWISE_NATIVE_TOKEN) {
            revert AssetNormalizationMismatch();
        }
        if (swap.nativeOut) {
            if (swap.assetOut != wrappedNative) revert AssetNormalizationMismatch();
        } else if (swap.assetOut == SETWISE_NATIVE_TOKEN) {
            revert AssetNormalizationMismatch();
        }
    }
}

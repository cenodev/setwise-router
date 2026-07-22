// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ISetwisePool
/// @notice Minimal interface for a deployed Setwise pool proxy, scoped to the
///         surface the Setwise Router needs to execute signed, fixed-amount
///         swaps. It deliberately omits the upgradeable portfolio machinery
///         (deposits, withdrawals, share ERC-20, ownership, UUPS) so the router
///         never imports the full Setwise implementation.
/// @dev Selectors and the `SwapExecuted` event / revert surface mirror the
///      deployed `SetwisePoolBase` / `SetwisePool` ABIs. A Setwise swap is an
///      RFQ execution: the amounts, assets, `quoteId`, `deadline`, and
///      `recipient` are fixed off-chain and bound by an EIP-712 `SwapQuote`
///      signature whose `payer` is the caller the pool observes (`msg.sender`,
///      i.e. the router). The pool independently verifies the signature against
///      its `QUOTE_SIGNER` and consumes the one-time `quoteId`.
///
///      Token normalization: the signed quote and the pool's balance accounting
///      always express a native leg as `WRAPPED_NATIVE_TOKEN`, never as
///      `address(0)`. The native entry points wrap/unwrap internally, so the
///      router selects the entry point from its native flags and forwards the
///      wrapped-native asset address in the quote.
interface ISetwisePool {
    /// @notice Emitted after a swap settles. For native legs the asset is the
    ///         wrapped-native token, matching the signed quote.
    event SwapExecuted(
        address indexed inputAsset,
        address indexed outputAsset,
        address indexed recipient,
        uint256 inAmount,
        uint256 outAmount,
        bytes auxiliaryData
    );

    /// @notice The `quoteId` has already been consumed by a prior swap.
    error QuoteAlreadyUsed(bytes32 quoteId);
    /// @notice The `quoteId` is the zero hash.
    error InvalidQuoteId();
    /// @notice `msg.value` does not equal the signed native input amount.
    error InvalidNativeAmount(uint256 expected, uint256 provided);
    /// @notice The `SwapQuote` signature fails verification against `QUOTE_SIGNER`.
    error InvalidSignature();
    /// @notice The pool has paused trading.
    error TradingPaused();

    /// @notice ERC-20 -> ERC-20 swap. Pulls `inputAmount` of `inputAsset` from
    ///         the caller and transfers `outputAmount` of `outputAsset` to
    ///         `recipient`. Both assets must be supported and appear verbatim in
    ///         the signed quote.
    function swapExactAssetForAsset(
        address inputAsset,
        address outputAsset,
        uint256 inputAmount,
        uint256 outputAmount,
        bytes32 quoteId,
        uint256 deadline,
        address recipient,
        bytes calldata signature,
        bytes calldata auxiliaryData
    ) external;

    /// @notice Native -> ERC-20 swap. The caller attaches `inputAmount` native
    ///         currency as `msg.value`; the pool wraps it into
    ///         `WRAPPED_NATIVE_TOKEN`, which is the signed quote's input asset.
    ///         Transfers `outputAmount` of `outputAsset` to `recipient`.
    function swapExactNativeForAsset(
        address outputAsset,
        uint256 inputAmount,
        uint256 outputAmount,
        bytes32 quoteId,
        uint256 deadline,
        address recipient,
        bytes calldata signature,
        bytes calldata auxiliaryData
    ) external payable;

    /// @notice ERC-20 -> native swap. Pulls `inputAmount` of `inputAsset` from
    ///         the caller, unwraps `outputAmount` of `WRAPPED_NATIVE_TOKEN`
    ///         (the signed quote's output asset), and sends native currency to
    ///         `recipient`.
    function swapExactAssetForNative(
        address inputAsset,
        uint256 inputAmount,
        uint256 outputAmount,
        bytes32 quoteId,
        uint256 deadline,
        address recipient,
        bytes calldata signature,
        bytes calldata auxiliaryData
    ) external;

    /// @notice The address the pool verifies `SwapQuote` signatures against.
    function QUOTE_SIGNER() external view returns (address);

    /// @notice The wrapped-native token used to express native legs on-chain.
    function WRAPPED_NATIVE_TOKEN() external view returns (address);

    /// @notice Whether a `quoteId` has already been consumed.
    function usedQuoteIds(bytes32 quoteId) external view returns (bool used);

    /// @notice Whether `token` is a supported pool asset.
    function isSupportedAsset(address token) external view returns (bool supported);

    /// @notice The EIP-712 domain separator used to hash `SwapQuote` payloads.
    function quoteDomainSeparator() external view returns (bytes32);

    /// @notice The pool's internally recorded balance for `token`.
    function recordedBalance(address token) external view returns (uint256);
}

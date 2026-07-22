// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IWrappedNativeToken
/// @notice Minimal wrapped-native token surface used by the Setwise native
///         entry points. Wrapping is performed by sending native currency to
///         the token (its receive hook mints 1:1); unwrapping calls `withdraw`.
/// @dev Matches the deployed Setwise `IWrappedNativeToken` interface, which only
///      exposes `withdraw`. Kept separate so the router can unwrap native-output
///      swaps without importing a full WETH ABI.
interface IWrappedNativeToken {
    /// @notice Unwrap `amount` wrapped-native tokens into native currency.
    function withdraw(uint256 amount) external;
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISetwisePool} from "./ISetwisePool.sol";
import {ISetwisePoolRegistry} from "./ISetwisePoolRegistry.sol";
import {IRouterControl} from "./IRouterControl.sol";
import {NativeAccounting} from "./NativeToken.sol";
import {SetwiseRouterAuthorization} from "./SetwiseRouterAuthorization.sol";
import {SetwiseAssetMode, SetwiseSwap, SetwiseSwapLib} from "./SetwiseSwap.sol";

/// @title SetwiseExecutionAdapter
/// @notice The direct Set (Setwise) execution path for fixed-amount, signed
///         swaps. Issue #15 added the ERC-20 → ERC-20 mode; issue #13 adds the
///         native → ERC-20 and ERC-20 → native modes. Transient-credit
///         composition is issue #17.
/// @dev Security model, in call order. Every check precedes any approval,
///      token pull, native forwarding, or pool interaction, so a failure never
///      leaves partial state:
///      1. `onlyConfiguredChain` — the deployment is bound to one chain.
///      2. `nativeFrame(!swap.nativeIn)` — opens the call-scoped native frame.
///         A native-input swap settles its input from the attached `msg.value`;
///         every other mode rejects attached native value on a standalone call
///         (`UnexpectedNativeValue`) while `multicall` sub-calls still share the
///         caller's frame.
///      3. `onlyEnabledSetwisePool` — the governed registry must list the pool
///         as enabled and router control must not have paused/disabled the
///         Set source, before the pool address is otherwise touched.
///      4. `onlyValidSetwiseAuthorization` — the RFQ-issued EIP-712
///         authorization binds the caller/funder, recipient, assets, native
///         flags, amounts, quote ID, and deadline against the pool's current
///         `QUOTE_SIGNER`.
///      The body resolves the settlement mode from the native flags, then:
///      - ERC-20 → ERC-20: pulls the authorized input from the funding wallet,
///        grants the pool an exact per-swap allowance, calls
///        `swapExactAssetForAsset`, and clears the allowance.
///      - native → ERC-20: spends exactly `amountIn` of the frame's native bound
///        and forwards it as `msg.value` to `swapExactNativeForAsset`, which the
///        pool wraps internally. The native input can never be subsidized by a
///        pre-existing router balance because the spend is bound to this call's
///        `msg.value` plus transient credit, not `address(this).balance`.
///      - ERC-20 → native: pulls the authorized input, grants and clears the
///        exact allowance, and calls `swapExactAssetForNative`, which unwraps
///        and sends native currency to the recipient.
///      In every mode the fixed output is enforced by balance-delta measurement
///      (the recipient's ERC-20 balance, or native balance for a native output).
///      A successful pool call consumes the shared `quoteId`, so replay reverts
///      at the pool. The recipient may be the router itself, staging output for
///      future composition (issue #17); a direct execution leaves the router
///      with zero balance delta and zero allowance.
contract SetwiseExecutionAdapter is NativeAccounting, SetwiseRouterAuthorization {
    /// @notice Router-control source ID for Set liquidity.
    bytes32 public constant SETWISE_SOURCE_ID = keccak256("setwise");

    /// @notice The chain this deployment is bound to.
    uint256 public immutable configuredChainId;
    /// @notice The governed registry of permanent Set pool proxies.
    ISetwisePoolRegistry public immutable poolRegistry;
    /// @notice The router's pause / per-chain / per-source kill-switch control.
    IRouterControl public immutable routerControl;

    /// @notice The deployment or call chain differs from the configured chain.
    error WrongChain(uint256 expected, uint256 actual);
    /// @notice A constructor argument was invalid (zero registry/control).
    error InvalidAdapterConfig();
    /// @notice A fixed amount was zero.
    error ZeroAmount();
    /// @notice The measured output delta does not equal the signed fixed output.
    error SetwiseOutputMismatch(uint256 expected, uint256 actual);
    /// @notice A low-level ERC-20 transfer/transferFrom failed or returned falsy.
    error SetwiseTokenTransferFailed(address token, address from, address to, uint256 amount);
    /// @notice A low-level ERC-20 approve failed or returned falsy.
    error SetwiseApprovalFailed(address token, address spender, uint256 amount);
    /// @notice A low-level ERC-20 balanceOf query failed.
    error SetwiseBalanceQueryFailed(address token, address account);

    /// @notice Complete execution metadata for one Set swap.
    event SetwiseSwapExecuted(
        address indexed pool,
        bytes32 indexed quoteId,
        address indexed funder,
        address recipient,
        address assetIn,
        address assetOut,
        uint256 amountIn,
        uint256 amountOut
    );

    constructor(
        uint256 chainId_,
        address wrappedNative_,
        address governance_,
        address poolRegistry_,
        address routerControl_
    ) NativeAccounting(wrappedNative_, governance_) {
        if (chainId_ == 0 || chainId_ != block.chainid) {
            revert WrongChain(chainId_, block.chainid);
        }
        if (poolRegistry_ == address(0) || routerControl_ == address(0)) {
            revert InvalidAdapterConfig();
        }
        configuredChainId = chainId_;
        poolRegistry = ISetwisePoolRegistry(poolRegistry_);
        routerControl = IRouterControl(routerControl_);
    }

    modifier onlyConfiguredChain() {
        if (block.chainid != configuredChainId) {
            revert WrongChain(configuredChainId, block.chainid);
        }
        _;
    }

    /// @notice Fail-closed venue guards. Runs before the authorization check so
    ///         an unregistered pool address is never even static-called, and
    ///         long before any approval, transfer, or value forwarding.
    modifier onlyEnabledSetwisePool(SetwiseSwap calldata swap) {
        poolRegistry.requireEnabledPool(swap.pool);
        routerControl.requireRouteEligible(configuredChainId, SETWISE_SOURCE_ID);
        _;
    }

    /// @notice Execute a signed, fixed-amount Set swap across every supported
    ///         settlement mode: ERC-20 → ERC-20, native → ERC-20, and
    ///         ERC-20 → native. Native → native has no Setwise entry point and
    ///         reverts in mode resolution.
    /// @param swap The fixed swap payload. Every security-sensitive field is
    ///        bound by both the router authorization and the pool quote. For a
    ///        native leg, `assetIn`/`assetOut` carry the wrapped-native token
    ///        exactly as it appears in the signed quote.
    /// @param funder The authorized funding wallet the ERC-20 input is pulled
    ///        from. Must equal `msg.sender`; router transient credit arrives
    ///        with issue #17.
    /// @param authorizationSignature The RFQ signer's EIP-712
    ///        `SetwiseAuthorization` over this exact call context.
    /// @return amountOut The measured output delivered to `swap.recipient`,
    ///         always equal to the signed `swap.amountOut`.
    function swapSetwise(SetwiseSwap calldata swap, address funder, bytes calldata authorizationSignature)
        external
        payable
        onlyConfiguredChain
        nativeFrame(!swap.nativeIn)
        onlyEnabledSetwisePool(swap)
        onlyValidSetwiseAuthorization(swap, funder, authorizationSignature)
        returns (uint256 amountOut)
    {
        SetwiseAssetMode swapMode = SetwiseSwapLib.mode(swap);
        SetwiseSwapLib.validateNormalization(swap, wrappedNative);
        if (swap.recipient == address(0)) revert ZeroRecipient();
        if (swap.amountIn == 0 || swap.amountOut == 0) revert ZeroAmount();

        ISetwisePool pool = ISetwisePool(swap.pool);

        if (swapMode == SetwiseAssetMode.NATIVE_TO_ERC20) {
            amountOut = _executeNativeToErc20(swap, pool);
        } else if (swapMode == SetwiseAssetMode.ERC20_TO_NATIVE) {
            amountOut = _executeErc20ToNative(swap, funder, pool);
        } else {
            amountOut = _executeErc20ToErc20(swap, funder, pool);
        }

        emit SetwiseSwapExecuted(
            swap.pool, swap.quoteId, funder, swap.recipient, swap.assetIn, swap.assetOut, swap.amountIn, amountOut
        );
    }

    /// @dev ERC-20 → ERC-20: pull the authorized input, grant the pool an exact
    ///      per-swap allowance, execute the signed quote, clear the allowance,
    ///      and enforce the fixed output by the recipient's ERC-20 balance delta.
    function _executeErc20ToErc20(SetwiseSwap calldata swap, address funder, ISetwisePool pool)
        internal
        returns (uint256 amountOut)
    {
        _safeTransferFrom(swap.assetIn, funder, address(this), swap.amountIn);

        _safeApprove(swap.assetIn, address(pool), swap.amountIn);
        uint256 recipientBefore = _balanceOf(swap.assetOut, swap.recipient);
        pool.swapExactAssetForAsset(
            swap.assetIn,
            swap.assetOut,
            swap.amountIn,
            swap.amountOut,
            swap.quoteId,
            swap.deadline,
            swap.recipient,
            swap.signature,
            swap.auxiliaryData
        );
        amountOut = _balanceOf(swap.assetOut, swap.recipient) - recipientBefore;
        _safeApprove(swap.assetIn, address(pool), 0);

        if (amountOut != swap.amountOut) revert SetwiseOutputMismatch(swap.amountOut, amountOut);
    }

    /// @dev Native → ERC-20: spend exactly `amountIn` of the frame's native
    ///      bound (this call's `msg.value` plus transient credit, never a
    ///      pre-existing router balance) and forward it to the pool's native
    ///      entry point, which wraps it internally. Enforce the fixed output by
    ///      the recipient's ERC-20 balance delta. Surplus attached value is
    ///      refunded by the frame as a per-call delta.
    function _executeNativeToErc20(SetwiseSwap calldata swap, ISetwisePool pool) internal returns (uint256 amountOut) {
        _spendNative(swap.amountIn);

        uint256 recipientBefore = _balanceOf(swap.assetOut, swap.recipient);
        pool.swapExactNativeForAsset{value: swap.amountIn}(
            swap.assetOut,
            swap.amountIn,
            swap.amountOut,
            swap.quoteId,
            swap.deadline,
            swap.recipient,
            swap.signature,
            swap.auxiliaryData
        );
        amountOut = _balanceOf(swap.assetOut, swap.recipient) - recipientBefore;

        if (amountOut != swap.amountOut) revert SetwiseOutputMismatch(swap.amountOut, amountOut);
    }

    /// @dev ERC-20 → native: pull the authorized input, grant the pool an exact
    ///      per-swap allowance, and call the pool's native-output entry point,
    ///      which unwraps and sends native currency to the recipient. Clear the
    ///      allowance and enforce the fixed output by the recipient's native
    ///      balance delta. A recipient that rejects native currency reverts the
    ///      pool call; such recipients settle via a wrapped-native (ERC-20)
    ///      route instead.
    function _executeErc20ToNative(SetwiseSwap calldata swap, address funder, ISetwisePool pool)
        internal
        returns (uint256 amountOut)
    {
        _safeTransferFrom(swap.assetIn, funder, address(this), swap.amountIn);

        _safeApprove(swap.assetIn, address(pool), swap.amountIn);
        uint256 recipientBefore = swap.recipient.balance;
        pool.swapExactAssetForNative(
            swap.assetIn,
            swap.amountIn,
            swap.amountOut,
            swap.quoteId,
            swap.deadline,
            swap.recipient,
            swap.signature,
            swap.auxiliaryData
        );
        _safeApprove(swap.assetIn, address(pool), 0);
        amountOut = swap.recipient.balance - recipientBefore;

        if (amountOut != swap.amountOut) revert SetwiseOutputMismatch(swap.amountOut, amountOut);
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory result) =
            token.call(abi.encodeWithSignature("transferFrom(address,address,uint256)", from, to, amount));
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) {
            revert SetwiseTokenTransferFailed(token, from, to, amount);
        }
    }

    function _safeApprove(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory result) =
            token.call(abi.encodeWithSignature("approve(address,uint256)", spender, amount));
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) {
            revert SetwiseApprovalFailed(token, spender, amount);
        }
    }

    function _balanceOf(address token, address account) internal view returns (uint256) {
        (bool ok, bytes memory result) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", account));
        if (!ok || result.length < 32) revert SetwiseBalanceQueryFailed(token, account);
        return abi.decode(result, (uint256));
    }
}

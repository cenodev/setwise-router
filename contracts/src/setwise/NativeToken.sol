// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IWrappedNativeToken} from "./IWrappedNativeToken.sol";
import {SETWISE_NATIVE_TOKEN} from "./SetwiseSwap.sol";

/// @title NativeTokenLib
/// @notice Chain-agnostic native / wrapped-native primitives. The wrapped-native
///         token is never hardcoded here: every helper takes it as a parameter so
///         the same code serves ETH/WETH on Ethereum, Base and Robinhood Chain and
///         BNB/WBNB on BSC. The canonical internal representation of a native leg is
///         the shared `SETWISE_NATIVE_TOKEN` sentinel (`address(0)`); on-chain a
///         native leg always settles through the chain's wrapped-native token.
/// @dev Wrapping sends native currency to the wrapped-native token (its receive hook
///      mints 1:1, matching the deployed Setwise `IWrappedNativeToken`); unwrapping
///      calls `withdraw` and forwards the freed native currency.
library NativeTokenLib {
    /// @notice A native transfer (wrap, unwrap forwarding, refund, sweep) failed.
    error NativeTransferFailed(address to, uint256 amount);
    /// @notice The wrapped-native token resolved to the zero address.
    error ZeroWrappedNative();

    /// @notice Whether `asset` is the canonical native sentinel.
    function isNative(address asset) internal pure returns (bool) {
        return asset == SETWISE_NATIVE_TOKEN;
    }

    /// @notice Send `amount` native currency to `to`, reverting on failure.
    function transferNative(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert NativeTransferFailed(to, amount);
    }

    /// @notice Wrap `amount` of native currency held by this contract into
    ///         `wrappedNative` (credited to this contract).
    function wrap(address wrappedNative, uint256 amount) internal {
        if (wrappedNative == address(0)) revert ZeroWrappedNative();
        if (amount == 0) return;
        (bool ok,) = wrappedNative.call{value: amount}("");
        if (!ok) revert NativeTransferFailed(wrappedNative, amount);
    }

    /// @notice Unwrap `amount` of this contract's `wrappedNative` and forward the
    ///         freed native currency to `recipient`.
    function unwrap(address wrappedNative, uint256 amount, address recipient) internal {
        if (amount == 0) return;
        IWrappedNativeToken(wrappedNative).withdraw(amount);
        transferNative(recipient, amount);
    }
}

/// @title NativeAccounting
/// @notice Transaction-scoped value accounting for the Setwise Router. Native
///         spending is bound to the native value attached to the current top-level
///         call (`msg.value`) plus any transient credit earned earlier in the same
///         transaction; a spend that exceeds that bound always reverts. ERC-20 legs
///         stage and consume transient token credit the same way (issue #17).
///         Refunds are computed as a per-call delta (the unspent portion of the
///         caller's `msg.value`), never from `address(this).balance`, so a
///         pre-existing router balance is never swept out to a caller.
/// @dev Accounting state lives in transient storage (Cancun), so it is scoped to a
///      single transaction and is discarded on revert. Credits therefore cannot
///      cross transactions, and every credit spend is bound to the frame payer (the
///      caller that opened the frame), so credits cannot cross users either.
///      Settlement reverts on any unconsumed credit, so a staged balance can never
///      persist past the transaction that created it. Production governance
///      (issue #37) owns the `governance` role.
abstract contract NativeAccounting {
    /// @notice The chain's wrapped-native token, selected from verified chain
    ///         configuration at deploy time (never a hardcoded constant).
    address public immutable wrappedNative;
    /// @notice Role authorized to recover stuck funds via `sweep`. Placeholder for the
    ///         Safe/timelock governance wired up in issue #37.
    address public immutable governance;

    // Transient-storage slots (ERC-7201-style namespaced constants).
    bytes32 private constant _FRAME_ACTIVE_SLOT = keccak256("setwise.router.NativeAccounting.frameActive");
    bytes32 private constant _FRAME_MSG_VALUE_SLOT = keccak256("setwise.router.NativeAccounting.frameMsgValue");
    bytes32 private constant _FRAME_SPENT_SLOT = keccak256("setwise.router.NativeAccounting.frameSpent");
    bytes32 private constant _FRAME_CREDIT_SLOT = keccak256("setwise.router.NativeAccounting.frameCredit");
    bytes32 private constant _FRAME_PAYER_SLOT = keccak256("setwise.router.NativeAccounting.framePayer");
    bytes32 private constant _TOKEN_CREDIT_COUNT_SLOT = keccak256("setwise.router.NativeAccounting.tokenCreditCount");
    // Per-token credit slots are keccak256(_TOKEN_CREDIT_NAMESPACE, token); the
    // touched-token list uses keccak256(_TOKEN_CREDIT_LIST_NAMESPACE, index).
    bytes32 private constant _TOKEN_CREDIT_NAMESPACE = keccak256("setwise.router.NativeAccounting.tokenCredit");
    bytes32 private constant _TOKEN_CREDIT_LIST_NAMESPACE = keccak256("setwise.router.NativeAccounting.tokenCreditList");

    /// @notice A native frame is already active (nested top-level call or multicall).
    error NativeFrameActive();
    /// @notice No native frame is active for an operation that requires one.
    error NativeFrameInactive();
    /// @notice A spend exceeds the native value bound to the current call.
    error InsufficientNativeValue(uint256 required, uint256 available);
    /// @notice The attached `msg.value` does not match the exact required amount.
    error NativeValueMismatch(uint256 expected, uint256 provided);
    /// @notice Native value was attached to a path that settles only in ERC-20.
    error UnexpectedNativeValue(uint256 provided);
    /// @notice Credited native currency was not fully consumed by the end of the call,
    ///         which would leave a residual router balance.
    error ResidualNativeCredit(uint256 amount);
    /// @notice A token-credit spend exceeds the credit staged earlier in the frame.
    error InsufficientTokenCredit(address token, uint256 required, uint256 available);
    /// @notice Credited tokens were not fully consumed by the end of the call, which
    ///         would leave a residual router balance.
    error ResidualTokenCredit(address token, uint256 amount);
    /// @notice A credit spend was attempted by a caller other than the frame payer,
    ///         so credit can never cross users within a transaction.
    error CreditUserMismatch(address caller, address payer);
    /// @notice The caller is not the `governance` role.
    error Unauthorized();
    /// @notice A zero recipient was supplied.
    error ZeroRecipient();
    /// @notice A low-level ERC-20 transfer failed or returned a falsy result.
    error TokenTransferFailed(address token, address to, uint256 amount);

    /// @notice Emitted when native currency is wrapped into `wrappedNative`.
    event NativeWrapped(address indexed wrappedNative, uint256 amount);
    /// @notice Emitted when wrapped-native is unwrapped and forwarded as native.
    event NativeUnwrapped(address indexed wrappedNative, address indexed recipient, uint256 amount);
    /// @notice Emitted when unspent call-scoped native value is refunded to the payer.
    event NativeRefunded(address indexed payer, uint256 amount);
    /// @notice Emitted when governance recovers funds via `sweep`.
    event Swept(address indexed token, address indexed to, uint256 amount);

    constructor(address wrappedNative_, address governance_) {
        if (wrappedNative_ == address(0)) revert NativeTokenLib.ZeroWrappedNative();
        wrappedNative = wrappedNative_;
        governance = governance_;
    }

    /// @notice Accept native currency (e.g. wrapped-native `withdraw` proceeds or a
    ///         direct top-level `msg.value`).
    receive() external payable {}

    /// @notice Establish the native frame for the current top-level call. Operations
    ///         run inside the frame; the outermost caller settles it. Re-entrant
    ///         top-level frames (including nested multicalls) revert.
    /// @param rejectNativeValue When true and this call begins the frame (i.e. it is
    ///        the outermost call, not a `multicall` sub-call), revert if any native
    ///        value is attached. Used by ERC-20-only entries so a mismatched
    ///        `msg.value` always reverts, while still allowing them to run as
    ///        `multicall` sub-calls that share the caller's native value.
    modifier nativeFrame(bool rejectNativeValue) {
        bool active = _frameActive();
        if (!active) {
            if (rejectNativeValue && msg.value != 0) revert UnexpectedNativeValue(msg.value);
            _beginNativeFrame();
        }
        _;
        if (!active) _settleNativeFrame(payable(msg.sender));
    }

    /// @notice Batch self-calls under a single native frame. The attached `msg.value`
    ///         is the shared bound for every sub-call; leftover value is refunded to
    ///         the caller by per-call delta after all sub-calls succeed.
    function multicall(bytes[] calldata data) external payable returns (bytes[] memory results) {
        if (_frameActive()) revert NativeFrameActive();
        _beginNativeFrame();
        results = new bytes[](data.length);
        for (uint256 i = 0; i < data.length; ++i) {
            (bool ok, bytes memory ret) = address(this).delegatecall(data[i]);
            if (!ok) _bubbleRevert(ret);
            results[i] = ret;
        }
        _settleNativeFrame(payable(msg.sender));
    }

    /// @notice Recover `amount` of `token` (native sentinel or ERC-20) to `to`. Not
    ///         permissionless: only the `governance` role may call it, and it moves an
    ///         explicit amount rather than the router's whole balance.
    function sweep(address token, address to, uint256 amount) external {
        if (msg.sender != governance) revert Unauthorized();
        if (to == address(0)) revert ZeroRecipient();
        if (NativeTokenLib.isNative(token)) {
            NativeTokenLib.transferNative(to, amount);
        } else {
            _safeTransferToken(token, to, amount);
        }
        emit Swept(token, to, amount);
    }

    // --- native value accounting -------------------------------------------

    /// @notice Account a spend of `amount` native currency against the current frame's
    ///         bound (`msg.value` + transient credit). Reverts when the spend would
    ///         exceed the bound. The native tokens themselves are already held by the
    ///         contract (from `msg.value` or a prior credit); this only enforces the
    ///         bound so a call can never spend native it was not given.
    /// @dev Callers that reach this from an externally triggerable callback (e.g.
    ///      AMM pool swap callbacks) authenticate the callback caller themselves;
    ///      the ERC-20 credit path additionally binds every spend to the frame
    ///      payer (issue #17).
    function _spendNative(uint256 amount) internal {
        if (amount == 0) return;
        if (!_frameActive()) revert NativeFrameInactive();
        uint256 remaining = _frameMsgValue() + _frameCredit() - _frameSpent();
        if (amount > remaining) revert InsufficientNativeValue(amount, remaining);
        _tstore(_FRAME_SPENT_SLOT, _frameSpent() + amount);
    }

    /// @notice Credit `amount` of native currency received mid-transaction (e.g. an
    ///         unwrap whose output is reserved for a later leg) so a subsequent spend
    ///         in the same frame can use it without new `msg.value`.
    function _creditNative(uint256 amount) internal {
        if (amount == 0) return;
        if (!_frameActive()) revert NativeFrameInactive();
        _tstore(_FRAME_CREDIT_SLOT, _frameCredit() + amount);
    }

    // --- ERC-20 transient credit (issue #17) ---------------------------------

    /// @notice Credit `amount` of `token` received mid-transaction (a verified
    ///         balance delta measured by the caller) so a later leg in the same
    ///         frame can consume it. The credit is transaction-scoped and must be
    ///         fully consumed before the frame settles.
    function _creditToken(address token, uint256 amount) internal {
        if (amount == 0) return;
        if (!_frameActive()) revert NativeFrameInactive();
        uint256 credit = _tokenCredit(token);
        if (credit == 0) _pushCreditedToken(token);
        _tstore(_tokenCreditSlot(token), credit + amount);
    }

    /// @notice Consume `amount` of `token` from the current frame's staged credit.
    ///         Only the frame payer may consume credit, so staged value can never
    ///         cross users; the spend reverts when it exceeds the staged credit.
    ///         The tokens themselves are already held by the router (they were
    ///         credited only after a measured balance delta); this enforces the
    ///         bound so a leg can never consume credit it was not given.
    function _spendTokenCredit(address token, uint256 amount) internal {
        if (amount == 0) return;
        if (!_frameActive()) revert NativeFrameInactive();
        _requireFramePayer();
        uint256 credit = _tokenCredit(token);
        if (amount > credit) revert InsufficientTokenCredit(token, amount, credit);
        _tstore(_tokenCreditSlot(token), credit - amount);
    }

    /// @notice The outstanding `token` credit staged in the current frame.
    function _tokenCredit(address token) internal view returns (uint256 credit) {
        bytes32 slot = _tokenCreditSlot(token);
        assembly {
            credit := tload(slot)
        }
    }

    /// @notice The caller that opened the current frame. Every credit spend is
    ///         bound to this caller, so credit cannot cross users.
    function _framePayer() internal view returns (address payer) {
        bytes32 slot = _FRAME_PAYER_SLOT;
        assembly {
            payer := tload(slot)
        }
    }

    /// @dev Revert unless `msg.sender` is the frame payer.
    function _requireFramePayer() private view {
        address payer = _framePayer();
        if (msg.sender != payer) revert CreditUserMismatch(msg.sender, payer);
    }

    /// @notice Revert unless the attached `msg.value` is exactly `expected`. Used by
    ///         standalone exact-native-input entries where any surplus or shortfall is
    ///         a mismatch.
    function _requireExactNativeValue(uint256 expected) internal view {
        if (msg.value != expected) revert NativeValueMismatch(expected, msg.value);
    }

    /// @notice Wrap `amount` of the current frame's native value into `wrappedNative`.
    function _wrapFrameNative(uint256 amount) internal {
        _spendNative(amount);
        NativeTokenLib.wrap(wrappedNative, amount);
        emit NativeWrapped(wrappedNative, amount);
    }

    /// @notice Unwrap `amount` of this contract's `wrappedNative`, forwarding the freed
    ///         native currency to `recipient`.
    function _unwrapTo(address recipient, uint256 amount) internal {
        NativeTokenLib.unwrap(wrappedNative, amount, recipient);
        emit NativeUnwrapped(wrappedNative, recipient, amount);
    }

    function _beginNativeFrame() private {
        _tstore(_FRAME_ACTIVE_SLOT, 1);
        _tstore(_FRAME_MSG_VALUE_SLOT, msg.value);
        _tstore(_FRAME_SPENT_SLOT, 0);
        _tstore(_FRAME_CREDIT_SLOT, 0);
        _tstore(_FRAME_PAYER_SLOT, uint256(uint160(msg.sender)));
        _tstore(_TOKEN_CREDIT_COUNT_SLOT, 0);
    }

    /// @dev Settle the frame: require that every staged credit (native and ERC-20)
    ///      was fully consumed so no residual router balance is left, then refund
    ///      the unspent portion of the caller's `msg.value` (a per-call delta,
    ///      never `address(this).balance`).
    function _settleNativeFrame(address payable payer) private {
        uint256 msgValue = _frameMsgValue();
        uint256 spent = _frameSpent();
        uint256 credit = _frameCredit();

        uint256 spentFromMsgValue = spent > msgValue ? msgValue : spent;
        uint256 spentFromCredit = spent - spentFromMsgValue;
        if (credit != spentFromCredit) revert ResidualNativeCredit(credit - spentFromCredit);

        uint256 refund = msgValue - spentFromMsgValue;

        uint256 tokenCount = _tokenCreditCount();
        for (uint256 i = 0; i < tokenCount; ++i) {
            address token = _creditedTokenAt(i);
            uint256 outstanding = _tokenCredit(token);
            if (outstanding != 0) revert ResidualTokenCredit(token, outstanding);
        }

        _tstore(_FRAME_ACTIVE_SLOT, 0);
        _tstore(_FRAME_MSG_VALUE_SLOT, 0);
        _tstore(_FRAME_SPENT_SLOT, 0);
        _tstore(_FRAME_CREDIT_SLOT, 0);
        _tstore(_FRAME_PAYER_SLOT, 0);
        for (uint256 i = 0; i < tokenCount; ++i) {
            _tstore(_tokenCreditSlot(_creditedTokenAt(i)), 0);
            _tstore(_tokenCreditListSlot(i), 0);
        }
        _tstore(_TOKEN_CREDIT_COUNT_SLOT, 0);

        if (refund != 0) {
            NativeTokenLib.transferNative(payer, refund);
            emit NativeRefunded(payer, refund);
        }
    }

    function _frameActive() private view returns (bool active) {
        bytes32 slot = _FRAME_ACTIVE_SLOT;
        assembly {
            active := tload(slot)
        }
    }

    function _frameMsgValue() private view returns (uint256 value) {
        bytes32 slot = _FRAME_MSG_VALUE_SLOT;
        assembly {
            value := tload(slot)
        }
    }

    function _frameSpent() private view returns (uint256 value) {
        bytes32 slot = _FRAME_SPENT_SLOT;
        assembly {
            value := tload(slot)
        }
    }

    function _frameCredit() private view returns (uint256 value) {
        bytes32 slot = _FRAME_CREDIT_SLOT;
        assembly {
            value := tload(slot)
        }
    }

    /// @dev Record `token` in the frame's credited-token list (called on the first
    ///      credit for that token in the frame) so settlement can require every
    ///      staged credit to be consumed.
    function _pushCreditedToken(address token) private {
        uint256 count = _tokenCreditCount();
        _tstore(_tokenCreditListSlot(count), uint256(uint160(token)));
        _tstore(_TOKEN_CREDIT_COUNT_SLOT, count + 1);
    }

    function _tokenCreditCount() private view returns (uint256 count) {
        bytes32 slot = _TOKEN_CREDIT_COUNT_SLOT;
        assembly {
            count := tload(slot)
        }
    }

    function _creditedTokenAt(uint256 index) private view returns (address token) {
        bytes32 slot = _tokenCreditListSlot(index);
        assembly {
            token := tload(slot)
        }
    }

    function _tokenCreditSlot(address token) private pure returns (bytes32) {
        return keccak256(abi.encode(_TOKEN_CREDIT_NAMESPACE, token));
    }

    function _tokenCreditListSlot(uint256 index) private pure returns (bytes32) {
        return keccak256(abi.encode(_TOKEN_CREDIT_LIST_NAMESPACE, index));
    }

    function _tstore(bytes32 slot, uint256 value) private {
        assembly {
            tstore(slot, value)
        }
    }

    function _bubbleRevert(bytes memory data) private pure {
        assembly {
            revert(add(data, 32), mload(data))
        }
    }

    /// @notice Minimal safe ERC-20 transfer (handles missing/false return values).
    function _safeTransferToken(address token, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSignature("transfer(address,uint256)", to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) {
            revert TokenTransferFailed(token, to, amount);
        }
    }
}

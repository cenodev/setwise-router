// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISetwisePool} from "../src/setwise/ISetwisePool.sol";
import {ISetwisePoolRegistry} from "../src/setwise/ISetwisePoolRegistry.sol";
import {IRouterControl} from "../src/setwise/IRouterControl.sol";
import {IWrappedNativeToken} from "../src/setwise/IWrappedNativeToken.sol";
import {NativeAccounting} from "../src/setwise/NativeToken.sol";
import {RouterControl} from "../src/setwise/RouterControl.sol";
import {SetwiseAssetMode, SetwiseSwap, SetwiseSwapLib} from "../src/setwise/SetwiseSwap.sol";
import {SetwiseExecutionAdapter} from "../src/setwise/SetwiseExecutionAdapter.sol";
import {SetwisePoolRegistry} from "../src/setwise/SetwisePoolRegistry.sol";
import {SetwiseRouterAuthorization} from "../src/setwise/SetwiseRouterAuthorization.sol";

interface VmExecution {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function addr(uint256 privateKey) external returns (address);
    function chainId(uint256 newChainId) external;
    function deal(address who, uint256 newBalance) external;
    function expectRevert() external;
    function expectRevert(bytes calldata revertData) external;
    function prank(address caller) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory logs);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function warp(uint256 newTimestamp) external;
}

contract TestERC1967Proxy {
    bytes32 internal constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d938fcb;

    constructor(address implementation, bytes memory initializationCall) {
        assembly ("memory-safe") {
            sstore(IMPLEMENTATION_SLOT, implementation)
        }
        if (initializationCall.length != 0) {
            (bool ok, bytes memory reason) = implementation.delegatecall(initializationCall);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(reason, 0x20), mload(reason))
                }
            }
        }
    }

    fallback() external payable {
        assembly ("memory-safe") {
            let implementation := sload(IMPLEMENTATION_SLOT)
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), implementation, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }

    receive() external payable {}
}

/// @notice Minimal ERC-20 with failure toggles for adapter rejection tests.
contract MockExecutionToken {
    mapping(address account => uint256 amount) public balanceOf;
    mapping(address account => mapping(address spender => uint256 amount)) public allowance;

    bool public failTransfers;
    bool public failApprovals;
    bool public requireZeroBeforeApprove;
    uint256 public transferFee;
    address public callbackTarget;
    bytes public callbackCall;

    function mint(address account, uint256 amount) external {
        balanceOf[account] += amount;
    }

    function setFailTransfers(bool value) external {
        failTransfers = value;
    }

    function setFailApprovals(bool value) external {
        failApprovals = value;
    }

    function setRequireZeroBeforeApprove(bool value) external {
        requireZeroBeforeApprove = value;
    }

    function setTransferFee(uint256 value) external {
        transferFee = value;
    }

    function setAllowance(address owner, address spender, uint256 amount) external {
        allowance[owner][spender] = amount;
    }

    /// @notice Emulate a token with a transfer hook: on `transfer`, call into
    ///         `target` mid-transfer. Any revert bubbles with its original data.
    function setCallback(address target, bytes calldata callData) external {
        callbackTarget = target;
        callbackCall = callData;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        if (failApprovals) return false;
        if (requireZeroBeforeApprove && amount != 0 && allowance[msg.sender][spender] != 0) return false;
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (failTransfers) return false;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount - transferFee;
        _attemptCallback();
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (failTransfers) return false;
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "insufficient allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - transferFee;
        return true;
    }

    function _attemptCallback() internal {
        if (callbackTarget == address(0)) return;
        (bool ok, bytes memory reason) = callbackTarget.call(callbackCall);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(reason, 0x20), mload(reason))
            }
        }
        revert("callback unexpectedly succeeded");
    }
}

/// @notice WETH9-style wrapped-native token: wrapping mints 1:1 on receive/deposit,
///         unwrapping burns and returns native currency. Doubles as an ERC-20 so a
///         wrapped-native (ERC-20) route can pay recipients that reject native.
contract MockWrappedNative {
    mapping(address account => uint256 amount) public balanceOf;
    mapping(address account => mapping(address spender => uint256 amount)) public allowance;

    receive() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "native transfer failed");
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "insufficient allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    /// @dev Test helper: mint wrapped-native without moving native. Tests back the
    ///      token with native via `vm.deal` so `withdraw` stays solvent.
    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }
}

/// @notice A recipient that accepts native currency and records the receipt.
contract AcceptingRecipient {
    uint256 public received;

    receive() external payable {
        received += msg.value;
    }
}

/// @notice A recipient with no receive/fallback: any native transfer to it reverts.
contract RejectingRecipient {
    function noop() external pure returns (bool) {
        return true;
    }
}

/// @notice Setwise pool mock faithful to the deployed security model: it
///         verifies the EIP-712 `SwapQuote` (payer = msg.sender = the router),
///         enforces the deadline, consumes the one-time `quoteId`, then pulls
///         the fixed input and pays the fixed output.
contract MockSetwiseExecutionPool {
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant NAME_HASH = keccak256("SetwisePool");
    bytes32 internal constant VERSION_HASH = keccak256("2.0.0");

    address public immutable QUOTE_SIGNER;
    address public immutable WRAPPED_NATIVE_TOKEN;

    mapping(bytes32 quoteId => bool used) public usedQuoteIds;

    bool public tradingPaused;
    bool public underpayOutput;
    bool public overpayOutput;
    bool public underpullInput;
    address public reentryTarget;
    bytes public reentryCall;

    error MockQuoteExpired(uint256 deadline);

    constructor(address signer, address wrappedNative_) {
        QUOTE_SIGNER = signer;
        WRAPPED_NATIVE_TOKEN = wrappedNative_;
    }

    /// @notice Accept native currency freed by a wrapped-native `withdraw`.
    receive() external payable {}

    function setTradingPaused(bool paused) external {
        tradingPaused = paused;
    }

    function setUnderpayOutput(bool value) external {
        underpayOutput = value;
    }

    function setOverpayOutput(bool value) external {
        overpayOutput = value;
    }

    function setUnderpullInput(bool value) external {
        underpullInput = value;
    }

    function setReentry(address target, bytes calldata callData) external {
        reentryTarget = target;
        reentryCall = callData;
    }

    function quoteDomainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function quoteDigest(
        address payer,
        address inputAsset,
        address outputAsset,
        uint256 inputAmount,
        uint256 outputAmount,
        bytes32 quoteId,
        uint256 deadline,
        address recipient
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                SetwiseSwapLib.SWAP_QUOTE_TYPEHASH,
                payer,
                inputAsset,
                outputAsset,
                inputAmount,
                outputAmount,
                quoteId,
                deadline,
                recipient
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", quoteDomainSeparator(), structHash));
    }

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
    ) external {
        _verifyQuote(quoteId, deadline);
        bytes32 digest =
            quoteDigest(msg.sender, inputAsset, outputAsset, inputAmount, outputAmount, quoteId, deadline, recipient);
        if (!_isValidQuoteSignature(digest, signature)) revert ISetwisePool.InvalidSignature();

        usedQuoteIds[quoteId] = true;
        _attemptReentry();
        uint256 pulled = underpullInput ? inputAmount - 1 : inputAmount;
        require(MockExecutionToken(inputAsset).transferFrom(msg.sender, address(this), pulled), "pool pull");
        uint256 paid = _payout(outputAmount);
        require(MockExecutionToken(outputAsset).transfer(recipient, paid), "pool pay");
        emit ISetwisePool.SwapExecuted(inputAsset, outputAsset, recipient, inputAmount, paid, auxiliaryData);
    }

    /// @notice Native -> ERC-20. The signed quote's input asset is the wrapped-native
    ///         token; the pool wraps the attached native input and pays the ERC-20 out.
    function swapExactNativeForAsset(
        address outputAsset,
        uint256 inputAmount,
        uint256 outputAmount,
        bytes32 quoteId,
        uint256 deadline,
        address recipient,
        bytes calldata signature,
        bytes calldata auxiliaryData
    ) external payable {
        _verifyQuote(quoteId, deadline);
        bytes32 digest = quoteDigest(
            msg.sender, WRAPPED_NATIVE_TOKEN, outputAsset, inputAmount, outputAmount, quoteId, deadline, recipient
        );
        if (!_isValidQuoteSignature(digest, signature)) revert ISetwisePool.InvalidSignature();
        if (msg.value != inputAmount) revert ISetwisePool.InvalidNativeAmount(inputAmount, msg.value);

        usedQuoteIds[quoteId] = true;
        _attemptReentry();
        (bool ok,) = WRAPPED_NATIVE_TOKEN.call{value: inputAmount}("");
        require(ok, "wrap failed");
        uint256 paid = _payout(outputAmount);
        require(MockExecutionToken(outputAsset).transfer(recipient, paid), "pool pay");
        emit ISetwisePool.SwapExecuted(WRAPPED_NATIVE_TOKEN, outputAsset, recipient, inputAmount, paid, auxiliaryData);
    }

    /// @notice ERC-20 -> native. The signed quote's output asset is the wrapped-native
    ///         token; the pool pulls the ERC-20 input, unwraps, and sends native out.
    function swapExactAssetForNative(
        address inputAsset,
        uint256 inputAmount,
        uint256 outputAmount,
        bytes32 quoteId,
        uint256 deadline,
        address recipient,
        bytes calldata signature,
        bytes calldata auxiliaryData
    ) external {
        _verifyQuote(quoteId, deadline);
        bytes32 digest = quoteDigest(
            msg.sender, inputAsset, WRAPPED_NATIVE_TOKEN, inputAmount, outputAmount, quoteId, deadline, recipient
        );
        if (!_isValidQuoteSignature(digest, signature)) revert ISetwisePool.InvalidSignature();

        usedQuoteIds[quoteId] = true;
        _attemptReentry();
        uint256 pulled = underpullInput ? inputAmount - 1 : inputAmount;
        require(MockExecutionToken(inputAsset).transferFrom(msg.sender, address(this), pulled), "pool pull");
        uint256 paid = _payout(outputAmount);
        IWrappedNativeToken(WRAPPED_NATIVE_TOKEN).withdraw(paid);
        (bool ok,) = recipient.call{value: paid}("");
        require(ok, "native transfer failed");
        emit ISetwisePool.SwapExecuted(inputAsset, WRAPPED_NATIVE_TOKEN, recipient, inputAmount, paid, auxiliaryData);
    }

    /// @dev The amount the pool actually pays: the signed output, or ±1 to
    ///      emulate a pool whose delivered delta differs from the signed quote.
    function _payout(uint256 outputAmount) internal view returns (uint256) {
        if (underpayOutput) return outputAmount - 1;
        if (overpayOutput) return outputAmount + 1;
        return outputAmount;
    }

    function _verifyQuote(bytes32 quoteId, uint256 deadline) internal view {
        if (tradingPaused) revert ISetwisePool.TradingPaused();
        if (quoteId == bytes32(0)) revert ISetwisePool.InvalidQuoteId();
        if (usedQuoteIds[quoteId]) revert ISetwisePool.QuoteAlreadyUsed(quoteId);
        if (block.timestamp > deadline) revert MockQuoteExpired(deadline);
    }

    function _attemptReentry() internal {
        if (reentryTarget == address(0)) return;
        (bool ok, bytes memory reason) = reentryTarget.call(reentryCall);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(reason, 0x20), mload(reason))
            }
        }
        revert("reentry unexpectedly succeeded");
    }

    function _isValidQuoteSignature(bytes32 digest, bytes calldata signature) internal view returns (bool) {
        if (signature.length != 65) return false;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 0x20))
            v := byte(0, calldataload(add(signature.offset, 0x40)))
        }
        if (v != 27 && v != 28) return false;
        return ecrecover(digest, v, r, s) == QUOTE_SIGNER;
    }
}

/// @notice Direct ERC-20 → ERC-20 Set execution tests against the real governed
///         registry and router control (both behind ERC-1967 proxies) and a
///         signature-verifying pool mock.
contract SetwiseExecutionAdapterTest {
    VmExecution internal constant vm = VmExecution(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant SIGNER_KEY = 0xA11CE;
    uint256 internal constant CHAIN_ID = 56;
    uint256 internal constant AMOUNT_IN = 1_000_000;
    uint256 internal constant AMOUNT_OUT = 500_000_000_000_000_000;
    bytes32 internal constant QUOTE_ID = keccak256("setwise-execution-adapter-test");

    address internal constant FUNDER = address(0xF00D);
    address internal constant OTHER_CALLER = address(0xF00E);
    address internal constant RECIPIENT = address(0xBEEF);
    address internal constant OWNER = address(0x0DDB);
    address internal constant GUARDIAN = address(0x6AA9);
    address internal constant GOVERNANCE = address(0x607C);

    bytes32 internal constant EXECUTED_TOPIC =
        keccak256("SetwiseSwapExecuted(address,bytes32,address,address,address,address,uint256,uint256)");

    address internal signer;
    MockExecutionToken internal tokenIn;
    MockExecutionToken internal tokenOut;
    MockWrappedNative internal wrappedNative;
    MockSetwiseExecutionPool internal pool;
    ISetwisePoolRegistry internal registry;
    IRouterControl internal control;
    SetwiseExecutionAdapter internal adapter;

    function setUp() public {
        vm.chainId(CHAIN_ID);
        vm.warp(1_700_000_000);

        signer = vm.addr(SIGNER_KEY);
        tokenIn = new MockExecutionToken();
        tokenOut = new MockExecutionToken();
        wrappedNative = new MockWrappedNative();
        pool = new MockSetwiseExecutionPool(signer, address(wrappedNative));

        SetwisePoolRegistry registryImpl = new SetwisePoolRegistry();
        TestERC1967Proxy registryProxy = new TestERC1967Proxy(
            address(registryImpl), abi.encodeCall(SetwisePoolRegistry.initialize, (OWNER, GUARDIAN))
        );
        registry = ISetwisePoolRegistry(address(registryProxy));

        RouterControl controlImpl = new RouterControl();
        TestERC1967Proxy controlProxy =
            new TestERC1967Proxy(address(controlImpl), abi.encodeCall(RouterControl.initialize, (OWNER, GUARDIAN)));
        control = IRouterControl(address(controlProxy));

        adapter = new SetwiseExecutionAdapter(
            CHAIN_ID, address(wrappedNative), GOVERNANCE, address(registry), address(control)
        );

        vm.prank(OWNER);
        registry.addPool(address(pool));

        tokenIn.mint(FUNDER, AMOUNT_IN * 10);
        tokenOut.mint(address(pool), AMOUNT_OUT * 10);
        // Back the pool's wrapped-native liquidity so native-output unwraps are
        // solvent: mint wrapped-native to the pool and reserve native behind it.
        wrappedNative.mint(address(pool), AMOUNT_OUT * 10);
        vm.deal(address(wrappedNative), AMOUNT_OUT * 10);
        vm.prank(FUNDER);
        tokenIn.approve(address(adapter), type(uint256).max);
    }

    // --- helpers -------------------------------------------------------------

    function _swap() internal view returns (SetwiseSwap memory) {
        return SetwiseSwap({
            pool: address(pool),
            assetIn: address(tokenIn),
            assetOut: address(tokenOut),
            nativeIn: false,
            nativeOut: false,
            amountIn: AMOUNT_IN,
            amountOut: AMOUNT_OUT,
            quoteId: QUOTE_ID,
            deadline: block.timestamp + 1 days,
            recipient: RECIPIENT,
            signature: "",
            auxiliaryData: hex"726671"
        });
    }

    /// @notice A native → ERC-20 swap. The native leg's quote asset is the
    ///         wrapped-native token; the caller attaches `amountIn` native value.
    function _nativeInSwap(address recipient) internal view returns (SetwiseSwap memory) {
        return SetwiseSwap({
            pool: address(pool),
            assetIn: address(wrappedNative),
            assetOut: address(tokenOut),
            nativeIn: true,
            nativeOut: false,
            amountIn: AMOUNT_IN,
            amountOut: AMOUNT_OUT,
            quoteId: QUOTE_ID,
            deadline: block.timestamp + 1 days,
            recipient: recipient,
            signature: "",
            auxiliaryData: hex"726671"
        });
    }

    /// @notice An ERC-20 → native swap. The native leg's quote asset is the
    ///         wrapped-native token; the pool unwraps and pays native out.
    function _nativeOutSwap(address recipient) internal view returns (SetwiseSwap memory) {
        return SetwiseSwap({
            pool: address(pool),
            assetIn: address(tokenIn),
            assetOut: address(wrappedNative),
            nativeIn: false,
            nativeOut: true,
            amountIn: AMOUNT_IN,
            amountOut: AMOUNT_OUT,
            quoteId: QUOTE_ID,
            deadline: block.timestamp + 1 days,
            recipient: recipient,
            signature: "",
            auxiliaryData: hex"726671"
        });
    }

    function _poolQuote(SetwiseSwap memory swap) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            SIGNER_KEY,
            pool.quoteDigest(
                address(adapter),
                swap.assetIn,
                swap.assetOut,
                swap.amountIn,
                swap.amountOut,
                swap.quoteId,
                swap.deadline,
                swap.recipient
            )
        );
        return abi.encodePacked(r, s, v);
    }

    function _authorization(SetwiseSwap memory swap, address funder) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, adapter.setwiseAuthorizationDigest(swap, funder));
        return abi.encodePacked(r, s, v);
    }

    function _fullySignedSwap() internal returns (SetwiseSwap memory swap, bytes memory authorization) {
        swap = _swap();
        swap.signature = _poolQuote(swap);
        authorization = _authorization(swap, FUNDER);
    }

    function _execute(SetwiseSwap memory swap, bytes memory authorization) internal returns (uint256) {
        vm.prank(FUNDER);
        return adapter.swapSetwise(swap, FUNDER, authorization);
    }

    // --- acceptance: successful swaps consume exactly the authorized input ---

    function testDirectSwapConsumesExactlyAuthorizedInput() external {
        (SetwiseSwap memory swap, bytes memory authorization) = _fullySignedSwap();

        uint256 amountOut = _execute(swap, authorization);

        require(amountOut == AMOUNT_OUT, "returned output");
        require(tokenIn.balanceOf(FUNDER) == AMOUNT_IN * 9, "funder debited exactly amountIn");
        require(tokenIn.balanceOf(address(pool)) == AMOUNT_IN, "pool credited exactly amountIn");
        require(tokenOut.balanceOf(RECIPIENT) == AMOUNT_OUT, "recipient credited exactly amountOut");
        require(tokenOut.balanceOf(address(pool)) == AMOUNT_OUT * 9, "pool output debit");
        require(pool.usedQuoteIds(QUOTE_ID), "quote consumed");
    }

    // --- acceptance: router balance and allowance are zero after execution ---

    function testRouterBalanceAndAllowanceZeroAfterDirectExecution() external {
        (SetwiseSwap memory swap, bytes memory authorization) = _fullySignedSwap();
        _execute(swap, authorization);

        require(tokenIn.balanceOf(address(adapter)) == 0, "router input balance");
        require(tokenOut.balanceOf(address(adapter)) == 0, "router output balance");
        require(tokenIn.allowance(address(adapter), address(pool)) == 0, "router pool allowance");
        require(tokenOut.allowance(address(adapter), address(pool)) == 0, "router output allowance");
    }

    function testPreExistingRouterBalanceIsExcludedByCallSnapshot() external {
        uint256 preExistingBalance = 77;
        tokenIn.mint(address(adapter), preExistingBalance);
        (SetwiseSwap memory swap, bytes memory authorization) = _fullySignedSwap();

        _execute(swap, authorization);

        require(tokenIn.balanceOf(address(adapter)) == preExistingBalance, "pre-existing input balance changed");
        require(tokenIn.allowance(address(adapter), address(pool)) == 0, "router pool allowance");
        require(tokenOut.balanceOf(address(adapter)) == 0, "router output residue");
    }

    // --- acceptance: output is delivered only to the signed recipient --------

    function testOutputDeliveredOnlyToSignedRecipient() external {
        (SetwiseSwap memory swap, bytes memory authorization) = _fullySignedSwap();
        _execute(swap, authorization);

        require(tokenOut.balanceOf(RECIPIENT) == AMOUNT_OUT, "signed recipient paid");
        require(tokenOut.balanceOf(FUNDER) == 0, "funder output balance");
        require(tokenOut.balanceOf(OTHER_CALLER) == 0, "bystander output balance");
        require(tokenOut.balanceOf(address(adapter)) == 0, "router output balance");
    }

    function testRejectsModifiedRecipient() external {
        (SetwiseSwap memory swap, bytes memory authorization) = _fullySignedSwap();
        swap.recipient = OTHER_CALLER;

        vm.expectRevert(abi.encodeWithSelector(SetwiseRouterAuthorization.InvalidSetwiseAuthorization.selector));
        vm.prank(FUNDER);
        adapter.swapSetwise(swap, FUNDER, authorization);
        require(tokenIn.balanceOf(FUNDER) == AMOUNT_IN * 10, "funds moved on modified recipient");
    }

    // --- acceptance: quote replay and caller substitution revert -------------

    function testQuoteReplayReverts() external {
        (SetwiseSwap memory swap, bytes memory authorization) = _fullySignedSwap();
        _execute(swap, authorization);
        require(tokenIn.balanceOf(FUNDER) == AMOUNT_IN * 9, "first swap input");

        vm.expectRevert(abi.encodeWithSelector(ISetwisePool.QuoteAlreadyUsed.selector, QUOTE_ID));
        vm.prank(FUNDER);
        adapter.swapSetwise(swap, FUNDER, authorization);

        require(tokenIn.balanceOf(FUNDER) == AMOUNT_IN * 9, "replay moved funds");
        require(tokenIn.allowance(address(adapter), address(pool)) == 0, "replay left allowance");
    }

    function testCallerSubstitutionReverts() external {
        (SetwiseSwap memory swap, bytes memory authorization) = _fullySignedSwap();

        vm.expectRevert(
            abi.encodeWithSelector(
                SetwiseRouterAuthorization.SetwiseAuthorizationWrongCaller.selector, OTHER_CALLER, FUNDER
            )
        );
        vm.prank(OTHER_CALLER);
        adapter.swapSetwise(swap, FUNDER, authorization);

        require(tokenIn.balanceOf(FUNDER) == AMOUNT_IN * 10, "substituted caller moved funds");
        require(tokenOut.balanceOf(RECIPIENT) == 0, "substituted caller delivered output");
        require(!pool.usedQuoteIds(QUOTE_ID), "substituted caller consumed quote");
    }

    // --- acceptance: reverts leave no partial state --------------------------

    function testRevertedSwapLeavesNoPartialState() external {
        (SetwiseSwap memory swap, bytes memory authorization) = _fullySignedSwap();
        pool.setTradingPaused(true);

        vm.expectRevert(abi.encodeWithSelector(ISetwisePool.TradingPaused.selector));
        vm.prank(FUNDER);
        adapter.swapSetwise(swap, FUNDER, authorization);

        require(tokenIn.balanceOf(FUNDER) == AMOUNT_IN * 10, "funder balance restored");
        require(tokenIn.balanceOf(address(adapter)) == 0, "router input residue");
        require(tokenOut.balanceOf(address(adapter)) == 0, "router output residue");
        require(tokenOut.balanceOf(RECIPIENT) == 0, "recipient residue");
        require(tokenIn.allowance(address(adapter), address(pool)) == 0, "residual allowance");
        require(!pool.usedQuoteIds(QUOTE_ID), "quote consumed on revert");
    }

    function testMaliciousPoolUnderpullRevertsAtomically() external {
        (SetwiseSwap memory swap, bytes memory authorization) = _fullySignedSwap();
        pool.setUnderpullInput(true);

        vm.expectRevert(
            abi.encodeWithSelector(SetwiseExecutionAdapter.SetwiseInputBalanceMismatch.selector, address(tokenIn), 0, 1)
        );
        vm.prank(FUNDER);
        adapter.swapSetwise(swap, FUNDER, authorization);

        require(tokenIn.balanceOf(FUNDER) == AMOUNT_IN * 10, "underpull moved funder input");
        require(tokenIn.balanceOf(address(adapter)) == 0, "underpull left router input");
        require(tokenIn.balanceOf(address(pool)) == 0, "underpull credited pool");
        require(tokenOut.balanceOf(RECIPIENT) == 0, "underpull paid output");
        require(tokenIn.allowance(address(adapter), address(pool)) == 0, "underpull left allowance");
        require(!pool.usedQuoteIds(QUOTE_ID), "underpull consumed quote");
    }

    function testPoolReentrancyRevertsAtomically() external {
        (SetwiseSwap memory swap, bytes memory authorization) = _fullySignedSwap();
        pool.setReentry(address(adapter), abi.encodeCall(adapter.swapSetwise, (swap, FUNDER, authorization)));

        vm.expectRevert(abi.encodeWithSelector(SetwiseExecutionAdapter.ReentrantSetwiseExecution.selector));
        vm.prank(FUNDER);
        adapter.swapSetwise(swap, FUNDER, authorization);

        require(tokenIn.balanceOf(FUNDER) == AMOUNT_IN * 10, "reentrancy moved funder input");
        require(tokenIn.balanceOf(address(adapter)) == 0, "reentrancy left router input");
        require(tokenOut.balanceOf(RECIPIENT) == 0, "reentrancy paid output");
        require(tokenIn.allowance(address(adapter), address(pool)) == 0, "reentrancy left allowance");
        require(!pool.usedQuoteIds(QUOTE_ID), "reentrancy consumed quote");
    }

    // --- registry and router-control guards ----------------------------------

    function testUnregisteredPoolRevertsBeforeAuthorization() external {
        (SetwiseSwap memory swap, bytes memory authorization) = _fullySignedSwap();
        swap.pool = address(new MockSetwiseExecutionPool(signer, address(wrappedNative)));
        // Deliberately invalid authorization: the registry guard must fire first.
        vm.expectRevert(abi.encodeWithSelector(ISetwisePoolRegistry.PoolNotRegistered.selector, swap.pool));
        vm.prank(FUNDER);
        adapter.swapSetwise(swap, FUNDER, authorization);
    }

    function testDisabledPoolReverts() external {
        (SetwiseSwap memory swap, bytes memory authorization) = _fullySignedSwap();
        vm.prank(OWNER);
        registry.setPoolEnabled(address(pool), false);

        vm.expectRevert(abi.encodeWithSelector(ISetwisePoolRegistry.PoolDisabled.selector, address(pool)));
        vm.prank(FUNDER);
        adapter.swapSetwise(swap, FUNDER, authorization);
    }

    function testPausedRouterReverts() external {
        (SetwiseSwap memory swap, bytes memory authorization) = _fullySignedSwap();
        vm.prank(GUARDIAN);
        control.pause();

        vm.expectRevert(abi.encodeWithSelector(IRouterControl.RouterAlreadyPaused.selector));
        vm.prank(FUNDER);
        adapter.swapSetwise(swap, FUNDER, authorization);
    }

    function testDisabledChainReverts() external {
        (SetwiseSwap memory swap, bytes memory authorization) = _fullySignedSwap();
        vm.prank(OWNER);
        control.disableChain(CHAIN_ID);

        vm.expectRevert(abi.encodeWithSelector(IRouterControl.ChainAlreadyDisabled.selector, CHAIN_ID));
        vm.prank(FUNDER);
        adapter.swapSetwise(swap, FUNDER, authorization);
    }

    function testDisabledSourceReverts() external {
        (SetwiseSwap memory swap, bytes memory authorization) = _fullySignedSwap();
        bytes32 sourceId = adapter.SETWISE_SOURCE_ID();
        require(sourceId == keccak256("setwise"), "source id");
        vm.prank(OWNER);
        control.disableSource(CHAIN_ID, sourceId);

        vm.expectRevert(abi.encodeWithSelector(IRouterControl.SourceAlreadyDisabled.selector, CHAIN_ID, sourceId));
        vm.prank(FUNDER);
        adapter.swapSetwise(swap, FUNDER, authorization);
    }

    // --- asset modes ----------------------------------------------------------

    function testNativeToNativeReverts() external {
        SetwiseSwap memory nativeBothSwap = _swap();
        nativeBothSwap.nativeIn = true;
        nativeBothSwap.nativeOut = true;
        nativeBothSwap.assetIn = address(wrappedNative);
        nativeBothSwap.assetOut = address(wrappedNative);
        nativeBothSwap.signature = _poolQuote(nativeBothSwap);
        bytes memory nativeBothAuthorization = _authorization(nativeBothSwap, FUNDER);

        vm.expectRevert(abi.encodeWithSelector(SetwiseSwapLib.NativeToNativeUnsupported.selector));
        vm.prank(FUNDER);
        adapter.swapSetwise(nativeBothSwap, FUNDER, nativeBothAuthorization);
    }

    // --- acceptance: wrong native flags / wrapped-native addresses revert -----

    function testNativeInWrongWrappedAssetReverts() external {
        SetwiseSwap memory swap = _nativeInSwap(RECIPIENT);
        // A native leg must be the wrapped-native token, not an arbitrary ERC-20.
        swap.assetIn = address(tokenIn);
        swap.signature = _poolQuote(swap);
        bytes memory authorization = _authorization(swap, FUNDER);

        vm.expectRevert(abi.encodeWithSelector(SetwiseSwapLib.AssetNormalizationMismatch.selector));
        vm.deal(FUNDER, AMOUNT_IN);
        vm.prank(FUNDER);
        adapter.swapSetwise{value: AMOUNT_IN}(swap, FUNDER, authorization);
    }

    function testNativeOutWrongWrappedAssetReverts() external {
        SetwiseSwap memory swap = _nativeOutSwap(RECIPIENT);
        // A native leg must be the wrapped-native token, not an arbitrary ERC-20.
        swap.assetOut = address(tokenOut);
        swap.signature = _poolQuote(swap);
        bytes memory authorization = _authorization(swap, FUNDER);

        vm.expectRevert(abi.encodeWithSelector(SetwiseSwapLib.AssetNormalizationMismatch.selector));
        vm.prank(FUNDER);
        adapter.swapSetwise(swap, FUNDER, authorization);
    }

    function testNativeInSentinelAssetReverts() external {
        SetwiseSwap memory swap = _nativeInSwap(RECIPIENT);
        // The on-chain quote asset for a native leg is wrapped-native, never the
        // sentinel; the sentinel must be normalized off-chain before signing.
        swap.assetIn = address(0);
        swap.signature = _poolQuote(swap);
        bytes memory authorization = _authorization(swap, FUNDER);

        vm.expectRevert(abi.encodeWithSelector(SetwiseSwapLib.AssetNormalizationMismatch.selector));
        vm.deal(FUNDER, AMOUNT_IN);
        vm.prank(FUNDER);
        adapter.swapSetwise{value: AMOUNT_IN}(swap, FUNDER, authorization);
    }

    // --- direction: native -> erc20 -------------------------------------------

    function testNativeToErc20EoaRecipient() external {
        SetwiseSwap memory swap = _nativeInSwap(RECIPIENT);
        swap.signature = _poolQuote(swap);
        bytes memory authorization = _authorization(swap, FUNDER);

        vm.deal(FUNDER, AMOUNT_IN);
        vm.prank(FUNDER);
        uint256 amountOut = adapter.swapSetwise{value: AMOUNT_IN}(swap, FUNDER, authorization);

        require(amountOut == AMOUNT_OUT, "returned output");
        require(tokenOut.balanceOf(RECIPIENT) == AMOUNT_OUT, "recipient credited exactly amountOut");
        require(tokenOut.balanceOf(address(pool)) == AMOUNT_OUT * 9, "pool output debit");
        require(wrappedNative.balanceOf(address(pool)) == AMOUNT_OUT * 10 + AMOUNT_IN, "pool wrapped native input");
        require(address(adapter).balance == 0, "router holds no native");
        require(pool.usedQuoteIds(QUOTE_ID), "quote consumed");
    }

    function testNativeToErc20ContractRecipient() external {
        AcceptingRecipient recipient = new AcceptingRecipient();
        SetwiseSwap memory swap = _nativeInSwap(address(recipient));
        swap.signature = _poolQuote(swap);
        bytes memory authorization = _authorization(swap, FUNDER);

        vm.deal(FUNDER, AMOUNT_IN);
        vm.prank(FUNDER);
        uint256 amountOut = adapter.swapSetwise{value: AMOUNT_IN}(swap, FUNDER, authorization);

        require(amountOut == AMOUNT_OUT, "returned output");
        require(tokenOut.balanceOf(address(recipient)) == AMOUNT_OUT, "contract recipient credited");
        require(address(adapter).balance == 0, "router holds no native");
    }

    function testNativeToErc20InsufficientValueReverts() external {
        SetwiseSwap memory swap = _nativeInSwap(RECIPIENT);
        swap.signature = _poolQuote(swap);
        bytes memory authorization = _authorization(swap, FUNDER);

        vm.expectRevert(
            abi.encodeWithSelector(NativeAccounting.InsufficientNativeValue.selector, AMOUNT_IN, AMOUNT_IN - 1)
        );
        vm.deal(FUNDER, AMOUNT_IN);
        vm.prank(FUNDER);
        adapter.swapSetwise{value: AMOUNT_IN - 1}(swap, FUNDER, authorization);

        require(tokenOut.balanceOf(RECIPIENT) == 0, "recipient paid on insufficient value");
        require(!pool.usedQuoteIds(QUOTE_ID), "quote consumed on insufficient value");
    }

    function testNativeToErc20RefundsSurplusByDelta() external {
        // Pre-fund the router with native that does NOT belong to this call.
        vm.deal(address(adapter), 5 ether);

        SetwiseSwap memory swap = _nativeInSwap(RECIPIENT);
        swap.signature = _poolQuote(swap);
        bytes memory authorization = _authorization(swap, FUNDER);

        // Attach 3 ether but only spend AMOUNT_IN; the surplus must be refunded by
        // per-call delta and the pre-existing router balance left untouched.
        vm.deal(FUNDER, 3 ether);
        uint256 userBefore = FUNDER.balance;
        vm.prank(FUNDER);
        adapter.swapSetwise{value: 3 ether}(swap, FUNDER, authorization);

        require(userBefore - FUNDER.balance == AMOUNT_IN, "funder spent exactly amountIn");
        require(address(adapter).balance == 5 ether, "pre-existing router balance untouched");
        require(tokenOut.balanceOf(RECIPIENT) == AMOUNT_OUT, "recipient received erc20 out");
    }

    function testNativeToErc20OutputMismatchReverts() external {
        SetwiseSwap memory swap = _nativeInSwap(RECIPIENT);
        swap.signature = _poolQuote(swap);
        bytes memory authorization = _authorization(swap, FUNDER);
        pool.setUnderpayOutput(true);

        vm.expectRevert(
            abi.encodeWithSelector(SetwiseExecutionAdapter.SetwiseOutputMismatch.selector, AMOUNT_OUT, AMOUNT_OUT - 1)
        );
        vm.deal(FUNDER, AMOUNT_IN);
        vm.prank(FUNDER);
        adapter.swapSetwise{value: AMOUNT_IN}(swap, FUNDER, authorization);

        require(tokenOut.balanceOf(RECIPIENT) == 0, "mismatch paid recipient");
        require(address(adapter).balance == 0, "router holds native on mismatch");
        require(!pool.usedQuoteIds(QUOTE_ID), "mismatch consumed quote");
    }

    function testNativeToErc20RouterReceiptWithoutConsumerReverts() external {
        SetwiseSwap memory swap = _nativeInSwap(address(adapter));
        swap.signature = _poolQuote(swap);
        bytes memory authorization = _authorization(swap, FUNDER);

        // Router receipt stages the measured output as transaction-scoped
        // transient credit (issue #17); a standalone call never consumes it, so
        // settlement reverts instead of leaving a residual router balance.
        vm.expectRevert(
            abi.encodeWithSelector(NativeAccounting.ResidualTokenCredit.selector, address(tokenOut), AMOUNT_OUT)
        );
        vm.deal(FUNDER, AMOUNT_IN);
        vm.prank(FUNDER);
        adapter.swapSetwise{value: AMOUNT_IN}(swap, FUNDER, authorization);

        require(tokenOut.balanceOf(address(adapter)) == 0, "router output residue");
        require(address(adapter).balance == 0, "router holds no native");
        require(!pool.usedQuoteIds(QUOTE_ID), "quote consumed on revert");
    }

    // --- direction: erc20 -> native -------------------------------------------

    function testErc20ToNativeEoaRecipient() external {
        SetwiseSwap memory swap = _nativeOutSwap(RECIPIENT);
        swap.signature = _poolQuote(swap);
        bytes memory authorization = _authorization(swap, FUNDER);

        uint256 recipientBefore = RECIPIENT.balance;
        vm.prank(FUNDER);
        uint256 amountOut = adapter.swapSetwise(swap, FUNDER, authorization);

        require(amountOut == AMOUNT_OUT, "returned output");
        require(RECIPIENT.balance - recipientBefore == AMOUNT_OUT, "recipient received native out");
        require(tokenIn.balanceOf(FUNDER) == AMOUNT_IN * 9, "funder debited exactly amountIn");
        require(tokenIn.balanceOf(address(pool)) == AMOUNT_IN, "pool credited exactly amountIn");
        require(tokenIn.balanceOf(address(adapter)) == 0, "router input balance");
        require(tokenIn.allowance(address(adapter), address(pool)) == 0, "router pool allowance");
        require(address(adapter).balance == 0, "router holds no native");
        require(pool.usedQuoteIds(QUOTE_ID), "quote consumed");
    }

    function testErc20ToNativeContractRecipient() external {
        AcceptingRecipient recipient = new AcceptingRecipient();
        SetwiseSwap memory swap = _nativeOutSwap(address(recipient));
        swap.signature = _poolQuote(swap);
        bytes memory authorization = _authorization(swap, FUNDER);

        vm.prank(FUNDER);
        uint256 amountOut = adapter.swapSetwise(swap, FUNDER, authorization);

        require(amountOut == AMOUNT_OUT, "returned output");
        require(recipient.received() == AMOUNT_OUT, "contract recipient received native");
        require(address(adapter).balance == 0, "router holds no native");
    }

    function testErc20ToNativeRejectingRecipientReverts() external {
        RejectingRecipient recipient = new RejectingRecipient();
        SetwiseSwap memory swap = _nativeOutSwap(address(recipient));
        swap.signature = _poolQuote(swap);
        bytes memory authorization = _authorization(swap, FUNDER);

        // A recipient with no receive/fallback rejects the pool's native transfer,
        // reverting the whole swap with no partial state.
        vm.expectRevert();
        vm.prank(FUNDER);
        adapter.swapSetwise(swap, FUNDER, authorization);

        require(tokenIn.balanceOf(FUNDER) == AMOUNT_IN * 10, "funder balance restored");
        require(tokenIn.balanceOf(address(adapter)) == 0, "router input residue");
        require(tokenIn.allowance(address(adapter), address(pool)) == 0, "residual allowance");
        require(address(recipient).balance == 0, "rejecting recipient received native");
        require(!pool.usedQuoteIds(QUOTE_ID), "quote consumed on revert");
    }

    function testWrappedNativeRoutePaysRejectingRecipient() external {
        // The supported alternative for a recipient that rejects native: settle the
        // output leg as wrapped-native (an ERC-20) via the ERC-20 → ERC-20 path.
        RejectingRecipient recipient = new RejectingRecipient();
        SetwiseSwap memory swap = _swap();
        swap.assetOut = address(wrappedNative);
        swap.recipient = address(recipient);
        swap.signature = _poolQuote(swap);
        bytes memory authorization = _authorization(swap, FUNDER);

        vm.prank(FUNDER);
        uint256 amountOut = adapter.swapSetwise(swap, FUNDER, authorization);

        require(amountOut == AMOUNT_OUT, "returned output");
        require(wrappedNative.balanceOf(address(recipient)) == AMOUNT_OUT, "recipient credited wrapped-native");
    }

    function testErc20ToNativeRejectsAttachedValue() external {
        SetwiseSwap memory swap = _nativeOutSwap(RECIPIENT);
        swap.signature = _poolQuote(swap);
        bytes memory authorization = _authorization(swap, FUNDER);

        vm.deal(FUNDER, 1);
        vm.prank(FUNDER);
        vm.expectRevert(abi.encodeWithSelector(NativeAccounting.UnexpectedNativeValue.selector, 1));
        adapter.swapSetwise{value: 1}(swap, FUNDER, authorization);
    }

    function testErc20ToNativeOutputMismatchReverts() external {
        SetwiseSwap memory swap = _nativeOutSwap(RECIPIENT);
        swap.signature = _poolQuote(swap);
        bytes memory authorization = _authorization(swap, FUNDER);
        pool.setUnderpayOutput(true);

        vm.expectRevert(
            abi.encodeWithSelector(SetwiseExecutionAdapter.SetwiseOutputMismatch.selector, AMOUNT_OUT, AMOUNT_OUT - 1)
        );
        vm.prank(FUNDER);
        adapter.swapSetwise(swap, FUNDER, authorization);

        require(RECIPIENT.balance == 0, "mismatch paid recipient");
        require(tokenIn.balanceOf(FUNDER) == AMOUNT_IN * 10, "mismatch moved funds");
        require(tokenIn.allowance(address(adapter), address(pool)) == 0, "mismatch left allowance");
        require(!pool.usedQuoteIds(QUOTE_ID), "mismatch consumed quote");
    }

    function testNativeToErc20EmitsMetadata() external {
        SetwiseSwap memory swap = _nativeInSwap(RECIPIENT);
        swap.signature = _poolQuote(swap);
        bytes memory authorization = _authorization(swap, FUNDER);

        vm.recordLogs();
        vm.deal(FUNDER, AMOUNT_IN);
        vm.prank(FUNDER);
        adapter.swapSetwise{value: AMOUNT_IN}(swap, FUNDER, authorization);

        VmExecution.Log[] memory logs = vm.getRecordedLogs();
        uint256 found;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter != address(adapter) || logs[i].topics[0] != EXECUTED_TOPIC) continue;
            found += 1;
            (address recipient, address assetIn, address assetOut, uint256 amountIn, uint256 amountOut) =
                abi.decode(logs[i].data, (address, address, address, uint256, uint256));
            require(recipient == RECIPIENT, "recipient field");
            require(assetIn == address(wrappedNative), "assetIn is wrapped-native");
            require(assetOut == address(tokenOut), "assetOut field");
            require(amountIn == AMOUNT_IN, "amountIn field");
            require(amountOut == AMOUNT_OUT, "amountOut field");
        }
        require(found == 1, "exactly one SetwiseSwapExecuted");
    }

    function testAttachedNativeValueReverts() external {
        (SetwiseSwap memory swap, bytes memory authorization) = _fullySignedSwap();
        vm.deal(FUNDER, 1);
        vm.prank(FUNDER);
        vm.expectRevert(abi.encodeWithSelector(NativeAccounting.UnexpectedNativeValue.selector, 1));
        adapter.swapSetwise{value: 1}(swap, FUNDER, authorization);
    }

    // --- fixed-result enforcement ---------------------------------------------

    function testOutputDeltaMismatchReverts() external {
        (SetwiseSwap memory swap, bytes memory authorization) = _fullySignedSwap();
        pool.setUnderpayOutput(true);

        vm.expectRevert(
            abi.encodeWithSelector(SetwiseExecutionAdapter.SetwiseOutputMismatch.selector, AMOUNT_OUT, AMOUNT_OUT - 1)
        );
        vm.prank(FUNDER);
        adapter.swapSetwise(swap, FUNDER, authorization);

        require(tokenIn.balanceOf(FUNDER) == AMOUNT_IN * 10, "mismatch moved funds");
        require(tokenOut.balanceOf(RECIPIENT) == 0, "mismatch paid recipient");
        require(tokenIn.allowance(address(adapter), address(pool)) == 0, "mismatch left allowance");
        require(!pool.usedQuoteIds(QUOTE_ID), "mismatch consumed quote");
    }

    function testZeroRecipientReverts() external {
        SetwiseSwap memory swap = _swap();
        swap.recipient = address(0);
        swap.signature = _poolQuote(swap);
        bytes memory authorization = _authorization(swap, FUNDER);

        vm.expectRevert(abi.encodeWithSelector(NativeAccounting.ZeroRecipient.selector));
        vm.prank(FUNDER);
        adapter.swapSetwise(swap, FUNDER, authorization);
    }

    function testZeroAmountsRevert() external {
        SetwiseSwap memory zeroIn = _swap();
        zeroIn.amountIn = 0;
        zeroIn.signature = _poolQuote(zeroIn);
        bytes memory zeroInAuthorization = _authorization(zeroIn, FUNDER);
        vm.expectRevert(abi.encodeWithSelector(SetwiseExecutionAdapter.ZeroAmount.selector));
        vm.prank(FUNDER);
        adapter.swapSetwise(zeroIn, FUNDER, zeroInAuthorization);

        SetwiseSwap memory zeroOut = _swap();
        zeroOut.amountOut = 0;
        zeroOut.quoteId = keccak256("zero-out");
        zeroOut.signature = _poolQuote(zeroOut);
        bytes memory zeroOutAuthorization = _authorization(zeroOut, FUNDER);
        vm.expectRevert(abi.encodeWithSelector(SetwiseExecutionAdapter.ZeroAmount.selector));
        vm.prank(FUNDER);
        adapter.swapSetwise(zeroOut, FUNDER, zeroOutAuthorization);
    }

    // --- router receipt stages transient credit for in-transaction composition ---

    function testRouterReceiptWithoutConsumerReverts() external {
        SetwiseSwap memory swap = _swap();
        swap.recipient = address(adapter);
        swap.signature = _poolQuote(swap);
        bytes memory authorization = _authorization(swap, FUNDER);

        // Router receipt stages the measured output as transaction-scoped
        // transient credit (issue #17); it must be consumed by a later leg in
        // the same transaction or settlement reverts atomically.
        vm.expectRevert(
            abi.encodeWithSelector(NativeAccounting.ResidualTokenCredit.selector, address(tokenOut), AMOUNT_OUT)
        );
        vm.prank(FUNDER);
        adapter.swapSetwise(swap, FUNDER, authorization);

        require(tokenOut.balanceOf(address(adapter)) == 0, "router output residue");
        require(tokenOut.balanceOf(FUNDER) == 0, "funder output balance");
        require(tokenIn.balanceOf(address(adapter)) == 0, "router input balance");
        require(tokenIn.allowance(address(adapter), address(pool)) == 0, "router pool allowance");
        require(!pool.usedQuoteIds(QUOTE_ID), "quote consumed on revert");
    }

    function testMulticallSubCallSharesNativeFrame() external {
        (SetwiseSwap memory swap, bytes memory authorization) = _fullySignedSwap();
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(adapter.swapSetwise, (swap, FUNDER, authorization));

        vm.prank(FUNDER);
        bytes[] memory results = adapter.multicall(calls);

        require(abi.decode(results[0], (uint256)) == AMOUNT_OUT, "multicall result");
        require(tokenOut.balanceOf(RECIPIENT) == AMOUNT_OUT, "multicall output");
    }

    // --- authorization lifecycle ----------------------------------------------

    function testExpiredAuthorizationReverts() external {
        (SetwiseSwap memory swap, bytes memory authorization) = _fullySignedSwap();
        vm.warp(swap.deadline + 1);

        vm.expectRevert(
            abi.encodeWithSelector(SetwiseRouterAuthorization.SetwiseAuthorizationExpired.selector, swap.deadline)
        );
        vm.prank(FUNDER);
        adapter.swapSetwise(swap, FUNDER, authorization);
        require(tokenIn.balanceOf(FUNDER) == AMOUNT_IN * 10, "expired moved funds");
    }

    function testModifiedInputAmountReverts() external {
        (SetwiseSwap memory swap, bytes memory authorization) = _fullySignedSwap();
        swap.amountIn += 1;

        vm.expectRevert(abi.encodeWithSelector(SetwiseRouterAuthorization.InvalidSetwiseAuthorization.selector));
        vm.prank(FUNDER);
        adapter.swapSetwise(swap, FUNDER, authorization);
        require(tokenIn.balanceOf(FUNDER) == AMOUNT_IN * 10, "modified amount moved funds");
    }

    function testWrongChainRevertsBeforeAuthorization() external {
        (SetwiseSwap memory swap, bytes memory authorization) = _fullySignedSwap();
        vm.chainId(CHAIN_ID + 1);

        vm.expectRevert(abi.encodeWithSelector(SetwiseExecutionAdapter.WrongChain.selector, CHAIN_ID, CHAIN_ID + 1));
        vm.prank(FUNDER);
        adapter.swapSetwise(swap, FUNDER, authorization);
    }

    // --- token transfer/approval failures --------------------------------------

    function testInputTransferFailureReverts() external {
        (SetwiseSwap memory swap, bytes memory authorization) = _fullySignedSwap();
        tokenIn.setFailTransfers(true);

        vm.expectRevert(
            abi.encodeWithSelector(
                SetwiseExecutionAdapter.SetwiseTokenTransferFailed.selector,
                address(tokenIn),
                FUNDER,
                address(adapter),
                AMOUNT_IN
            )
        );
        vm.prank(FUNDER);
        adapter.swapSetwise(swap, FUNDER, authorization);
    }

    function testApproveFailureReverts() external {
        (SetwiseSwap memory swap, bytes memory authorization) = _fullySignedSwap();
        tokenIn.setFailApprovals(true);

        vm.expectRevert(
            abi.encodeWithSelector(
                SetwiseExecutionAdapter.SetwiseApprovalFailed.selector, address(tokenIn), address(pool), AMOUNT_IN
            )
        );
        vm.prank(FUNDER);
        adapter.swapSetwise(swap, FUNDER, authorization);

        require(tokenIn.balanceOf(FUNDER) == AMOUNT_IN * 10, "approval failure moved funds");
    }

    function testForceApproveResetsUsdtStyleAllowance() external {
        tokenIn.setRequireZeroBeforeApprove(true);
        tokenIn.setAllowance(address(adapter), address(pool), 1);
        (SetwiseSwap memory swap, bytes memory authorization) = _fullySignedSwap();

        _execute(swap, authorization);

        require(tokenIn.balanceOf(FUNDER) == AMOUNT_IN * 9, "funder input");
        require(tokenIn.balanceOf(address(adapter)) == 0, "router input residue");
        require(tokenIn.allowance(address(adapter), address(pool)) == 0, "allowance not cleared");
    }

    function testFeeOnTransferInputRevertsBeforePoolCall() external {
        tokenIn.setTransferFee(1);
        (SetwiseSwap memory swap, bytes memory authorization) = _fullySignedSwap();

        vm.expectRevert(
            abi.encodeWithSelector(
                SetwiseExecutionAdapter.SetwiseInputBalanceMismatch.selector, address(tokenIn), AMOUNT_IN, AMOUNT_IN - 1
            )
        );
        vm.prank(FUNDER);
        adapter.swapSetwise(swap, FUNDER, authorization);

        require(tokenIn.balanceOf(FUNDER) == AMOUNT_IN * 10, "fee token moved funder input");
        require(tokenIn.balanceOf(address(adapter)) == 0, "fee token left router input");
        require(tokenIn.balanceOf(address(pool)) == 0, "fee token reached pool");
        require(tokenIn.allowance(address(adapter), address(pool)) == 0, "fee token left allowance");
        require(!pool.usedQuoteIds(QUOTE_ID), "fee token consumed quote");
    }

    function testFalseReturningOutputRevertsAtomically() external {
        tokenOut.setFailTransfers(true);
        (SetwiseSwap memory swap, bytes memory authorization) = _fullySignedSwap();

        vm.expectRevert();
        vm.prank(FUNDER);
        adapter.swapSetwise(swap, FUNDER, authorization);

        require(tokenIn.balanceOf(FUNDER) == AMOUNT_IN * 10, "false output moved funder input");
        require(tokenIn.balanceOf(address(adapter)) == 0, "false output left router input");
        require(tokenIn.balanceOf(address(pool)) == 0, "false output credited pool");
        require(tokenOut.balanceOf(RECIPIENT) == 0, "false output paid recipient");
        require(tokenIn.allowance(address(adapter), address(pool)) == 0, "false output left allowance");
        require(!pool.usedQuoteIds(QUOTE_ID), "false output consumed quote");
    }

    // --- execution metadata ------------------------------------------------------

    function testEmitsCompleteExecutionMetadata() external {
        (SetwiseSwap memory swap, bytes memory authorization) = _fullySignedSwap();

        vm.recordLogs();
        _execute(swap, authorization);

        VmExecution.Log[] memory logs = vm.getRecordedLogs();
        uint256 found;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter != address(adapter) || logs[i].topics[0] != EXECUTED_TOPIC) continue;
            found += 1;
            require(logs[i].topics.length == 4, "indexed topic count");
            require(address(uint160(uint256(logs[i].topics[1]))) == address(pool), "pool topic");
            require(logs[i].topics[2] == QUOTE_ID, "quoteId topic");
            require(address(uint160(uint256(logs[i].topics[3]))) == FUNDER, "funder topic");
            (address recipient, address assetIn, address assetOut, uint256 amountIn, uint256 amountOut) =
                abi.decode(logs[i].data, (address, address, address, uint256, uint256));
            require(recipient == RECIPIENT, "recipient field");
            require(assetIn == address(tokenIn), "assetIn field");
            require(assetOut == address(tokenOut), "assetOut field");
            require(amountIn == AMOUNT_IN, "amountIn field");
            require(amountOut == AMOUNT_OUT, "amountOut field");
        }
        require(found == 1, "exactly one SetwiseSwapExecuted");
    }

    // --- deployment configuration -------------------------------------------------

    function testConstructorRejectsWrongChain() external {
        vm.expectRevert(abi.encodeWithSelector(SetwiseExecutionAdapter.WrongChain.selector, CHAIN_ID + 1, CHAIN_ID));
        new SetwiseExecutionAdapter(
            CHAIN_ID + 1, address(wrappedNative), GOVERNANCE, address(registry), address(control)
        );

        vm.expectRevert(abi.encodeWithSelector(SetwiseExecutionAdapter.WrongChain.selector, 0, CHAIN_ID));
        new SetwiseExecutionAdapter(0, address(wrappedNative), GOVERNANCE, address(registry), address(control));
    }

    function testConstructorRejectsZeroRegistryOrControl() external {
        vm.expectRevert(abi.encodeWithSelector(SetwiseExecutionAdapter.InvalidAdapterConfig.selector));
        new SetwiseExecutionAdapter(CHAIN_ID, address(wrappedNative), GOVERNANCE, address(0), address(control));

        vm.expectRevert(abi.encodeWithSelector(SetwiseExecutionAdapter.InvalidAdapterConfig.selector));
        new SetwiseExecutionAdapter(CHAIN_ID, address(wrappedNative), GOVERNANCE, address(registry), address(0));
    }
}

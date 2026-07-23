// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    MockExecutionToken,
    MockSetwiseExecutionPool,
    MockWrappedNative,
    TestERC1967Proxy
} from "./SetwiseExecutionAdapter.t.sol";
import {IRouterControl} from "../src/setwise/IRouterControl.sol";
import {ISetwisePoolRegistry} from "../src/setwise/ISetwisePoolRegistry.sol";
import {RouterControl} from "../src/setwise/RouterControl.sol";
import {SetwiseExecutionAdapter} from "../src/setwise/SetwiseExecutionAdapter.sol";
import {SetwisePoolRegistry} from "../src/setwise/SetwisePoolRegistry.sol";
import {SetwiseSwap} from "../src/setwise/SetwiseSwap.sol";

interface VmSetwiseInvariant {
    function addr(uint256 privateKey) external returns (address);
    function chainId(uint256 newChainId) external;
    function deal(address who, uint256 newBalance) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function warp(uint256 newTimestamp) external;
}

/// @notice Stateful handler exercised by Foundry across arbitrary multicall
///         sequences and normal, reverting, and adversarial pool/token modes.
contract SetwiseExecutionInvariantHandler {
    VmSetwiseInvariant private constant vm =
        VmSetwiseInvariant(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant SIGNER_KEY = 0xA11CE;
    uint256 private constant AMOUNT_IN = 1_000_000;
    uint256 private constant AMOUNT_OUT = 500_000;
    address private constant RECIPIENT = address(0xBEEF);

    SetwiseExecutionAdapter private immutable adapter;
    MockSetwiseExecutionPool private immutable pool;
    MockExecutionToken private immutable tokenIn;
    MockExecutionToken private immutable tokenOut;
    MockWrappedNative private immutable wrappedNative;

    uint256 private nonce;

    constructor(
        SetwiseExecutionAdapter adapter_,
        MockSetwiseExecutionPool pool_,
        MockExecutionToken tokenIn_,
        MockExecutionToken tokenOut_,
        MockWrappedNative wrappedNative_
    ) {
        adapter = adapter_;
        pool = pool_;
        tokenIn = tokenIn_;
        tokenOut = tokenOut_;
        wrappedNative = wrappedNative_;
        tokenIn.approve(address(adapter_), type(uint256).max);
    }

    receive() external payable {}

    /// @dev `modeSeed` selects ERC-20→ERC-20, native→ERC-20, or
    ///      ERC-20→native. `behaviorSeed` selects success, output mismatch,
    ///      pool underpull, reentrancy, fee-on-transfer, false transfer,
    ///      false approval, false output, or USDT-style force approval.
    function executeAdversarialMulticall(uint8 modeSeed, uint8 behaviorSeed, uint8 lengthSeed) external {
        uint256 mode = uint256(modeSeed) % 3;
        uint256 behavior = uint256(behaviorSeed) % 9;
        uint256 length = (uint256(lengthSeed) % 4) + 1;
        if (mode == 1 && (behavior == 2 || behavior == 6 || behavior == 8)) behavior = 1;
        if (mode == 2 && behavior == 7) behavior = 1;

        bytes[] memory calls = new bytes[](length);
        uint256 attachedValue;
        SetwiseSwap memory firstSwap;
        bytes memory firstAuthorization;

        for (uint256 i = 0; i < length; ++i) {
            SetwiseSwap memory swap = _swap(mode);
            swap.signature = _poolQuote(swap);
            bytes memory authorization = _authorization(swap);
            calls[i] = abi.encodeCall(adapter.swapSetwise, (swap, address(this), authorization));
            if (i == 0) {
                firstSwap = swap;
                firstAuthorization = authorization;
            }
            if (mode == 1) attachedValue += AMOUNT_IN;
        }

        _configureAdversary(behavior, firstSwap, firstAuthorization);
        try adapter.multicall{value: attachedValue}(calls) returns (bytes[] memory) {} catch {}
        _resetAdversary();
    }

    function _swap(uint256 mode) private returns (SetwiseSwap memory swap) {
        swap = SetwiseSwap({
            pool: address(pool),
            assetIn: mode == 1 ? address(wrappedNative) : address(tokenIn),
            assetOut: mode == 2 ? address(wrappedNative) : address(tokenOut),
            nativeIn: mode == 1,
            nativeOut: mode == 2,
            amountIn: AMOUNT_IN,
            amountOut: AMOUNT_OUT,
            quoteId: keccak256(abi.encode(address(this), ++nonce)),
            deadline: block.timestamp + 1 days,
            recipient: RECIPIENT,
            signature: "",
            auxiliaryData: hex"726671"
        });
    }

    /// @dev Issue #17: fuzz create/consume ordering for transient-credit
    ///      composition. Mode 0 stages ERC-20 credit (tokenIn -> tokenOut to the
    ///      router) and consumes it (tokenOut -> tokenIn, router funder); mode 1
    ///      stages native credit (tokenIn -> native to the router) and consumes
    ///      it (native -> tokenOut, no new msg.value). Only sequences whose
    ///      every prefix stages at least as much as it consumes and whose totals
    ///      match exactly can succeed; every other ordering reverts atomically,
    ///      which the balance/allowance invariants verify after each run.
    function executeCompositionMulticall(uint8 sequenceSeed, uint8 modeSeed) external {
        uint256 length = (uint256(sequenceSeed) % 4) + 1;
        uint256 mode = uint256(modeSeed) % 2;

        bytes[] memory calls = new bytes[](length);
        for (uint256 i = 0; i < length; ++i) {
            bool create = ((uint256(sequenceSeed) >> (8 + i)) & 1) == 1;
            calls[i] = create ? _compositionCreateCall(mode) : _compositionConsumeCall(mode);
        }
        try adapter.multicall(calls) returns (bytes[] memory) {} catch {}
    }

    function _compositionCreateCall(uint256 mode) private returns (bytes memory) {
        SetwiseSwap memory swap = _swap(mode == 1 ? 2 : 0);
        swap.recipient = address(adapter);
        swap.signature = _poolQuote(swap);
        return abi.encodeCall(adapter.swapSetwise, (swap, address(this), _authorizationFor(swap, address(this))));
    }

    function _compositionConsumeCall(uint256 mode) private returns (bytes memory) {
        SetwiseSwap memory swap = _swap(mode == 1 ? 1 : 0);
        swap.assetIn = mode == 1 ? address(wrappedNative) : address(tokenOut);
        swap.assetOut = mode == 1 ? address(tokenOut) : address(tokenIn);
        swap.amountIn = AMOUNT_OUT;
        swap.amountOut = mode == 1 ? AMOUNT_OUT : AMOUNT_IN;
        swap.signature = _poolQuote(swap);
        return abi.encodeCall(adapter.swapSetwise, (swap, address(adapter), _authorizationFor(swap, address(adapter))));
    }

    function _poolQuote(SetwiseSwap memory swap) private returns (bytes memory) {
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

    function _authorization(SetwiseSwap memory swap) private returns (bytes memory) {
        return _authorizationFor(swap, address(this));
    }

    function _authorizationFor(SetwiseSwap memory swap, address funder) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, adapter.setwiseAuthorizationDigest(swap, funder));
        return abi.encodePacked(r, s, v);
    }

    function _configureAdversary(uint256 behavior, SetwiseSwap memory firstSwap, bytes memory firstAuthorization)
        private
    {
        if (behavior == 1) {
            pool.setUnderpayOutput(true);
        } else if (behavior == 2) {
            pool.setUnderpullInput(true);
        } else if (behavior == 3) {
            pool.setReentry(
                address(adapter), abi.encodeCall(adapter.swapSetwise, (firstSwap, address(this), firstAuthorization))
            );
        } else if (behavior == 4) {
            tokenIn.setTransferFee(1);
        } else if (behavior == 5) {
            tokenIn.setFailTransfers(true);
        } else if (behavior == 6) {
            tokenIn.setFailApprovals(true);
        } else if (behavior == 7) {
            tokenOut.setFailTransfers(true);
        } else if (behavior == 8) {
            tokenIn.setRequireZeroBeforeApprove(true);
            tokenIn.setAllowance(address(adapter), address(pool), 1);
        }
    }

    function _resetAdversary() private {
        pool.setUnderpayOutput(false);
        pool.setUnderpullInput(false);
        pool.setReentry(address(0), "");
        tokenIn.setTransferFee(0);
        tokenIn.setFailTransfers(false);
        tokenIn.setFailApprovals(false);
        tokenIn.setRequireZeroBeforeApprove(false);
        tokenOut.setFailTransfers(false);
    }
}

/// @notice Issue #14 invariant suite. Foundry repeatedly calls the handler with
///         arbitrary modes, adversaries, and multicall lengths, checking after
///         every sequence that no call-scoped asset or pool allowance remains.
contract SetwiseExecutionInvariantTest {
    VmSetwiseInvariant private constant vm =
        VmSetwiseInvariant(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant SIGNER_KEY = 0xA11CE;
    uint256 private constant CHAIN_ID = 56;
    uint256 private constant INPUT_BASELINE = 77;
    uint256 private constant OUTPUT_BASELINE = 91;
    uint256 private constant WRAPPED_BASELINE = 103;
    uint256 private constant NATIVE_BASELINE = 1 ether;

    MockExecutionToken private tokenIn;
    MockExecutionToken private tokenOut;
    MockWrappedNative private wrappedNative;
    MockSetwiseExecutionPool private pool;
    SetwiseExecutionAdapter private adapter;
    address[] private invariantTargets;

    function setUp() public {
        vm.chainId(CHAIN_ID);
        vm.warp(1_700_000_000);

        tokenIn = new MockExecutionToken();
        tokenOut = new MockExecutionToken();
        wrappedNative = new MockWrappedNative();
        pool = new MockSetwiseExecutionPool(vm.addr(SIGNER_KEY), address(wrappedNative));

        SetwisePoolRegistry registryImpl = new SetwisePoolRegistry();
        TestERC1967Proxy registryProxy = new TestERC1967Proxy(
            address(registryImpl), abi.encodeCall(SetwisePoolRegistry.initialize, (address(this), address(this)))
        );
        ISetwisePoolRegistry registry = ISetwisePoolRegistry(address(registryProxy));

        RouterControl controlImpl = new RouterControl();
        TestERC1967Proxy controlProxy = new TestERC1967Proxy(
            address(controlImpl), abi.encodeCall(RouterControl.initialize, (address(this), address(this)))
        );
        IRouterControl control = IRouterControl(address(controlProxy));

        adapter = new SetwiseExecutionAdapter(
            CHAIN_ID, address(wrappedNative), address(this), address(registry), address(control)
        );
        registry.addPool(address(pool));

        SetwiseExecutionInvariantHandler handler =
            new SetwiseExecutionInvariantHandler(adapter, pool, tokenIn, tokenOut, wrappedNative);

        tokenIn.mint(address(handler), type(uint128).max);
        tokenOut.mint(address(pool), type(uint128).max);
        wrappedNative.mint(address(pool), type(uint128).max);
        vm.deal(address(wrappedNative), type(uint128).max);
        vm.deal(address(handler), 1_000_000 ether);

        tokenIn.mint(address(adapter), INPUT_BASELINE);
        tokenOut.mint(address(adapter), OUTPUT_BASELINE);
        wrappedNative.mint(address(adapter), WRAPPED_BASELINE);
        vm.deal(address(adapter), NATIVE_BASELINE);

        invariantTargets.push(address(handler));
    }

    function targetContracts() external view returns (address[] memory) {
        return invariantTargets;
    }

    function invariantRouterBalancesRemainAtTheirSnapshots() external view {
        require(tokenIn.balanceOf(address(adapter)) == INPUT_BASELINE, "input residue");
        require(tokenOut.balanceOf(address(adapter)) == OUTPUT_BASELINE, "output residue");
        require(wrappedNative.balanceOf(address(adapter)) == WRAPPED_BASELINE, "wrapped residue");
        require(address(adapter).balance == NATIVE_BASELINE, "native residue");
    }

    function invariantPoolAllowancesAreAlwaysZero() external view {
        require(tokenIn.allowance(address(adapter), address(pool)) == 0, "input allowance");
        require(tokenOut.allowance(address(adapter), address(pool)) == 0, "output allowance");
        require(wrappedNative.allowance(address(adapter), address(pool)) == 0, "wrapped allowance");
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    MockExecutionToken,
    MockSetwiseExecutionPool,
    MockWrappedNative,
    TestERC1967Proxy
} from "./SetwiseExecutionAdapter.t.sol";
import {ISetwisePoolRegistry} from "../src/setwise/ISetwisePoolRegistry.sol";
import {IRouterControl} from "../src/setwise/IRouterControl.sol";
import {NativeAccounting} from "../src/setwise/NativeToken.sol";
import {RouterControl} from "../src/setwise/RouterControl.sol";
import {SetwiseExecutionAdapter} from "../src/setwise/SetwiseExecutionAdapter.sol";
import {SetwisePoolRegistry} from "../src/setwise/SetwisePoolRegistry.sol";
import {SetwiseRouterAuthorization} from "../src/setwise/SetwiseRouterAuthorization.sol";
import {SetwiseSwap} from "../src/setwise/SetwiseSwap.sol";

interface VmTransientCredit {
    function addr(uint256 privateKey) external returns (address);
    function chainId(uint256 newChainId) external;
    function deal(address who, uint256 newBalance) external;
    function expectRevert(bytes calldata revertData) external;
    function prank(address caller) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function warp(uint256 newTimestamp) external;
}

/// @notice Exposes the transient credit ledger directly so frame-payer and
///         frame-active rules can be exercised without a full swap.
contract TransientCreditHarness is NativeAccounting {
    constructor(address wrappedNative_, address governance_) NativeAccounting(wrappedNative_, governance_) {}

    /// @notice Stage token credit inside a frame and settle it (consumed == 0,
    ///         so settlement always reverts; used only through `multicall`-style
    ///         compositions or revert assertions).
    function stageCredit(address token, uint256 amount) external payable nativeFrame(false) {
        _creditToken(token, amount);
    }

    /// @notice Consume staged token credit inside the current frame.
    function consumeCredit(address token, uint256 amount) external payable nativeFrame(false) {
        _spendTokenCredit(token, amount);
    }

    /// @notice Stage credit, then let another contract try to consume it. The
    ///         delegate call runs with `msg.sender == spender`, not the frame
    ///         payer, so the spend must revert with `CreditUserMismatch`.
    function creditThenDelegateSpend(address token, uint256 amount, address spender) external payable nativeFrame(false) {
        _creditToken(token, amount);
        (bool ok, bytes memory reason) =
            spender.call(abi.encodeCall(CreditSpender.spend, (address(this), token, amount)));
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(reason, 0x20), mload(reason))
            }
        }
        revert("cross-user spend unexpectedly succeeded");
    }

    /// @notice Frame-free credit entry points to prove the ledger requires an
    ///         active frame.
    function stageCreditNoFrame(address token, uint256 amount) external {
        _creditToken(token, amount);
    }

    function consumeCreditNoFrame(address token, uint256 amount) external {
        _spendTokenCredit(token, amount);
    }
}

/// @notice Stands in for a mid-frame caller that is not the frame payer.
contract CreditSpender {
    function spend(address harness, address token, uint256 amount) external {
        TransientCreditHarness(payable(harness)).consumeCredit(token, amount);
    }
}

/// @notice Issue #17: transaction-scoped transient credit and composition for
///         fixed-amount Set legs. A leg whose signed recipient is the router
///         stages its measured output delta as transient credit; a later leg in
///         the same transaction whose signed funder is the router consumes that
///         credit. Credits can never cross transactions or users, variable
///         output can never stage credit, and any unconsumed credit reverts.
contract SetwiseTransientCreditTest {
    VmTransientCredit internal constant vm =
        VmTransientCredit(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant SIGNER_KEY = 0xA11CE;
    uint256 internal constant CHAIN_ID = 56;
    uint256 internal constant AMOUNT_IN = 1_000_000;
    uint256 internal constant AMOUNT_MID = 500_000_000_000_000_000;
    uint256 internal constant AMOUNT_OUT = 250_000;

    address internal constant FUNDER = address(0xF00D);
    address internal constant RECIPIENT = address(0xBEEF);
    address internal constant OWNER = address(0x0DDB);
    address internal constant GUARDIAN = address(0x6AA9);
    address internal constant GOVERNANCE = address(0x607C);

    address internal signer;
    MockExecutionToken internal tokenA;
    MockExecutionToken internal tokenB;
    MockExecutionToken internal tokenC;
    MockWrappedNative internal wrappedNative;
    MockSetwiseExecutionPool internal pool;
    SetwiseExecutionAdapter internal adapter;

    function setUp() public {
        vm.chainId(CHAIN_ID);
        vm.warp(1_700_000_000);

        signer = vm.addr(SIGNER_KEY);
        tokenA = new MockExecutionToken();
        tokenB = new MockExecutionToken();
        tokenC = new MockExecutionToken();
        wrappedNative = new MockWrappedNative();
        pool = new MockSetwiseExecutionPool(signer, address(wrappedNative));

        SetwisePoolRegistry registryImpl = new SetwisePoolRegistry();
        TestERC1967Proxy registryProxy = new TestERC1967Proxy(
            address(registryImpl), abi.encodeCall(SetwisePoolRegistry.initialize, (OWNER, GUARDIAN))
        );
        ISetwisePoolRegistry registry = ISetwisePoolRegistry(address(registryProxy));

        RouterControl controlImpl = new RouterControl();
        TestERC1967Proxy controlProxy =
            new TestERC1967Proxy(address(controlImpl), abi.encodeCall(RouterControl.initialize, (OWNER, GUARDIAN)));
        IRouterControl control = IRouterControl(address(controlProxy));

        adapter = new SetwiseExecutionAdapter(
            CHAIN_ID, address(wrappedNative), GOVERNANCE, address(registry), address(control)
        );

        vm.prank(OWNER);
        registry.addPool(address(pool));

        tokenA.mint(FUNDER, AMOUNT_IN * 16);
        tokenB.mint(address(pool), AMOUNT_MID * 16);
        tokenC.mint(address(pool), AMOUNT_OUT * 16);
        // Back native-output unwraps: mint wrapped-native to the pool and reserve
        // native currency behind it.
        wrappedNative.mint(address(pool), AMOUNT_MID * 16);
        vm.deal(address(wrappedNative), AMOUNT_MID * 16);
        vm.prank(FUNDER);
        tokenA.approve(address(adapter), type(uint256).max);
    }

    // --- helpers -------------------------------------------------------------

    function _erc20Swap(address assetIn, address assetOut, uint256 amountIn, uint256 amountOut, address recipient)
        internal
        view
        returns (SetwiseSwap memory)
    {
        return SetwiseSwap({
            pool: address(pool),
            assetIn: assetIn,
            assetOut: assetOut,
            nativeIn: false,
            nativeOut: false,
            amountIn: amountIn,
            amountOut: amountOut,
            quoteId: keccak256(abi.encode(assetIn, assetOut, amountIn, recipient, "erc20")),
            deadline: block.timestamp + 1 days,
            recipient: recipient,
            signature: "",
            auxiliaryData: hex"726671"
        });
    }

    function _nativeInSwap(uint256 amountIn, address assetOut, uint256 amountOut, address recipient)
        internal
        view
        returns (SetwiseSwap memory)
    {
        return SetwiseSwap({
            pool: address(pool),
            assetIn: address(wrappedNative),
            assetOut: assetOut,
            nativeIn: true,
            nativeOut: false,
            amountIn: amountIn,
            amountOut: amountOut,
            quoteId: keccak256(abi.encode("native-in", assetOut, amountIn, recipient)),
            deadline: block.timestamp + 1 days,
            recipient: recipient,
            signature: "",
            auxiliaryData: hex"726671"
        });
    }

    function _nativeOutSwap(address assetIn, uint256 amountIn, uint256 amountOut, address recipient)
        internal
        view
        returns (SetwiseSwap memory)
    {
        return SetwiseSwap({
            pool: address(pool),
            assetIn: assetIn,
            assetOut: address(wrappedNative),
            nativeIn: false,
            nativeOut: true,
            amountIn: amountIn,
            amountOut: amountOut,
            quoteId: keccak256(abi.encode("native-out", assetIn, amountIn, recipient)),
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

    function _sign(SetwiseSwap memory swap) internal returns (SetwiseSwap memory) {
        swap.signature = _poolQuote(swap);
        return swap;
    }

    /// @dev Builds the two-leg composition calldata. Kept separate from
    ///      execution so revert assertions can place `vm.expectRevert`
    ///      immediately before the reverting call (the digest view calls used
    ///      while signing would otherwise consume the expectation).
    function _composeCalls(SetwiseSwap memory createSwap, SetwiseSwap memory consumeSwap)
        internal
        returns (bytes[] memory calls)
    {
        calls = new bytes[](2);
        calls[0] = abi.encodeCall(adapter.swapSetwise, (createSwap, FUNDER, _authorization(createSwap, FUNDER)));
        calls[1] = abi.encodeCall(
            adapter.swapSetwise, (consumeSwap, address(adapter), _authorization(consumeSwap, address(adapter)))
        );
    }

    function _compose(SetwiseSwap memory createSwap, SetwiseSwap memory consumeSwap)
        internal
        returns (bytes[] memory results)
    {
        // Build calldata first: the digest view calls made while signing would
        // otherwise consume the prank before the multicall itself.
        bytes[] memory calls = _composeCalls(createSwap, consumeSwap);
        vm.prank(FUNDER);
        return adapter.multicall(calls);
    }

    function _requireCleanRouter() internal view {
        require(tokenA.balanceOf(address(adapter)) == 0, "router tokenA residue");
        require(tokenB.balanceOf(address(adapter)) == 0, "router tokenB residue");
        require(tokenC.balanceOf(address(adapter)) == 0, "router tokenC residue");
        require(wrappedNative.balanceOf(address(adapter)) == 0, "router wrapped residue");
        require(address(adapter).balance == 0, "router native residue");
        require(tokenA.allowance(address(adapter), address(pool)) == 0, "tokenA allowance");
        require(tokenB.allowance(address(adapter), address(pool)) == 0, "tokenB allowance");
        require(tokenC.allowance(address(adapter), address(pool)) == 0, "tokenC allowance");
    }

    // --- acceptance: composition across every settlement-mode pair -----------

    function testErc20CompositionConsumesStagedCredit() external {
        SetwiseSwap memory leg1 = _sign(_erc20Swap(address(tokenA), address(tokenB), AMOUNT_IN, AMOUNT_MID, address(adapter)));
        SetwiseSwap memory leg2 = _sign(_erc20Swap(address(tokenB), address(tokenC), AMOUNT_MID, AMOUNT_OUT, RECIPIENT));

        bytes[] memory results = _compose(leg1, leg2);

        require(abi.decode(results[0], (uint256)) == AMOUNT_MID, "leg1 staged output");
        require(abi.decode(results[1], (uint256)) == AMOUNT_OUT, "leg2 output");
        require(tokenA.balanceOf(FUNDER) == AMOUNT_IN * 15, "funder debited only leg1 input");
        require(tokenB.balanceOf(FUNDER) == 0, "funder never touched the mid asset");
        require(tokenC.balanceOf(RECIPIENT) == AMOUNT_OUT, "recipient credited leg2 output");
        _requireCleanRouter();
    }

    function testNativeCreditFundsNativeInputLeg() external {
        // Leg 1 (ERC-20 -> native) stages native credit at the router; leg 2
        // (native -> ERC-20) spends it with no new msg.value attached.
        SetwiseSwap memory leg1 = _sign(_nativeOutSwap(address(tokenA), AMOUNT_IN, AMOUNT_MID, address(adapter)));
        SetwiseSwap memory leg2 = _sign(_nativeInSwap(AMOUNT_MID, address(tokenC), AMOUNT_OUT, RECIPIENT));

        bytes[] memory results = _compose(leg1, leg2);

        require(abi.decode(results[0], (uint256)) == AMOUNT_MID, "leg1 staged native");
        require(abi.decode(results[1], (uint256)) == AMOUNT_OUT, "leg2 output");
        require(tokenA.balanceOf(FUNDER) == AMOUNT_IN * 15, "funder debited only leg1 input");
        require(FUNDER.balance == 0, "funder attached no native value");
        require(tokenC.balanceOf(RECIPIENT) == AMOUNT_OUT, "recipient credited leg2 output");
        _requireCleanRouter();
    }

    function testTokenCreditFromNativeInputFundsErc20OutputLeg() external {
        // Leg 1 (native -> ERC-20) stages token credit at the router; leg 2
        // (ERC-20 -> native) consumes it and pays native to the recipient.
        SetwiseSwap memory leg1 = _sign(_nativeInSwap(AMOUNT_MID, address(tokenB), AMOUNT_MID, address(adapter)));
        SetwiseSwap memory leg2 = _sign(_nativeOutSwap(address(tokenB), AMOUNT_MID, AMOUNT_OUT, RECIPIENT));

        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(adapter.swapSetwise, (leg1, FUNDER, _authorization(leg1, FUNDER)));
        calls[1] =
            abi.encodeCall(adapter.swapSetwise, (leg2, address(adapter), _authorization(leg2, address(adapter))));

        uint256 recipientBefore = RECIPIENT.balance;
        vm.deal(FUNDER, AMOUNT_MID);
        vm.prank(FUNDER);
        adapter.multicall{value: AMOUNT_MID}(calls);

        require(RECIPIENT.balance - recipientBefore == AMOUNT_OUT, "recipient received native output");
        require(FUNDER.balance == 0, "funder native fully consumed");
        _requireCleanRouter();
    }

    function testTokenCreditFundsNativeOutputLeg() external {
        SetwiseSwap memory leg1 = _sign(_erc20Swap(address(tokenA), address(tokenB), AMOUNT_IN, AMOUNT_MID, address(adapter)));
        SetwiseSwap memory leg2 = _sign(_nativeOutSwap(address(tokenB), AMOUNT_MID, AMOUNT_OUT, RECIPIENT));

        uint256 recipientBefore = RECIPIENT.balance;
        _compose(leg1, leg2);

        require(RECIPIENT.balance - recipientBefore == AMOUNT_OUT, "recipient received native output");
        _requireCleanRouter();
    }

    // --- acceptance: credits cannot cross transactions -----------------------

    function testCreditCannotCrossTransactions() external {
        SetwiseSwap memory leg1 = _sign(_erc20Swap(address(tokenA), address(tokenB), AMOUNT_IN, AMOUNT_MID, address(adapter)));
        SetwiseSwap memory leg2 = _sign(_erc20Swap(address(tokenB), address(tokenC), AMOUNT_MID, AMOUNT_OUT, RECIPIENT));
        _compose(leg1, leg2);
        _requireCleanRouter();

        // A later transaction holds no staged credit: the same consume leg must
        // revert with zero available credit.
        SetwiseSwap memory consumeOnly = _erc20Swap(address(tokenB), address(tokenC), AMOUNT_MID, AMOUNT_OUT, RECIPIENT);
        consumeOnly.quoteId = keccak256("second-transaction-consume");
        consumeOnly = _sign(consumeOnly);
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(
            adapter.swapSetwise, (consumeOnly, address(adapter), _authorization(consumeOnly, address(adapter)))
        );

        vm.expectRevert(
            abi.encodeWithSelector(NativeAccounting.InsufficientTokenCredit.selector, address(tokenB), AMOUNT_MID, 0)
        );
        vm.prank(FUNDER);
        adapter.multicall(calls);
        _requireCleanRouter();
    }

    // --- acceptance: credits cannot cross users ------------------------------

    function testCreditCannotCrossUsersMidFrame() external {
        TransientCreditHarness harness = new TransientCreditHarness(address(wrappedNative), GOVERNANCE);
        CreditSpender spender = new CreditSpender();

        vm.expectRevert(
            abi.encodeWithSelector(NativeAccounting.CreditUserMismatch.selector, address(spender), FUNDER)
        );
        vm.prank(FUNDER);
        harness.creditThenDelegateSpend(address(tokenB), AMOUNT_MID, address(spender));
    }

    function testMidFrameCallbackCannotConsumeCredit() external {
        // A token callback firing mid-leg faces the per-execution lock, so a
        // callback can never reach the credit ledger with a foreign caller.
        SetwiseSwap memory leg1 = _sign(_erc20Swap(address(tokenA), address(tokenB), AMOUNT_IN, AMOUNT_MID, address(adapter)));
        SetwiseSwap memory consume = _sign(_erc20Swap(address(tokenB), address(tokenC), AMOUNT_MID, AMOUNT_OUT, RECIPIENT));
        bytes memory leg1Authorization = _authorization(leg1, FUNDER);
        tokenB.setCallback(
            address(adapter),
            abi.encodeCall(adapter.swapSetwise, (consume, address(adapter), _authorization(consume, address(adapter))))
        );

        vm.expectRevert(abi.encodeWithSelector(SetwiseExecutionAdapter.ReentrantSetwiseExecution.selector));
        vm.prank(FUNDER);
        adapter.swapSetwise(leg1, FUNDER, leg1Authorization);
        _requireCleanRouter();
    }

    function testCreditLedgerRequiresActiveFrame() external {
        TransientCreditHarness harness = new TransientCreditHarness(address(wrappedNative), GOVERNANCE);

        vm.expectRevert(abi.encodeWithSelector(NativeAccounting.NativeFrameInactive.selector));
        harness.stageCreditNoFrame(address(tokenB), 1);

        vm.expectRevert(abi.encodeWithSelector(NativeAccounting.NativeFrameInactive.selector));
        harness.consumeCreditNoFrame(address(tokenB), 1);
    }

    // --- acceptance: output credit equals the measured balance delta ---------

    function testUnderpaidOutputCannotStageCredit() external {
        pool.setUnderpayOutput(true);
        SetwiseSwap memory leg1 = _sign(_erc20Swap(address(tokenA), address(tokenB), AMOUNT_IN, AMOUNT_MID, address(adapter)));
        SetwiseSwap memory leg2 = _sign(_erc20Swap(address(tokenB), address(tokenC), AMOUNT_MID, AMOUNT_OUT, RECIPIENT));
        bytes[] memory calls = _composeCalls(leg1, leg2);

        // The delivered delta (amountOut - 1) is not the signed fixed output, so
        // the composition reverts atomically before any credit exists.
        vm.expectRevert(
            abi.encodeWithSelector(SetwiseExecutionAdapter.SetwiseOutputMismatch.selector, AMOUNT_MID, AMOUNT_MID - 1)
        );
        vm.prank(FUNDER);
        adapter.multicall(calls);
        _requireCleanRouter();
    }

    function testOverpaidOutputCannotStageCredit() external {
        pool.setOverpayOutput(true);
        SetwiseSwap memory leg1 = _sign(_erc20Swap(address(tokenA), address(tokenB), AMOUNT_IN, AMOUNT_MID, address(adapter)));
        SetwiseSwap memory leg2 = _sign(_erc20Swap(address(tokenB), address(tokenC), AMOUNT_MID, AMOUNT_OUT, RECIPIENT));
        bytes[] memory calls = _composeCalls(leg1, leg2);

        // Credit is exactly the measured delta; an over-delivering (variable)
        // pool is rejected just like an under-delivering one.
        vm.expectRevert(
            abi.encodeWithSelector(SetwiseExecutionAdapter.SetwiseOutputMismatch.selector, AMOUNT_MID, AMOUNT_MID + 1)
        );
        vm.prank(FUNDER);
        adapter.multicall(calls);
        _requireCleanRouter();
    }

    // --- acceptance: variable-output -> Set composition is rejected -----------

    function testConsumeExceedingStagedCreditReverts() external {
        SetwiseSwap memory leg1 = _sign(_erc20Swap(address(tokenA), address(tokenB), AMOUNT_IN, AMOUNT_MID, address(adapter)));
        SetwiseSwap memory leg2 = _erc20Swap(address(tokenB), address(tokenC), AMOUNT_MID + 1, AMOUNT_OUT, RECIPIENT);
        leg2.quoteId = keccak256("over-consume");
        leg2 = _sign(leg2);
        bytes[] memory calls = _composeCalls(leg1, leg2);

        // A Set leg always consumes exactly its signed fixed input; a route that
        // would need more than the staged (measured) credit reverts.
        vm.expectRevert(
            abi.encodeWithSelector(
                NativeAccounting.InsufficientTokenCredit.selector, address(tokenB), AMOUNT_MID + 1, AMOUNT_MID
            )
        );
        vm.prank(FUNDER);
        adapter.multicall(calls);
        _requireCleanRouter();
    }

    function testPartiallyConsumedCreditRevertsResidual() external {
        SetwiseSwap memory leg1 = _sign(_erc20Swap(address(tokenA), address(tokenB), AMOUNT_IN, AMOUNT_MID, address(adapter)));
        SetwiseSwap memory leg2 = _erc20Swap(address(tokenB), address(tokenC), AMOUNT_MID - 1, AMOUNT_OUT, RECIPIENT);
        leg2.quoteId = keccak256("under-consume");
        leg2 = _sign(leg2);
        bytes[] memory calls = _composeCalls(leg1, leg2);

        // Consuming less than the staged credit leaves a residual, which reverts
        // at frame settlement; composite routes must be sized exactly.
        vm.expectRevert(
            abi.encodeWithSelector(NativeAccounting.ResidualTokenCredit.selector, address(tokenB), 1)
        );
        vm.prank(FUNDER);
        adapter.multicall(calls);
        _requireCleanRouter();
    }

    function testNativeRouterReceiptWithoutConsumerReverts() external {
        SetwiseSwap memory leg1 = _sign(_nativeOutSwap(address(tokenA), AMOUNT_IN, AMOUNT_MID, address(adapter)));
        bytes memory authorization = _authorization(leg1, FUNDER);

        vm.expectRevert(abi.encodeWithSelector(NativeAccounting.ResidualNativeCredit.selector, AMOUNT_MID));
        vm.prank(FUNDER);
        adapter.swapSetwise(leg1, FUNDER, authorization);
        _requireCleanRouter();
    }

    // --- acceptance: credit-funded legs never touch external wallets ----------

    function testCreditFundedLegRejectsExternalCallerBinding() external {
        // A credit-funded leg must be authorized with the router as funder. An
        // authorization that binds an external funder instead never matches the
        // signed digest, so the credit path cannot be reached with it.
        SetwiseSwap memory consume = _sign(_erc20Swap(address(tokenB), address(tokenC), AMOUNT_MID, AMOUNT_OUT, RECIPIENT));
        bytes memory wrongAuthorization = _authorization(consume, FUNDER);

        vm.expectRevert(abi.encodeWithSelector(SetwiseRouterAuthorization.InvalidSetwiseAuthorization.selector));
        vm.prank(FUNDER);
        adapter.swapSetwise(consume, address(adapter), wrongAuthorization);
        _requireCleanRouter();
    }

    function testStandaloneCreditFundedLegHasNoCredit() external {
        // Outside a composition there is no staged credit; the authorized
        // credit-funded leg reverts instead of pulling from anywhere.
        SetwiseSwap memory consume = _sign(_erc20Swap(address(tokenB), address(tokenC), AMOUNT_MID, AMOUNT_OUT, RECIPIENT));
        bytes memory authorization = _authorization(consume, address(adapter));

        vm.expectRevert(
            abi.encodeWithSelector(NativeAccounting.InsufficientTokenCredit.selector, address(tokenB), AMOUNT_MID, 0)
        );
        vm.prank(FUNDER);
        adapter.swapSetwise(consume, address(adapter), authorization);
        _requireCleanRouter();
    }

    // --- acceptance: multicall ordering is fuzz-tested ------------------------

    /// @notice Fuzz arbitrary create/consume orderings of one-to-four legs. A
    ///         create leg stages AMOUNT_MID of tokenB credit (A -> B, router
    ///         recipient); a consume leg spends it (B -> C, router funder). A
    ///         sequence succeeds iff every prefix consumes no more than it
    ///         staged and the totals match exactly; every other ordering must
    ///         revert atomically with no router residue.
    function testFuzzMulticallCompositionOrdering(uint256 seed) external {
        uint256 length = (seed % 4) + 1;
        bytes[] memory calls = new bytes[](length);
        uint256 staged;
        uint256 consumed;
        bool valid = true;

        for (uint256 i = 0; i < length; ++i) {
            bool create = ((seed >> (8 + i)) & 1) == 1;
            if (create) {
                SetwiseSwap memory leg = _erc20Swap(address(tokenA), address(tokenB), AMOUNT_IN, AMOUNT_MID, address(adapter));
                leg.quoteId = keccak256(abi.encode("fuzz-create", seed, i));
                leg = _sign(leg);
                calls[i] = abi.encodeCall(adapter.swapSetwise, (leg, FUNDER, _authorization(leg, FUNDER)));
                staged += 1;
            } else {
                SetwiseSwap memory leg = _erc20Swap(address(tokenB), address(tokenC), AMOUNT_MID, AMOUNT_OUT, RECIPIENT);
                leg.quoteId = keccak256(abi.encode("fuzz-consume", seed, i));
                leg = _sign(leg);
                calls[i] = abi.encodeCall(
                    adapter.swapSetwise, (leg, address(adapter), _authorization(leg, address(adapter)))
                );
                consumed += 1;
                if (consumed > staged) valid = false;
            }
        }
        if (staged != consumed) valid = false;

        vm.prank(FUNDER);
        try adapter.multicall(calls) returns (bytes[] memory results) {
            require(valid, "invalid ordering succeeded");
            require(results.length == length, "result count");
            require(tokenC.balanceOf(RECIPIENT) == consumed * AMOUNT_OUT, "recipient output");
            require(tokenA.balanceOf(FUNDER) == AMOUNT_IN * 16 - staged * AMOUNT_IN, "funder input debit");
        } catch {
            require(!valid, "valid ordering reverted");
            require(tokenA.balanceOf(FUNDER) == AMOUNT_IN * 16, "reverted sequence debited funder");
        }
        _requireCleanRouter();
    }
}

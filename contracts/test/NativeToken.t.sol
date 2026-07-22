// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISetwisePool} from "../src/setwise/ISetwisePool.sol";
import {IWrappedNativeToken} from "../src/setwise/IWrappedNativeToken.sol";
import {NativeTokenLib, NativeAccounting} from "../src/setwise/NativeToken.sol";
import {SETWISE_NATIVE_TOKEN} from "../src/setwise/SetwiseSwap.sol";

interface Vm {
    function expectRevert() external;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata data) external;
    function deal(address who, uint256 newBalance) external;
    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function etch(address target, bytes calldata code) external;
}

interface IERC20 {
    function balanceOf(address who) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice WETH9-style wrapped-native token: wrapping mints 1:1 on receive/deposit,
///         unwrapping burns and returns native currency.
contract MockWrappedNative {
    string public symbol;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    constructor(string memory symbol_) {
        symbol = symbol_;
    }

    receive() external payable {
        _mint(msg.sender, msg.value);
    }

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "native transfer failed");
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    /// @dev Test helper: mint wrapped-native without moving native. Tests back the
    ///      token with native via `vm.deal` so `withdraw` stays solvent.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _mint(address to, uint256 amount) internal {
        balanceOf[to] += amount;
        totalSupply += amount;
    }
}

contract MockERC20 {
    string public symbol;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory symbol_) {
        symbol = symbol_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
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
}

/// @notice Minimal Setwise pool mock for native-handling tests. It moves tokens
///         according to the settlement entry point (no signature verification) and
///         enforces `msg.value == inputAmount` on the native-input entry, mirroring
///         the deployed pool's `InvalidNativeAmount` behavior.
contract MockSetwisePool {
    address public immutable WRAPPED_NATIVE_TOKEN;

    constructor(address wrappedNative_) {
        WRAPPED_NATIVE_TOKEN = wrappedNative_;
    }

    receive() external payable {}

    function swapExactNativeForAsset(
        address outputAsset,
        uint256 inputAmount,
        uint256 outputAmount,
        bytes32,
        uint256,
        address recipient,
        bytes calldata,
        bytes calldata
    ) external payable {
        require(msg.value == inputAmount, "InvalidNativeAmount");
        // Wrap the native input into the pool's wrapped-native balance.
        (bool ok,) = WRAPPED_NATIVE_TOKEN.call{value: inputAmount}("");
        require(ok, "wrap failed");
        _transferOut(outputAsset, recipient, outputAmount);
    }

    function swapExactAssetForAsset(
        address inputAsset,
        address outputAsset,
        uint256 inputAmount,
        uint256 outputAmount,
        bytes32,
        uint256,
        address recipient,
        bytes calldata,
        bytes calldata
    ) external {
        _pull(inputAsset, inputAmount);
        _transferOut(outputAsset, recipient, outputAmount);
    }

    function swapExactAssetForNative(
        address inputAsset,
        uint256 inputAmount,
        uint256 outputAmount,
        bytes32,
        uint256,
        address recipient,
        bytes calldata,
        bytes calldata
    ) external {
        _pull(inputAsset, inputAmount);
        IWrappedNativeToken(WRAPPED_NATIVE_TOKEN).withdraw(outputAmount);
        (bool ok,) = recipient.call{value: outputAmount}("");
        require(ok, "native transfer failed");
    }

    function _pull(address token, uint256 amount) internal {
        require(IERC20(token).transferFrom(msg.sender, address(this), amount), "pull failed");
    }

    function _transferOut(address token, address to, uint256 amount) internal {
        require(IERC20(token).transfer(to, amount), "transfer failed");
    }
}

/// @notice Thin router harness composing `NativeAccounting` over the mock pool, so
///         the native-value accounting can be exercised across every settlement
///         direction. Stands in for the execution adapter built in issues #13/#15.
contract NativeRouterHarness is NativeAccounting {
    constructor(address wrappedNative_, address governance_) NativeAccounting(wrappedNative_, governance_) {}

    /// @notice Native -> wrapped-native, exact input. Standalone only: the attached
    ///         value must equal `amountIn` exactly (any mismatch reverts).
    function wrapExactInput(address recipient, uint256 amountIn) external payable nativeFrame(false) {
        _requireExactNativeValue(amountIn);
        _wrapFrameNative(amountIn);
        IERC20(wrappedNative).transfer(recipient, amountIn);
    }

    /// @notice Wrapped-native held by the router -> native to `recipient`.
    function unwrapTo(address recipient, uint256 amount) external payable nativeFrame(true) {
        _unwrapTo(recipient, amount);
    }

    /// @notice Native -> ERC-20 via the pool's native-input entry point.
    function swapNativeForAsset(address pool, address assetOut, uint256 amountIn, uint256 amountOut, address recipient)
        external
        payable
        nativeFrame(false)
    {
        _spendNative(amountIn);
        ISetwisePool(pool).swapExactNativeForAsset{value: amountIn}(
            assetOut, amountIn, amountOut, bytes32(0), 0, recipient, "", ""
        );
    }

    /// @notice ERC-20 -> native via the pool's native-output entry point (the pool
    ///         unwraps and sends native to `recipient`).
    function swapAssetForNative(address pool, address assetIn, uint256 amountIn, uint256 amountOut, address recipient)
        external
        payable
        nativeFrame(true)
    {
        _fundPool(pool, assetIn, amountIn);
        ISetwisePool(pool).swapExactAssetForNative(assetIn, amountIn, amountOut, bytes32(0), 0, recipient, "", "");
    }

    /// @notice ERC-20 -> native where the router receives wrapped-native and unwraps
    ///         it to `recipient` (router-side unwrap path).
    function swapAssetForNativeViaRouter(
        address pool,
        address assetIn,
        uint256 amountIn,
        uint256 amountOut,
        address recipient
    ) external payable nativeFrame(true) {
        _fundPool(pool, assetIn, amountIn);
        ISetwisePool(pool)
            .swapExactAssetForAsset(assetIn, wrappedNative, amountIn, amountOut, bytes32(0), 0, address(this), "", "");
        _unwrapTo(recipient, amountOut);
    }

    /// @notice ERC-20 -> ERC-20 via the pool. Rejects any attached native value when
    ///         called standalone.
    function swapAssetForAsset(
        address pool,
        address assetIn,
        address assetOut,
        uint256 amountIn,
        uint256 amountOut,
        address recipient
    ) external payable nativeFrame(true) {
        _fundPool(pool, assetIn, amountIn);
        ISetwisePool(pool)
            .swapExactAssetForAsset(assetIn, assetOut, amountIn, amountOut, bytes32(0), 0, recipient, "", "");
    }

    /// @notice Unwrap router-held wrapped-native and credit the freed native for a
    ///         later leg in the same frame (transient credit, no new msg.value).
    function unwrapToCredit(uint256 amount) external payable nativeFrame(false) {
        IWrappedNativeToken(wrappedNative).withdraw(amount);
        _creditNative(amount);
    }

    /// @notice Spend credited native and forward it to `recipient`.
    function sendCreditedNative(address recipient, uint256 amount) external payable nativeFrame(false) {
        _spendNative(amount);
        NativeTokenLib.transferNative(recipient, amount);
    }

    function _fundPool(address pool, address assetIn, uint256 amountIn) internal {
        require(IERC20(assetIn).transferFrom(msg.sender, address(this), amountIn), "pull from caller failed");
        IERC20(assetIn).approve(pool, amountIn);
    }
}

/// @notice Unit tests for chain-aware native / wrapped-native handling. Runs without
///         forge-std: assertions use `require` and cheatcodes are declared inline.
contract NativeTokenTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant USER = address(0xBEEF);
    address internal constant RECIPIENT = address(0xCAFE);
    address internal constant GOVERNANCE = address(0x60D);

    MockWrappedNative internal weth;
    MockERC20 internal usdc;
    MockSetwisePool internal pool;
    NativeRouterHarness internal router;

    function setUp() external {
        weth = new MockWrappedNative("WETH");
        usdc = new MockERC20("USDC");
        pool = new MockSetwisePool(address(weth));
        router = new NativeRouterHarness(address(weth), GOVERNANCE);

        // Pool liquidity: USDC for native->erc20 and asset->asset outputs, and
        // backed wrapped-native for native-output unwraps.
        usdc.mint(address(pool), 1_000_000e6);
        weth.mint(address(pool), 100 ether);
        vm.deal(address(weth), 100 ether); // back the minted wrapped-native so withdraw is solvent

        vm.deal(USER, 100 ether);
        usdc.mint(USER, 1_000_000e6);
    }

    // --- library primitives -------------------------------------------------

    function testIsNativeSentinel() external view {
        require(NativeTokenLib.isNative(SETWISE_NATIVE_TOKEN), "sentinel is native");
        require(NativeTokenLib.isNative(address(0)), "zero address is native");
        require(!NativeTokenLib.isNative(address(weth)), "wrapped-native is not native");
    }

    function testWrapMintsWrappedNative() external {
        vm.startPrank(USER);
        router.wrapExactInput{value: 1 ether}(RECIPIENT, 1 ether);
        vm.stopPrank();
        require(weth.balanceOf(RECIPIENT) == 1 ether, "recipient received wrapped-native");
        require(address(router).balance == 0, "router holds no native");
    }

    function testUnwrapSendsNative() external {
        // Seed the router with wrapped-native, then unwrap to the recipient.
        weth.mint(address(router), 2 ether);
        vm.deal(address(weth), address(weth).balance + 2 ether);

        uint256 before = RECIPIENT.balance;
        router.unwrapTo(RECIPIENT, 2 ether);
        require(RECIPIENT.balance - before == 2 ether, "recipient received native");
        require(weth.balanceOf(address(router)) == 0, "router wrapped-native drained");
    }

    // --- exact-input mismatch always reverts --------------------------------

    function testWrapExactInputRevertsOnMismatch() external {
        vm.startPrank(USER);
        vm.expectRevert(abi.encodeWithSelector(NativeAccounting.NativeValueMismatch.selector, 1 ether, 2 ether));
        router.wrapExactInput{value: 2 ether}(RECIPIENT, 1 ether);
        vm.stopPrank();
    }

    // --- direction: native -> erc20 -----------------------------------------

    function testNativeToErc20() external {
        vm.startPrank(USER);
        router.swapNativeForAsset{value: 1 ether}(address(pool), address(usdc), 1 ether, 2000e6, RECIPIENT);
        vm.stopPrank();
        require(usdc.balanceOf(RECIPIENT) == 2000e6, "recipient received erc20 out");
        require(address(router).balance == 0, "router holds no native");
    }

    function testNativeToErc20InsufficientValueReverts() external {
        vm.startPrank(USER);
        vm.expectRevert(abi.encodeWithSelector(NativeAccounting.InsufficientNativeValue.selector, 1 ether, 0.5 ether));
        router.swapNativeForAsset{value: 0.5 ether}(address(pool), address(usdc), 1 ether, 2000e6, RECIPIENT);
        vm.stopPrank();
    }

    function testNativeToErc20RefundsSurplusByDelta() external {
        // Pre-fund the router with native that does NOT belong to this call.
        vm.deal(address(router), 5 ether);

        vm.startPrank(USER);
        uint256 userBefore = USER.balance;
        // Attach 3 ether but only spend 1 ether; the 2 ether surplus must be refunded.
        router.swapNativeForAsset{value: 3 ether}(address(pool), address(usdc), 1 ether, 2000e6, RECIPIENT);
        vm.stopPrank();

        require(userBefore - USER.balance == 1 ether, "user spent exactly amountIn");
        require(address(router).balance == 5 ether, "pre-existing router balance untouched");
        require(usdc.balanceOf(RECIPIENT) == 2000e6, "recipient received erc20 out");
    }

    // --- direction: erc20 -> native -----------------------------------------

    function testErc20ToNative() external {
        vm.startPrank(USER);
        usdc.approve(address(router), 1000e6);
        uint256 before = RECIPIENT.balance;
        router.swapAssetForNative(address(pool), address(usdc), 1000e6, 0.5 ether, RECIPIENT);
        vm.stopPrank();
        require(RECIPIENT.balance - before == 0.5 ether, "recipient received native out");
        require(usdc.balanceOf(USER) == 999_000e6, "user spent erc20 in");
    }

    function testErc20ToNativeViaRouterUnwrap() external {
        vm.startPrank(USER);
        usdc.approve(address(router), 1000e6);
        uint256 before = RECIPIENT.balance;
        router.swapAssetForNativeViaRouter(address(pool), address(usdc), 1000e6, 0.5 ether, RECIPIENT);
        vm.stopPrank();
        require(RECIPIENT.balance - before == 0.5 ether, "recipient received native out");
        require(weth.balanceOf(address(router)) == 0, "router holds no wrapped-native");
        require(address(router).balance == 0, "router holds no native");
    }

    function testErc20ToNativeRejectsNativeValue() external {
        vm.startPrank(USER);
        usdc.approve(address(router), 1000e6);
        vm.expectRevert(abi.encodeWithSelector(NativeAccounting.UnexpectedNativeValue.selector, 1 ether));
        router.swapAssetForNative{value: 1 ether}(address(pool), address(usdc), 1000e6, 0.5 ether, RECIPIENT);
        vm.stopPrank();
    }

    // --- direction: erc20 -> erc20 ------------------------------------------

    function testErc20ToErc20() external {
        MockERC20 dai = new MockERC20("DAI");
        dai.mint(address(pool), 1_000_000e18);

        vm.startPrank(USER);
        usdc.approve(address(router), 1000e6);
        router.swapAssetForAsset(address(pool), address(usdc), address(dai), 1000e6, 900e18, RECIPIENT);
        vm.stopPrank();
        require(dai.balanceOf(RECIPIENT) == 900e18, "recipient received erc20 out");
    }

    function testErc20ToErc20RejectsNativeValue() external {
        vm.startPrank(USER);
        usdc.approve(address(router), 1000e6);
        vm.expectRevert(abi.encodeWithSelector(NativeAccounting.UnexpectedNativeValue.selector, 1 wei));
        router.swapAssetForAsset{value: 1 wei}(address(pool), address(usdc), address(usdc), 1000e6, 1000e6, RECIPIENT);
        vm.stopPrank();
    }

    // --- multicall: shared native frame + transient credit ------------------

    function testMulticallNativeInThenErc20Out() external {
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(
            NativeRouterHarness.swapNativeForAsset, (address(pool), address(usdc), 1 ether, 2000e6, RECIPIENT)
        );
        calls[1] = abi.encodeCall(
            NativeRouterHarness.swapNativeForAsset, (address(pool), address(usdc), 0.5 ether, 1000e6, RECIPIENT)
        );

        vm.startPrank(USER);
        // Attach 2 ether; only 1.5 is spent, 0.5 must be refunded by delta.
        router.multicall{value: 2 ether}(calls);
        vm.stopPrank();

        require(usdc.balanceOf(RECIPIENT) == 3000e6, "recipient received both outputs");
        require(address(router).balance == 0, "router holds no native");
    }

    function testMulticallErc20OnlySubcallSharesFrameWithoutReverting() external {
        // A native-in leg plus an erc20-only leg under one multicall: the erc20-only
        // sub-call must not reject the shared msg.value.
        MockERC20 dai = new MockERC20("DAI");
        dai.mint(address(pool), 1_000_000e18);

        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(
            NativeRouterHarness.swapNativeForAsset, (address(pool), address(usdc), 1 ether, 2000e6, RECIPIENT)
        );
        calls[1] = abi.encodeCall(
            NativeRouterHarness.swapAssetForAsset,
            (address(pool), address(usdc), address(dai), 1000e6, 900e18, RECIPIENT)
        );

        vm.startPrank(USER);
        usdc.approve(address(router), 1000e6);
        router.multicall{value: 1 ether}(calls);
        vm.stopPrank();

        require(usdc.balanceOf(RECIPIENT) == 2000e6, "native-in output delivered");
        require(dai.balanceOf(RECIPIENT) == 900e18, "erc20-only output delivered");
    }

    function testMulticallTransientCreditCarriesNative() external {
        // Leg A unwraps router-held wrapped-native into credited native; leg B spends
        // that credit to forward native to the recipient — no new msg.value required.
        weth.mint(address(router), 1 ether);
        vm.deal(address(weth), address(weth).balance + 1 ether);

        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(NativeRouterHarness.unwrapToCredit, (1 ether));
        calls[1] = abi.encodeCall(NativeRouterHarness.sendCreditedNative, (RECIPIENT, 1 ether));

        uint256 before = RECIPIENT.balance;
        router.multicall(calls);
        require(RECIPIENT.balance - before == 1 ether, "credited native delivered");
        require(address(router).balance == 0, "no residual router balance");
    }

    function testResidualCreditReverts() external {
        // Credit native but never spend it: settlement must revert rather than leave a
        // residual router balance.
        weth.mint(address(router), 1 ether);
        vm.deal(address(weth), address(weth).balance + 1 ether);

        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(NativeRouterHarness.unwrapToCredit, (1 ether));

        vm.expectRevert(abi.encodeWithSelector(NativeAccounting.ResidualNativeCredit.selector, 1 ether));
        router.multicall(calls);
    }

    function testNestedMulticallReverts() external {
        bytes[] memory inner = new bytes[](0);
        bytes[] memory outer = new bytes[](1);
        outer[0] = abi.encodeWithSignature("multicall(bytes[])", inner);
        vm.expectRevert(NativeAccounting.NativeFrameActive.selector);
        router.multicall(outer);
    }

    // --- sweep is governed, not permissionless ------------------------------

    function testSweepNativeByGovernance() external {
        vm.deal(address(router), 3 ether);
        uint256 before = GOVERNANCE.balance;
        vm.prank(GOVERNANCE);
        router.sweep(SETWISE_NATIVE_TOKEN, GOVERNANCE, 3 ether);
        require(GOVERNANCE.balance - before == 3 ether, "governance recovered native");
        require(address(router).balance == 0, "router drained");
    }

    function testSweepTokenByGovernance() external {
        usdc.mint(address(router), 500e6);
        vm.prank(GOVERNANCE);
        router.sweep(address(usdc), GOVERNANCE, 500e6);
        require(usdc.balanceOf(GOVERNANCE) == 500e6, "governance recovered tokens");
    }

    function testSweepRevertsForNonGovernance() external {
        vm.deal(address(router), 1 ether);
        vm.prank(USER);
        vm.expectRevert(NativeAccounting.Unauthorized.selector);
        router.sweep(SETWISE_NATIVE_TOKEN, USER, 1 ether);
    }

    function testSweepRejectsZeroRecipient() external {
        vm.deal(address(router), 1 ether);
        vm.prank(GOVERNANCE);
        vm.expectRevert(NativeAccounting.ZeroRecipient.selector);
        router.sweep(SETWISE_NATIVE_TOKEN, address(0), 1 ether);
    }

    // --- wrapped-native is config-selected, never hardcoded -----------------

    function testWrappedNativeIsConfigSelected() external {
        // Deploy the same harness against distinct wrapped-native tokens (standing in
        // for WETH on Ethereum/Base/Robinhood and WBNB on BSC) and confirm wrap/unwrap
        // work for each — no Ethereum WETH constant is baked into the router.
        address[] memory wrapped = new address[](2);
        wrapped[0] = address(new MockWrappedNative("WETH"));
        wrapped[1] = address(new MockWrappedNative("WBNB"));

        for (uint256 i = 0; i < wrapped.length; ++i) {
            NativeRouterHarness r = new NativeRouterHarness(wrapped[i], GOVERNANCE);
            require(r.wrappedNative() == wrapped[i], "wrapped-native is the constructor arg");

            vm.deal(USER, 10 ether);
            vm.startPrank(USER);
            r.wrapExactInput{value: 1 ether}(RECIPIENT, 1 ether);
            vm.stopPrank();
            require(
                MockWrappedNative(payable(wrapped[i])).balanceOf(RECIPIENT) >= 1 ether, "wrap works per chain token"
            );
        }
    }

    function testConstructorRejectsZeroWrappedNative() external {
        vm.expectRevert(NativeTokenLib.ZeroWrappedNative.selector);
        new NativeRouterHarness(address(0), GOVERNANCE);
    }

    // The canonical sentinel used by the router matches the data-type layer.
    function testSentinelMatchesDataTypeLayer() external pure {
        require(SETWISE_NATIVE_TOKEN == address(0), "canonical native sentinel is address(0)");
    }
}

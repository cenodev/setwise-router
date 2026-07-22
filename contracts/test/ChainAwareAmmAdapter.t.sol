// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    ChainAwareAmmAdapter,
    IV4PoolManager,
    V2AdapterConfig,
    V3AdapterConfig,
    V4AdapterConfig,
    V4PoolKey,
    V4SwapParams
} from "../src/amm/ChainAwareAmmAdapter.sol";

interface Vm {
    function chainId(uint256 newChainId) external;
    function etch(address target, bytes calldata code) external;
}

interface IV3SwapCallback {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

interface IV4UnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory result);
}

contract MockToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    uint256 public transferFromCalls;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory name_, string memory symbol_) {
        name = name_;
        symbol = symbol_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        ++transferFromCalls;
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

contract MockWrappedNative is MockToken {
    constructor() MockToken("Wrapped Native", "WNATIVE") {}

    receive() external payable {
        balanceOf[msg.sender] += msg.value;
        totalSupply += msg.value;
    }

    function withdraw(uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "wrapped balance");
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "native transfer");
    }
}

contract MockV2Pool {
    address public token0;
    address public token1;
    uint112 public reserve0;
    uint112 public reserve1;

    function initialize(address token0_, address token1_, uint112 reserve0_, uint112 reserve1_) external {
        require(token0 == address(0), "initialized");
        token0 = token0_;
        token1 = token1_;
        reserve0 = reserve0_;
        reserve1 = reserve1_;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, uint32(block.timestamp));
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata) external {
        if (amount0Out != 0) MockToken(token0).transfer(to, amount0Out);
        if (amount1Out != 0) MockToken(token1).transfer(to, amount1Out);
    }
}

contract MockV3Pool {
    address public token0;
    address public token1;

    function initialize(address token0_, address token1_) external {
        require(token0 == address(0), "initialized");
        token0 = token0_;
        token1 = token1_;
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        uint256 amountIn;
        uint256 amountOut;
        if (amountSpecified > 0) {
            amountIn = uint256(amountSpecified);
            amountOut = amountIn / 2;
        } else {
            amountOut = uint256(-amountSpecified);
            amountIn = amountOut * 2;
        }
        (amount0, amount1) =
            zeroForOne ? (int256(amountIn), -int256(amountOut)) : (-int256(amountOut), int256(amountIn));
        IV3SwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        MockToken(zeroForOne ? token1 : token0).transfer(recipient, amountOut);
    }
}

contract MockV4PoolManager is IV4PoolManager {
    uint256 public unlockCalls;

    function unlock(bytes calldata data) external returns (bytes memory result) {
        ++unlockCalls;
        return IV4UnlockCallback(msg.sender).unlockCallback(data);
    }

    function swap(V4PoolKey memory, V4SwapParams memory params, bytes calldata) external pure returns (int256 delta) {
        uint256 amountIn;
        uint256 amountOut;
        if (params.amountSpecified < 0) {
            amountIn = uint256(-params.amountSpecified);
            amountOut = amountIn / 2;
        } else {
            amountOut = uint256(params.amountSpecified);
            amountIn = amountOut * 2;
        }
        int128 inputDelta = -int128(int256(amountIn));
        int128 outputDelta = int128(int256(amountOut));
        int128 amount0 = params.zeroForOne ? inputDelta : outputDelta;
        int128 amount1 = params.zeroForOne ? outputDelta : inputDelta;
        uint256 packed = (uint256(uint128(amount0)) << 128) | uint256(uint128(amount1));
        return int256(packed);
    }

    function sync(address) external {}

    function settle() external payable returns (uint256 paid) {
        return msg.value;
    }

    function take(address currency, address to, uint256 amount) external {
        MockToken(currency).transfer(to, amount);
    }
}

contract ChainAwareAmmAdapterTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant PRIMARY_FACTORY = address(0x1000);
    address private constant SECONDARY_FACTORY = address(0x2000);
    address private constant V3_FACTORY = address(0x3000);
    bytes32 private constant PRIMARY_HASH = keccak256("primary-v2");
    bytes32 private constant SECONDARY_HASH = keccak256("secondary-v2");
    bytes32 private constant V3_HASH = keccak256("v3");

    MockWrappedNative private wrapped;
    MockToken private tokenA;
    MockToken private tokenB;
    MockV4PoolManager private manager;

    function setUp() public {
        wrapped = new MockWrappedNative();
        tokenA = new MockToken("Token A", "A");
        tokenB = new MockToken("Token B", "B");
        manager = new MockV4PoolManager();
    }

    function testConstructorRejectsWrongChain() public {
        V2AdapterConfig memory disabledV2;
        uint24[] memory noFees = new uint24[](0);
        V3AdapterConfig memory disabledV3 = V3AdapterConfig(address(0), bytes32(0), noFees);
        V4AdapterConfig memory disabledV4;
        try new ChainAwareAmmAdapter(
            block.chainid + 1, address(wrapped), address(this), disabledV2, disabledV2, disabledV3, disabledV4
        ) {
            revert("expected wrong-chain revert");
        } catch {}
    }

    function testV2ExactInputAndExactOutput() public {
        ChainAwareAmmAdapter router = _router(true, address(manager), V3_FACTORY);
        (address pool,) = router.v2PoolFor(address(tokenA), address(tokenB), false);
        _installV2Pool(pool);
        tokenA.mint(address(this), 100_000 ether);
        tokenB.mint(pool, 1_000_000 ether);
        tokenA.approve(address(router), type(uint256).max);

        (uint256 amountIn, uint256 amountOut) =
            router.swapV2(address(this), false, address(tokenA), address(tokenB), 1_000 ether, 1, block.timestamp);
        require(amountIn == 1_000 ether, "v2 exact-in amount");
        require(amountOut > 0, "v2 exact-in output");

        (amountIn, amountOut) = router.swapV2(
            address(this), true, address(tokenA), address(tokenB), 100 ether, 1_000 ether, block.timestamp
        );
        require(amountOut == 100 ether, "v2 exact-out amount");
        require(amountIn <= 1_000 ether, "v2 exact-out limit");
    }

    function testV2SecondarySentinelSelectsConfiguredFactory() public {
        ChainAwareAmmAdapter router = _router(true, address(manager), V3_FACTORY);
        (address primary,) = router.v2PoolFor(address(tokenA), address(tokenB), false);
        (address secondary,) = router.v2PoolFor(address(tokenA), address(tokenB), true);
        require(primary != secondary, "distinct V2 adapters");
        _installV2Pool(secondary);
        tokenA.mint(address(this), 2_000 ether);
        tokenB.mint(secondary, 1_000_000 ether);
        tokenA.approve(address(router), type(uint256).max);

        (uint256 amountIn, uint256 amountOut) =
            router.swapV2(address(this), false, address(tokenA), address(tokenB), 1_000 ether, 1, type(uint256).max);
        require(amountIn == 1_000 ether && amountOut > 0, "secondary V2 swap");
    }

    function testUnsupportedV2RevertsBeforeTransfer() public {
        ChainAwareAmmAdapter router = _router(false, address(manager), V3_FACTORY);
        tokenA.mint(address(this), 1_000 ether);
        tokenA.approve(address(router), type(uint256).max);
        (bool ok,) = address(router)
            .call(
                abi.encodeCall(
                    router.swapV2,
                    (address(this), false, address(tokenA), address(tokenB), 100 ether, 0, type(uint256).max)
                )
            );
        require(!ok, "unsupported V2 accepted");
        require(tokenA.transferFromCalls() == 0, "funds touched before V2 rejection");
    }

    function testV3ExactInputAndExactOutput() public {
        ChainAwareAmmAdapter router = _router(true, address(manager), V3_FACTORY);
        (address pool,) = router.v3PoolFor(address(tokenA), address(tokenB), 500);
        _installV3Pool(pool);
        tokenA.mint(address(this), 10_000 ether);
        tokenB.mint(pool, 10_000 ether);
        tokenA.approve(address(router), type(uint256).max);

        (uint256 amountIn, uint256 amountOut) = router.swapV3(
            address(this), false, 500, address(tokenA), address(tokenB), 1_000 ether, 500 ether, block.timestamp
        );
        require(amountIn == 1_000 ether && amountOut == 500 ether, "v3 exact-in");

        (amountIn, amountOut) = router.swapV3(
            address(this), true, 500, address(tokenA), address(tokenB), 100 ether, 200 ether, block.timestamp
        );
        require(amountIn == 200 ether && amountOut == 100 ether, "v3 exact-out");
    }

    function testSpoofedV3CallbackReverts() public {
        ChainAwareAmmAdapter router = _router(true, address(manager), V3_FACTORY);
        bytes memory callbackData = abi.encode(address(this), address(tokenA), address(tokenB), false, uint24(500));
        (bool ok,) =
            address(router).call(abi.encodeCall(router.uniswapV3SwapCallback, (int256(1), int256(-1), callbackData)));
        require(!ok, "spoofed V3 callback accepted");
    }

    function testUnsupportedV3FeeAndWrongFactoryRevertBeforeTransfer() public {
        ChainAwareAmmAdapter router = _router(true, address(manager), V3_FACTORY);
        tokenA.mint(address(this), 1_000 ether);
        tokenA.approve(address(router), type(uint256).max);
        (bool ok,) = address(router)
            .call(
                abi.encodeCall(
                    router.swapV3,
                    (
                        address(this),
                        false,
                        uint24(2500),
                        address(tokenA),
                        address(tokenB),
                        100 ether,
                        0,
                        block.timestamp
                    )
                )
            );
        require(!ok, "unsupported V3 fee accepted");
        require(tokenA.transferFromCalls() == 0, "funds touched before fee rejection");

        ChainAwareAmmAdapter wrongFactory = _router(true, address(manager), address(0xDEAD));
        tokenA.approve(address(wrongFactory), type(uint256).max);
        (ok,) = address(wrongFactory)
            .call(
                abi.encodeCall(
                    wrongFactory.swapV3,
                    (address(this), false, uint24(500), address(tokenA), address(tokenB), 100 ether, 0, block.timestamp)
                )
            );
        require(!ok, "wrong V3 factory accepted");
        require(tokenA.transferFromCalls() == 0, "funds touched before factory rejection");
    }

    function testV4ExactInputAndExactOutput() public {
        ChainAwareAmmAdapter router = _router(true, address(manager), V3_FACTORY);
        tokenA.mint(address(this), 10_000 ether);
        tokenB.mint(address(manager), 10_000 ether);
        tokenA.approve(address(router), type(uint256).max);

        (uint256 amountIn, uint256 amountOut) = router.swapV4(
            address(this), false, 500, 10, address(tokenA), address(tokenB), 1_000 ether, 500 ether, block.timestamp
        );
        require(amountIn == 1_000 ether && amountOut == 500 ether, "v4 exact-in");

        (amountIn, amountOut) = router.swapV4(
            address(this), true, 500, 10, address(tokenA), address(tokenB), 100 ether, 200 ether, block.timestamp
        );
        require(amountIn == 200 ether && amountOut == 100 ether, "v4 exact-out");
    }

    function testUnsupportedV4HookRevertsBeforeUnlockOrTransfer() public {
        ChainAwareAmmAdapter router = _router(true, address(manager), V3_FACTORY);
        tokenA.mint(address(this), 1_000 ether);
        tokenA.approve(address(router), type(uint256).max);
        (bool ok,) = address(router)
            .call(
                abi.encodeCall(
                    router.swapV4WithHook,
                    (
                        address(this),
                        false,
                        uint24(500),
                        int24(10),
                        address(tokenA),
                        address(tokenB),
                        100 ether,
                        0,
                        block.timestamp,
                        address(0xBEEF),
                        bytes("")
                    )
                )
            );
        require(!ok, "unsupported V4 hook accepted");
        require(manager.unlockCalls() == 0, "manager unlocked before hook rejection");
        require(tokenA.transferFromCalls() == 0, "funds touched before hook rejection");
    }

    function testSpoofedV4CallbackReverts() public {
        ChainAwareAmmAdapter router = _router(true, address(manager), V3_FACTORY);
        (bool ok,) = address(router).call(abi.encodeCall(router.unlockCallback, (bytes("spoof"))));
        require(!ok, "spoofed V4 callback accepted");
    }

    function testActiveChainIsCheckedOnEverySwap() public {
        ChainAwareAmmAdapter router = _router(true, address(manager), V3_FACTORY);
        vm.chainId(block.chainid + 1);
        (bool ok,) = address(router)
            .call(
                abi.encodeCall(
                    router.swapV2, (address(this), false, address(tokenA), address(tokenB), 1 ether, 0, block.timestamp)
                )
            );
        require(!ok, "wrong-chain swap accepted");
    }

    function _router(bool withSecondary, address poolManager, address v3Factory)
        private
        returns (ChainAwareAmmAdapter)
    {
        V2AdapterConfig memory primary = V2AdapterConfig(PRIMARY_FACTORY, PRIMARY_HASH, 30);
        V2AdapterConfig memory secondary = withSecondary
            ? V2AdapterConfig(SECONDARY_FACTORY, SECONDARY_HASH, 30)
            : V2AdapterConfig(address(0), bytes32(0), 0);
        uint24[] memory fees = new uint24[](2);
        fees[0] = 500;
        fees[1] = 3000;
        V3AdapterConfig memory v3 = V3AdapterConfig(v3Factory, V3_HASH, fees);
        return new ChainAwareAmmAdapter(
            block.chainid, address(wrapped), address(this), primary, secondary, v3, V4AdapterConfig(poolManager)
        );
    }

    function _installV2Pool(address pool) private {
        MockV2Pool implementation = new MockV2Pool();
        vm.etch(pool, address(implementation).code);
        (address token0, address token1) =
            address(tokenA) < address(tokenB) ? (address(tokenA), address(tokenB)) : (address(tokenB), address(tokenA));
        MockV2Pool(pool).initialize(token0, token1, 1_000_000 ether, 1_000_000 ether);
    }

    function _installV3Pool(address pool) private {
        MockV3Pool implementation = new MockV3Pool();
        vm.etch(pool, address(implementation).code);
        (address token0, address token1) =
            address(tokenA) < address(tokenB) ? (address(tokenA), address(tokenB)) : (address(tokenB), address(tokenA));
        MockV3Pool(pool).initialize(token0, token1);
    }
}

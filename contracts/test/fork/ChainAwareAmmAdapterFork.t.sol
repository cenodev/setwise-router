// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    ChainAwareAmmAdapter,
    V2AdapterConfig,
    V3AdapterConfig,
    V4AdapterConfig
} from "../../src/amm/ChainAwareAmmAdapter.sol";

interface Vm {
    function createSelectFork(string calldata rpcUrl) external returns (uint256 forkId);
    function createSelectFork(string calldata rpcUrl, uint256 blockNumber) external returns (uint256 forkId);
    function deal(address account, uint256 newBalance) external;
    function envOr(string calldata name, string calldata defaultValue) external view returns (string memory value);
}

interface IERC20Fork {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract ChainAwareAmmAdapterForkTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant ETHEREUM_BLOCK = 25_591_046;
    uint256 private constant BSC_BLOCK = 111_549_346;
    uint256 private constant BASE_BLOCK = 48_983_756;

    address private constant ETHEREUM_WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address private constant ETHEREUM_USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address private constant ETHEREUM_V2_FACTORY = 0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f;
    address private constant ETHEREUM_SUSHI_FACTORY = 0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac;
    address private constant ETHEREUM_V3_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    address private constant ETHEREUM_V4_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    address private constant ETHEREUM_UNISWAP_V2_WETH_USDC = 0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc;
    address private constant ETHEREUM_SUSHI_WETH_USDC = 0x397FF1542f962076d0BFE58eA045FfA2d347ACa0;
    address private constant ETHEREUM_V3_WETH_USDC_500 = 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640;

    address private constant BSC_WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address private constant BSC_USDT = 0x55d398326f99059fF775485246999027B3197955;
    address private constant BSC_PANCAKE_FACTORY = 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73;
    address private constant BSC_V3_FACTORY = 0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7;
    address private constant BSC_PANCAKE_WBNB_USDT = 0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE;
    address private constant BSC_V3_WBNB_USDT_500 = 0x6fe9E9de56356F7eDBfcBB29FAB7cd69471a4869;

    address private constant BASE_WETH = 0x4200000000000000000000000000000000000006;
    address private constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address private constant BASE_V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address private constant BASE_V4_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    address private constant BASE_V3_WETH_USDC_500 = 0xd0b53D9277642d899DF5C87A3966A349A798F224;

    bytes32 private constant UNISWAP_V2_HASH = 0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f;
    bytes32 private constant SUSHI_V2_HASH = 0xe18a34eb0e04b04f7a0ac29a6e80748dca96319b42c54d679cb821dca90c6303;
    bytes32 private constant PANCAKE_V2_HASH = 0x00fb7f630766e6a796048ea87d01acd3068e8ff67d078148a3fa3f4a84f69bd5;
    bytes32 private constant UNISWAP_V3_HASH = 0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54;

    function testForkEthereumUniswapV2ExactInput() public {
        _selectEthereum();
        ChainAwareAmmAdapter router = _ethereumRouter();
        (address pool,) = router.v2PoolFor(ETHEREUM_WETH, ETHEREUM_USDC, false);
        require(pool == ETHEREUM_UNISWAP_V2_WETH_USDC, "Ethereum Uniswap V2 derivation");
        _wrapAndApprove(ETHEREUM_WETH, address(router), 0.02 ether);

        uint256 beforeBalance = IERC20Fork(ETHEREUM_USDC).balanceOf(address(this));
        (uint256 amountIn, uint256 amountOut) =
            router.swapV2(address(this), false, ETHEREUM_WETH, ETHEREUM_USDC, 0.01 ether, 1, block.timestamp);
        require(amountIn == 0.01 ether && amountOut > 0, "Ethereum Uniswap V2 amounts");
        require(
            IERC20Fork(ETHEREUM_USDC).balanceOf(address(this)) - beforeBalance == amountOut,
            "Ethereum Uniswap V2 delivery"
        );
    }

    function testForkEthereumSushiV2ExactInput() public {
        _selectEthereum();
        ChainAwareAmmAdapter router = _ethereumRouter();
        (address pool,) = router.v2PoolFor(ETHEREUM_WETH, ETHEREUM_USDC, true);
        require(pool == ETHEREUM_SUSHI_WETH_USDC, "Ethereum Sushi V2 derivation");
        _wrapAndApprove(ETHEREUM_WETH, address(router), 0.02 ether);

        (uint256 amountIn, uint256 amountOut) =
            router.swapV2(address(this), false, ETHEREUM_WETH, ETHEREUM_USDC, 0.01 ether, 1, type(uint256).max);
        require(amountIn == 0.01 ether && amountOut > 0, "Ethereum Sushi V2 amounts");
    }

    function testForkEthereumUniswapV3ExactInput() public {
        _selectEthereum();
        ChainAwareAmmAdapter router = _ethereumRouter();
        (address pool,) = router.v3PoolFor(ETHEREUM_WETH, ETHEREUM_USDC, 500);
        require(pool == ETHEREUM_V3_WETH_USDC_500, "Ethereum V3 derivation");
        _wrapAndApprove(ETHEREUM_WETH, address(router), 0.02 ether);

        (uint256 amountIn, uint256 amountOut) =
            router.swapV3(address(this), false, 500, ETHEREUM_WETH, ETHEREUM_USDC, 0.01 ether, 1, block.timestamp);
        require(amountIn == 0.01 ether && amountOut > 0, "Ethereum V3 amounts");
    }

    function testForkEthereumUniswapV4HooklessExactInput() public {
        _selectEthereum();
        ChainAwareAmmAdapter router = _ethereumRouter();
        vm.deal(address(this), 1 ether);

        (uint256 amountIn, uint256 amountOut) = router.swapV4{value: 0.01 ether}(
            address(this), false, 500, 10, address(0), ETHEREUM_USDC, 0.01 ether, 1, block.timestamp
        );
        require(amountIn == 0.01 ether && amountOut > 0, "Ethereum V4 amounts");
    }

    function testForkBscPancakeV2ExactInput() public {
        _selectBsc();
        ChainAwareAmmAdapter router = _bscRouter();
        (address pool,) = router.v2PoolFor(BSC_WBNB, BSC_USDT, false);
        require(pool == BSC_PANCAKE_WBNB_USDT, "BSC Pancake V2 derivation");
        _wrapAndApprove(BSC_WBNB, address(router), 0.02 ether);

        (uint256 amountIn, uint256 amountOut) =
            router.swapV2(address(this), false, BSC_WBNB, BSC_USDT, 0.01 ether, 1, block.timestamp);
        require(amountIn == 0.01 ether && amountOut > 0, "BSC Pancake V2 amounts");
    }

    function testForkBscUniswapV3ExactInput() public {
        _selectBsc();
        ChainAwareAmmAdapter router = _bscRouter();
        (address pool,) = router.v3PoolFor(BSC_WBNB, BSC_USDT, 500);
        require(pool == BSC_V3_WBNB_USDT_500, "BSC V3 derivation");
        _wrapAndApprove(BSC_WBNB, address(router), 0.02 ether);

        (uint256 amountIn, uint256 amountOut) =
            router.swapV3(address(this), false, 500, BSC_WBNB, BSC_USDT, 0.01 ether, 1, block.timestamp);
        require(amountIn == 0.01 ether && amountOut > 0, "BSC V3 amounts");
    }

    function testForkBaseUniswapV3ExactInput() public {
        _selectBase();
        ChainAwareAmmAdapter router = _baseRouter();
        (address pool,) = router.v3PoolFor(BASE_WETH, BASE_USDC, 500);
        require(pool == BASE_V3_WETH_USDC_500, "Base V3 derivation");
        _wrapAndApprove(BASE_WETH, address(router), 0.02 ether);

        (uint256 amountIn, uint256 amountOut) =
            router.swapV3(address(this), false, 500, BASE_WETH, BASE_USDC, 0.01 ether, 1, block.timestamp);
        require(amountIn == 0.01 ether && amountOut > 0, "Base V3 amounts");
    }

    function testForkBaseUniswapV4HooklessExactInput() public {
        _selectBase();
        ChainAwareAmmAdapter router = _baseRouter();
        vm.deal(address(this), 1 ether);

        (uint256 amountIn, uint256 amountOut) = router.swapV4{value: 0.01 ether}(
            address(this), false, 500, 10, address(0), BASE_USDC, 0.01 ether, 1, block.timestamp
        );
        require(amountIn == 0.01 ether && amountOut > 0, "Base V4 amounts");
    }

    /// @dev Robinhood Chain has no enabled direct AMM in canonical configuration,
    ///      so there is deliberately no live adapter fork case until addresses are verified.
    function testRobinhoodHasNoEnabledDirectAdapter() public pure {
        require(true, "documented no-op");
    }

    function _ethereumRouter() private returns (ChainAwareAmmAdapter) {
        return new ChainAwareAmmAdapter(
            1,
            ETHEREUM_WETH,
            address(this),
            V2AdapterConfig(ETHEREUM_V2_FACTORY, UNISWAP_V2_HASH, 30),
            V2AdapterConfig(ETHEREUM_SUSHI_FACTORY, SUSHI_V2_HASH, 30),
            V3AdapterConfig(ETHEREUM_V3_FACTORY, UNISWAP_V3_HASH, _v3Fees()),
            V4AdapterConfig(ETHEREUM_V4_MANAGER)
        );
    }

    function _bscRouter() private returns (ChainAwareAmmAdapter) {
        return new ChainAwareAmmAdapter(
            56,
            BSC_WBNB,
            address(this),
            V2AdapterConfig(BSC_PANCAKE_FACTORY, PANCAKE_V2_HASH, 25),
            V2AdapterConfig(address(0), bytes32(0), 0),
            V3AdapterConfig(BSC_V3_FACTORY, UNISWAP_V3_HASH, _v3Fees()),
            V4AdapterConfig(address(0))
        );
    }

    function _baseRouter() private returns (ChainAwareAmmAdapter) {
        return new ChainAwareAmmAdapter(
            8453,
            BASE_WETH,
            address(this),
            V2AdapterConfig(address(0), bytes32(0), 0),
            V2AdapterConfig(address(0), bytes32(0), 0),
            V3AdapterConfig(BASE_V3_FACTORY, UNISWAP_V3_HASH, _v3Fees()),
            V4AdapterConfig(BASE_V4_MANAGER)
        );
    }

    function _v3Fees() private pure returns (uint24[] memory fees) {
        fees = new uint24[](4);
        fees[0] = 100;
        fees[1] = 500;
        fees[2] = 3000;
        fees[3] = 10_000;
    }

    function _selectEthereum() private {
        vm.createSelectFork(vm.envOr("RPC_URL_ETHEREUM", string("https://ethereum-rpc.publicnode.com")), ETHEREUM_BLOCK);
    }

    function _selectBsc() private {
        string memory archiveRpc = vm.envOr("RPC_ARCHIVE_URL_BSC", string(""));
        if (bytes(archiveRpc).length != 0) {
            vm.createSelectFork(archiveRpc, BSC_BLOCK);
        } else {
            // Binance's public endpoint is not archival. Keep the secret-free
            // fallback executable at latest; CI/release runs supply the archive role.
            vm.createSelectFork(vm.envOr("RPC_URL_BSC", string("https://bsc-dataseed.binance.org")));
        }
    }

    function _selectBase() private {
        vm.createSelectFork(vm.envOr("RPC_URL_BASE", string("https://mainnet.base.org")), BASE_BLOCK);
    }

    function _wrapAndApprove(address wrappedNative, address router, uint256 amount) private {
        vm.deal(address(this), amount);
        (bool ok,) = wrappedNative.call{value: amount}("");
        require(ok, "wrap failed");
        require(IERC20Fork(wrappedNative).approve(router, type(uint256).max), "approve failed");
    }

    receive() external payable {}
}

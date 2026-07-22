// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {NativeAccounting, NativeTokenLib} from "../setwise/NativeToken.sol";

struct V2AdapterConfig {
    address factory;
    bytes32 initCodeHash;
    uint16 feeBps;
}

struct V3AdapterConfig {
    address factory;
    bytes32 initCodeHash;
    uint24[] fees;
}

struct V4AdapterConfig {
    address poolManager;
}

struct V4PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct V4SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IV2Pool {
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
}

interface IV3Pool {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

interface IV4PoolManager {
    function unlock(bytes calldata data) external returns (bytes memory result);
    function swap(V4PoolKey memory key, V4SwapParams memory params, bytes calldata hookData)
        external
        returns (int256 swapDelta);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
}

/// @title ChainAwareAmmAdapter
/// @notice Direct V2, V3, and V4 execution with chain-bound immutable protocol
///         configuration. The public swap signatures retain the ZFi exact-input /
///         exact-output model; `deadline == type(uint256).max` on `swapV2` retains
///         the upstream secondary-V2 sentinel behavior.
/// @dev The canonical registry generates constructor inputs for one deployment per
///      chain. Every swap rechecks `block.chainid`, rejects unsupported adapters
///      before moving funds, and authenticates callbacks against both the immutable
///      deployment and a transient active-swap context.
contract ChainAwareAmmAdapter is NativeAccounting {
    uint160 internal constant MIN_SQRT_RATIO_PLUS_ONE = 4_295_128_740;
    uint160 internal constant MAX_SQRT_RATIO_MINUS_ONE =
        1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341;
    uint256 private constant BPS_DENOMINATOR = 10_000;
    bytes32 private constant V3_CALLBACK_SLOT = keccak256("setwise.router.amm.v3Callback");
    bytes32 private constant V4_CALLBACK_SLOT = keccak256("setwise.router.amm.v4Callback");

    uint256 public immutable configuredChainId;

    address public immutable v2PrimaryFactory;
    bytes32 public immutable v2PrimaryInitCodeHash;
    uint16 public immutable v2PrimaryFeeBps;
    address public immutable v2SecondaryFactory;
    bytes32 public immutable v2SecondaryInitCodeHash;
    uint16 public immutable v2SecondaryFeeBps;

    address public immutable v3Factory;
    bytes32 public immutable v3InitCodeHash;
    bytes32 public immutable v3FeesPacked;
    uint8 public immutable v3FeeCount;

    address public immutable v4PoolManager;

    error BadSwap();
    error Expired();
    error Slippage();
    error WrongChain(uint256 expected, uint256 actual);
    error InvalidAdapterConfig();
    error UnsupportedAdapter(uint8 version, uint8 adapterId);
    error UnsupportedV3Fee(uint24 fee);
    error UnsupportedV4Hook(address hooks);
    error InvalidTokenPair(address tokenIn, address tokenOut);
    error PoolNotDeployed(address pool);
    error InvalidV3Callback(address caller);
    error InvalidV4Callback(address caller);
    error AmmTokenTransferFailed(address token, address from, address to, uint256 amount);

    event AmmSwap(
        uint8 indexed version,
        uint8 indexed adapterId,
        address indexed payer,
        address recipient,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    constructor(
        uint256 chainId_,
        address wrappedNative_,
        address governance_,
        V2AdapterConfig memory v2Primary_,
        V2AdapterConfig memory v2Secondary_,
        V3AdapterConfig memory v3_,
        V4AdapterConfig memory v4_
    ) NativeAccounting(wrappedNative_, governance_) {
        if (chainId_ == 0 || chainId_ != block.chainid) {
            revert WrongChain(chainId_, block.chainid);
        }
        _validateV2Config(v2Primary_);
        _validateV2Config(v2Secondary_);

        configuredChainId = chainId_;
        v2PrimaryFactory = v2Primary_.factory;
        v2PrimaryInitCodeHash = v2Primary_.initCodeHash;
        v2PrimaryFeeBps = v2Primary_.feeBps;
        v2SecondaryFactory = v2Secondary_.factory;
        v2SecondaryInitCodeHash = v2Secondary_.initCodeHash;
        v2SecondaryFeeBps = v2Secondary_.feeBps;

        (bytes32 packedFees, uint8 feeCount) = _validateAndPackV3Config(v3_);
        v3Factory = v3_.factory;
        v3InitCodeHash = v3_.initCodeHash;
        v3FeesPacked = packedFees;
        v3FeeCount = feeCount;
        v4PoolManager = v4_.poolManager;
    }

    modifier onlyConfiguredChain() {
        if (block.chainid != configuredChainId) {
            revert WrongChain(configuredChainId, block.chainid);
        }
        _;
    }

    // --- V2 ----------------------------------------------------------------

    function swapV2(
        address to,
        bool exactOut,
        address tokenIn,
        address tokenOut,
        uint256 swapAmount,
        uint256 amountLimit,
        uint256 deadline
    )
        external
        payable
        onlyConfiguredChain
        nativeFrame(tokenIn != address(0))
        returns (uint256 amountIn, uint256 amountOut)
    {
        bool secondary = deadline == type(uint256).max;
        if (!secondary && block.timestamp > deadline) revert Expired();
        if (to == address(0)) revert ZeroRecipient();

        V2SwapState memory state = _prepareV2(tokenIn, tokenOut, secondary);
        uint256 requestedAmount = swapAmount == 0 && state.nativeIn ? msg.value : swapAmount;
        (amountIn, amountOut) =
            _quoteV2(exactOut, requestedAmount, amountLimit, state.reserveIn, state.reserveOut, state.feeBps);

        _payV2(state.pool, state.tokenIn, state.nativeIn, amountIn);
        address poolRecipient = state.nativeOut ? address(this) : to;
        if (state.zeroForOne) {
            IV2Pool(state.pool).swap(0, amountOut, poolRecipient, "");
        } else {
            IV2Pool(state.pool).swap(amountOut, 0, poolRecipient, "");
        }
        if (state.nativeOut) _unwrapTo(to, amountOut);

        emit AmmSwap(2, secondary ? 1 : 0, msg.sender, to, tokenIn, tokenOut, amountIn, amountOut);
    }

    function v2PoolFor(address tokenA, address tokenB, bool secondary)
        external
        view
        onlyConfiguredChain
        returns (address pool, bool zeroForOne)
    {
        (address factory, bytes32 initCodeHash,) = _v2Config(secondary);
        address normalizedA = tokenA == address(0) ? wrappedNative : tokenA;
        address normalizedB = tokenB == address(0) ? wrappedNative : tokenB;
        _validateTokenPair(normalizedA, normalizedB);
        return _v2PoolFor(normalizedA, normalizedB, factory, initCodeHash);
    }

    // --- V3 ----------------------------------------------------------------

    function swapV3(
        address to,
        bool exactOut,
        uint24 swapFee,
        address tokenIn,
        address tokenOut,
        uint256 swapAmount,
        uint256 amountLimit,
        uint256 deadline
    )
        external
        payable
        onlyConfiguredChain
        nativeFrame(tokenIn != address(0))
        returns (uint256 amountIn, uint256 amountOut)
    {
        if (block.timestamp > deadline) revert Expired();
        if (to == address(0)) revert ZeroRecipient();
        _requireV3Fee(swapFee);

        bool nativeIn = tokenIn == address(0);
        bool nativeOut = tokenOut == address(0);
        address normalizedIn = nativeIn ? wrappedNative : tokenIn;
        address normalizedOut = nativeOut ? wrappedNative : tokenOut;
        _validateTokenPair(normalizedIn, normalizedOut);
        if (!exactOut && swapAmount == 0 && nativeIn) swapAmount = msg.value;
        if (swapAmount == 0 || swapAmount > uint256(type(int256).max)) revert BadSwap();

        (address pool, bool zeroForOne) = _v3PoolFor(normalizedIn, normalizedOut, swapFee);
        _requirePool(pool);
        bytes memory callbackData = abi.encode(msg.sender, normalizedIn, normalizedOut, nativeIn, swapFee);
        _storeTransient(V3_CALLBACK_SLOT, keccak256(callbackData));
        (int256 amount0Delta, int256 amount1Delta) = IV3Pool(pool)
            .swap(
                nativeOut ? address(this) : to,
                zeroForOne,
                exactOut ? -int256(swapAmount) : int256(swapAmount),
                zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE,
                callbackData
            );
        if (_loadTransient(V3_CALLBACK_SLOT) != bytes32(0)) revert InvalidV3Callback(pool);

        int256 inputDelta = zeroForOne ? amount0Delta : amount1Delta;
        int256 outputDelta = zeroForOne ? amount1Delta : amount0Delta;
        if (inputDelta <= 0 || outputDelta >= 0) revert BadSwap();
        amountIn = uint256(inputDelta);
        amountOut = uint256(-outputDelta);
        if (exactOut) {
            if (amountOut != swapAmount || (amountLimit != 0 && amountIn > amountLimit)) revert Slippage();
        } else if (amountIn != swapAmount || (amountLimit != 0 && amountOut < amountLimit)) {
            revert Slippage();
        }
        if (nativeOut) _unwrapTo(to, amountOut);

        emit AmmSwap(3, 0, msg.sender, to, tokenIn, tokenOut, amountIn, amountOut);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data)
        external
        onlyConfiguredChain
    {
        bytes32 expected = _loadTransient(V3_CALLBACK_SLOT);
        if (expected == bytes32(0) || expected != keccak256(data)) {
            revert InvalidV3Callback(msg.sender);
        }
        (address payer, address tokenIn, address tokenOut, bool nativeIn, uint24 fee) =
            abi.decode(data, (address, address, address, bool, uint24));
        _requireV3Fee(fee);
        (address pool, bool zeroForOne) = _v3PoolFor(tokenIn, tokenOut, fee);
        if (msg.sender != pool) revert InvalidV3Callback(msg.sender);

        int256 requiredDelta = zeroForOne ? amount0Delta : amount1Delta;
        if (requiredDelta <= 0) revert BadSwap();
        _storeTransient(V3_CALLBACK_SLOT, bytes32(0));
        uint256 amountRequired = uint256(requiredDelta);
        if (nativeIn) {
            _spendNative(amountRequired);
            NativeTokenLib.wrap(wrappedNative, amountRequired);
            _safeTransfer(tokenIn, pool, amountRequired);
        } else {
            _safeTransferFrom(tokenIn, payer, pool, amountRequired);
        }
    }

    function v3PoolFor(address tokenA, address tokenB, uint24 fee)
        external
        view
        onlyConfiguredChain
        returns (address pool, bool zeroForOne)
    {
        _requireV3Fee(fee);
        address normalizedA = tokenA == address(0) ? wrappedNative : tokenA;
        address normalizedB = tokenB == address(0) ? wrappedNative : tokenB;
        _validateTokenPair(normalizedA, normalizedB);
        return _v3PoolFor(normalizedA, normalizedB, fee);
    }

    function isV3FeeSupported(uint24 fee) public view returns (bool) {
        uint256 packed = uint256(v3FeesPacked);
        for (uint256 i = 0; i < v3FeeCount; ++i) {
            if (uint24(packed >> (i * 24)) == fee) return true;
        }
        return false;
    }

    // --- V4 ----------------------------------------------------------------

    function swapV4(
        address to,
        bool exactOut,
        uint24 swapFee,
        int24 tickSpacing,
        address tokenIn,
        address tokenOut,
        uint256 swapAmount,
        uint256 amountLimit,
        uint256 deadline
    )
        external
        payable
        onlyConfiguredChain
        nativeFrame(tokenIn != address(0))
        returns (uint256 amountIn, uint256 amountOut)
    {
        return _swapV4(
            to, exactOut, swapFee, tickSpacing, tokenIn, tokenOut, swapAmount, amountLimit, deadline, address(0), ""
        );
    }

    /// @notice Explicit hook-bearing entry point. Current deployments are
    ///         configured as hookless, so any non-zero hook fails before unlock or
    ///         token transfer. The separate entry point keeps that policy visible.
    function swapV4WithHook(
        address to,
        bool exactOut,
        uint24 swapFee,
        int24 tickSpacing,
        address tokenIn,
        address tokenOut,
        uint256 swapAmount,
        uint256 amountLimit,
        uint256 deadline,
        address hooks,
        bytes calldata hookData
    )
        external
        payable
        onlyConfiguredChain
        nativeFrame(tokenIn != address(0))
        returns (uint256 amountIn, uint256 amountOut)
    {
        return _swapV4(
            to, exactOut, swapFee, tickSpacing, tokenIn, tokenOut, swapAmount, amountLimit, deadline, hooks, hookData
        );
    }

    function unlockCallback(bytes calldata callbackData) external onlyConfiguredChain returns (bytes memory result) {
        bytes32 expected = _loadTransient(V4_CALLBACK_SLOT);
        if (msg.sender != v4PoolManager || expected == bytes32(0) || expected != keccak256(callbackData)) {
            revert InvalidV4Callback(msg.sender);
        }
        _storeTransient(V4_CALLBACK_SLOT, bytes32(0));

        V4CallbackData memory data = abi.decode(callbackData, (V4CallbackData));
        _validateV4Hook(data.hooks, data.hookData);
        bool zeroForOne = data.tokenIn < data.tokenOut;
        V4PoolKey memory key = V4PoolKey({
            currency0: zeroForOne ? data.tokenIn : data.tokenOut,
            currency1: zeroForOne ? data.tokenOut : data.tokenIn,
            fee: data.fee,
            tickSpacing: data.tickSpacing,
            hooks: data.hooks
        });
        int256 delta = IV4PoolManager(msg.sender)
            .swap(
                key,
                V4SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: data.exactOut ? int256(data.swapAmount) : -int256(data.swapAmount),
                sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE
            }),
                data.hookData
            );
        (uint256 amountIn, uint256 amountOut) = _decodeV4Delta(delta, zeroForOne);
        if (data.exactOut) {
            if (amountOut != data.swapAmount || (data.amountLimit != 0 && amountIn > data.amountLimit)) {
                revert Slippage();
            }
        } else if (amountIn != data.swapAmount || (data.amountLimit != 0 && amountOut < data.amountLimit)) {
            revert Slippage();
        }

        if (data.tokenIn == address(0)) {
            _spendNative(amountIn);
            IV4PoolManager(msg.sender).settle{value: amountIn}();
        } else {
            IV4PoolManager(msg.sender).sync(data.tokenIn);
            _safeTransferFrom(data.tokenIn, data.payer, msg.sender, amountIn);
            IV4PoolManager(msg.sender).settle();
        }
        IV4PoolManager(msg.sender).take(data.tokenOut, data.to, amountOut);
        return abi.encode(amountIn, amountOut);
    }

    // --- internal helpers --------------------------------------------------

    struct V4CallbackData {
        address payer;
        address to;
        bool exactOut;
        uint24 fee;
        int24 tickSpacing;
        address tokenIn;
        address tokenOut;
        uint256 swapAmount;
        uint256 amountLimit;
        address hooks;
        bytes hookData;
    }

    struct V2SwapState {
        address pool;
        address tokenIn;
        uint256 reserveIn;
        uint256 reserveOut;
        uint16 feeBps;
        bool zeroForOne;
        bool nativeIn;
        bool nativeOut;
    }

    function _swapV4(
        address to,
        bool exactOut,
        uint24 swapFee,
        int24 tickSpacing,
        address tokenIn,
        address tokenOut,
        uint256 swapAmount,
        uint256 amountLimit,
        uint256 deadline,
        address hooks,
        bytes memory hookData
    ) internal returns (uint256 amountIn, uint256 amountOut) {
        if (block.timestamp > deadline) revert Expired();
        if (to == address(0)) revert ZeroRecipient();
        if (v4PoolManager == address(0)) revert UnsupportedAdapter(4, 0);
        _validateV4Hook(hooks, hookData);
        _validateTokenPair(tokenIn, tokenOut);
        if (!exactOut && swapAmount == 0 && tokenIn == address(0)) swapAmount = msg.value;
        if (swapAmount == 0 || swapAmount > uint256(type(int256).max)) revert BadSwap();
        _requirePool(v4PoolManager);

        bytes memory callbackData = abi.encode(
            V4CallbackData({
                payer: msg.sender,
                to: to,
                exactOut: exactOut,
                fee: swapFee,
                tickSpacing: tickSpacing,
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                swapAmount: swapAmount,
                amountLimit: amountLimit,
                hooks: hooks,
                hookData: hookData
            })
        );
        _storeTransient(V4_CALLBACK_SLOT, keccak256(callbackData));
        bytes memory result = IV4PoolManager(v4PoolManager).unlock(callbackData);
        if (_loadTransient(V4_CALLBACK_SLOT) != bytes32(0)) {
            revert InvalidV4Callback(v4PoolManager);
        }
        (amountIn, amountOut) = abi.decode(result, (uint256, uint256));
        emit AmmSwap(4, 0, msg.sender, to, tokenIn, tokenOut, amountIn, amountOut);
    }

    function _v2Config(bool secondary) internal view returns (address factory, bytes32 initCodeHash, uint16 feeBps) {
        if (secondary) {
            factory = v2SecondaryFactory;
            initCodeHash = v2SecondaryInitCodeHash;
            feeBps = v2SecondaryFeeBps;
        } else {
            factory = v2PrimaryFactory;
            initCodeHash = v2PrimaryInitCodeHash;
            feeBps = v2PrimaryFeeBps;
        }
        if (factory == address(0)) revert UnsupportedAdapter(2, secondary ? 1 : 0);
    }

    function _prepareV2(address tokenIn, address tokenOut, bool secondary)
        internal
        view
        returns (V2SwapState memory state)
    {
        (address factory, bytes32 initCodeHash, uint16 feeBps) = _v2Config(secondary);
        state.nativeIn = tokenIn == address(0);
        state.nativeOut = tokenOut == address(0);
        state.tokenIn = state.nativeIn ? wrappedNative : tokenIn;
        address normalizedOut = state.nativeOut ? wrappedNative : tokenOut;
        _validateTokenPair(state.tokenIn, normalizedOut);
        (state.pool, state.zeroForOne) = _v2PoolFor(state.tokenIn, normalizedOut, factory, initCodeHash);
        _requirePool(state.pool);
        (uint112 reserve0, uint112 reserve1,) = IV2Pool(state.pool).getReserves();
        (state.reserveIn, state.reserveOut) =
            state.zeroForOne ? (uint256(reserve0), uint256(reserve1)) : (uint256(reserve1), uint256(reserve0));
        state.feeBps = feeBps;
    }

    function _quoteV2(
        bool exactOut,
        uint256 swapAmount,
        uint256 amountLimit,
        uint256 reserveIn,
        uint256 reserveOut,
        uint16 feeBps
    ) internal pure returns (uint256 amountIn, uint256 amountOut) {
        if (exactOut) {
            if (swapAmount == 0 || swapAmount >= reserveOut) revert BadSwap();
            amountOut = swapAmount;
            uint256 feeFactor = BPS_DENOMINATOR - feeBps;
            uint256 numerator = reserveIn * amountOut * BPS_DENOMINATOR;
            uint256 denominator = (reserveOut - amountOut) * feeFactor;
            amountIn = (numerator + denominator - 1) / denominator;
            if (amountLimit != 0 && amountIn > amountLimit) revert Slippage();
        } else {
            amountIn = swapAmount;
            if (amountIn == 0) revert BadSwap();
            uint256 amountInWithFee = amountIn * (BPS_DENOMINATOR - feeBps);
            amountOut = (amountInWithFee * reserveOut) / (reserveIn * BPS_DENOMINATOR + amountInWithFee);
            if (amountOut == 0 || (amountLimit != 0 && amountOut < amountLimit)) revert Slippage();
        }
    }

    function _v2PoolFor(address tokenA, address tokenB, address factory, bytes32 initCodeHash)
        internal
        pure
        returns (address pool, bool zeroForOne)
    {
        (address token0, address token1, bool zf1) = _sortTokens(tokenA, tokenB);
        pool = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(hex"ff", factory, keccak256(abi.encodePacked(token0, token1)), initCodeHash)
                    )
                )
            )
        );
        zeroForOne = zf1;
    }

    function _v3PoolFor(address tokenA, address tokenB, uint24 fee)
        internal
        view
        returns (address pool, bool zeroForOne)
    {
        if (v3Factory == address(0)) revert UnsupportedAdapter(3, 0);
        (address token0, address token1, bool zf1) = _sortTokens(tokenA, tokenB);
        bytes32 salt = keccak256(abi.encode(token0, token1, fee));
        pool = address(uint160(uint256(keccak256(abi.encodePacked(hex"ff", v3Factory, salt, v3InitCodeHash)))));
        zeroForOne = zf1;
    }

    function _payV2(address pool, address tokenIn, bool nativeIn, uint256 amount) internal {
        if (nativeIn) {
            _spendNative(amount);
            NativeTokenLib.wrap(wrappedNative, amount);
            _safeTransfer(tokenIn, pool, amount);
        } else {
            _safeTransferFrom(tokenIn, msg.sender, pool, amount);
        }
    }

    function _validateTokenPair(address tokenIn, address tokenOut) internal pure {
        if (tokenIn == tokenOut || (tokenIn == address(0) && tokenOut == address(0))) {
            revert InvalidTokenPair(tokenIn, tokenOut);
        }
    }

    function _sortTokens(address tokenA, address tokenB)
        internal
        pure
        returns (address token0, address token1, bool zeroForOne)
    {
        zeroForOne = tokenA < tokenB;
        (token0, token1) = zeroForOne ? (tokenA, tokenB) : (tokenB, tokenA);
    }

    function _requirePool(address pool) internal view {
        if (pool.code.length == 0) revert PoolNotDeployed(pool);
    }

    function _requireV3Fee(uint24 fee) internal view {
        if (v3Factory == address(0)) revert UnsupportedAdapter(3, 0);
        if (!isV3FeeSupported(fee)) revert UnsupportedV3Fee(fee);
    }

    function _validateV4Hook(address hooks, bytes memory hookData) internal pure {
        if (hooks != address(0) || hookData.length != 0) revert UnsupportedV4Hook(hooks);
    }

    function _decodeV4Delta(int256 delta, bool zeroForOne) internal pure returns (uint256 amountIn, uint256 amountOut) {
        int128 amount0;
        int128 amount1;
        assembly ("memory-safe") {
            amount0 := sar(128, delta)
            amount1 := signextend(15, delta)
        }
        int256 inputDelta = zeroForOne ? int256(amount0) : int256(amount1);
        int256 outputDelta = zeroForOne ? int256(amount1) : int256(amount0);
        if (inputDelta >= 0 || outputDelta <= 0) revert BadSwap();
        amountIn = uint256(-inputDelta);
        amountOut = uint256(outputDelta);
    }

    function _validateV2Config(V2AdapterConfig memory config) private pure {
        bool disabled = config.factory == address(0);
        if (disabled) {
            if (config.initCodeHash != bytes32(0) || config.feeBps != 0) {
                revert InvalidAdapterConfig();
            }
        } else if (config.initCodeHash == bytes32(0) || config.feeBps == 0 || config.feeBps >= BPS_DENOMINATOR) {
            revert InvalidAdapterConfig();
        }
    }

    function _validateAndPackV3Config(V3AdapterConfig memory config)
        private
        pure
        returns (bytes32 packed, uint8 count)
    {
        if (config.factory == address(0)) {
            if (config.initCodeHash != bytes32(0) || config.fees.length != 0) {
                revert InvalidAdapterConfig();
            }
            return (bytes32(0), 0);
        }
        if (config.initCodeHash == bytes32(0) || config.fees.length == 0 || config.fees.length > 10) {
            revert InvalidAdapterConfig();
        }
        uint256 value;
        for (uint256 i = 0; i < config.fees.length; ++i) {
            uint24 fee = config.fees[i];
            if (fee == 0) revert InvalidAdapterConfig();
            for (uint256 j = 0; j < i; ++j) {
                if (config.fees[j] == fee) revert InvalidAdapterConfig();
            }
            value |= uint256(fee) << (i * 24);
        }
        return (bytes32(value), uint8(config.fees.length));
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory result) = token.call(abi.encodeWithSignature("transfer(address,uint256)", to, amount));
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) {
            revert AmmTokenTransferFailed(token, address(this), to, amount);
        }
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory result) =
            token.call(abi.encodeWithSignature("transferFrom(address,address,uint256)", from, to, amount));
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) {
            revert AmmTokenTransferFailed(token, from, to, amount);
        }
    }

    function _storeTransient(bytes32 slot, bytes32 value) private {
        assembly {
            tstore(slot, value)
        }
    }

    function _loadTransient(bytes32 slot) private view returns (bytes32 value) {
        assembly {
            value := tload(slot)
        }
    }
}

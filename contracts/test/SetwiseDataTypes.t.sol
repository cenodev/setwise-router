// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISetwisePool} from "../src/setwise/ISetwisePool.sol";
import {SetwiseSwap, SetwiseAssetMode, SetwiseSwapLib, SETWISE_NATIVE_TOKEN} from "../src/setwise/SetwiseSwap.sol";

interface Vm {
    function expectRevert() external;
}

contract SetwiseSwapHarness {
    function mode(SetwiseSwap calldata swap) external pure returns (SetwiseAssetMode) {
        return SetwiseSwapLib.mode(swap);
    }

    function entrySelector(SetwiseSwap calldata swap) external pure returns (bytes4) {
        return SetwiseSwapLib.entrySelector(swap);
    }

    function normalizeAsset(address asset, address wrappedNative) external pure returns (address) {
        return SetwiseSwapLib.normalizeAsset(asset, wrappedNative);
    }

    function quoteInputAsset(SetwiseSwap calldata swap, address wrappedNative) external pure returns (address) {
        return SetwiseSwapLib.quoteInputAsset(swap, wrappedNative);
    }

    function quoteOutputAsset(SetwiseSwap calldata swap, address wrappedNative) external pure returns (address) {
        return SetwiseSwapLib.quoteOutputAsset(swap, wrappedNative);
    }

    function validateNormalization(SetwiseSwap calldata swap, address wrappedNative) external pure {
        SetwiseSwapLib.validateNormalization(swap, wrappedNative);
    }
}

/// @notice Compatibility tests for the Setwise data types and the minimal pool
///         interface. Runs without forge-std: assertions use `require` and the
///         `expectRevert` cheatcode is declared inline.
contract SetwiseDataTypesTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant POOL = 0x5e7151dEf0A13C29Ca4D3A16b13b6b4A4d6a3A29;
    address internal constant RECIPIENT = 0x000000000000000000000000000000000000bEEF;

    SetwiseSwapHarness internal harness = new SetwiseSwapHarness();

    function _swap(bool nativeIn, bool nativeOut, address assetIn, address assetOut)
        internal
        pure
        returns (SetwiseSwap memory)
    {
        return SetwiseSwap({
            pool: POOL,
            assetIn: assetIn,
            assetOut: assetOut,
            nativeIn: nativeIn,
            nativeOut: nativeOut,
            amountIn: 1_000_000_000,
            amountOut: 500_000_000_000_000_000,
            quoteId: bytes32(uint256(1)),
            deadline: 1_893_456_000,
            recipient: RECIPIENT,
            signature: "",
            auxiliaryData: ""
        });
    }

    // --- interface selectors mirror the deployed pool ABI ---

    function testSwapSelectorsMatchDeployedPool() external pure {
        require(ISetwisePool.swapExactAssetForAsset.selector == 0x24266baa, "swapExactAssetForAsset");
        require(ISetwisePool.swapExactNativeForAsset.selector == 0xdcf8b279, "swapExactNativeForAsset");
        require(ISetwisePool.swapExactAssetForNative.selector == 0x695d9b7f, "swapExactAssetForNative");
    }

    function testViewSelectorsMatchDeployedPool() external pure {
        require(ISetwisePool.QUOTE_SIGNER.selector == 0xd0e15ba4, "QUOTE_SIGNER");
        require(ISetwisePool.WRAPPED_NATIVE_TOKEN.selector == 0x1b3f8c5e, "WRAPPED_NATIVE_TOKEN");
        require(ISetwisePool.usedQuoteIds.selector == 0x03ea8003, "usedQuoteIds");
        require(ISetwisePool.isSupportedAsset.selector == 0x9be918e6, "isSupportedAsset");
        require(ISetwisePool.quoteDomainSeparator.selector == 0x7102ae2a, "quoteDomainSeparator");
        require(ISetwisePool.recordedBalance.selector == 0x5089331d, "recordedBalance");
    }

    function testSwapQuoteTypehashMatchesDeployedPool() external pure {
        require(
            SetwiseSwapLib.SWAP_QUOTE_TYPEHASH == 0x05f457dcd915199b3c456f83a601d28b8a9c57b952c20f6b13c56eec1b203c13,
            "SWAP_QUOTE_TYPEHASH"
        );
    }

    // --- mode resolution is unambiguous for every asset mode ---

    function testModeResolution() external view {
        require(harness.mode(_swap(false, false, USDC, WETH)) == SetwiseAssetMode.ERC20_TO_ERC20, "erc20-to-erc20");
        require(harness.mode(_swap(true, false, WETH, USDC)) == SetwiseAssetMode.NATIVE_TO_ERC20, "native-to-erc20");
        require(harness.mode(_swap(false, true, USDC, WETH)) == SetwiseAssetMode.ERC20_TO_NATIVE, "erc20-to-native");
    }

    function testNativeToNativeHasNoMode() external {
        vm.expectRevert();
        harness.mode(_swap(true, true, WETH, WETH));
    }

    function testEntrySelectorFollowsMode() external view {
        require(
            harness.entrySelector(_swap(false, false, USDC, WETH)) == ISetwisePool.swapExactAssetForAsset.selector,
            "erc20-to-erc20 entry"
        );
        require(
            harness.entrySelector(_swap(true, false, WETH, USDC)) == ISetwisePool.swapExactNativeForAsset.selector,
            "native-to-erc20 entry"
        );
        require(
            harness.entrySelector(_swap(false, true, USDC, WETH)) == ISetwisePool.swapExactAssetForNative.selector,
            "erc20-to-native entry"
        );
    }

    // --- native <-> wrapped-native normalization ---

    function testNormalizeAssetMapsSentinelToWrappedNative() external view {
        require(harness.normalizeAsset(SETWISE_NATIVE_TOKEN, WETH) == WETH, "sentinel -> wrapped");
        require(harness.normalizeAsset(USDC, WETH) == USDC, "erc20 unchanged");
    }

    function testQuoteAssetsUseWrappedNativeForNativeLegs() external view {
        SetwiseSwap memory nativeIn = _swap(true, false, WETH, USDC);
        require(harness.quoteInputAsset(nativeIn, WETH) == WETH, "native-in quote asset");
        require(harness.quoteOutputAsset(nativeIn, WETH) == USDC, "native-in output asset");

        SetwiseSwap memory nativeOut = _swap(false, true, USDC, WETH);
        require(harness.quoteInputAsset(nativeOut, WETH) == USDC, "native-out input asset");
        require(harness.quoteOutputAsset(nativeOut, WETH) == WETH, "native-out quote asset");
    }

    function testValidateNormalizationAcceptsConsistentSwaps() external view {
        harness.validateNormalization(_swap(false, false, USDC, WETH), WETH);
        harness.validateNormalization(_swap(true, false, WETH, USDC), WETH);
        harness.validateNormalization(_swap(false, true, USDC, WETH), WETH);
        // Wrapped-native is a valid ERC-20 asset on a non-native leg (direct WETH swap).
        harness.validateNormalization(_swap(false, false, WETH, USDC), WETH);
    }

    function testValidateNormalizationRejectsNativeLegWithoutWrappedAsset() external {
        vm.expectRevert();
        harness.validateNormalization(_swap(true, false, USDC, USDC), WETH);
    }

    function testValidateNormalizationRejectsSentinelOnErc20Leg() external {
        vm.expectRevert();
        harness.validateNormalization(_swap(false, false, SETWISE_NATIVE_TOKEN, USDC), WETH);
    }
}

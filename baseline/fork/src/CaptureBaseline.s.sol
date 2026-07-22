// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "forge-std/Script.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {Vm} from "forge-std/Vm.sol";
import "zfi/zQuoter.sol";

/// @notice Fork harness that captures representative zQuoter return values,
///         gas usage, and revert selectors at the pinned mainnet block, plus a
///         few end-to-end zRouter executions. Output is one `ROUTE_JSON <json>`
///         line per capture; scripts/capture-execution-fixtures.mjs parses them
///         into baseline/routes/execution.json.
contract CaptureBaseline is Script, StdCheats {
    zQuoter quoter;

    // Full cheatcode interface (Script's inherited vm is VmSafe, which lacks
    // prank/deal). Used only to fund and impersonate the fixed SWAPPER.
    Vm internal constant VM = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    // Token constants WETH/USDC/USDT/DAI/WBTC/WSTETH are imported from the
    // file-level declarations in zQuoter.sol.
    address constant ROUTER = 0x000000000000FB114709235f1ccBFfb925F600e4;
    address constant ETH = address(0);

    address constant USER = address(0xBEEF);
    uint256 constant SLIPPAGE = 100; // 1%
    uint256 constant DEADLINE = type(uint256).max;
    uint256 constant FORK_BLOCK = 24_880_000;

    function run() external {
        string memory rpc = vm.envOr("ETH_RPC_URL", string("https://1rpc.io/eth"));
        vm.createSelectFork(rpc, FORK_BLOCK);
        quoter = new zQuoter();

        emitMeta(rpc);

        // --- quoter view captures (return data + gas) ---
        captureGetQuotes();
        captureBuildBestSwap("quoter-buildBestSwap-eth-to-wbtc", ETH, WBTC, 10 ether);
        captureBuildBestSwap("quoter-buildBestSwap-usdc-to-usdt", USDC, USDT, 1000e6);
        captureQuoteLido();

        // --- end-to-end router executions (gas + received) ---
        execBestSwap("exec-bestSwap-eth-to-dai", ETH, DAI, 1 ether);
        execBestSwap("exec-bestSwap-usdc-to-usdt", USDC, USDT, 1000e6);

        // --- revert captures (selector + signature) ---
        revertNoRouteSameToken();
        revertSlippageTooHigh();
        revertNoRouteUnrouteable();
    }

    // ---------------------------------------------------------------- meta

    function emitMeta(string memory rpc) internal view {
        console.log(
            string.concat(
                "ROUTE_META {\"rpc\":\"",
                rpc,
                '","block":',
                vm.toString(FORK_BLOCK),
                ',"quoter":"',
                vm.toString(address(quoter)),
                '","router":"',
                vm.toString(ROUTER),
                '"}'
            )
        );
    }

    // ---------------------------------------------------------------- helpers

    function logCapture(
        string memory id,
        string memory kind,
        bool ok,
        uint256 gas,
        bytes memory returnData,
        string memory extra
    ) internal view {
        console.log(
            string.concat(
                "ROUTE_JSON {\"id\":\"",
                id,
                '","kind":"',
                kind,
                '","ok":',
                ok ? "true" : "false",
                ',"gas":',
                vm.toString(gas),
                ',"returnData":"',
                vm.toString(returnData),
                '"',
                extra,
                "}"
            )
        );
    }

    function quoteExtra(zQuoter.Quote memory q) internal pure returns (string memory) {
        return
            string.concat(
                ',"source":',
                vm.toString(uint256(uint8(q.source))),
                ',"feeBps":',
                vm.toString(q.feeBps),
                ',"amountIn":"',
                vm.toString(q.amountIn),
                '","amountOut":"',
                vm.toString(q.amountOut),
                '"'
            );
    }

    // ---------------------------------------------------------------- view captures

    function captureGetQuotes() internal {
        bytes memory call = abi.encodeWithSelector(quoter.getQuotes.selector, false, ETH, DAI, 1 ether);
        uint256 g0 = gasleft();
        (bool ok, bytes memory ret) = address(quoter).staticcall(call);
        uint256 gas = g0 - gasleft();

        string memory extra = "";
        if (ok) {
            (zQuoter.Quote memory best, ) = abi.decode(ret, (zQuoter.Quote, zQuoter.Quote[]));
            extra = quoteExtra(best);
        }
        logCapture("quoter-getQuotes-eth-to-dai", "view", ok, gas, ret, extra);
    }

    function captureBuildBestSwap(string memory id, address tokenIn, address tokenOut, uint256 amt) internal {
        bytes memory call =
            abi.encodeWithSelector(quoter.buildBestSwap.selector, USER, false, tokenIn, tokenOut, amt, SLIPPAGE, DEADLINE);
        uint256 g0 = gasleft();
        (bool ok, bytes memory ret) = address(quoter).staticcall(call);
        uint256 gas = g0 - gasleft();

        string memory extra = "";
        if (ok) {
            (zQuoter.Quote memory best, , uint256 amountLimit, uint256 msgValue) =
                abi.decode(ret, (zQuoter.Quote, bytes, uint256, uint256));
            extra = string.concat(
                quoteExtra(best),
                ',"amountLimit":"',
                vm.toString(amountLimit),
                '","msgValue":"',
                vm.toString(msgValue),
                '"'
            );
        }
        logCapture(id, "view", ok, gas, ret, extra);
    }

    function captureQuoteLido() internal {
        bytes memory call = abi.encodeWithSelector(quoter.quoteLido.selector, false, WSTETH, 1 ether);
        uint256 g0 = gasleft();
        (bool ok, bytes memory ret) = address(quoter).staticcall(call);
        uint256 gas = g0 - gasleft();
        logCapture("quoter-quoteLido-eth-to-wsteth", "view", ok, gas, ret, "");
    }

    // ---------------------------------------------------------------- executions

    function execBestSwap(string memory id, address tokenIn, address tokenOut, uint256 amt) internal {
        (zQuoter.Quote memory q, bytes memory cd, , uint256 mv) =
            quoter.buildBestSwap(USER, false, tokenIn, tokenOut, amt, SLIPPAGE, DEADLINE);

        if (tokenIn == ETH) {
            deal(USER, mv);
        } else {
            deal(tokenIn, USER, amt);
            VM.prank(USER);
            (bool ap, ) = tokenIn.call(abi.encodeWithSignature("approve(address,uint256)", ROUTER, amt));
            require(ap, "approve failed");
        }

        uint256 balBefore = tokenOut == ETH ? USER.balance : _bal(tokenOut, USER);
        VM.prank(USER);
        uint256 g0 = gasleft();
        (bool ok, bytes memory ret) = ROUTER.call{value: mv}(cd);
        uint256 gas = g0 - gasleft();
        uint256 received = 0;
        if (ok) {
            uint256 balAfter = tokenOut == ETH ? USER.balance : _bal(tokenOut, USER);
            received = balAfter > balBefore ? balAfter - balBefore : 0;
        }

        string memory extra = string.concat(
            quoteExtra(q),
            ',"msgValue":"',
            vm.toString(mv),
            '","received":"',
            vm.toString(received),
            '"'
        );
        logCapture(id, "exec", ok, gas, ret, extra);
    }

    function _bal(address token, address who) internal view returns (uint256) {
        (bool ok, bytes memory d) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", who));
        return ok ? abi.decode(d, (uint256)) : 0;
    }

    // ---------------------------------------------------------------- reverts

    function revertNoRouteSameToken() internal {
        bytes memory call =
            abi.encodeWithSelector(quoter.buildSwapAuto.selector, USER, false, DAI, DAI, 1 ether, SLIPPAGE, DEADLINE);
        (bool ok, bytes memory ret) = address(quoter).staticcall(call);
        logRevert("revert-noRoute-same-token", ok, ret);
    }

    function revertSlippageTooHigh() internal {
        bytes memory call =
            abi.encodeWithSelector(quoter.buildBestSwap.selector, USER, false, ETH, DAI, 1 ether, 10_000, DEADLINE);
        (bool ok, bytes memory ret) = address(quoter).staticcall(call);
        logRevert("revert-slippageBpsTooHigh", ok, ret);
    }

    function revertNoRouteUnrouteable() internal {
        // A token with no liquidity against DAI should yield NoRoute.
        address dead = 0x000000000000000000000000000000000000dEaD;
        bytes memory call =
            abi.encodeWithSelector(quoter.buildBestSwap.selector, USER, false, dead, DAI, 1 ether, SLIPPAGE, DEADLINE);
        (bool ok, bytes memory ret) = address(quoter).staticcall(call);
        logRevert("revert-noRoute-unrouteable", ok, ret);
    }

    function logRevert(string memory id, bool ok, bytes memory ret) internal view {
        string memory selector = ret.length >= 4 ? vm.toString(bytes4(ret)) : "0x";
        console.log(
            string.concat(
                "ROUTE_JSON {\"id\":\"",
                id,
                '","kind":"revert","ok":',
                ok ? "true" : "false",
                ',"gas":0,"returnData":"',
                vm.toString(ret),
                '","revertSelector":"',
                selector,
                '"}'
            )
        );
    }
}

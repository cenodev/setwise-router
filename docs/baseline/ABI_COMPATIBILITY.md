# ZFi Ethereum ABI compatibility baseline

Pinned to [`z-fi/zFi@43ac1e67388cc4f96be6b2cbeb0f95f647c9aeb3`](https://github.com/z-fi/zFi/commit/43ac1e67388cc4f96be6b2cbeb0f95f647c9aeb3)
via the [`zFi-main/`](../../zFi-main) submodule. This document is generated from
the committed fixtures in [`baseline/abi/`](../../baseline/abi) — do not edit the
tables by hand.

## Purpose

Issue #5 defines what "preserve ZFi functionality" means on Ethereum. It records
the public router and quoter ABI, the supported venue and route combinations, the
revert surface, and an explicit decision on which non-swap extensions stay in
scope. The fixtures double as a golden baseline: `test/abi-baseline.test.js`
fails if the pinned submodule's ABI or the recorded fixtures change unexpectedly.

## Regenerate

```bash
npm run build                          # forge build of the pinned zFi-main snapshot
node scripts/build-abi-baseline.mjs    # rewrite baseline/abi/*.json from artifacts
node scripts/build-abi-docs.mjs        # rewrite this document from the fixtures
```

## zRouter — public ABI (29 functions)

Deployed bytecode: **24524 bytes** (default Foundry
profile; under the EIP-170 limit of 24,576).

### Swap execution core (scope: core-swap)

| Selector | Signature | Mutability | Venue | Notes |
| --- | --- | --- | --- | --- |
| `0x12db224a` | `swapCurve(address,bool,address[11],uint256[4][5],address[5],uint256,uint256,uint256)` | payable | CURVE | Up to 5 hops; exchange/underlying/add_liquidity/remove_liquidity_one_coin |
| `0x21c0dad2` | `swapV4(address,bool,uint24,int24,address,address,uint256,uint256,uint256)` | payable | UNI_V4 | — |
| `0x3f896275` | `snwapMulti(address,uint256,address,address[],uint256[],address,bytes)` | payable | EXECUTOR | Multi-output executor swap |
| `0x5f3bd1c8` | `snwap(address,uint256,address,address,uint256,address,bytes)` | payable | EXECUTOR | Generic executor swap; Bebop/Bitgetol/any via safeExecutor |
| `0x6e0a4f98` | `swapV2(address,bool,address,address,uint256,uint256,uint256)` | payable | UNI_V2\|SUSHI | deadline == type(uint256).max sentinel selects the SUSHI factory |
| `0x9d5b5af8` | `swapVZ(address,bool,uint256,address,address,uint256,uint256,uint256,uint256,uint256)` | payable | ZAMM | Raw selectors to ZAMM/ZAMM_0; ERC-20 (id 0) and ERC-6909 ids |
| `0xafeae12b` | `swapV3(address,bool,uint24,address,address,uint256,uint256,uint256)` | payable | UNI_V3 | — |

### Native / wrapped-native + Lido (scope: swap-support)

| Selector | Signature | Mutability | Venue | Notes |
| --- | --- | --- | --- | --- |
| `0x0efe6a8b` | `deposit(address,uint256,uint256)` | payable | — | Pull ETH/ERC-20/ERC-6909 into transient balance |
| `0x47c1ba3a` | `exactETHToSTETH(address)` | payable | LIDO | Exact-in ETH -> stETH |
| `0xbd6b76d7` | `ethToExactSTETH(address,uint256)` | payable | LIDO | Exact-out ETH -> stETH |
| `0xc391b381` | `ethToExactWSTETH(address,uint256)` | payable | LIDO | Exact-out ETH -> wstETH |
| `0xde0e9a3e` | `unwrap(uint256)` | payable | — | WETH -> ETH |
| `0xea598cb0` | `wrap(uint256)` | payable | — | ETH -> WETH |
| `0xf978602c` | `exactETHToWSTETH(address)` | payable | LIDO | Exact-in ETH -> wstETH |

### Funding & approvals (scope: swap-support)

| Selector | Signature | Mutability | Venue | Notes |
| --- | --- | --- | --- | --- |
| `0x06262f1b` | `trust(address,bool)` | payable | — | onlyOwner execute() target whitelist |
| `0x09d31579` | `permit2TransferFrom(address,uint256,uint256,uint256,bytes)` | payable | — | Permit2 signed single transfer |
| `0x230390f4` | `permitDAI(uint256,uint256,uint8,bytes32,bytes32)` | payable | — | DAI-style permit |
| `0x41abb1ef` | `ensureAllowance(address,bool,address)` | payable | — | onlyOwner max approval / ERC-6909 operator |
| `0x7984d8b1` | `permit2BatchTransferFrom((address,uint256)[],uint256,uint256,bytes)` | payable | — | Permit2 signed batch transfer |
| `0x7ac2ff7b` | `permit(address,uint256,uint256,uint8,bytes32,bytes32)` | payable | — | ERC-2612 permit |

### Execution plumbing (scope: swap-support)

| Selector | Signature | Mutability | Venue | Notes |
| --- | --- | --- | --- | --- |
| `0x91dd7346` | `unlockCallback(bytes)` | payable | UNI_V4 | V4 PoolManager unlock callback |
| `0xac9650d8` | `multicall(bytes[])` | payable | — | delegatecall batch; the chaining primitive |
| `0xb61d27f6` | `execute(address,uint256,bytes)` | payable | — | Call a trusted target; locks the V3/V4 callback slot |
| `0xcb019b84` | `sweep(address,uint256,uint256,address)` | payable | — | Withdraw ETH/ERC-20/ERC-6909 |
| `0xe8382b01` | `safeExecutor()` | view | — | Immutable SafeExecutor getter |

### Non-swap extensions (scope: extension)

| Selector | Signature | Mutability | Venue | Notes |
| --- | --- | --- | --- | --- |
| `0x150b7a02` | `onERC721Received(address,address,uint256,bytes)` | pure | — | ERC-721 receiver hook used during NameNFT reveal |
| `0x2cb9f974` | `revealName(string,bytes32,address)` | payable | — | NameNFT .wei commit-reveal registration |
| `0xc42957a8` | `addLiquidity((uint256,uint256,address,address,uint256),uint256,uint256,uint256,uint256,address,uint256)` | payable | ZAMM | Mints zAMM liquidity; NOT a swap (no router slippage/deadline guard) |
| `0xf2fde38b` | `transferOwnership(address)` | payable | — | — |

### Events

| Topic hash | Event |
| --- | --- |
| `0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0` | `OwnershipTransferred(address,address)` |

### Errors (revert surface)

| Selector | Error | Raised when |
| --- | --- | --- |
| `0x7c7f7bb9` | `BadSwap()` | Zero resolved input on exact-in swaps; V3 callback with both pool deltas zero; invalid Curve swap_type/pool_type; a Curve hop that fails to increase the output balance. |
| `0xb12d13eb` | `ETHTransferFailed()` | A native ETH transfer (payout or refund) failed. |
| `0x203d82d8` | `Expired()` | checkDeadline modifier: block.timestamp > deadline (swapV2/V3/V4/VZ/Curve). |
| `0xdfa1a408` | `InvalidId()` | deposit: native deposit carrying a non-zero ERC-6909 id. |
| `0x85cf0a35` | `InvalidMsgVal()` | msg.value mismatch on ETH-input Curve swaps and deposit(). |
| `0x7dd37f70` | `Slippage()` | Realized output below amountLimit (exact-in) or required input above amountLimit (exact-out) on V2/V3/V4/Curve. |
| `0x20768e08` | `SnwapSlippage(address,uint256,uint256)` | snwap/snwapMulti: measured recipient balance delta below amountOutMin. |
| `0x28982d61` | `SwapExactInFail()` | swapVZ: low-level exact-in call to ZAMM/ZAMM_0 returned false. |
| `0xb4fff567` | `SwapExactOutFail()` | swapVZ: low-level exact-out call to ZAMM/ZAMM_0 returned false. |
| `0x82b42900` | `Unauthorized()` | V3 callback caller is not the computed pool; V4 unlockCallback caller is not the PoolManager; non-owner calling ensureAllowance/trust/transferOwnership; execute() target not whitelisted via trust(). |

The router also surfaces Solady-style transfer helpers that revert with
`TransferFailed()`, `TransferFromFailed()`, and `ApproveFailed()` from the
free `safeTransfer`/`safeTransferFrom`/`safeApprove` functions.

## zQuoter — public ABI (9 functions, all `view`)

Deployed bytecode: **33106 bytes** on the default
profile — this **exceeds EIP-170**. Deploy zQuoter with the `zquoter` Foundry
profile (`optimizer_runs = 20`, `yul = false`) to stay under 24,576 bytes. The
ABI is identical across profiles; only bytecode size differs.

| Selector | Signature | Role |
| --- | --- | --- |
| `0x4c464f59` | `build3HopMulticall(address,bool,address,address,uint256,uint256,uint256)` | 3-hop route over two hub intermediates |
| `0x61bcd9b0` | `quoteLido(bool,address,uint256)` | ETH -> stETH/wstETH quote |
| `0x85f86a90` | `buildHybridSplit(address,address,address,uint256,uint256,uint256)` | Exact-in split: best direct vs best 2-hop |
| `0x892af013` | `buildSplitSwap(address,address,address,uint256,uint256,uint256)` | Exact-in split across top 2 venues |
| `0x98d7d292` | `buildSwapAuto(address,bool,address,address,uint256,uint256,uint256)` | Cascade: 2-hop then 3-hop |
| `0xe1fd10bc` | `getQuotes(bool,address,address,uint256)` | All-venue quote discovery; filters bogus exact-out V3 picks |
| `0xe453166e` | `buildBestSwapViaETHMulticall(address,address,bool,address,address,uint256,uint256,uint256)` | Best of single-hop vs 2-hop hub route |
| `0xe7798987` | `buildBestSwap(address,bool,address,address,uint256,uint256,uint256)` | Best single-hop route + calldata |
| `0xfdfd58fb` | `quoteCurve(bool,address,address,uint256,uint256)` | Single-hop Curve quote via MetaRegistry |

### Errors

| Selector | Error | Raised when |
| --- | --- | --- |
| `0x6586e129` | `NoRoute()` | No venue produced a non-zero quote, tokenIn == tokenOut, an unbuildable Curve source was selected, or every 2-hop/3-hop/split cascade failed. |
| `0x982c96c6` | `SlippageBpsTooHigh()` | slippageBps >= 10000 (100%) passed to a slippage-limit computation. |

## Venues and route combinations

| ID | Venue | Router function(s) | Quoter source | Notes |
| --- | --- | --- | --- | --- |
| 0 | UNI_V2 | `swapV2` | UNI_V2 | CREATE2 pair; 0.30% fee math |
| 1 | SUSHI | `swapV2` | SUSHI | swapV2 with deadline == max sentinel |
| 2 | ZAMM | `swapVZ` | ZAMM | Precision pools; ERC-20 + ERC-6909 |
| 3 | UNI_V3 | `swapV3` | UNI_V3 | Concentrated liquidity; fee tiers |
| 4 | UNI_V4 | `swapV4` | UNI_V4 | PoolManager unlock callback |
| 5 | CURVE | `swapCurve` | CURVE | StableNg/Crypto/Meta pools; up to 5 hops |
| 6 | LIDO | `exactETHToSTETH|exactETHToWSTETH|ethToExactSTETH|ethToExactWSTETH` | LIDO | stETH/wstETH wrap-style routes (Ethereum-only) |
| 7 | WETH_WRAP | `wrap|unwrap` | WETH_WRAP | Native <-> WETH 1:1 fast path |
| — | EXECUTOR | `snwap|snwapMulti` | — | Generic safeExecutor target (e.g. Bebop, Bitgetol forwarders) |

Route discovery shapes (zQuoter):

| Shape | Quoter function | Max hops | Notes |
| --- | --- | --- | --- |
| single-hop | `buildBestSwap` | 1 | Best direct venue |
| two-hop-hub | `buildBestSwapViaETHMulticall` | 2 | Via one hub intermediate |
| three-hop | `build3HopMulticall` | 3 | Via two hub intermediates |
| split | `buildSplitSwap` | 1 | Exact-in split across top 2 venues |
| hybrid-split | `buildHybridSplit` | 2 | Split best direct vs best 2-hop |
| auto | `buildSwapAuto` | 3 | Cascade 2-hop then 3-hop |

Two-hop and three-hop routes intermediate through these hubs: `WETH`, `USDC`, `USDT`, `DAI`, `WBTC`, `WSTETH`.

## Non-swap extension scope decision

Preserve the swap surface (core-swap + swap-support) as the routing baseline. Treat NameNFT, zAMM liquidity, and ownership as non-swap extensions that are capability-gated per issue #11 and excluded from non-Ethereum deployments.

| Extension | Functions | Decision | Rationale |
| --- | --- | --- | --- |
| NameNFT | `revealName`, `onERC721Received` | ethereum-only | .wei naming is an Ethereum-mainnet product; gate behind a capability flag and drop on other chains. |
| zAMM liquidity | `addLiquidity` | out-of-swap-scope | LP minting, not routing; preserved for parity but not part of Setwise swap execution. |
| Ownership | `transferOwnership` | retain | Required for trust/ensureAllowance administration; keep but govern via issue #37. |

Separate ZFi products that are **not** part of the router/quoter ABI and stay out
of routing scope:

| Component | Upstream path | Decision | Rationale |
| --- | --- | --- | --- |
| DAO (Moloch) | `zFi-main/src/dao` | out-of-scope | Not part of router/quoter ABI. |
| Coin launch | `zFi-main/src (CoinLaunch/CauseCoin)` | out-of-scope | Token-launch product, not routing. |
| Dutch auction | `zFi-main/src/DutchAuction.sol` | out-of-scope | Auction product, not routing. |

Ethereum-only behavior flagged for capability gating (issue #11): `ethToExactSTETH`, `ethToExactWSTETH`, `exactETHToSTETH`, `exactETHToWSTETH`, `revealName`.

## Known broken or intentionally unsupported

- Default-profile zQuoter bytecode exceeds EIP-170 (24,576 bytes); deploy with the `zquoter` Foundry profile (optimizer_runs=20, yul=false).
- Bebop and Bitgetol have no typed router interface; reachable only as snwap executor targets.
- Curve pools using the CURVE_ETH sentinel directly are not buildable by the router (quoter filters them).

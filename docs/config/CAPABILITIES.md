# Chain-specific extension capabilities

Issue #11 separates portable routing from Ethereum-specific ZFi extensions
(Curve, Lido, zAMM, Sushi, NameNFT, and related extensions). The canonical
source of truth is the typed multi-chain configuration registry
([`config/chains/`](../../config/chains)); the capability metadata lives in
[`config/capabilities.mjs`](../../config/capabilities.mjs).

## Why capabilities

The ZFi router and quoter bytecode is immutable and identical on every chain
(see [`docs/baseline/ABI_COMPATIBILITY.md`](../baseline/ABI_COMPATIBILITY.md)).
What differs per chain is which extensions are usable. Each chain config
therefore declares a `capabilities` map alongside `venues`, and the registry
validates that an extension is only enabled where its deployment requirement is
met. Unsupported extensions are never implicit: every chain declares every
known capability explicitly, enabled or not.

Swap venues (`uniswapV2`, `uniswapV3`, `curve`, `lido`, `zamm`, …) are already
capability-gated through `venues.<venue>.enabled`. The `capabilities` map covers
the function-level extensions that are not venues in their own right: the
Lido staking routes, NameNFT, zAMM liquidity minting, and ownership.

## Capability decisions

| Capability | Gated functions | Scope | Decision | Deployment requirement |
| --- | --- | --- | --- | --- |
| `lidoStaking` | `exactETHToSTETH`, `exactETHToWSTETH`, `ethToExactSTETH`, `ethToExactWSTETH`, `quoteLido` | swap-support | ethereum-only | chain id `1`; `venues.lido` enabled |
| `nameNft` | `revealName`, `onERC721Received` | extension | ethereum-only | chain id `1` |
| `zammLiquidity` | `addLiquidity` | extension | out-of-swap-scope | chain id `1`; `venues.zamm` enabled |
| `ownership` | `transferOwnership` | extension | retain | none (governed via issue #37) |

The gated function sets match the baseline `ethereumOnly` lists and the
non-swap extension decision recorded in
[`baseline/abi/compatibility-matrix.json`](../../baseline/abi/compatibility-matrix.json);
`test/capabilities.test.js` asserts the two stay in sync.

- **ethereum-only** — an Ethereum-mainnet product. The registry rejects the
  capability being enabled on any other chain, so no Ethereum address is
  reachable from another chain configuration.
- **out-of-swap-scope** — LP minting, not routing. Preserved for Ethereum
  parity but excluded from non-Ethereum deployments and from Setwise swap
  execution.
- **retain** — required for `trust` / `ensureAllowance` administration; kept on
  every chain and governed separately (issue #37).

## Per-chain state

| Chain | `lidoStaking` | `nameNft` | `zammLiquidity` | `ownership` |
| --- | --- | --- | --- | --- |
| Ethereum (1) | enabled | enabled | enabled | enabled |
| BSC (56) | disabled | disabled | disabled | enabled |
| Base (8453) | disabled | disabled | disabled | enabled |
| Robinhood (4663) | disabled | disabled | disabled | enabled |

## ABI behavior when a capability is unavailable

The router/quoter ABI does not change per chain — the bytecode is immutable.
When a capability is unavailable on a chain, its functions remain present in the
ABI but **revert before moving assets**: the deployment surfaces no usable
target addresses for the disabled extension (the required venues are disabled
and their addresses unset), so the call reverts on the zero/placeholder address
before any transfer occurs. `generateDeployInputs` and `generateServiceConfig`
omit disabled capabilities entirely, so neither the deployer nor the quote
service can wire or route to an unavailable extension.

## Generated configuration

`npm run build:config` surfaces capabilities in the three typed outputs
(`config/generated/`):

- **service** — enabled capabilities with their gated `functions` and
  `requiresVenues`; disabled capabilities are omitted.
- **app** — every capability with an `enabled` flag and a UI `displayName`
  (internal keys preserved).
- **deploy** — enabled capabilities with their `requiresVenues`, so a
  deployment only wires extensions whose requirements are satisfied.

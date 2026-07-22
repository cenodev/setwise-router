# Chain-aware direct AMM adapters

`ChainAwareAmmAdapter` owns the direct V2, V3, and V4 paths extracted from the
pinned ZFi baseline. One instance is deployed per chain. Constructor inputs are
derived from `config/chains/<chainId>.json`; factory, init-code hash, fee, fee
tier, wrapped-native, and PoolManager values are never selected from caller
calldata.

## Immutable configuration

| Chain | V2 primary | V2 secondary | V3 | V4 policy |
| --- | --- | --- | --- | --- |
| Ethereum (`1`) | Uniswap V2, 30 bps | Sushi, 30 bps | Uniswap, `100/500/3000/10000` | configured PoolManager, hookless |
| BSC (`56`) | Pancake V2, 25 bps | disabled | Uniswap, `100/500/3000/10000` | disabled |
| Base (`8453`) | disabled | disabled | Uniswap, `100/500/3000/10000` | configured PoolManager, hookless |
| Robinhood (`4663`) | disabled | disabled | disabled | disabled |

V2 and V3 pool addresses are CREATE2-derived only from the active deployment's
immutable factory and init-code hash. Every external entry verifies
`block.chainid == configuredChainId`. The V3 fee must occur in the immutable
packed fee list. The current V4 policy accepts only `hooks == address(0)` and
empty hook data; `swapV4WithHook` exists so an unsupported hook fails with the
explicit `UnsupportedV4Hook` error before `PoolManager.unlock` or token transfer.

## Swap and callback behavior

- `swapV2`, `swapV3`, and `swapV4` preserve the baseline exact-input and
  exact-output amount/limit behavior.
- `swapV2` retains `deadline == type(uint256).max` as the secondary-V2 sentinel.
- Native legs use the shared canonical native sentinel and the chain-specific
  immutable wrapped-native token. Call-scoped accounting refunds only unused
  `msg.value`; it never consumes the router's total native balance.
- V3 callbacks must come from the pool derived from the immutable factory and
  must match the transient commitment established immediately before `swap`.
- V4 callbacks must come from the immutable PoolManager and match the transient
  commitment established immediately before `unlock`.
- Callback commitments are cleared before payment, preventing reentrant replay.

## Tests

Deterministic Foundry tests cover both exact modes for all three versions,
secondary V2 selection, wrong-chain deployment/use, unsupported adapters and
fees before transfer, wrong V3 factories, unsupported V4 hooks, and spoofed V3
and V4 callbacks.

The fork suite executes a live exact-input swap through every adapter enabled in
the matrix. Ethereum and Base use committed blocks. BSC uses the committed block
when `RPC_ARCHIVE_URL_BSC` is available, otherwise its non-archive public RPC is
tested at latest. Run all fork suites with:

```bash
node scripts/test-contracts-fork.mjs
```

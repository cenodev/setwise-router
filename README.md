# Setwise Router

Maintained fork program for the ZFi router stack with Setwise liquidity as a
first-class venue. Same-chain deployments target Ethereum, BSC, Base, and
Robinhood Chain.

## Upstream baseline

The immutable ZFi snapshot lives in [`zFi-main/`](./zFi-main) as a git submodule
pinned to [`z-fi/zFi@43ac1e67388cc4f96be6b2cbeb0f95f647c9aeb3`](https://github.com/z-fi/zFi/commit/43ac1e67388cc4f96be6b2cbeb0f95f647c9aeb3).

- License & copyright: [`LICENSE`](./LICENSE), [`NOTICE`](./NOTICE), [`zFi-main/LICENSE`](./zFi-main/LICENSE)
- Provenance: [`docs/upstream/PROVENANCE.md`](./docs/upstream/PROVENANCE.md)
- Fork map / external Setwise deps: [`docs/upstream/FORK_MAP.md`](./docs/upstream/FORK_MAP.md)
- Product plan: [`SETWISE_ROUTER_PLAN.md`](./SETWISE_ROUTER_PLAN.md)

Do not edit `zFi-main` for Setwise features. Keep it as the clean upstream
reference for differential comparisons.

## Clone

```bash
git clone --recurse-submodules https://github.com/cenodev/setwise-router.git
cd setwise-router
git submodule update --init --recursive
```

## Checks

Requires [Foundry](https://getfoundry.sh/) on `PATH` for contract builds.

```bash
npm test                 # provenance + ABI/route baseline + CI config tests
npm run lint             # syntax-check verification scripts and quote service
npm run typecheck        # same surface as lint for this baseline (JS syntax)
npm run format           # format/syntax gate for JS packages
npm run build            # config registry + forge build (default) + app stub
npm run check:bytecode   # EIP-170 / soft-headroom gate (default + zquoter)
npm run test:contracts   # secret-free Foundry unit suite (no RPC)
npm run check            # full local gate matching CI baseline
```

CI workflows and required branch-protection checks are documented in
[`docs/CI.md`](./docs/CI.md). Pull requests run the deterministic `baseline`
job; fork-backed Foundry suites are separate and non-blocking.

`npm test` includes `test/abi-baseline.test.js`, which fails if the pinned
submodule's router/quoter ABI or any committed baseline fixture changes
unexpectedly. The ABI drift check compares the committed fixtures against the
rebuilt `zFi-main/out` artifacts, so run `npm run build` before `npm test` to
enable it (it is skipped when artifacts are absent).

## Compatibility baseline

Issue #5 captures what "preserve ZFi functionality" means on Ethereum. The
baseline lives in [`baseline/`](./baseline) and [`docs/baseline/`](./docs/baseline):

- [`baseline/abi/`](./baseline/abi) — router/quoter ABI fixtures (selectors,
  signatures, events, errors, bytecode size) and the swap-vs-extension
  compatibility matrix.
- [`baseline/routes/calldata.json`](./baseline/routes/calldata.json) —
  deterministic calldata for representative routes across every venue and shape.
- [`baseline/routes/execution.json`](./baseline/routes/execution.json) —
  representative return values, gas, and revert selectors captured on a mainnet
  fork pinned to block `24880000`.
- [`docs/baseline/ABI_COMPATIBILITY.md`](./docs/baseline/ABI_COMPATIBILITY.md) —
  the human-readable matrix and the non-swap extension scope decision.

Regenerate (Foundry required; capture needs an archive Ethereum RPC):

```bash
npm run build              # forge build the pinned snapshot
npm run baseline:abi       # rewrite baseline/abi/*.json + ABI_COMPATIBILITY.md
npm run baseline:routes    # rewrite baseline/routes/calldata.json
npm run baseline:capture   # rewrite baseline/routes/execution.json from a fork
```

## Setwise pool interface (issue #7)

The minimal Setwise pool surface the router needs to execute signed, fixed-amount
swaps lives in [`contracts/src/setwise/`](./contracts/src/setwise): `ISetwisePool`
(the ERC-20→ERC-20, native→ERC-20, and ERC-20→native entry points plus the
quote-signer / wrapped-native / quote-id views, `SwapExecuted`, and the revert
surface), `IWrappedNativeToken`, and the `SetwiseSwap` calldata types. Only the
interface and data types are vendored — not the upgradeable Setwise
implementation. Selectors mirror the deployed `SetwisePoolBase`/`SetwisePool`
ABIs and are guarded by compatibility tests.

- [`docs/setwise/POOL_INTERFACE.md`](./docs/setwise/POOL_INTERFACE.md) — interface,
  EIP-712 `SwapQuote`, settlement modes, and native↔wrapped-native token
  normalization.
- [`baseline/abi/setwisePool.json`](./baseline/abi/setwisePool.json) — pool ABI
  baseline; [`baseline/setwise/calldata.json`](./baseline/setwise/calldata.json) —
  deterministic RFQ-API calldata for the three settlement modes.

Regenerate (Foundry required):

```bash
node scripts/build-setwise-abi.mjs       # rewrite baseline/abi/setwisePool.json
node scripts/build-setwise-calldata.mjs  # rewrite baseline/setwise/calldata.json
forge test                               # in contracts/: data-types + selector compatibility
## Multi-chain configuration registry

Issue #4 replaces Ethereum-only global constants with a typed registry keyed by
chain ID. The canonical source is one reviewed JSON file per chain in
[`config/chains/`](./config/chains) (`1`, `56`, `8453`, `4663`), covering native
and wrapped-native tokens, RPC roles, Multicall3, router/quoter addresses,
factories, pool managers, token hubs, explorers, and venue capabilities.

- [`config/schema.mjs`](./config/schema.mjs) — schema (JSDoc typedefs) and
  validation. Rejects missing fields, zero addresses, duplicate chain ids/keys
  and single-role addresses, and cross-chain reuse of chain-unique addresses.
  Canonical cross-chain deployments (Multicall3, Permit2) are exempt.
- [`config/registry.mjs`](./config/registry.mjs) — loads and validates the
  registry. `getChainConfig(chainId)` throws `UnsupportedChainError` for
  unsupported chains; there is no implicit fallback to Ethereum.
- [`config/generate.mjs`](./config/generate.mjs) — derives typed service,
  frontend, and contract-deployment inputs from the single source.

RPC roles reference environment-variable **names** only; credentials and
production RPC URLs stay in `.env` (see [`.env.example`](./.env.example)) and are
never committed or generated. Chains whose addresses are not yet verified from
primary sources (currently Robinhood Chain) set `addressesVerified: false` and
declare every venue as disabled rather than carrying unverified addresses.

Generate the typed outputs (written to the git-ignored `config/generated/`):

```bash
npm run build:config
```

## Terminology

In user-facing UI copy, prefer **Set** when referring to Setwise liquidity.
Internal APIs and identifiers keep `pool` / `poolId`.

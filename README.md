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
npm run build            # forge build (default) + app build stub
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

## Terminology

In user-facing UI copy, prefer **Set** when referring to Setwise liquidity.
Internal APIs and identifiers keep `pool` / `poolId`.

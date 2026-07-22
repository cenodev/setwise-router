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
npm test          # provenance + required-layer verification
npm run lint      # syntax-check verification scripts and ZFi quote service
npm run typecheck # same surface as lint for this baseline (JS syntax)
npm run build     # forge build of the untouched zFi-main snapshot
```

## Terminology

In user-facing UI copy, prefer **Set** when referring to Setwise liquidity.
Internal APIs and identifiers keep `pool` / `poolId`.

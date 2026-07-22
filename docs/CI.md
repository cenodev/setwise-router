# Continuous integration

Deterministic checks protect every pull request from compilation, test,
formatting, and deployability regressions. Fork-backed Foundry suites are
intentionally separated so public-RPC flakiness cannot block merges.

## Workflows

| Workflow | File | Required for merge? | Secrets |
| --- | --- | --- | --- |
| **CI** → job `baseline` | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | **Yes** | None |
| **CI Fork** → job `fork` | [`.github/workflows/ci-fork.yml`](../.github/workflows/ci-fork.yml) | No (informational; `continue-on-error`) | None |

Neither workflow reads production secrets. Optional repository **variables**
(not secrets) may override defaults:

| Variable | Purpose | Default |
| --- | --- | --- |
| `FOUNDRY_VERSION` | Override for `foundry-rs/foundry-toolchain` (normally unused) | [`.foundry-version`](../.foundry-version) (`v1.7.1`) |
| `FOUNDRY_ETH_RPC_URL` | Archive-capable Ethereum RPC for the fork workflow | unset (fork job skips tests) |
| `RPC_URL_BSC` | BSC primary RPC for latest-state adapter forks | canonical public RPC |
| `RPC_ARCHIVE_URL_BSC` | Optional archive BSC RPC for the pinned adapter block | unset (uses latest-state primary RPC) |
| `RPC_URL_BASE` | Base RPC for the pinned adapter forks | canonical public RPC |

## What `baseline` runs

1. Submodule checkout (`zFi-main` + nested `forge-std`)
2. Node from [`.node-version`](../.node-version) with npm cache
3. Foundry from the pinned version in [`.foundry-version`](../.foundry-version)
4. `npm run lint` / `lint:services`
5. `npm run format`
6. `npm run typecheck`
7. `npm test` and `npm run test:services`
8. `npm run build:config` (typed multi-chain registry outputs)
9. `npm run verify:deployments` (schema-validated deployment manifests; no RPC)
10. `npm run build:services`
11. Default-profile `forge build` + EIP-170 gate for **zRouter**
12. `zquoter`-profile `forge build` + EIP-170 gate for **zQuoter** (soft headroom fails before the hard 24,576-byte limit)
13. Secret-free Foundry unit tests (`npm run test:contracts`) — temporary foundry config **without** `eth_rpc_url` for `test/{zSwap,ShareBurner,CollectorVault}.t.sol`, plus `contracts/` Setwise data-type tests

## What `fork` runs

`node scripts/test-contracts-fork.mjs` runs the upstream suite against an
**archive-capable** Ethereum RPC supplied as repository variable
`FOUNDRY_ETH_RPC_URL` (not a secret), then exercises every enabled direct AMM
adapter on Ethereum, BSC, and Base. Robinhood is asserted to have no enabled
adapter while its deployment addresses remain unverified. Ethereum and Base
use pinned blocks; BSC uses `RPC_ARCHIVE_URL_BSC` at its pinned block when set,
or `RPC_URL_BSC` at latest because the canonical public endpoint is non-archive.
Triggered only on `workflow_dispatch` and a weekday schedule — **not** on pull
requests — so public/non-archive RPC gaps cannot mark a PR unstable. If the
variable is unset, the job succeeds after skipping the fork suites.

## Branch protection

Configure `main` branch protection (GitHub → Settings → Branches) to require:

| Status check name | Notes |
| --- | --- |
| `baseline` | Exact job name from the **CI** workflow |

Do **not** require `fork`. Leave “Require branches to be up to date” enabled
once `baseline` is stable.

## Local equivalents

```bash
npm run check            # lint, typecheck, format, tests, bytecode gate, offline forge
npm run check:bytecode   # rebuilds each profile and gates EIP-170 / soft headroom
npm run test:contracts   # secret-free Foundry suite
node scripts/test-contracts-fork.mjs   # upstream + per-chain direct-AMM fork matrix
```

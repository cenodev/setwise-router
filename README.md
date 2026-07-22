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
```

## Governed Set registry (issue #8)

Each chain has an enumerable `SetwisePoolRegistry` that records permanent pool
proxy addresses while retaining internal `pool` / `poolId` terminology. The
registry supports two-step Safe/timelock ownership, a disable-only emergency
guardian, complete state-change events, and owner-authorized UUPS upgrades. It
rejects pool implementation addresses so an implementation upgrade does not
change the registered proxy.

Router adapters must call `requireEnabledPool(pool)` before any approval,
transfer, Permit2 interaction, or value forwarding. Services and UI can read
membership, enabled state, governance, and the enumerable proxy list through
`ISetwisePoolRegistry`.

- [`contracts/src/setwise/SetwisePoolRegistry.sol`](./contracts/src/setwise/SetwisePoolRegistry.sol)
- [`contracts/src/setwise/ISetwisePoolRegistry.sol`](./contracts/src/setwise/ISetwisePoolRegistry.sol)
- [`docs/setwise/POOL_REGISTRY.md`](./docs/setwise/POOL_REGISTRY.md)

```bash
cd contracts && forge test --match-contract SetwisePoolRegistryTest
```

## Set Router authorization (issue #10)

`SetwiseRouterAuthorization` verifies an RFQ-issued EIP-712 authorization before
an adapter can move funds. It binds the current chain and router, pool, funding
wallet, recipient, assets, native flags, fixed amounts, quote ID, and deadline.
The signature is checked against the pool's current `QUOTE_SIGNER`, supporting
both canonical/compact EOA signatures and pass-through Safe-style ERC-1271
signatures. The pool still verifies its own quote and consumes the shared quote
ID.

- [`contracts/src/setwise/SetwiseRouterAuthorization.sol`](./contracts/src/setwise/SetwiseRouterAuthorization.sol)
- [`docs/setwise/ROUTER_AUTHORIZATION.md`](./docs/setwise/ROUTER_AUTHORIZATION.md)
- [`baseline/setwise/router-authorization.json`](./baseline/setwise/router-authorization.json)

```bash
cd contracts && forge test --match-contract SetwiseRouterAuthorizationTest
npm run test --workspace=@setwise-router/quote
```

## Set ERC-20 execution (issue #15)

`SetwiseExecutionAdapter` is the direct Set execution path for signed,
fixed-amount ERC-20 → ERC-20 swaps. Every guard runs before funds move: chain
binding, native-value rejection, the governed pool registry
(`requireEnabledPool`), router-control kill switches
(`requireRouteEligible`), and the RFQ-issued EIP-712 authorization. The adapter
pulls exactly the authorized input from the funding wallet, grants the pool an
exact per-swap allowance that is cleared after execution, enforces the fixed
output by balance-delta measurement, and emits complete execution metadata.
Output may settle directly to the user or to the router itself for future
composition; a direct execution leaves zero router balance and zero allowance.

- [`contracts/src/setwise/SetwiseExecutionAdapter.sol`](./contracts/src/setwise/SetwiseExecutionAdapter.sol)
- [`docs/setwise/ERC20_EXECUTION.md`](./docs/setwise/ERC20_EXECUTION.md)

```bash
cd contracts && forge test --match-contract SetwiseExecutionAdapterTest
```

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

## Chain-specific extension capabilities

Issue #11 capability-gates the Ethereum-only ZFi extensions (Curve, Lido, zAMM,
Sushi, NameNFT, and related extensions). Each chain declares a `capabilities`
map alongside `venues`; the registry rejects an Ethereum-only capability being
enabled on another chain and any capability whose required venues are disabled,
so no Ethereum address is reachable from another chain configuration and a
disabled extension reverts before moving assets.

- [`config/capabilities.mjs`](./config/capabilities.mjs) — capability
  definitions, deployment requirements, and the non-swap extension decisions.
- [`docs/config/CAPABILITIES.md`](./docs/config/CAPABILITIES.md) — capability
  matrix, per-chain state, and ABI behavior when a capability is unavailable.

## Chain-aware direct AMM adapters

Issue #12 extracts direct V2, V3, and V4 execution into
[`ChainAwareAmmAdapter.sol`](./contracts/src/amm/ChainAwareAmmAdapter.sol). Each
deployment binds its chain ID, wrapped-native token, V2 factory/init-code
hash/fee, V3 factory/init-code hash/fee tiers, and V4 PoolManager as immutables.
The existing exact-input/exact-output swap model and secondary-V2 deadline
sentinel remain available. Unsupported adapters, V3 fees, and V4 hooks revert
before funds move; V3 and V4 callbacks require both the expected pool/manager
and a transient active-swap commitment.

The fork matrix covers every enabled adapter in canonical configuration:
Ethereum Uniswap V2, Sushi, V3, and hookless V4; BSC Pancake V2 and Uniswap V3;
and Base Uniswap V3 and hookless V4. Robinhood remains explicitly disabled
until its venue addresses are verified.

- [`docs/setwise/AMM_ADAPTERS.md`](./docs/setwise/AMM_ADAPTERS.md) — immutable
  constructor mapping, callback security, and fork coverage.
- [`contracts/test/ChainAwareAmmAdapter.t.sol`](./contracts/test/ChainAwareAmmAdapter.t.sol)
  — deterministic exact-mode and rejection tests.
- [`contracts/test/fork/ChainAwareAmmAdapterFork.t.sol`](./contracts/test/fork/ChainAwareAmmAdapterFork.t.sol)
  — live enabled-adapter matrix.

## Unified quote schema

The quote service exports strict validators for the versioned, chain-aware
`v1` request, response, and error models shared by ZFi, aggregator, and Set
sources. Requests bind every token, router, funder, and recipient to the selected
chain. Responses normalize source outcomes, amounts, gas, fees, approvals,
expiry, evidence, calldata, and native value; indicative responses cannot carry
an executable transaction, while firm responses contain exactly one.

- [`docs/api/QUOTE_API_V1.md`](./docs/api/QUOTE_API_V1.md) — invariants,
  source-state semantics, transaction rules, and stable error codes.
- [`docs/api/quote-v1.openapi.json`](./docs/api/quote-v1.openapi.json) — OpenAPI
  3.1 contract for `POST /v1/quotes`.
- [`services/quote/fixtures/v1/`](./services/quote/fixtures/v1) — exact-input,
  exact-output, indicative, firm, unavailable/excluded/stale/failed, and error
  fixtures exercised by the service tests.

## Deployment manifests (issue #3)

Committed per-chain deployment records live in [`deployments/`](./deployments).
Each manifest stores chain id, contract addresses, bytecode hashes, constructor
inputs, deployment transactions, compiler profiles, and explorer links. UUPS
proxy addresses are recorded separately from their implementation metadata.

Offline verification (schema + config cross-check, no private keys):

```bash
npm run verify:deployments
npm run verify:deployments:checklist
```

Optional on-chain verification uses each chain's public RPC after checking
`eth_chainId`:

```bash
npm run verify:deployments:on-chain
```

## Terminology

In user-facing UI copy, prefer **Set** when referring to Setwise liquidity.
Internal APIs and identifiers keep `pool` / `poolId`.

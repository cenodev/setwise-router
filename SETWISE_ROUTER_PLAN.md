# Setwise Router Plan

## Goal

Build Setwise Router as a maintained fork of the ZFi router stack. Preserve ZFi's Ethereum routing behavior, add Setwise pools as a first-class liquidity source, and deploy a same-chain router on:

- Ethereum mainnet (`1`)
- BNB Smart Chain mainnet (`56`)
- Base mainnet (`8453`)
- Robinhood Chain mainnet (`4663`)

This plan assumes "support four chains" means independent same-chain swaps on each network. Cross-chain swaps and bridging are a separate product phase.

## What is being forked

ZFi routing is a stack, not only `zRouter.sol`:

1. `zRouter.sol` executes direct AMM swaps, multicalls, native wrapping, Permit2 flows, Curve/Lido/zAMM paths, and trusted forwarders.
2. `zQuoter.sol` discovers and builds direct, multi-hop, split, and hybrid routes. It is already close enough to the EIP-170 bytecode limit to require a special compiler profile.
3. `server/quote.js` compares on-chain ZFi routes with external aggregators and returns executable transactions.
4. The dapp contains Ethereum-specific addresses, chain assumptions, approval logic, and route presentation.

The new project should fork all four layers into a separate `setwise-router` package/repository. Keep `zFi-main` unchanged as the upstream reference and retain its MIT license and provenance.

## Architectural decisions

### 1. One deployment per chain, one shared codebase

Use a typed chain registry for RPCs, native/wrapped-native tokens, Multicall3, router/quoter deployments, factories, pool managers, token hubs, explorer URLs, and enabled venue capabilities.

Do not keep Ethereum addresses as global constants in server or UI code. Contract deployments may use constructor immutables or chain-specific derived contracts where gas savings justify them, but the configuration source and deployment outputs must be machine-readable.

"ZFi parity" means:

- Ethereum retains all currently working ZFi routes and public behavior.
- Other chains expose the same router/API model but enable only protocols actually deployed and tested there.
- Unsupported chain/protocol combinations fail explicitly; they do not silently fall back to an address from another network.

### 2. Keep Setwise RFQ pricing off-chain

Setwise pools do not expose a pure on-chain AMM quote. A swap uses a signed EIP-712 quote with fixed input/output amounts, a one-time `quoteId`, a recipient, and a packed inventory/deadline guard. Therefore, Setwise should not be added to the large on-chain `zQuoter` enum and bytecode.

The route service will use a two-stage process:

1. Fan out indicative requests to the chain's ZFi quoter, external aggregators, and Setwise RFQ API.
2. Rank comparable routes, including gas and fees.
3. If Setwise wins, request a short-lived firm quote whose on-chain payer is the Setwise Router.
4. Build the router calldata, simulate it at the current block, and reject or re-quote if the firm result is no longer competitive or executable.

### 3. Add a narrow Setwise adapter to the router

Add a dedicated `swapSetwise` execution path rather than using ZFi's generic executor. The adapter will:

- Accept a whitelisted Setwise pool proxy and a signed, fixed-amount Setwise quote.
- Pull ERC-20 input from the caller or consume router transient credit.
- For ERC-20 input, grant only the exact per-swap allowance to the pool and clear it after execution.
- Call the correct Setwise entry point for ERC-20/native input and output.
- Measure output by balance delta, enforce the expected amount, and credit transient storage when the router is the recipient.
- Forward direct-route output to the user without leaving funds in the router.
- Emit the Setwise pool, `quoteId`, input/output assets, amounts, funder, and recipient.

Use a per-chain pool registry controlled by a Safe/timelock. Whitelist the permanent UUPS proxy address, not its current implementation address. Registry changes must be observable through events and delayed in production.

### 4. Bind the funding wallet as well as the router payer

The existing Setwise pool signature must name the router as `payer`, because the pool sees `msg.sender == router`. That pool signature does not bind the wallet from which the router pulls funds.

To prevent copied calldata from consuming another user's one-time quote, the RFQ service should also issue a router-specific EIP-712 authorization binding:

- chain ID and router address
- Setwise pool
- funding wallet
- recipient
- input/output assets and native flags
- fixed input/output amounts
- Setwise `quoteId` and expiry

The router verifies this authorization against the pool's configured `QUOTE_SIGNER`, including ERC-1271 support. The Setwise pool then independently verifies its existing pool quote. A successful pool execution consumes the shared `quoteId`, so the router does not need a second persistent nonce store.

### 5. Preserve atomic composition, but phase it carefully

Setwise signatures fix both amounts. That makes arbitrary composition with variable-output AMM legs unsafe to pre-sign.

MVP scope:

- Direct Setwise exact-input and exact-output routes.
- Existing ZFi direct, multi-hop, split, and hybrid routes unchanged where the chain supports them.
- Compare Setwise against composite ZFi and external-aggregator routes, but do not mix Setwise into a composite route.

Later safe composition patterns:

- Setwise first, because its fixed output can become the next leg's fixed input.
- Setwise last only when the prior leg is exact-output for the exact signed Setwise input.
- Fixed-allocation split routes where the Setwise leg's input is known before signing.

Every composite pattern needs an end-to-end invariant and fork test before enablement.

## Chain capability baseline

| Chain | Native / wrapped native | Initial venue strategy | Setwise prerequisite |
| --- | --- | --- | --- |
| Ethereum | ETH / WETH | Preserve current ZFi Uniswap V2/V3/V4, Sushi, Curve, Lido, zAMM and configured external aggregators | Deploy/register production Setwise pools and RFQ configuration |
| BSC | BNB / WBNB | Direct Pancake/Uniswap-compatible adapters where verified, plus chain-supported aggregators | Current Setwise deployment is BSC testnet only; production pools, signer and market policy are required |
| Base | ETH / WETH | Direct Uniswap-compatible adapters plus chain-supported aggregators | Deploy Setwise pools, signer and RFQ configuration |
| Robinhood Chain | ETH / canonical WETH | Begin with 0x/RFQ and verified Uniswap deployments; add direct venue adapters only after address and fork-test verification | Deploy Setwise pools against canonical Robinhood Stock Tokens/USDG, signer and RFQ configuration |

Robinhood Chain currently documents chain ID `4663`, ETH gas, canonical WETH and USDG, Uniswap as a public DEX, and 0x support. Exact factory, pool-manager, allowance-target, and token addresses must still be verified from primary sources and bytecode before each deployment.

## Work phases

### Phase 0 — Baseline and specification

Deliverables:

- Create `setwise-router` without modifying the upstream `zFi-main` snapshot.
- Record the ZFi source revision/provenance and retain license notices.
- Run and archive the existing Foundry and JavaScript test baselines.
- Produce an ABI compatibility list: functions that remain unchanged, functions made chain-capable, and Ethereum-only extensions.
- Turn the chain capability table into a release checklist with verified addresses and bytecode hashes.
- Decide governance addresses, deployment model, fee policy, and whether router addresses need deterministic CREATE2 deployment.

Exit criteria: the untouched fork builds and tests, and "ZFi functionality" has an explicit acceptance matrix.

### Phase 1 — Multi-chain core refactor

Deliverables:

- Introduce `ChainConfig` and deployment artifacts keyed by chain ID.
- Replace server/UI global Ethereum constants with chain lookups.
- Refactor direct V2/V3/V4 and wrapped-native logic around per-chain factories, pool managers, init-code hashes, and native-token semantics.
- Capability-gate Curve, Lido, zAMM, Sushi, NameNFT, and other chain-specific functions.
- Make quote API requests require `chainId` and reject mismatched tokens, routers, RPC responses, and transactions.
- Add deployment/verification scripts for all mainnets and their chosen staging testnets.

Exit criteria: the same source builds distinct, explicit deployments and cannot route using another chain's addresses.

### Phase 2 — Setwise execution adapter

Deliverables:

- Add `ISetwisePool`, `ISetwisePoolRegistry`, `SetwiseSwap`, and router authorization types.
- Implement ERC-20→ERC-20, native→ERC-20, and ERC-20→native paths.
- Add exact approval/reset logic, transient-credit support, output-delta checks, pool allowlisting, expiry, caller binding, replay, and event coverage.
- Update the Setwise RFQ API to return both the existing pool signature and router authorization.
- Preserve the existing direct-to-pool RFQ API mode for the current Setwise app.

Exit criteria: a direct Setwise swap executes through the router for every asset mode with no residual router balance or allowance.

### Phase 3 — Unified quote and route service

Deliverables:

- Replace the single-chain `server/quote.js` constants with chain-aware source adapters.
- Normalize all quote results into one schema: chain, source, exact mode, amounts, gas estimate, fees, approval target, expiry, calldata, and evidence.
- Query on-chain ZFi routes, supported external aggregators, and Setwise indicative pricing concurrently.
- Compare routes on net user outcome rather than output amount alone.
- Add the Setwise indicative→firm→simulate flow and automatic fallback when firming fails.
- Fetch external quotes with the actual execution address expected by that venue; never rewrite returned targets or calldata.
- Add source timeouts, circuit breakers, cache keys that include chain ID, structured errors, and metrics.

0x is a useful baseline external source because its current documentation lists all four target chains, including Robinhood Chain. It should remain an adapter, not a hard dependency or single point of failure.

Exit criteria: one API returns an executable best route plus comparable route evidence on every supported chain.

### Phase 4 — Dapp and wallet integration

Deliverables:

- Add chain selection/switching and chain-scoped token lists.
- Present Setwise as a named route source with pool identity, quote expiry, fixed amounts, fees, and relevant RWA/session warnings.
- Handle router, Permit2, and external-aggregator approval targets distinctly.
- Revalidate chain, account, balance, allowance, quote ID, expiry, and simulation immediately before wallet submission.
- Track submitted transactions and replacement/reorg states per chain.

Exit criteria: a user can quote, approve, swap, and inspect route provenance without needing chain-specific manual steps.

### Phase 5 — Testnet rollout and operations

Rollout order:

1. BSC testnet, reusing the existing Setwise test deployment.
2. Base Sepolia.
3. Robinhood Chain testnet (`46630`).
4. Ethereum Sepolia plus Ethereum-mainnet fork rehearsals.
5. Mainnets behind per-chain feature flags and conservative limits.

Operational deliverables:

- Production RPC providers with failover; public RPCs are development fallbacks only.
- Remote/HSM-backed Setwise signing, authenticated firm-quote endpoints, rate limits, and strongly consistent quote reservations.
- Safe/timelock ownership, pause/runbook, signer rotation, monitoring, alerts, and transaction reconciliation.
- Per-source kill switches so one venue can be disabled without stopping the router.

Exit criteria: canary swaps, monitoring, incident response, rollback/disable procedures, and ownership handoff are rehearsed on each chain.

### Phase 6 — Security review and mainnet release

Required test groups:

- Differential Ethereum tests against current ZFi routes and calldata behavior.
- Unit tests for every Setwise asset mode, exact mode, expiry, replay, caller/recipient binding, wrong chain, wrong pool, malicious pool, reentrancy, fee-on-transfer rejection, false-returning tokens, and ERC-1271 signers.
- Invariants that every successful transaction is balance-conserving, spends only caller/transient credit, and leaves no unintended router balance or approval.
- Fork tests on every chain using the exact release deployment configuration.
- Fuzz tests for multicall ordering and native/token combinations.
- Quote-service schema, timeout, stale-state, reorg, API manipulation, and transaction-simulation tests.

Security gates:

- Resolve or consciously redesign the ZFi audit findings around total-balance refunds, permissionless sweeps, generic execution, trusted targets, and transient accounting. Do not inherit "the router never holds funds" as the only control.
- Independent smart-contract audit of the fork and Setwise adapter.
- Independent review of RFQ signing, route authorization, and operational key management.
- Audit or production-readiness approval for the underlying Setwise pools; their current README explicitly says they are not audited for production use.

Exit criteria: no open critical/high findings, all release configurations reproduced from source, verified contracts published, and mainnet limits approved by governance.

## Suggested implementation order

1. Freeze the ZFi compatibility baseline.
2. Build the chain registry and make the quote server chain-aware.
3. Implement and test the Setwise adapter plus RFQ router authorization on BSC testnet.
4. Integrate two-stage route selection.
5. Prove Ethereum parity on a pinned mainnet fork.
6. Add Base and Robinhood testnets, then BSC mainnet staging.
7. Complete UI integration and operational controls.
8. Audit, canary, and progressively enable mainnets.

## MVP acceptance criteria

- The API requires one of the four supported chain IDs and returns transactions only for that chain.
- Existing Ethereum ZFi routes remain available and pass differential tests.
- Setwise appears in route comparison and can win based on net executable outcome.
- A selected Setwise quote executes atomically through Setwise Router for ERC-20/native combinations.
- The funding wallet, recipient, pool, amounts, chain, quote ID, and expiry are cryptographically bound.
- Expired, replayed, copied, cross-chain, wrong-pool, and stale-inventory Setwise quotes revert.
- The router retains no user assets and no Setwise pool allowance after a successful or reverted call.
- Every returned transaction is simulated before delivery and again checked by the client before submission.
- Per-chain/source pause controls and observability are live before any production funds are enabled.

## Decisions needed before implementation

1. Confirm that BSC means BSC mainnet (`56`) and that testnets are staging only.
2. Confirm that version one is same-chain only, with cross-chain swaps deferred.
3. Choose whether Ethereum must retain every non-swap ZFi extension (NameNFT, DAO/coin/auction features) or only swap-router functionality.
4. Choose router governance and emergency-control addresses for each chain.
5. Define Setwise production pool/token lists for Ethereum, BSC, Base, and Robinhood Chain.
6. Decide fee/surplus policy and how gas-adjusted route ranking should value RWA trades.
7. Decide whether deterministic same-address deployments across chains are a requirement.

## Current source references

- ZFi execution: `zFi-main/src/zRouter.sol`
- ZFi on-chain quoting/building: `zFi-main/src/zQuoter.sol`
- ZFi external quote service: `zFi-main/server/quote.js`
- Setwise pool interface and signature rules: `setwise-contracts/contracts/SetwisePoolBase.sol`
- Setwise swap implementation: `setwise-contracts/contracts/SetwiseRebalancingPool.sol`
- Setwise indicative and firm quoting: `rfq-api/src`
- Robinhood Chain network details: <https://docs.robinhood.com/chain/connecting/>
- Robinhood Chain canonical tokens: <https://docs.robinhood.com/chain/contracts/>
- Base network details: <https://docs.base.org/base-chain/quickstart/connecting-to-base>
- BSC network details: <https://docs.bnbchain.org/bnb-smart-chain/developers/wallet-configuration/>
- 0x supported chains: <https://docs.0x.org/docs/introduction/supported-chains>

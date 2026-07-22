# Fork map and external Setwise dependencies

This document records which ZFi layers are imported as the upstream reference,
which paths are intended to be forked into Setwise-owned packages later, and
which Setwise components remain outside this repository.

## Imported upstream reference (do not modify for features)

Everything under [`zFi-main/`](../../zFi-main) is the pinned ZFi snapshot
(`z-fi/zFi@43ac1e67388cc4f96be6b2cbeb0f95f647c9aeb3`). Treat it as read-only
for product work.

| Layer | Upstream path | Role |
| --- | --- | --- |
| Execution router | `zFi-main/src/zRouter.sol` | On-chain swap execution, multicall, Permit2, venue adapters |
| On-chain quoter | `zFi-main/src/zQuoter.sol` | Direct / multi-hop / split / hybrid route discovery |
| Quote service | `zFi-main/server/` | Off-chain quote host comparing on-chain routes with aggregators |
| Dapp | `zFi-main/dapp/`, `zFi-main/zSwap.html` | Ethereum swap UI and routing presentation |
| Tests | `zFi-main/test/` | Foundry baseline |
| Scripts | `zFi-main/script/` | Build and deployment helpers |
| Audit notes | `zFi-main/audit/` | Inherited findings for later remediation |
| License | `zFi-main/LICENSE` | MIT, Copyright (c) 2026 ZAMM |

Supporting upstream sources that ship with the same snapshot (DAO, auctions,
precision pools, forwarders, workers, docs, assets) stay inside `zFi-main/` for
provenance completeness even when MVP scope focuses on the router stack.

## Intended Setwise forks (not yet extracted)

Later foundation/layout work should copy or adapt these layers into
Setwise-owned packages **outside** `zFi-main/`, preserving license notices:

| Concern | Upstream source | Planned Setwise ownership |
| --- | --- | --- |
| Contracts | `zFi-main/src/zRouter.sol`, `zFi-main/src/zQuoter.sol`, related libs | Setwise router/quoter packages |
| Quote API | `zFi-main/server/quote.js` | Chain-aware quote service |
| Frontend routing | `zFi-main/dapp/modules/`, wallet/theme/token list | Setwise Router dapp integration |
| Tooling | `zFi-main/script/`, `foundry.toml` | Shared build/test/deploy commands |

Until those packages exist, the building baseline is the unmodified submodule.

## External Setwise dependencies (remain outside this import)

These products are **not** vendored by issue #1. They stay separate repositories
or services and will be integrated through adapters and configuration:

| Component | Typical location | Notes |
| --- | --- | --- |
| Setwise pool contracts | `setwise-contracts` | Pool interface, UUPS proxies, EIP-712 pool quotes |
| RFQ / firm-quote API | `rfq-api` | Indicative and firm pricing; later router authorization |
| Setwise application | `setwise-app` | Existing direct-to-pool UX; UI copy uses **Set** for user-facing pool language while APIs retain `pool` / `poolId` |
| Token lists / market data | `setwise-token-list`, `setwise-market-data` | Discovery and pricing inputs |

## Terminology

- **UI / product copy**: say **Set** when referring to Setwise liquidity a user
  selects or reviews.
- **Internal identifiers and APIs**: keep `pool`, `poolId`, and related contract
  or RFQ field names unchanged.

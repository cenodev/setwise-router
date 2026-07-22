# Deployment manifests

This directory holds **committed** deployment manifests — one JSON file per
chain recording deployed contract addresses, bytecode metadata, deployment
transactions, compiler profiles, and explorer links.

These files are source-controlled and reviewed. They are distinct from
**generated build artifacts** (`contracts/out/`, `contracts/cache/`,
`contracts/broadcast/`) which are git-ignored.

## Naming convention

```
<chain-key>-<chain-id>.json
```

Examples: `ethereum-1.json`, `bsc-56.json`, `base-8453.json`,
`robinhood-4663.json`.

## Schema

Each manifest is deterministic (no timestamps) and validated by
[`schema.mjs`](./schema.mjs):

```json
{
  "schemaVersion": 1,
  "chainId": 1,
  "chainKey": "ethereum",
  "contracts": {
    "setwisePoolRegistry": {
      "status": "deployed",
      "kind": "uups-proxy",
      "displayName": "Set pool registry",
      "address": "0xProxyAddress...",
      "implementation": {
        "kind": "implementation",
        "address": "0xImplementationAddress...",
        "bytecodeHash": "0x...",
        "compiler": {
          "profile": "default",
          "solcVersion": "0.8.28",
          "optimizer": true,
          "optimizerRuns": 200,
          "evmVersion": "cancun"
        },
        "constructorInputs": []
      },
      "deployment": {
        "transactionHash": "0x...",
        "blockNumber": 12345678
      },
      "explorer": {
        "addressUrl": "https://etherscan.io/address/0xProxyAddress...",
        "transactionUrl": "https://etherscan.io/tx/0x..."
      }
    },
    "setwiseRouter": {
      "status": "pending",
      "kind": "direct",
      "displayName": "Set Router"
    }
  }
}
```

### Contract roles

| Internal key | UI label | Kind | Config registry path |
| --- | --- | --- | --- |
| `setwisePoolRegistry` | Set pool registry | `uups-proxy` | `venues.setwise.poolRegistry` |
| `setwiseTokenHub` | Set token hub | `direct` | `venues.setwise.tokenHub` |
| `setwiseRouter` | Set Router | `direct` | `router` |
| `setwiseQuoter` | Set Quoter | `direct` | `quoter` |

User-facing copy uses **Set**; internal identifiers keep `pool` / `poolId`.

UUPS proxy entries must record the **proxy address** used by integrators and a
nested **implementation** record with bytecode metadata. Proxy and implementation
addresses must differ.

## Verification

Offline schema validation (no RPC, no private keys):

```bash
npm run verify:deployments
```

Optional on-chain checks (verifies `eth_chainId`, code presence, bytecode hashes,
and EIP-1967 proxy vs implementation roles via each chain's public RPC):

```bash
npm run verify:deployments:on-chain
```

Human-readable release checklist:

```bash
npm run verify:deployments:checklist
```

Invalid chain or address configuration **fails closed** — verification exits
non-zero and refuses RPC reads when `eth_chainId` does not match the manifest.

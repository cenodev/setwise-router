# Deployment manifests

This directory holds **committed** deployment manifests — one JSON file per
chain recording deployed contract addresses, block numbers, and verification
status.

These files are source-controlled and reviewed. They are distinct from
**generated build artifacts** (`contracts/out/`, `contracts/cache/`,
`contracts/broadcast/`) which are git-ignored.

## Naming convention

```
<chain-name>-<chain-id>.json
```

Example: `ethereum-1.json`, `bsc-56.json`, `base-8453.json`,
`robinhood-4663.json`.

## Schema (planned)

```json
{
  "chainId": 1,
  "chainName": "ethereum",
  "contracts": {
    "SetwiseRouter": {
      "address": "0x...",
      "deployBlock": 0,
      "verified": false
    }
  },
  "deployedAt": "2026-01-01T00:00:00Z",
  "deployer": "0x..."
}
```

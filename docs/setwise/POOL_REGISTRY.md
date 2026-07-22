# Governed Set registry

Each supported chain deploys its own `SetwisePoolRegistry` behind an ERC-1967
proxy. The registry is the source of truth for which permanent Setwise pool
proxies the router may call. User-facing surfaces should describe these as
**Sets**; contract, service, and API identifiers retain `pool` and `poolId`.

## Trust and upgrade model

- Initialize the registry proxy with the production Safe or timelock as owner.
- Ownership transfers are two-step: the current owner nominates
  `pendingOwner`, and the nominated Safe/timelock accepts.
- The owner may add, remove, disable, or re-enable pool proxies and authorize a
  UUPS registry implementation upgrade.
- The emergency guardian is disable-only. It cannot add, remove, re-enable, or
  upgrade anything. Governance can set the guardian to `address(0)` to remove
  the role.
- Register the permanent pool **proxy**, never its implementation. `addPool`
  rejects a UUPS implementation address and verifies the proxy exposes the
  pool quote-signer and wrapped-native views. A pool implementation upgrade
  therefore does not change its registry membership.

Production delay policy belongs to the owner timelock. The registry deliberately
does not embed a second delay that could conflict with governance execution or
prevent an emergency disable.

## Router guard

Every Set execution path must make
`requireEnabledPool(pool)` its first external interaction, before token
approvals, transfers, Permit2 calls, or native-value forwarding. It fails closed:

- an unknown or removed proxy reverts with `PoolNotRegistered(pool)`;
- a governed or emergency-disabled proxy reverts with `PoolDisabled(pool)`.

`isPoolEnabled` returns `false` for both cases for convenient quote-service and
UI filtering; callers that need the distinction can use `poolState` or
`isPoolRegistered`.

## Service and UI reads

The stable read interface is `ISetwisePoolRegistry`:

| Method | Purpose |
| --- | --- |
| `owner`, `pendingOwner`, `emergencyGuardian` | Governance state |
| `isPoolRegistered(pool)` | Membership, independent of enabled state |
| `isPoolEnabled(pool)` | Fail-closed routing eligibility |
| `requireEnabledPool(pool)` | Reverting router preflight guard |
| `poolCount`, `poolAt`, `pools` | Enumerable proxy list |
| `poolState(pool)` | Membership, enabled bit, and current array index |

## Event reconstruction

`PoolAdded`, `PoolStatusChanged`, and `PoolRemoved` contain enough information
to reconstruct membership, enabled state, and exact swap-and-pop enumeration.
The removal event includes the proxy moved into the removed index. Ownership,
guardian, and ERC-1967 implementation changes are covered by
`OwnershipTransferStarted`, `OwnershipTransferred`,
`EmergencyGuardianChanged`, and `Upgraded`.

Tests live in
[`contracts/test/SetwisePoolRegistry.t.sol`](../../contracts/test/SetwisePoolRegistry.t.sol).
They cover unauthorized changes, complete events, two-step ownership, emergency
disable, fail-closed guard ordering, pool proxy upgrades, implementation-address
rejection, and registry UUPS upgrades with state preservation.

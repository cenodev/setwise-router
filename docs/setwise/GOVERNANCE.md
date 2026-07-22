# Governance, Timelocks, and Emergency Controls

This runbook covers ownership transfer, pause/unpause, per-chain and
per-source disable, and signer rotation for the Setwise Router. User-facing
surfaces describe liquidity venues as **Sets**; contract, service, and API
identifiers retain `pool` and `poolId`.

## Architecture

| Contract | Role | Owner | Guardian capability |
| --- | --- | --- | --- |
| `SetwisePoolRegistry` | Per-chain Set membership | Governance Safe/timelock | Disable-only |
| `RouterControl` | Global, per-chain, per-source disable | Governance Safe/timelock | Disable-only (no resume/re-enable) |
| `SetwiseTimelock` | Delayed execution of routine governance | Proposer (Safe) | Cancel-only |

All three are deployed behind ERC-1967 proxies. The implementation constructor
locks initialization so only the proxy storage is initializable.

## Role separation

- **Owner / Proposer** (governance Safe or timelock): full routine control —
  add/remove Sets, enable/disable sources, pause/resume, upgrade contracts,
  schedule timelock operations.
- **Emergency Guardian**: disable-only at every level. Can pause the router,
  disable chains, disable sources, emergency-disable Sets, and cancel pending
  timelock operations. Cannot add, remove, re-enable, resume, upgrade, or
  schedule anything.
- **No personal EOA** may hold the owner role in production. The owner must be
  a Safe or timelock contract.

## Ownership transfer (two-step)

1. Current owner calls `transferOwnership(newSafe)`.
2. `OwnershipTransferStarted` event is emitted; monitoring alerts fire.
3. New Safe calls `acceptOwnership()`.
4. `OwnershipTransferred` event confirms the handoff.

Until step 3 completes, the old owner retains full control. An unauthorized
caller cannot accept.

## Pause and unpause

| Action | Who | Effect |
| --- | --- | --- |
| `RouterControl.pause()` | Owner or Guardian | All routing halts immediately |
| `RouterControl.resume()` | Owner only | Routing resumes |
| `SetwisePoolRegistry.emergencyDisablePool(pool)` | Owner or Guardian | Single Set disabled |
| `SetwisePoolRegistry.setPoolEnabled(pool, true)` | Owner only | Re-enable a Set |

A single venue can be disabled without halting healthy routes:

```solidity
control.disableSource(chainId, keccak256("setwise"));
```

Other sources on the same chain and the same source on other chains remain
eligible.

## Per-chain disable

```solidity
control.disableChain(56);       // owner only
control.emergencyDisableChain(56); // owner or guardian
control.enableChain(56);        // owner only
```

## Timelock operations

Routine governance actions (delay changes, proposer rotation, contract
upgrades) pass through `SetwiseTimelock`:

1. Proposer calls `schedule(target, value, data, eta)`.
2. `OperationScheduled` event emitted; monitoring alerts.
3. After `delay` (1 hour – 30 days), the operation becomes executable.
4. Proposer calls `execute(id)` within the 14-day grace period.
5. `OperationExecuted` event emitted.

The guardian can `cancel(id)` at any point before execution. Expired
operations must be re-scheduled.

### Self-governance changes

`setDelay`, `setProposer`, and `setGuardian` on the timelock itself are
`onlySelf` — they must be scheduled and executed through the timelock,
enforcing the delay on governance changes.

## Signer rotation

Setwise pool quote signers are immutable per pool implementation. To rotate:

1. Deploy a new pool implementation with the new signer.
2. Schedule a pool proxy upgrade through the timelock.
3. Execute the upgrade after the delay.
4. The pool proxy address (and registry membership) remains unchanged.

## Monitoring and alerting

Every control change emits an observable event:

| Event | Trigger |
| --- | --- |
| `RouterPaused` / `RouterResumed` | Global pause state change |
| `ChainDisabled` / `ChainEnabled` | Per-chain state change |
| `SourceDisabled` / `SourceEnabled` | Per-source state change |
| `PoolStatusChanged` | Set enable/disable |
| `OwnershipTransferStarted` / `OwnershipTransferred` | Ownership changes |
| `EmergencyGuardianChanged` | Guardian rotation |
| `OperationScheduled` / `OperationExecuted` / `OperationCancelled` | Timelock lifecycle |

Services consume these via the `app/src/governance.js` module:

- `describeGovernanceState(state)` → severity level for dashboards.
- `checkRouteEligibility(state, chainId, sourceId)` → pre-trade guard.
- `buildControlChangeAlert(eventType, params)` → monitoring webhook payload.

## Staging drill checklist

Run on every staging chain before mainnet deployment:

- [ ] Deploy `RouterControl` proxy; initialize with staging Safe as owner.
- [ ] Deploy `SetwiseTimelock` proxy; initialize with staging Safe as proposer.
- [ ] Transfer `SetwisePoolRegistry` ownership to the timelock.
- [ ] Pause → verify all routes revert → resume → verify routes work.
- [ ] Disable one source → verify other sources route → re-enable.
- [ ] Disable one chain → verify other chains route → re-enable.
- [ ] Guardian emergency-disables a Set → verify re-enable requires owner.
- [ ] Schedule a timelock operation → guardian cancels → verify not executable.
- [ ] Schedule → wait delay → execute → verify effect.
- [ ] Attempt unauthorized actions from an EOA → verify all revert.
- [ ] Confirm monitoring fires on every event above.

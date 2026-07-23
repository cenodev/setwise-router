# Ethereum differential suite

Issue #16 continuously compares the Ethereum behavior retained from ZFi with
the Setwise compatibility surface. The oracle is the immutable
`z-fi/zFi@43ac1e67388cc4f96be6b2cbeb0f95f647c9aeb3` submodule at Ethereum block
`24,880,000`; the comparison manifest is
[`baseline/differential/ethereum.json`](../../baseline/differential/ethereum.json).

## What is compared

Every preserved category has a named case: direct, two-hop, three-hop, split,
hybrid, Curve, Lido, zAMM, and native wrap/unwrap. The deterministic check
re-encodes Setwise quoter requests from the pinned ABI and compares them
byte-for-byte with the upstream route fixtures. Where fork captures exist it
also round-trips return data through the Setwise decoder, compares selected
sources and amounts, verifies executable calldata, checks recipient balance
deltas and revert names/selectors, and reports gas deltas.

Run:

```bash
npm run differential:ethereum
npm run differential:ethereum -- --report /tmp/ethereum-differential.md
```

Any unexplained output, calldata, source, recipient-balance, or revert
difference fails. Gas regressions above 5% are reported as warnings; regressions
above 15% fail.

## Intentional deviations

Reviewed deviations live in
[`baseline/differential/allowlist.json`](../../baseline/differential/allowlist.json).
Each entry must identify one exact case and field, record the exact upstream and
Setwise values, provide a substantive rationale, and include `approvedBy` and
`approvedAt`. Wildcards are rejected. Stale entries fail, so the allowlist
cannot become a permanent blanket exemption.

Example:

```json
{
  "caseId": "direct-recipient-balance",
  "field": "recipientDelta",
  "upstream": "100",
  "setwise": "99",
  "rationale": "Explain the intentional, reviewed accounting change here.",
  "approvedBy": "router-reviewers",
  "approvedAt": "2026-07-23T00:00:00Z"
}
```

## Deliberate fixture refresh

Fork fixtures are never rewritten implicitly. A refresh requires the explicit
capture command and an archive-capable Ethereum RPC:

```bash
ETH_RPC_URL=https://archive.example npm run differential:capture
git diff -- baseline/routes baseline/differential
npm run differential:ethereum
```

Review the fork block, route/source changes, return bytes, recipient deltas, and
gas report before committing a refresh. Changing the pinned block or upstream
commit is a separate baseline decision and must update the compatibility
fixtures and documentation together.

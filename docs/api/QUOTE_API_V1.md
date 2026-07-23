# Quote API v1

`POST /v1/quotes` is the versioned contract shared by the ZFi on-chain quoter,
external aggregators, and Set quote sources. Its machine-readable OpenAPI 3.1
definition is [`quote-v1.openapi.json`](./quote-v1.openapi.json); committed
request, response, source-state, and error examples live in
[`services/quote/fixtures/v1/`](../../services/quote/fixtures/v1/).

## Request invariants

- `chainId`, `tokenIn`, `tokenOut`, `router`, `recipient`, and `funder` are all
  explicit. Every address is paired with its chain ID and must match the
  top-level supported chain.
- `mode` is `exact-input` or `exact-output`; `amount` is a positive canonical
  unsigned-integer string in the exact side's smallest unit.
- `slippage.maxBps` is an integer from 0 through 10,000.
- If the chain registry has a configured router, the request router must match
  it. There is no implicit Ethereum or router fallback.

## Response invariants

Every source returns an outcome with evidence. `available`, `unavailable`,
`excluded`, `stale`, and `failed` are distinct states; a stale outcome may retain
its normalized quote for diagnostics but cannot be selected. A quote normalizes
input/output/limit amounts, gas, fees, approval target, and expiry. Quoted
routes additionally expose a structured `ranking` record with raw and adjusted
amounts, every cost adjustment, pricing status, thresholds, and fallback.

`kind: indicative` cannot carry an approval target or transaction. `kind: firm`
requires a selected available source, an expiry, and exactly one top-level
transaction. That transaction includes one chain ID, target router, calldata,
and native value, and its chain and target must match the request.

For `exact-input`, `amounts.input` equals the requested amount and `amounts.limit`
is the minimum acceptable output. For `exact-output`, `amounts.output` equals the
requested amount and `amounts.limit` is the maximum acceptable input.

## Amount semantics by source and route builder

Every source normalizes `amounts.input`, `amounts.output`, and `amounts.limit`
as canonical unsigned-integer strings in a token's smallest unit, and the exact
side always equals the request `amount`:

- **ZFi on-chain (`zfi`)** — each route builder maps the request onto a quoter
  view and reports the decoded amounts. `direct` uses the single best leg;
  `multi-hop` and `three-hop` report the first leg's input and the last leg's
  output; `split` and `hybrid` sum their parallel legs. When a builder returns
  an explicit on-chain amount limit it is used as-is; otherwise the limit is
  derived from the quoted amount and the slippage tolerance.
- **External aggregators (`aggregator`)** — the aggregator's returned sell/buy
  amounts are preserved; the limit is the reported `minBuyAmount` (exact-input)
  or `maxSellAmount` (exact-output). Fees, gas, and approval metadata pass
  through unmodified.
- **Set (`setwise`)** — indicative amounts are compared without an approval
  target or transaction. A competitive indication may be replaced by a
  short-lived firm quote whose approval and transaction are bound to the
  requested router.

`split` and `hybrid` builders are exact-input only. For an `exact-output`
request they are not selectable; a source that supports only `exact-input`
appears with `status: "excluded"` and `UNSUPPORTED_MODE` policy evidence.

## Net executable outcome ranking

Routes are compared in the token on the non-exact side:

- `exact-input` maximizes output after subtracting protocol fees, integrator
  fees, execution gas, and any approval gas.
- `exact-output` minimizes required input after adding those costs.

`source` remains accepted as the legacy fee name, but is ranked as an
integrator fee. `network` fees are already represented by
`gas.estimatedCost` and are not charged twice. Firm quotes with a non-null
approval target include the default 46,000-unit approval estimate; callers may
override it globally or per source. The route's gas cost and units provide its
gas price when possible, or the caller may provide one explicitly.

Token conversion uses caller-supplied direct rational records:
`fromAmount` units of `fromToken` equal `toAmount` units of `toToken`. Conversion
rounds costs up and uses BigInt throughout, so 6-, 8-, and 18-decimal assets do
not lose precision. No inverse, multi-hop, RWA, or oracle price is inferred.

The default minimum-improvement band is the greater of 1 basis point and one
smallest comparison-token unit. Routes inside the band are equivalent and the
lexicographically smallest source ID wins, making selection independent of
adapter completion order. Callers can override either threshold.

If gas units, gas price, or a direct conversion is missing, the affected
adjustment reports `missing-estimate` or `missing-price`, the ranking is
`unpriced`, and `adjustedAmount` is `null`. Fully priced routes outrank unpriced
routes. If every viable route is unpriced, selection explicitly falls back to
the raw exact-mode amount. The response appends `UNPRICED_ADJUSTMENTS` policy
evidence and preserves source warnings such as RWA price warnings; it never
manufactures a missing price.

Deterministic fixtures under
[`services/quote/fixtures/ranking/`](../../services/quote/fixtures/ranking/)
cover Ethereum, BSC, Base, and Robinhood Chain native gas costs across 6-, 8-,
and 18-decimal comparison tokens.

## Indicative-to-firm execution

`runSetwiseFirmSelection` implements the executable selection boundary:

1. Run and rank all supported indicative sources. Indicative responses are
   always non-executable.
2. Request a short-lived Set firm quote only when Set won the indicative
   comparison. Request current non-Set firm competitors in parallel.
3. Reject malformed transactions and quotes that leave less than the
   submission buffer (15 seconds by default), then re-rank firm amounts and
   costs.
4. Simulate the best complete router transaction at the current block
   (`blockTag: "latest"`). A failed simulation removes that source before the
   next candidate is ranked.
5. Recheck expiry after simulation. If no firm candidate survives, return the
   original indicative response with `transaction: null`.

The workflow returns structured `fallbacks` alongside the schema response.
Each record identifies `sourceId`, `stage`, `code`, `message`, and `observedAt`.
Firming, signer, inventory, staleness, expiry, transaction, and simulation
failures therefore remain distinguishable. The selected quote, approval
target, and transaction are always lifted from the same surviving source, so
fallback cannot reuse Set approval metadata for a competitor.

## Conservative rounding

Slippage limits are rounded so a limit never over-promises, using BigInt math
that preserves token-decimal precision:

- `exact-input` → `limit` (minimum output) is rounded **down** (floor).
- `exact-output` → `limit` (maximum input) is rounded **up** (ceil), so the
  protected maximum input is never below the input the route actually requires.
  This prevents exact-output phantom liquidity, where a quote looks fillable
  but reverts because a truncated limit sat below the required input.

## Route evidence and reconstruction

Every source outcome carries non-empty evidence, and the response preserves the
selected route and every rejected route. The selected route is reconstructable
from its outcome: the normalized quote reports input/output/limit amounts, gas,
fees, slippage limit, approval target, and expiry. Its ranking record and
`ranking:<sourceId>` policy evidence preserve the raw amount, adjusted amount,
individual costs, missing-price state, thresholds, and fallback. ZFi evidence
encodes the chosen builder and its ordered legs (swap venue, fee, amounts);
parallel split routes additionally report each leg's `proportionBps` share of
the input (summing to 10,000). Set evidence records pool identity, inventory
snapshot, and price decomposition. Aggregator evidence records the HTTP
reference and block number.

## Terminology

User-facing source metadata uses **Set**. Internal identifiers deliberately keep
`type: setwise` and `poolId` so adapters and backend storage do not need a
migration.

## Stable errors

The public error envelope always contains `apiVersion` and `error.code`. Codes
are stable within v1:

- `QUOTE_INVALID_REQUEST`
- `QUOTE_INVALID_RESPONSE`
- `QUOTE_UNSUPPORTED_API_VERSION`
- `QUOTE_UNSUPPORTED_CHAIN`
- `QUOTE_CHAIN_MISMATCH`
- `QUOTE_ROUTER_MISMATCH`
- `QUOTE_INVALID_ADDRESS`
- `QUOTE_INVALID_AMOUNT`
- `QUOTE_INVALID_SLIPPAGE`
- `QUOTE_SOURCE_EVIDENCE_REQUIRED`
- `QUOTE_AMBIGUOUS_EXECUTION`

Callers may display `error.message` for diagnostics but should branch only on
`error.code`.

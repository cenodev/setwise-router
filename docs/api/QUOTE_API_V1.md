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
input/output/limit amounts, gas, fees, approval target, and expiry.

`kind: indicative` cannot carry an approval target or transaction. `kind: firm`
requires a selected available source, an expiry, and exactly one top-level
transaction. That transaction includes one chain ID, target router, calldata,
and native value, and its chain and target must match the request.

For `exact-input`, `amounts.input` equals the requested amount and `amounts.limit`
is the minimum acceptable output. For `exact-output`, `amounts.output` equals the
requested amount and `amounts.limit` is the maximum acceptable input.

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

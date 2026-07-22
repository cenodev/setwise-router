# Set Router authorization

Issue #10 adds the router-level EIP-712 authorization that prevents copied Set
swap calldata from pulling funds from a different wallet. Internal interfaces
and fields retain `Setwise`, `pool`, and `poolId` terminology; user-facing venue
copy remains **Set**.

The Set pool and router verify separate signatures:

1. The router verifies `SetwiseAuthorization`, which binds the funding wallet,
   execution context, and every security-sensitive field in `SetwiseSwap`.
2. The pool independently verifies its existing `SwapQuote`, where `payer` is
   the router because the pool observes `msg.sender == router`.
3. A successful pool call consumes their shared `quoteId`. The router therefore
   does not add a second persistent nonce store.

## EIP-712 definition

The router authorization domain is:

| Field | Value |
| --- | --- |
| `name` | `SetwiseRouter` |
| `version` | `1` |
| `chainId` | current `block.chainid` |
| `verifyingContract` | current router address |

The primary type is:

```text
SetwiseAuthorization(uint256 chainId,address router,address pool,address funder,address recipient,address assetIn,address assetOut,bool nativeIn,bool nativeOut,uint256 amountIn,uint256 amountOut,bytes32 quoteId,uint256 deadline)
```

Typehash:
`0xdb214515455e435a629caeea5e43ce9fb3a46d7eff051638240c82e84a1ea858`.

`chainId` and `router` deliberately appear in both the domain and the message.
The duplication makes the signed payload self-describing while the EIP-712
domain independently prevents cross-chain and cross-router replay.

The router derives the message from the actual `SetwiseSwap` calldata, the
declared `funder`, `block.chainid`, and `address(this)`. Callers cannot supply a
different chain or router value to the verification path.

## Verification order

Adapters protect their execution entry point with
`onlyValidSetwiseAuthorization(swap, funder, authorizationSignature)`. The
modifier checks, in order:

1. `msg.sender == funder`, preventing another account from copying the call.
2. `block.timestamp <= swap.deadline`.
3. The current `ISetwisePool(swap.pool).QUOTE_SIGNER()` is nonzero.
4. The signer validates the exact EIP-712 digest.

The protected function body begins only after these checks. Approvals, Permit2
interactions, token pulls, native-value forwarding, and pool calls belong in the
body, so caller or calldata substitution fails before funds move. The governed
pool-registry check remains an adapter responsibility and must also precede any
asset interaction.

EOA verification accepts canonical 65-byte and EIP-2098 compact signatures,
rejecting invalid `v` and high-`s` values. If `QUOTE_SIGNER` has code, the full
signature bytes are passed through `IERC1271.isValidSignature` using
`staticcall`. This supports Safe-style multi-signature encodings without the
router interpreting them. Reverts, malformed return data, or a value other than
the ERC-1271 magic value fail closed.

## Shared RFQ fixture

[`baseline/setwise/router-authorization.json`](../../baseline/setwise/router-authorization.json)
is the canonical contract/RFQ compatibility fixture. It contains the complete
typed data, expected typehash, domain separator, struct hash, digest, signer,
and EOA signature. The quote-service helper in
[`services/quote/src/setwise-authorization.js`](../../services/quote/src/setwise-authorization.js)
builds the same payload.

Both test suites consume that one fixture:

```bash
cd contracts && forge test --match-contract SetwiseRouterAuthorizationTest
npm run test --workspace=@setwise-router/quote
```

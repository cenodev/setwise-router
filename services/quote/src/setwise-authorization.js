export const SETWISE_AUTHORIZATION_PRIMARY_TYPE = "SetwiseAuthorization";

export const SETWISE_AUTHORIZATION_DOMAIN = Object.freeze({
  name: "SetwiseRouter",
  version: "1",
});

export const SETWISE_AUTHORIZATION_TYPES = Object.freeze({
  EIP712Domain: Object.freeze([
    Object.freeze({ name: "name", type: "string" }),
    Object.freeze({ name: "version", type: "string" }),
    Object.freeze({ name: "chainId", type: "uint256" }),
    Object.freeze({ name: "verifyingContract", type: "address" }),
  ]),
  SetwiseAuthorization: Object.freeze([
    Object.freeze({ name: "chainId", type: "uint256" }),
    Object.freeze({ name: "router", type: "address" }),
    Object.freeze({ name: "pool", type: "address" }),
    Object.freeze({ name: "funder", type: "address" }),
    Object.freeze({ name: "recipient", type: "address" }),
    Object.freeze({ name: "assetIn", type: "address" }),
    Object.freeze({ name: "assetOut", type: "address" }),
    Object.freeze({ name: "nativeIn", type: "bool" }),
    Object.freeze({ name: "nativeOut", type: "bool" }),
    Object.freeze({ name: "amountIn", type: "uint256" }),
    Object.freeze({ name: "amountOut", type: "uint256" }),
    Object.freeze({ name: "quoteId", type: "bytes32" }),
    Object.freeze({ name: "deadline", type: "uint256" }),
  ]),
});

/** Build the exact typed-data payload consumed by the RFQ signing workflow. */
export function buildSetwiseAuthorizationTypedData(message) {
  return {
    types: SETWISE_AUTHORIZATION_TYPES,
    primaryType: SETWISE_AUTHORIZATION_PRIMARY_TYPE,
    domain: {
      ...SETWISE_AUTHORIZATION_DOMAIN,
      chainId: message.chainId,
      verifyingContract: message.router,
    },
    message: { ...message },
  };
}

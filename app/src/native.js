import { getChainConfig } from "../../config/index.mjs";
import { NATIVE_TOKEN_ADDRESS } from "./constants.js";

/**
 * @typedef {"native"|"wrapped-native"|"erc20"|"robinhood-stock"} TokenKind
 * @typedef {{
 *   chainId: number,
 *   address: string,
 *   symbol: string,
 *   name: string,
 *   decimals: number,
 *   kind: TokenKind,
 *   logoUri?: string,
 *   poolId?: string,
 * }} ChainToken
 */

/**
 * @param {number} chainId
 * @returns {{ native: ChainToken, wrapped: ChainToken|null }}
 */
export function getNativeAssets(chainId) {
  const config = getChainConfig(chainId);
  const native = {
    chainId,
    address: NATIVE_TOKEN_ADDRESS,
    symbol: config.nativeToken.symbol,
    name: config.nativeToken.name,
    decimals: config.nativeToken.decimals,
    kind: "native",
  };

  const wrappedAddress = config.wrappedNative.address;
  const wrapped = wrappedAddress
    ? {
        chainId,
        address: wrappedAddress,
        symbol: config.wrappedNative.symbol,
        name: config.wrappedNative.name,
        decimals: config.wrappedNative.decimals,
        kind: "wrapped-native",
      }
    : null;

  return { native, wrapped };
}

/**
 * @param {ChainToken} token
 * @param {{ preferWrapped?: boolean }} [options]
 */
export function formatTokenLabel(token, options = {}) {
  if (token.kind === "native" && options.preferWrapped) {
    return `${token.symbol} (native)`;
  }
  if (token.kind === "wrapped-native") {
    return `${token.symbol} (wrapped)`;
  }
  return token.symbol;
}

/**
 * Map a picker token to the address expected by quote requests.
 *
 * @param {ChainToken} token
 * @param {{ useWrappedNative?: boolean }} [options]
 */
export function resolveQuoteTokenAddress(token, options = {}) {
  if (token.kind === "native" && options.useWrappedNative) {
    const { wrapped } = getNativeAssets(token.chainId);
    if (!wrapped?.address) {
      throw new Error(`chain ${token.chainId} has no wrapped-native address configured`);
    }
    return wrapped.address;
  }
  return token.address;
}

/**
 * @param {ChainToken} token
 */
export function isNativeAsset(token) {
  return token.kind === "native" || token.kind === "wrapped-native";
}

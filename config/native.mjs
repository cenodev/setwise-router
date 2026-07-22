/**
 * Canonical native / wrapped-native representation, selected from the typed
 * multi-chain configuration registry.
 *
 * One source of truth: every chain's native token and wrapped-native token come
 * from `config/chains/<chainId>.json` via the registry. There is no hardcoded
 * WETH (or WBNB) constant anywhere downstream — ETH/WETH on Ethereum, Base and
 * Robinhood Chain and BNB/WBNB on BSC are all resolved from configuration.
 *
 * The canonical internal representation of a native leg is the zero-address
 * sentinel (`NATIVE_TOKEN_SENTINEL`), matching the contracts'
 * `SETWISE_NATIVE_TOKEN`. On-chain a native leg always settles through the
 * chain's wrapped-native token; `resolveNativeAsset` mirrors the contract's
 * `SetwiseSwapLib.normalizeAsset`.
 */

import { getChainConfig } from "./registry.mjs";
import { ZERO_ADDRESS } from "./schema.mjs";

/** Canonical sentinel for a native leg (mirrors `SETWISE_NATIVE_TOKEN` on-chain). */
export const NATIVE_TOKEN_SENTINEL = ZERO_ADDRESS;

/** @param {string} asset @returns {boolean} whether `asset` is the native sentinel. */
export function isNativeAsset(asset) {
  return typeof asset === "string" && asset.toLowerCase() === NATIVE_TOKEN_SENTINEL;
}

/**
 * Resolve the canonical native + wrapped-native representation for a chain.
 *
 * Throws for unsupported chains (no implicit Ethereum fallback). The wrapped
 * address is `null` only on unverified chains (e.g. Robinhood Chain pre-launch);
 * callers that need an on-chain native leg must require a verified address.
 *
 * @param {number} chainId
 * @returns {{
 *   chainId: number,
 *   native: { symbol: string, name: string, decimals: number, sentinel: string },
 *   wrapped: { symbol: string, name: string, decimals: number, address: string|null },
 *   addressesVerified: boolean,
 * }}
 */
export function getNativeConfig(chainId) {
  const config = getChainConfig(chainId);
  return {
    chainId: config.chainId,
    native: { ...config.nativeToken, sentinel: NATIVE_TOKEN_SENTINEL },
    wrapped: { ...config.wrappedNative },
    addressesVerified: config.addressesVerified,
  };
}

/**
 * Resolve a wrapped-native address that is guaranteed present, throwing when the
 * chain is unverified or has no wrapped-native address. Use before building any
 * on-chain native leg.
 *
 * @param {number} chainId
 * @returns {string} the non-zero wrapped-native address
 */
export function requireWrappedNative(chainId) {
  const { wrapped, addressesVerified } = getNativeConfig(chainId);
  if (!addressesVerified || typeof wrapped.address !== "string") {
    throw new Error(
      `chain ${chainId} has no verified wrapped-native address; cannot build a native leg`,
    );
  }
  return wrapped.address;
}

/**
 * Normalize an RFQ/UI asset into the on-chain quote asset for `chainId`: the
 * native sentinel maps to the chain's wrapped-native token, every other asset is
 * returned unchanged. Mirrors `SetwiseSwapLib.normalizeAsset`.
 *
 * @param {number} chainId
 * @param {string} asset
 * @returns {string}
 */
export function resolveNativeAsset(chainId, asset) {
  if (!isNativeAsset(asset)) return asset;
  return requireWrappedNative(chainId);
}

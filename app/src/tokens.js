import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getChainConfig, isAddress, isSupportedChain } from "../../config/index.mjs";
import { NATIVE_TOKEN_ADDRESS } from "./constants.js";
import { getNativeAssets } from "./native.js";
import { loadRobinhoodCanonicalMetadata } from "./robinhood.js";

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "tokens");

export class TokenListError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = "TokenListError";
    this.errors = errors;
  }
}

/**
 * @param {unknown} list
 * @param {number} [expectedChainId]
 */
export function validateTokenList(list, expectedChainId) {
  const errors = [];
  if (typeof list !== "object" || list === null || Array.isArray(list)) {
    throw new TokenListError("token list must be an object");
  }

  const chainId = list.chainId;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    errors.push("chainId must be a positive safe integer");
  } else if (expectedChainId != null && chainId !== expectedChainId) {
    errors.push(`chainId ${chainId} does not match expected ${expectedChainId}`);
  } else if (!isSupportedChain(chainId)) {
    errors.push(`unsupported chain id ${chainId}`);
  }

  if (!Array.isArray(list.tokens) || list.tokens.length === 0) {
    errors.push("tokens must be a non-empty array");
  }

  const seen = new Set();
  const tokens = Array.isArray(list.tokens) ? list.tokens : [];

  for (const [index, token] of tokens.entries()) {
    const path = `tokens[${index}]`;
    if (typeof token !== "object" || token === null) {
      errors.push(`${path} must be an object`);
      continue;
    }

    if (token.chainId !== chainId) {
      errors.push(`${path}.chainId must equal list chainId ${chainId}`);
    }

    const address = token.address;
    const isNative = address === NATIVE_TOKEN_ADDRESS;
    if (!isNative && !isAddress(address)) {
      errors.push(`${path}.address is not a valid address`);
    }

    const normalized = isNative ? NATIVE_TOKEN_ADDRESS : address.toLowerCase();
    if (seen.has(normalized)) {
      errors.push(`${path}.address duplicates another token on this chain`);
    }
    seen.add(normalized);

    if (typeof token.symbol !== "string" || token.symbol.trim() === "") {
      errors.push(`${path}.symbol is required`);
    }
    if (typeof token.name !== "string" || token.name.trim() === "") {
      errors.push(`${path}.name is required`);
    }
    if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 36) {
      errors.push(`${path}.decimals must be an integer between 0 and 36`);
    }
    if (
      !["native", "wrapped-native", "erc20", "robinhood-stock"].includes(token.kind)
    ) {
      errors.push(`${path}.kind is not supported`);
    }
  }

  if (errors.length > 0) {
    throw new TokenListError("token list failed validation", errors);
  }

  return /** @type {{ chainId: number, version: number, tokens: import("./native.js").ChainToken[] }} */ (
    list
  );
}

/**
 * Ensure the committed list matches registry native/wrapped metadata.
 *
 * @param {{ chainId: number, tokens: import("./native.js").ChainToken[] }} list
 */
export function assertTokenListMatchesChainConfig(list) {
  const config = getChainConfig(list.chainId);
  const { native, wrapped } = getNativeAssets(list.chainId);
  const byKind = Object.groupBy(list.tokens, (token) => token.kind);

  const nativeTokens = byKind.native ?? [];
  const wrappedTokens = byKind["wrapped-native"] ?? [];

  if (nativeTokens.length !== 1) {
    throw new TokenListError(`chain ${list.chainId} must declare exactly one native token`);
  }
  if (nativeTokens[0].symbol !== config.nativeToken.symbol) {
    throw new TokenListError(
      `native token symbol mismatch for chain ${list.chainId}: expected ${config.nativeToken.symbol}`,
    );
  }

  const expectedWrappedAddress =
    wrapped?.address ??
    (list.chainId === 4663
      ? loadRobinhoodCanonicalMetadata().wrappedNative.address
      : null);

  if (expectedWrappedAddress) {
    if (wrappedTokens.length !== 1) {
      throw new TokenListError(
        `chain ${list.chainId} must declare exactly one wrapped-native token`,
      );
    }
    if (wrappedTokens[0].address.toLowerCase() !== expectedWrappedAddress.toLowerCase()) {
      throw new TokenListError(
        `wrapped-native address mismatch for chain ${list.chainId}: expected ${expectedWrappedAddress}`,
      );
    }
  } else if (wrappedTokens.length > 0) {
    throw new TokenListError(
      `chain ${list.chainId} has no verified wrapped-native address but token list includes one`,
    );
  }
}

/**
 * @param {number} chainId
 */
export function loadTokenList(chainId) {
  if (!isSupportedChain(chainId)) {
    throw new TokenListError(`unsupported chain id ${chainId}`);
  }

  const file = join(dataDir, `${chainId}.json`);
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const list = validateTokenList(parsed, chainId);
  assertTokenListMatchesChainConfig(list);
  return list;
}

/**
 * @param {number} chainId
 * @returns {import("./native.js").ChainToken[]}
 */
export function getTokensForChain(chainId) {
  return loadTokenList(chainId).tokens;
}

/**
 * @param {number} chainId
 * @param {string} address
 */
export function findToken(chainId, address) {
  const normalized =
    address.toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase()
      ? NATIVE_TOKEN_ADDRESS
      : address.toLowerCase();

  return getTokensForChain(chainId).find((token) => {
    const tokenAddress =
      token.address.toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase()
        ? NATIVE_TOKEN_ADDRESS
        : token.address.toLowerCase();
    return tokenAddress === normalized;
  });
}

/**
 * @param {import("./native.js").ChainToken} token
 * @param {number} chainId
 */
export function isTokenOnChain(token, chainId) {
  return token.chainId === chainId && Boolean(findToken(chainId, token.address));
}

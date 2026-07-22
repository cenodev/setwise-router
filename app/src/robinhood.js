import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isAddress } from "../../config/index.mjs";
import { ROBINHOOD_TOKEN_SOURCE } from "./constants.js";

const metadataPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
  "robinhood-canonical.json",
);

const ROBINHOOD_STOCK_NAME_SUFFIX = "• Robinhood Token";
const ROBINHOOD_ETF_NAME_SUFFIX = "• Robinhood ETF";

/**
 * @typedef {{
 *   source: string,
 *   sourceLabel: string,
 *   chainId: number,
 *   wrappedNative: { symbol: string, name: string, decimals: number, address: string },
 *   stablecoins: Array<{ symbol: string, name: string, decimals: number, address: string }>,
 *   stockTokens: Array<{ symbol: string, name: string, decimals: number, address: string, kind: "robinhood-stock" }>,
 * }} RobinhoodCanonicalMetadata
 */

/** @returns {RobinhoodCanonicalMetadata} */
export function loadRobinhoodCanonicalMetadata() {
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  validateRobinhoodCanonicalMetadata(metadata);
  return metadata;
}

/** @param {unknown} metadata */
export function validateRobinhoodCanonicalMetadata(metadata) {
  if (typeof metadata !== "object" || metadata === null) {
    throw new Error("Robinhood canonical metadata must be an object");
  }
  if (metadata.source !== ROBINHOOD_TOKEN_SOURCE) {
    throw new Error(
      `Robinhood canonical metadata must cite ${ROBINHOOD_TOKEN_SOURCE}`,
    );
  }
  if (metadata.chainId !== 4663) {
    throw new Error("Robinhood canonical metadata must target chain 4663");
  }

  for (const token of [...metadata.stablecoins, ...metadata.stockTokens]) {
    if (!isAddress(token.address)) {
      throw new Error(`invalid Robinhood token address for ${token.symbol}`);
    }
  }
}

/**
 * @param {{ symbol: string, name: string, address: string, kind?: string }} token
 */
export function isCanonicalRobinhoodStockToken(token) {
  const metadata = loadRobinhoodCanonicalMetadata();
  const normalized = token.address.toLowerCase();
  const listed = [...metadata.stablecoins, ...metadata.stockTokens].some(
    (entry) => entry.address.toLowerCase() === normalized,
  );
  if (listed) return true;

  if (token.kind === "robinhood-stock") {
    return (
      token.name.includes(ROBINHOOD_STOCK_NAME_SUFFIX) ||
      token.name.includes(ROBINHOOD_ETF_NAME_SUFFIX)
    );
  }

  return false;
}

/**
 * @param {{ symbol: string, name: string, address: string }} token
 */
export function assertCanonicalRobinhoodToken(token) {
  if (!isCanonicalRobinhoodStockToken(token)) {
    throw new Error(
      `${token.symbol} at ${token.address} is not a canonical Robinhood Stock Token. ` +
        `Verify addresses at ${ROBINHOOD_TOKEN_SOURCE}.`,
    );
  }
}

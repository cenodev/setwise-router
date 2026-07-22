/**
 * Setwise pool catalog and per-chain discovery (issue #19).
 *
 * Eligible pools are declared explicitly per chain. Discovery filters by chain,
 * enabled flag, and optional on-chain registry membership when the chain config
 * exposes a pool registry address.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isAddress } from "../../../config/index.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CATALOG_PATH = join(packageRoot, "fixtures/setwise/pools.json");

/**
 * @typedef {Object} SetwisePoolRecord
 * @property {string} poolId        Stable internal pool identifier.
 * @property {number} chainId       Chain the pool is deployed on.
 * @property {string} poolAddress   On-chain pool proxy address.
 * @property {boolean} enabled      Whether the pool accepts indicative quotes.
 * @property {readonly string[]} supportedAssets  Lower-case asset addresses.
 */

/**
 * @param {unknown} entry
 * @returns {SetwisePoolRecord}
 */
export function normalizePoolRecord(entry) {
  if (!entry || typeof entry !== "object") {
    throw new Error("pool catalog entry must be an object");
  }
  const { poolId, chainId, poolAddress, enabled, supportedAssets } = entry;
  if (typeof poolId !== "string" || poolId.trim().length === 0) {
    throw new Error("pool catalog entry requires a non-empty poolId");
  }
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error(`pool "${poolId}" has an invalid chainId`);
  }
  if (!isAddress(poolAddress)) {
    throw new Error(`pool "${poolId}" has an invalid poolAddress`);
  }
  if (typeof enabled !== "boolean") {
    throw new Error(`pool "${poolId}" requires an enabled boolean`);
  }
  if (!Array.isArray(supportedAssets) || supportedAssets.length === 0) {
    throw new Error(`pool "${poolId}" requires a non-empty supportedAssets list`);
  }
  for (const asset of supportedAssets) {
    if (!isAddress(asset)) {
      throw new Error(`pool "${poolId}" has an invalid supported asset "${asset}"`);
    }
  }
  return Object.freeze({
    poolId,
    chainId,
    poolAddress,
    enabled,
    supportedAssets: Object.freeze(
      supportedAssets.map((asset) => asset.toLowerCase()),
    ),
  });
}

/**
 * Load and validate the committed pool catalog fixture.
 *
 * @param {string} [catalogPath]
 * @returns {readonly SetwisePoolRecord[]}
 */
export function loadPoolCatalog(catalogPath = DEFAULT_CATALOG_PATH) {
  const raw = JSON.parse(readFileSync(catalogPath, "utf8"));
  if (!raw || !Array.isArray(raw.pools)) {
    throw new Error("pool catalog must contain a pools array");
  }
  const pools = raw.pools.map(normalizePoolRecord);
  const ids = new Set();
  for (const pool of pools) {
    const key = `${pool.chainId}:${pool.poolId}`;
    if (ids.has(key)) {
      throw new Error(`duplicate pool id "${pool.poolId}" on chain ${pool.chainId}`);
    }
    ids.add(key);
  }
  return Object.freeze(pools);
}

/**
 * @param {readonly SetwisePoolRecord[]} catalog
 * @param {number} chainId
 * @param {string} poolId
 * @returns {SetwisePoolRecord|null}
 */
export function getPoolById(catalog, chainId, poolId) {
  return (
    catalog.find((pool) => pool.chainId === chainId && pool.poolId === poolId) ??
    null
  );
}

/**
 * Discover Set pools eligible for indicative quoting on a chain.
 *
 * @param {number} chainId
 * @param {object} [chainConfig]
 * @param {object} [options]
 * @param {readonly SetwisePoolRecord[]} [options.catalog]
 * @param {readonly string[]} [options.registryPools] Lower-case registry addresses.
 * @returns {SetwisePoolRecord[]}
 */
export function discoverEligiblePools(chainId, chainConfig = {}, options = {}) {
  const catalog = options.catalog ?? loadPoolCatalog();
  const registryPools = new Set(
    (options.registryPools ?? []).map((address) => address.toLowerCase()),
  );
  const registryConfigured = Boolean(
    chainConfig?.venues?.setwise?.poolRegistry,
  );

  return catalog.filter((pool) => {
    if (pool.chainId !== chainId || !pool.enabled) return false;
    if (!registryConfigured) return true;
    return registryPools.has(pool.poolAddress.toLowerCase());
  });
}

/**
 * Validate that a pool record matches the request chain and is enabled.
 *
 * @param {SetwisePoolRecord} pool
 * @param {number} chainId
 * @returns {{ valid: true } | { valid: false, code: string, message: string }}
 */
export function validatePoolIdentity(pool, chainId) {
  if (pool.chainId !== chainId) {
    return {
      valid: false,
      code: "POOL_CHAIN_MISMATCH",
      message: `pool ${pool.poolId} is registered on chain ${pool.chainId}, not ${chainId}`,
    };
  }
  if (!pool.enabled) {
    return {
      valid: false,
      code: "POOL_DISABLED",
      message: `pool ${pool.poolId} is disabled`,
    };
  }
  return { valid: true };
}

/**
 * Reject routes that reference the pool contract itself as a trade asset.
 *
 * @param {SetwisePoolRecord} pool
 * @param {string} tokenIn
 * @param {string} tokenOut
 * @returns {{ valid: true } | { valid: false, code: string, message: string }}
 */
export function rejectSelfReferentialRoute(pool, tokenIn, tokenOut) {
  const poolAddress = pool.poolAddress.toLowerCase();
  if (
    tokenIn.toLowerCase() === poolAddress ||
    tokenOut.toLowerCase() === poolAddress
  ) {
    return {
      valid: false,
      code: "SELF_REFERENTIAL_ROUTE",
      message: "Set pool contract cannot be traded as an asset",
    };
  }
  return { valid: true };
}

/**
 * @param {SetwisePoolRecord} pool
 * @param {string} tokenIn
 * @param {string} tokenOut
 * @returns {{ supported: true } | { supported: false, code: string, message: string }}
 */
export function validateSupportedAssets(pool, tokenIn, tokenOut) {
  const assets = new Set(pool.supportedAssets);
  if (!assets.has(tokenIn.toLowerCase()) || !assets.has(tokenOut.toLowerCase())) {
    return {
      supported: false,
      code: "UNSUPPORTED_ASSET_PAIR",
      message: `pool ${pool.poolId} does not support the requested asset pair`,
    };
  }
  return { supported: true };
}

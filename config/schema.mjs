/**
 * Schema and validation for the typed multi-chain configuration registry.
 *
 * The canonical source of truth is one JSON file per chain in `config/chains/`,
 * named `<chainId>.json`. This module defines the expected shape (via JSDoc
 * typedefs) and validates each chain plus the registry as a whole.
 *
 * Validation rejects:
 *   - missing required fields,
 *   - zero addresses,
 *   - duplicate chain ids / keys and duplicate single-role addresses,
 *   - cross-chain reuse of chain-unique addresses.
 *
 * Secrets and production RPC credentials never appear here: RPC roles reference
 * environment-variable names only, never their values.
 */

import {
  CAPABILITY_DEFINITIONS,
  ETHEREUM_CHAIN_ID,
  KNOWN_CAPABILITIES,
} from "./capabilities.mjs";

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Venues that every chain must declare explicitly (enabled or not) so that
 * unsupported protocol capabilities are never implicit.
 */
export const KNOWN_VENUES = Object.freeze([
  "uniswapV2",
  "uniswapV3",
  "uniswapV4",
  "sushiswap",
  "pancakeSwap",
  "curve",
  "lido",
  "zamm",
  "setwise",
]);

/**
 * Address fields that may appear on a venue entry. `initCodeHash` is a bytes32,
 * the rest are 20-byte addresses.
 */
const VENUE_ADDRESS_FIELDS = Object.freeze([
  "factory",
  "poolManager",
  "poolRegistry",
  "tokenHub",
]);

/**
 * Singleton address roles within a chain that must be pairwise distinct so a
 * copy/paste of one address into two roles is rejected.
 */
const SINGLETON_ROLES = Object.freeze([
  "wrappedNative",
  "router",
  "quoter",
  "multicall3",
  "permit2",
  "setwisePoolRegistry",
  "setwiseTokenHub",
]);

/**
 * Addresses that are canonically identical across chains (deterministic
 * deployments) and therefore exempt from the cross-chain collision check.
 */
const CROSS_CHAIN_CONSISTENT_ROLES = Object.freeze(["multicall3", "permit2"]);

/**
 * @typedef {Object} TokenInfo
 * @property {string} symbol
 * @property {string} name
 * @property {number} decimals
 */

/**
 * @typedef {TokenInfo & { address: string|null }} WrappedNativeToken
 */

/**
 * @typedef {Object} RpcConfig
 * @property {string|null} publicUrl  Non-secret public RPC (dev fallback only).
 * @property {string} primaryEnv      Env-var name holding the credentialed RPC.
 * @property {string} [archiveEnv]    Env-var name holding an archive RPC.
 */

/**
 * @typedef {Object} ExplorerConfig
 * @property {string} name
 * @property {string} baseUrl
 * @property {string} txUrlTemplate
 * @property {string} addressUrlTemplate
 */

/**
 * @typedef {Object} VenueConfig
 * @property {boolean} enabled
 * @property {string|null} [factory]
 * @property {string|null} [poolManager]
 * @property {string|null} [initCodeHash]
 * @property {string|null} [poolRegistry]  Setwise pool registry (internal name).
 * @property {string|null} [tokenHub]      Setwise token hub (internal name).
 */

/**
 * @typedef {Object} ChainConfig
 * @property {number} chainId
 * @property {string} key
 * @property {string} displayName
 * @property {boolean} addressesVerified
 * @property {TokenInfo} nativeToken
 * @property {WrappedNativeToken} wrappedNative
 * @property {RpcConfig} rpc
 * @property {string|null} multicall3
 * @property {string|null} [permit2]
 * @property {string|null} router
 * @property {string|null} quoter
 * @property {ExplorerConfig} explorer
 * @property {Record<string, VenueConfig>} venues
 * @property {Record<string, { enabled: boolean }>} [aggregators]
 * @property {Record<string, { enabled: boolean }>} capabilities
 */

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when value is a 20-byte hex address that is not the zero address. */
export function isAddress(value) {
  return (
    typeof value === "string" &&
    ADDRESS_RE.test(value) &&
    value.toLowerCase() !== ZERO_ADDRESS
  );
}

/** True when value is a 32-byte hex string. */
export function isBytes32(value) {
  return typeof value === "string" && BYTES32_RE.test(value);
}

function isHttpUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Validate a single chain config object.
 *
 * @param {unknown} config
 * @param {number} [expectedChainId] Chain id implied by the file name, if any.
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateChainConfig(config, expectedChainId) {
  const errors = [];
  if (!isPlainObject(config)) {
    return { valid: false, errors: ["config must be an object"] };
  }
  const label = `chain ${expectedChainId ?? "?"}`;

  if (!Number.isInteger(config.chainId) || config.chainId <= 0) {
    errors.push(`${label}: chainId must be a positive integer`);
  } else if (expectedChainId !== undefined && config.chainId !== expectedChainId) {
    errors.push(
      `${label}: chainId ${config.chainId} does not match file name (${expectedChainId})`,
    );
  }

  if (typeof config.key !== "string" || !/^[a-z0-9-]+$/.test(config.key)) {
    errors.push(`${label}: key must be a lowercase slug`);
  }
  if (typeof config.displayName !== "string" || config.displayName.length === 0) {
    errors.push(`${label}: displayName must be a non-empty string`);
  }
  if (typeof config.addressesVerified !== "boolean") {
    errors.push(`${label}: addressesVerified must be a boolean`);
  }

  validateToken(config.nativeToken, `${label}.nativeToken`, errors);
  validateWrappedNative(config.wrappedNative, config.addressesVerified, label, errors);
  validateRpc(config.rpc, `${label}.rpc`, errors);
  validateExplorer(config.explorer, `${label}.explorer`, errors);

  for (const role of ["multicall3", "permit2", "router", "quoter"]) {
    if (!(role in config)) {
      if (role === "multicall3") errors.push(`${label}: missing multicall3 field`);
      continue;
    }
    const value = config[role];
    if (value !== null && !isAddress(value)) {
      errors.push(`${label}: ${role} must be null or a non-zero address`);
    }
  }
  if (config.addressesVerified === true && !isAddress(config.multicall3)) {
    errors.push(`${label}: addressesVerified requires a non-zero multicall3`);
  }

  validateVenues(config.venues, label, errors);
  validateAggregators(config.aggregators, label, errors);
  validateCapabilities(config.capabilities, config.chainId, config.venues, label, errors);

  collectSingletonDuplicates(config, label, errors);

  return { valid: errors.length === 0, errors };
}

function validateToken(token, path, errors) {
  if (!isPlainObject(token)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (typeof token.symbol !== "string" || token.symbol.length === 0) {
    errors.push(`${path}.symbol must be a non-empty string`);
  }
  if (typeof token.name !== "string" || token.name.length === 0) {
    errors.push(`${path}.name must be a non-empty string`);
  }
  if (!Number.isInteger(token.decimals) || token.decimals < 0) {
    errors.push(`${path}.decimals must be a non-negative integer`);
  }
}

function validateWrappedNative(token, addressesVerified, label, errors) {
  const path = `${label}.wrappedNative`;
  if (!isPlainObject(token)) {
    errors.push(`${path} must be an object`);
    return;
  }
  validateToken(token, path, errors);
  if (!("address" in token)) {
    errors.push(`${path}.address is required (use null only when unverified)`);
  } else if (token.address !== null && !isAddress(token.address)) {
    errors.push(`${path}.address must be null or a non-zero address`);
  }
  if (addressesVerified === true && !isAddress(token.address)) {
    errors.push(`${label}: addressesVerified requires a non-zero wrappedNative.address`);
  }
}

function validateRpc(rpc, path, errors) {
  if (!isPlainObject(rpc)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (typeof rpc.primaryEnv !== "string" || rpc.primaryEnv.length === 0) {
    errors.push(`${path}.primaryEnv must name the env var holding the RPC URL`);
  }
  if ("publicUrl" in rpc && rpc.publicUrl !== null && !isHttpUrl(rpc.publicUrl)) {
    errors.push(`${path}.publicUrl must be null or an http(s) URL`);
  }
  if ("archiveEnv" in rpc && rpc.archiveEnv !== null && typeof rpc.archiveEnv !== "string") {
    errors.push(`${path}.archiveEnv must be a string env-var name`);
  }
  // Guard against accidentally committing a credential instead of an env name.
  for (const field of ["primaryEnv", "archiveEnv"]) {
    const value = rpc[field];
    if (typeof value === "string" && /^https?:\/\//.test(value)) {
      errors.push(`${path}.${field} must be an env-var name, not a URL`);
    }
  }
}

function validateExplorer(explorer, path, errors) {
  if (!isPlainObject(explorer)) {
    errors.push(`${path} must be an object`);
    return;
  }
  for (const field of ["name", "baseUrl", "txUrlTemplate", "addressUrlTemplate"]) {
    if (typeof explorer[field] !== "string" || explorer[field].length === 0) {
      errors.push(`${path}.${field} must be a non-empty string`);
    }
  }
}

function validateVenues(venues, label, errors) {
  if (!isPlainObject(venues)) {
    errors.push(`${label}: venues must be an object`);
    return;
  }
  for (const venue of KNOWN_VENUES) {
    if (!(venue in venues)) {
      errors.push(`${label}: venues.${venue} must be declared explicitly`);
      continue;
    }
    const entry = venues[venue];
    if (!isPlainObject(entry) || typeof entry.enabled !== "boolean") {
      errors.push(`${label}: venues.${venue}.enabled must be a boolean`);
      continue;
    }
    for (const field of VENUE_ADDRESS_FIELDS) {
      if (field in entry && entry[field] !== null && !isAddress(entry[field])) {
        errors.push(`${label}: venues.${venue}.${field} must be null or a non-zero address`);
      }
    }
    if ("initCodeHash" in entry && entry.initCodeHash !== null && !isBytes32(entry.initCodeHash)) {
      errors.push(`${label}: venues.${venue}.initCodeHash must be null or bytes32`);
    }
  }
  for (const venue of Object.keys(venues)) {
    if (!KNOWN_VENUES.includes(venue)) {
      errors.push(`${label}: unknown venue "${venue}" (add it to KNOWN_VENUES first)`);
    }
  }
}

function validateAggregators(aggregators, label, errors) {
  if (aggregators === undefined) return;
  if (!isPlainObject(aggregators)) {
    errors.push(`${label}: aggregators must be an object`);
    return;
  }
  for (const [name, entry] of Object.entries(aggregators)) {
    if (!isPlainObject(entry) || typeof entry.enabled !== "boolean") {
      errors.push(`${label}: aggregators.${name}.enabled must be a boolean`);
    }
  }
}

/**
 * Validate the chain-specific extension capabilities (issue #11).
 *
 * Every known capability must be declared explicitly with a boolean `enabled`.
 * An enabled capability must satisfy its deployment requirement: Ethereum-only
 * capabilities may only be enabled on Ethereum (so no Ethereum address is
 * reachable from another chain), and any required venues must be enabled.
 *
 * @param {unknown} capabilities
 * @param {number} chainId
 * @param {Record<string, { enabled: boolean }>|undefined} venues
 * @param {string} label
 * @param {string[]} errors
 */
function validateCapabilities(capabilities, chainId, venues, label, errors) {
  if (!isPlainObject(capabilities)) {
    errors.push(`${label}: capabilities must be an object`);
    return;
  }
  for (const capability of KNOWN_CAPABILITIES) {
    if (!(capability in capabilities)) {
      errors.push(`${label}: capabilities.${capability} must be declared explicitly`);
      continue;
    }
    const entry = capabilities[capability];
    if (!isPlainObject(entry) || typeof entry.enabled !== "boolean") {
      errors.push(`${label}: capabilities.${capability}.enabled must be a boolean`);
      continue;
    }
    if (!entry.enabled) continue;

    const definition = CAPABILITY_DEFINITIONS[capability];
    if (definition.ethereumOnly && chainId !== ETHEREUM_CHAIN_ID) {
      errors.push(
        `${label}: capabilities.${capability} is Ethereum-only and cannot be enabled on chain ${chainId}`,
      );
    }
    for (const venue of definition.requiresVenues) {
      if (!venues?.[venue]?.enabled) {
        errors.push(
          `${label}: capabilities.${capability} requires venues.${venue} to be enabled`,
        );
      }
    }
  }
  for (const capability of Object.keys(capabilities)) {
    if (!KNOWN_CAPABILITIES.includes(capability)) {
      errors.push(
        `${label}: unknown capability "${capability}" (add it to KNOWN_CAPABILITIES first)`,
      );
    }
  }
}

/** Addresses keyed by singleton role for one chain (null roles omitted). */
function singletonAddresses(config) {
  const map = new Map();
  const setRole = (role, value) => {
    if (typeof value === "string" && value !== null) map.set(role, value.toLowerCase());
  };
  setRole("wrappedNative", config.wrappedNative?.address);
  setRole("router", config.router);
  setRole("quoter", config.quoter);
  setRole("multicall3", config.multicall3);
  setRole("permit2", config.permit2);
  setRole("setwisePoolRegistry", config.venues?.setwise?.poolRegistry);
  setRole("setwiseTokenHub", config.venues?.setwise?.tokenHub);
  return map;
}

function collectSingletonDuplicates(config, label, errors) {
  const seen = new Map();
  for (const [role, address] of singletonAddresses(config)) {
    if (seen.has(address)) {
      errors.push(
        `${label}: address ${address} used for both ${seen.get(address)} and ${role}`,
      );
    } else {
      seen.set(address, role);
    }
  }
}

/**
 * Cross-chain validation over the whole registry.
 *
 * @param {Map<number, ChainConfig>} chains
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateRegistry(chains) {
  const errors = [];

  const ids = [...chains.keys()];
  if (new Set(ids).size !== ids.length) {
    errors.push("registry: duplicate chain ids detected");
  }
  const keys = [...chains.values()].map((c) => c.key);
  if (new Set(keys).size !== keys.length) {
    errors.push("registry: duplicate chain keys detected");
  }

  // address (lowercased) -> `${chainId}:${role}` for chain-unique roles.
  const seen = new Map();
  const recordUnique = (chainId, role, value) => {
    if (typeof value !== "string" || value === null) return;
    const address = value.toLowerCase();
    const where = `${chainId}:${role}`;
    if (seen.has(address) && seen.get(address) !== where) {
      errors.push(
        `registry: address ${address} reused across ${seen.get(address)} and ${where}`,
      );
    } else {
      seen.set(address, where);
    }
  };

  for (const [chainId, config] of chains) {
    recordUnique(chainId, "wrappedNative", config.wrappedNative?.address);
    recordUnique(chainId, "router", config.router);
    recordUnique(chainId, "quoter", config.quoter);
    for (const venue of KNOWN_VENUES) {
      const entry = config.venues?.[venue];
      if (!entry) continue;
      for (const field of VENUE_ADDRESS_FIELDS) {
        recordUnique(chainId, `${venue}.${field}`, entry[field]);
      }
    }
    // multicall3 / permit2 are intentionally exempt (CROSS_CHAIN_CONSISTENT_ROLES).
    void CROSS_CHAIN_CONSISTENT_ROLES;
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Typed multi-chain configuration registry.
 *
 * Loads every `config/chains/<chainId>.json`, validates each file and the
 * registry as a whole, and exposes chain lookups keyed by chain id.
 *
 * Lookups are strict: an unsupported or missing chain id throws instead of
 * silently falling back to Ethereum (or any other chain). Services must always
 * pass an explicit chain id.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateChainConfig, validateRegistry } from "./schema.mjs";

const chainsDir = join(dirname(fileURLToPath(import.meta.url)), "chains");

export class ConfigValidationError extends Error {
  constructor(errors) {
    super(`chain configuration failed validation:\n- ${errors.join("\n- ")}`);
    this.name = "ConfigValidationError";
    this.errors = errors;
  }
}

export class UnsupportedChainError extends Error {
  constructor(chainId, supported) {
    super(
      `unsupported chain id "${chainId}"; supported chains: ${supported.join(", ")}. ` +
        "No implicit fallback is provided; pass an explicit supported chain id.",
    );
    this.name = "UnsupportedChainError";
    this.chainId = chainId;
    this.supported = supported;
  }
}

/**
 * Load and validate every chain config from disk.
 *
 * @param {string} [dir] Override the chains directory (used by tests).
 * @returns {Map<number, import("./schema.mjs").ChainConfig>}
 */
export function loadRegistry(dir = chainsDir) {
  const files = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
  if (files.length === 0) {
    throw new ConfigValidationError([`no chain configs found in ${dir}`]);
  }

  const errors = [];
  const chains = new Map();
  for (const file of files) {
    const expectedChainId = Number.parseInt(file.replace(/\.json$/, ""), 10);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch (err) {
      errors.push(`${file}: invalid JSON (${err.message})`);
      continue;
    }
    const result = validateChainConfig(parsed, expectedChainId);
    if (!result.valid) {
      errors.push(...result.errors.map((e) => `${file}: ${e}`));
      continue;
    }
    if (chains.has(parsed.chainId)) {
      errors.push(`${file}: duplicate chain id ${parsed.chainId}`);
      continue;
    }
    chains.set(parsed.chainId, parsed);
  }

  const registryResult = validateRegistry(chains);
  if (!registryResult.valid) errors.push(...registryResult.errors);

  if (errors.length > 0) throw new ConfigValidationError(errors);
  return chains;
}

let cached = null;

/** Memoized registry loaded from the committed `config/chains/` directory. */
export function registry() {
  if (!cached) cached = loadRegistry();
  return cached;
}

/** @returns {number[]} Sorted list of supported chain ids. */
export function supportedChainIds() {
  return [...registry().keys()].sort((a, b) => a - b);
}

/** @param {number} chainId @returns {boolean} */
export function isSupportedChain(chainId) {
  return registry().has(Number(chainId));
}

/**
 * Resolve a chain config by id. Throws for unsupported chains — there is no
 * default and no fallback to Ethereum.
 *
 * @param {number} chainId
 * @returns {import("./schema.mjs").ChainConfig}
 */
export function getChainConfig(chainId) {
  const id = Number(chainId);
  const chains = registry();
  const config = chains.get(id);
  if (!config) throw new UnsupportedChainError(chainId, supportedChainIds());
  return config;
}

/** @returns {Map<number, import("./schema.mjs").ChainConfig>} */
export function getAllChains() {
  return registry();
}

/** Reset the memoized registry (used by tests). */
export function _resetRegistryCache() {
  cached = null;
}

/**
 * EIP-1967 / UUPS proxy detection helpers.
 */

import {
  EIP1967_IMPLEMENTATION_SLOT,
  IMPLEMENTATION_SELECTOR,
  UUPS_PROXIABLE_UUID_SELECTOR,
} from "./constants.mjs";
import { getCode, getStorageAt } from "./rpc.mjs";

const ZERO_WORD = `0x${"0".repeat(64)}`;

/**
 * Parse an address from a 32-byte storage word (last 20 bytes).
 *
 * @param {string} word
 * @returns {string|null}
 */
export function addressFromStorageWord(word) {
  if (typeof word !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(word)) return null;
  if (word.toLowerCase() === ZERO_WORD) return null;
  return `0x${word.slice(-40)}`;
}

/**
 * Read the EIP-1967 implementation pointer for a proxy address.
 *
 * @param {string} rpcUrl
 * @param {string} proxyAddress
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<string|null>}
 */
export async function readEip1967Implementation(rpcUrl, proxyAddress, options = {}) {
  const slot = await getStorageAt(rpcUrl, proxyAddress, EIP1967_IMPLEMENTATION_SLOT, options);
  return addressFromStorageWord(slot);
}

/**
 * Heuristic classification of an on-chain address.
 *
 * @param {string} code
 * @returns {"empty"|"eip1967-proxy"|"minimal-proxy"|"contract"}
 */
export function classifyBytecode(code) {
  if (typeof code !== "string" || code === "0x" || code.length <= 2) return "empty";
  const normalized = code.toLowerCase();
  if (normalized.includes("360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d938fcb")) {
    return "eip1967-proxy";
  }
  // ERC-1167 minimal proxy prefix
  if (normalized.startsWith("0x363d3d373d3d3d363d73")) return "minimal-proxy";
  return "contract";
}

/**
 * Detect whether runtime bytecode exposes the UUPS proxiableUUID selector.
 *
 * @param {string} code
 * @returns {boolean}
 */
export function bytecodeHasUupsInterface(code) {
  return (
    typeof code === "string" &&
    code.toLowerCase().includes(UUPS_PROXIABLE_UUID_SELECTOR.slice(2))
  );
}

/**
 * Detect whether runtime bytecode exposes a generic implementation() selector.
 *
 * @param {string} code
 * @returns {boolean}
 */
export function bytecodeHasImplementationSelector(code) {
  return (
    typeof code === "string" &&
    code.toLowerCase().includes(IMPLEMENTATION_SELECTOR.slice(2))
  );
}

/**
 * Inspect an address and distinguish proxy vs implementation roles.
 *
 * @param {string} rpcUrl
 * @param {string} address
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{
 *   address: string,
 *   code: string,
 *   classification: ReturnType<typeof classifyBytecode>,
 *   eip1967Implementation: string|null,
 *   hasUupsInterface: boolean,
 *   role: "proxy"|"implementation"|"unknown"|"empty"
 * }>}
 */
export async function inspectAddress(rpcUrl, address, options = {}) {
  const code = await getCode(rpcUrl, address, options);
  const classification = classifyBytecode(code);
  const eip1967Implementation = await readEip1967Implementation(rpcUrl, address, options);
  const hasUupsInterface = bytecodeHasUupsInterface(code);

  let role = "unknown";
  if (classification === "empty") role = "empty";
  else if (eip1967Implementation || classification === "eip1967-proxy") role = "proxy";
  else if (hasUupsInterface) role = "implementation";

  return {
    address,
    code,
    classification,
    eip1967Implementation,
    hasUupsInterface,
    role,
  };
}

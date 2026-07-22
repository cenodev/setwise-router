/**
 * Keccak-256 helpers for runtime bytecode verification.
 */

import { spawnSync } from "node:child_process";

function resolveCast() {
  if (process.env.CAST_BIN) return process.env.CAST_BIN;
  const which = spawnSync("command", ["-v", "cast"], {
    shell: true,
    encoding: "utf8",
  });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  return null;
}

/**
 * Compute keccak256 of a hex string (with or without 0x prefix).
 *
 * @param {string} hex
 * @returns {string} 0x-prefixed 32-byte hash
 */
export function keccak256Hex(hex) {
  const cast = resolveCast();
  if (!cast) {
    throw new Error("cast is required for bytecode hashing; install Foundry or set CAST_BIN");
  }
  const normalized = hex.startsWith("0x") ? hex : `0x${hex}`;
  const result = spawnSync(cast, ["keccak", normalized], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || "cast keccak failed");
  }
  return result.stdout.trim();
}

/**
 * Hash the runtime bytecode returned by eth_getCode.
 *
 * @param {string} code
 * @returns {string}
 */
export function runtimeBytecodeHash(code) {
  if (typeof code !== "string" || code === "0x") {
    return `0x${"0".repeat(64)}`;
  }
  return keccak256Hex(code);
}

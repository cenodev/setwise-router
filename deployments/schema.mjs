/**
 * Schema and validation for committed deployment manifests.
 *
 * Manifests are deterministic (no timestamps), schema-validated, and fail closed
 * on invalid chain or address configuration. UUPS proxy entries must carry a
 * separate implementation record with bytecode metadata.
 */

import { isAddress } from "../config/schema.mjs";
import {
  MANIFEST_CONTRACT_KINDS,
  MANIFEST_CONTRACT_ROLES,
  MANIFEST_SCHEMA_VERSION,
  MANIFEST_STATUSES,
} from "./constants.mjs";

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTxHash(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isBytecodeHash(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function validateCompiler(compiler, path, errors) {
  if (!isPlainObject(compiler)) {
    errors.push(`${path} must be an object`);
    return;
  }
  for (const field of ["profile", "solcVersion"]) {
    if (typeof compiler[field] !== "string" || compiler[field].length === 0) {
      errors.push(`${path}.${field} must be a non-empty string`);
    }
  }
  if ("optimizer" in compiler && typeof compiler.optimizer !== "boolean") {
    errors.push(`${path}.optimizer must be a boolean`);
  }
  if (
    "optimizerRuns" in compiler &&
    (!Number.isInteger(compiler.optimizerRuns) || compiler.optimizerRuns < 0)
  ) {
    errors.push(`${path}.optimizerRuns must be a non-negative integer`);
  }
  if ("evmVersion" in compiler && typeof compiler.evmVersion !== "string") {
    errors.push(`${path}.evmVersion must be a string`);
  }
}

function validateExplorer(explorer, path, errors) {
  if (!isPlainObject(explorer)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (typeof explorer.addressUrl !== "string" || explorer.addressUrl.length === 0) {
    errors.push(`${path}.addressUrl must be a non-empty string`);
  }
  if ("transactionUrl" in explorer) {
    if (typeof explorer.transactionUrl !== "string" || explorer.transactionUrl.length === 0) {
      errors.push(`${path}.transactionUrl must be a non-empty string`);
    }
  }
}

function validateDeployment(deployment, path, errors) {
  if (!isPlainObject(deployment)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (!isTxHash(deployment.transactionHash)) {
    errors.push(`${path}.transactionHash must be a 32-byte hex hash`);
  }
  if (
    !Number.isInteger(deployment.blockNumber) ||
    deployment.blockNumber < 0
  ) {
    errors.push(`${path}.blockNumber must be a non-negative integer`);
  }
}

function validateImplementation(impl, path, errors, { requireAddress = true } = {}) {
  if (!isPlainObject(impl)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (impl.kind !== "implementation") {
    errors.push(`${path}.kind must be "implementation"`);
  }
  if (requireAddress && !isAddress(impl.address)) {
    errors.push(`${path}.address must be a non-zero address`);
  } else if ("address" in impl && impl.address !== null && !isAddress(impl.address)) {
    errors.push(`${path}.address must be null or a non-zero address`);
  }
  if (!isBytecodeHash(impl.bytecodeHash)) {
    errors.push(`${path}.bytecodeHash must be a 32-byte hex hash`);
  }
  validateCompiler(impl.compiler, `${path}.compiler`, errors);
  if (!Array.isArray(impl.constructorInputs)) {
    errors.push(`${path}.constructorInputs must be an array`);
  }
}

function validateContractEntry(name, entry, label, errors) {
  if (!isPlainObject(entry)) {
    errors.push(`${label}.contracts.${name} must be an object`);
    return;
  }

  if (!(name in MANIFEST_CONTRACT_ROLES)) {
    errors.push(`${label}.contracts.${name}: unknown contract role`);
  }

  if (!MANIFEST_STATUSES.includes(entry.status)) {
    errors.push(`${label}.contracts.${name}.status must be one of: ${MANIFEST_STATUSES.join(", ")}`);
    return;
  }

  const role = MANIFEST_CONTRACT_ROLES[name];
  if (entry.displayName !== undefined && typeof entry.displayName !== "string") {
    errors.push(`${label}.contracts.${name}.displayName must be a string`);
  } else if (entry.displayName !== undefined && entry.displayName !== role.displayName) {
    errors.push(
      `${label}.contracts.${name}.displayName must be "${role.displayName}" (UI label uses Set)`,
    );
  }

  if (entry.status === "pending") {
    if (entry.kind !== role.kind) {
      errors.push(`${label}.contracts.${name}.kind must be "${role.kind}" for pending entries`);
    }
    for (const field of ["address", "implementation", "deployment", "explorer", "bytecodeHash"]) {
      if (field in entry) {
        errors.push(`${label}.contracts.${name}: pending entries must not include ${field}`);
      }
    }
    return;
  }

  if (!MANIFEST_CONTRACT_KINDS.includes(entry.kind)) {
    errors.push(`${label}.contracts.${name}.kind must be one of: ${MANIFEST_CONTRACT_KINDS.join(", ")}`);
  }
  if (entry.kind !== role.kind) {
    errors.push(`${label}.contracts.${name}.kind must be "${role.kind}"`);
  }
  if (!isAddress(entry.address)) {
    errors.push(`${label}.contracts.${name}.address must be a non-zero address`);
  }

  validateDeployment(entry.deployment, `${label}.contracts.${name}.deployment`, errors);
  validateExplorer(entry.explorer, `${label}.contracts.${name}.explorer`, errors);

  if (entry.kind === "uups-proxy") {
    if (!isPlainObject(entry.implementation)) {
      errors.push(`${label}.contracts.${name}.implementation is required for uups-proxy entries`);
    } else {
      validateImplementation(
        entry.implementation,
        `${label}.contracts.${name}.implementation`,
        errors,
      );
      if (
        isAddress(entry.address) &&
        isAddress(entry.implementation.address) &&
        entry.address.toLowerCase() === entry.implementation.address.toLowerCase()
      ) {
        errors.push(
          `${label}.contracts.${name}: proxy address must differ from implementation address`,
        );
      }
    }
  } else if ("implementation" in entry) {
    errors.push(`${label}.contracts.${name}: direct contracts must not include implementation`);
  }

  if ("bytecodeHash" in entry) {
    if (!isBytecodeHash(entry.bytecodeHash)) {
      errors.push(`${label}.contracts.${name}.bytecodeHash must be a 32-byte hex hash`);
    }
  } else if (entry.kind === "direct") {
    errors.push(`${label}.contracts.${name}.bytecodeHash is required for deployed direct contracts`);
  }
  if (!Array.isArray(entry.constructorInputs)) {
    errors.push(`${label}.contracts.${name}.constructorInputs must be an array`);
  } else if (entry.kind === "direct") {
    // constructorInputs required for direct contracts
  }
  if (entry.kind === "direct" && !("constructorInputs" in entry)) {
    errors.push(`${label}.contracts.${name}.constructorInputs is required for deployed direct contracts`);
  }
  if (entry.kind === "direct") {
    validateCompiler(entry.compiler, `${label}.contracts.${name}.compiler`, errors);
  }
}

/**
 * Validate one deployment manifest object.
 *
 * @param {unknown} manifest
 * @param {number} [expectedChainId] Chain id implied by the file name.
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateDeploymentManifest(manifest, expectedChainId) {
  const errors = [];
  const label = `manifest ${expectedChainId ?? "?"}`;

  if (!isPlainObject(manifest)) {
    return { valid: false, errors: ["manifest must be an object"] };
  }

  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    errors.push(`${label}: schemaVersion must be ${MANIFEST_SCHEMA_VERSION}`);
  }
  if (!Number.isInteger(manifest.chainId) || manifest.chainId <= 0) {
    errors.push(`${label}: chainId must be a positive integer`);
  } else if (expectedChainId !== undefined && manifest.chainId !== expectedChainId) {
    errors.push(
      `${label}: chainId ${manifest.chainId} does not match file name (${expectedChainId})`,
    );
  }
  if (typeof manifest.chainKey !== "string" || !/^[a-z0-9-]+$/.test(manifest.chainKey)) {
    errors.push(`${label}: chainKey must be a lowercase slug`);
  }
  if (!isPlainObject(manifest.contracts)) {
    errors.push(`${label}: contracts must be an object`);
    return { valid: errors.length === 0, errors };
  }

  for (const [name, entry] of Object.entries(manifest.contracts)) {
    validateContractEntry(name, entry, label, errors);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Cross-check a manifest against the typed chain config registry.
 *
 * @param {import("../config/schema.mjs").ChainConfig} chainConfig
 * @param {object} manifest
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateManifestAgainstConfig(chainConfig, manifest) {
  const errors = [];
  const label = `chain ${manifest.chainId}`;

  if (chainConfig.chainId !== manifest.chainId) {
    errors.push(`${label}: manifest chainId does not match config registry`);
  }
  if (chainConfig.key !== manifest.chainKey) {
    errors.push(
      `${label}: manifest chainKey "${manifest.chainKey}" does not match config key "${chainConfig.key}"`,
    );
  }

  for (const [name, role] of Object.entries(MANIFEST_CONTRACT_ROLES)) {
    const entry = manifest.contracts?.[name];
    if (!entry) continue;

    const configValue = role.configPath.reduce((obj, key) => obj?.[key], chainConfig) ?? null;

    if (entry.status === "deployed") {
      if (!isAddress(entry.address)) {
        errors.push(`${label}.contracts.${name}: deployed entry missing address`);
        continue;
      }
      if (configValue === null || configValue === undefined) {
        errors.push(
          `${label}.contracts.${name}: manifest is deployed but config registry has no address for ${name}`,
        );
      } else if (typeof configValue === "string") {
        if (entry.address.toLowerCase() !== configValue.toLowerCase()) {
          errors.push(
            `${label}.contracts.${name}: manifest address ${entry.address} does not match config registry ${configValue}`,
          );
        }
      }
    } else if (entry.status === "pending" && isAddress(configValue)) {
      errors.push(
        `${label}.contracts.${name}: config registry has address ${configValue} but manifest is still pending`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Registry-level validation across all manifests.
 *
 * @param {Map<number, object>} manifests
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateManifestRegistry(manifests) {
  const errors = [];
  const ids = [...manifests.keys()];
  if (new Set(ids).size !== ids.length) {
    errors.push("manifest registry: duplicate chain ids detected");
  }

  const keys = [...manifests.values()].map((m) => m.chainKey);
  if (new Set(keys).size !== keys.length) {
    errors.push("manifest registry: duplicate chain keys detected");
  }

  const seen = new Map();
  for (const manifest of manifests.values()) {
    for (const [name, entry] of Object.entries(manifest.contracts ?? {})) {
      if (entry.status !== "deployed" || !isAddress(entry.address)) continue;
      const address = entry.address.toLowerCase();
      const where = `${manifest.chainId}:${name}`;
      if (seen.has(address) && seen.get(address) !== where) {
        errors.push(
          `manifest registry: address ${address} reused across ${seen.get(address)} and ${where}`,
        );
      } else {
        seen.set(address, where);
      }
      if (entry.kind === "uups-proxy" && isAddress(entry.implementation?.address)) {
        const impl = entry.implementation.address.toLowerCase();
        const implWhere = `${manifest.chainId}:${name}.implementation`;
        if (seen.has(impl) && seen.get(impl) !== implWhere) {
          errors.push(
            `manifest registry: implementation ${impl} reused across ${seen.get(impl)} and ${implWhere}`,
          );
        } else {
          seen.set(impl, implWhere);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

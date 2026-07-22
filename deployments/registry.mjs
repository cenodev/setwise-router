/**
 * Load and validate committed deployment manifests from `deployments/`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getChainConfig } from "../config/registry.mjs";
import {
  validateDeploymentManifest,
  validateManifestAgainstConfig,
  validateManifestRegistry,
} from "./schema.mjs";

const deploymentsDir = join(dirname(fileURLToPath(import.meta.url)));

const MANIFEST_FILE_RE = /^[a-z0-9-]+-(\d+)\.json$/;

export class DeploymentManifestError extends Error {
  constructor(errors) {
    super(`deployment manifest validation failed:\n- ${errors.join("\n- ")}`);
    this.name = "DeploymentManifestError";
    this.errors = errors;
  }
}

/**
 * Parse the chain id from a manifest file name (`ethereum-1.json` → 1).
 *
 * @param {string} file
 * @returns {number|null}
 */
export function chainIdFromManifestFile(file) {
  const match = MANIFEST_FILE_RE.exec(file);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Expected manifest file name for a chain config key and id.
 *
 * @param {string} chainKey
 * @param {number} chainId
 */
export function manifestFileName(chainKey, chainId) {
  return `${chainKey}-${chainId}.json`;
}

/**
 * Load every `deployments/<chain-key>-<chain-id>.json` manifest.
 *
 * @param {string} [dir]
 * @returns {Map<number, object>}
 */
export function loadDeploymentManifests(dir = deploymentsDir) {
  const files = readdirSync(dir).filter((f) => MANIFEST_FILE_RE.test(f));
  if (files.length === 0) {
    throw new DeploymentManifestError([`no deployment manifests found in ${dir}`]);
  }

  const errors = [];
  const manifests = new Map();

  for (const file of files) {
    const expectedChainId = chainIdFromManifestFile(file);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch (err) {
      errors.push(`${file}: invalid JSON (${err.message})`);
      continue;
    }

    const result = validateDeploymentManifest(parsed, expectedChainId);
    if (!result.valid) {
      errors.push(...result.errors.map((e) => `${file}: ${e}`));
      continue;
    }

    if (manifests.has(parsed.chainId)) {
      errors.push(`${file}: duplicate chain id ${parsed.chainId}`);
      continue;
    }
    manifests.set(parsed.chainId, parsed);
  }

  const registryResult = validateManifestRegistry(manifests);
  if (!registryResult.valid) errors.push(...registryResult.errors);

  for (const [chainId, manifest] of manifests) {
    try {
      const chainConfig = getChainConfig(chainId);
      const cross = validateManifestAgainstConfig(chainConfig, manifest);
      if (!cross.valid) errors.push(...cross.errors.map((e) => `${fileFor(manifest)}: ${e}`));
    } catch {
      errors.push(`${fileFor(manifest)}: chain ${chainId} is not in the config registry`);
    }
  }

  if (errors.length > 0) throw new DeploymentManifestError(errors);
  return manifests;
}

function fileFor(manifest) {
  return manifestFileName(manifest.chainKey, manifest.chainId);
}

let cached = null;

/** Memoized manifests loaded from the committed `deployments/` directory. */
export function deploymentManifests() {
  if (!cached) cached = loadDeploymentManifests();
  return cached;
}

/** @returns {number[]} */
export function manifestChainIds() {
  return [...deploymentManifests().keys()].sort((a, b) => a - b);
}

/**
 * @param {number} chainId
 * @returns {object}
 */
export function getDeploymentManifest(chainId) {
  const manifest = deploymentManifests().get(Number(chainId));
  if (!manifest) {
    throw new DeploymentManifestError([
      `no deployment manifest for chain id ${chainId}; known manifests: ${manifestChainIds().join(", ")}`,
    ]);
  }
  return manifest;
}

/** Reset memoized manifests (tests). */
export function _resetDeploymentManifestCache() {
  cached = null;
}

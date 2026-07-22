/**
 * Deployment manifest verification and release checklist generation.
 */

import { getChainConfig } from "../config/registry.mjs";
import { MANIFEST_CONTRACT_ROLES } from "./constants.mjs";
import { runtimeBytecodeHash } from "./bytecode.mjs";
import { inspectAddress } from "./proxy.mjs";
import {
  loadDeploymentManifests,
  manifestFileName,
} from "./registry.mjs";
import { assertRpcChainId, resolvePublicRpcUrl } from "./rpc.mjs";

/**
 * @typedef {Object} VerificationFinding
 * @property {"ok"|"warn"|"error"|"skip"} level
 * @property {number} chainId
 * @property {string} contract
 * @property {string} message
 */

/**
 * Offline verification: schema, registry cross-checks, determinism. No RPC.
 *
 * @param {string} [dir]
 * @returns {{ ok: boolean, findings: VerificationFinding[] }}
 */
export function verifyManifestsOffline(dir) {
  const findings = [];
  try {
    const manifests = loadDeploymentManifests(dir);
    for (const [chainId, manifest] of manifests) {
      findings.push({
        level: "ok",
        chainId,
        contract: "*",
        message: `manifest ${manifestFileName(manifest.chainKey, chainId)} validated`,
      });
      for (const [name, entry] of Object.entries(manifest.contracts)) {
        if (entry.status === "pending") {
          findings.push({
            level: "skip",
            chainId,
            contract: name,
            message: `${MANIFEST_CONTRACT_ROLES[name].displayName} pending deployment`,
          });
        }
      }
    }
    return { ok: true, findings };
  } catch (err) {
    const errors = err.errors ?? [err.message];
    for (const message of errors) {
      findings.push({ level: "error", chainId: 0, contract: "*", message });
    }
    return { ok: false, findings };
  }
}

/**
 * On-chain verification for deployed manifest entries. Requires a public RPC;
 * never uses private keys.
 *
 * @param {object} options
 * @param {string} [options.dir]
 * @param {number[]} [options.chainIds]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ ok: boolean, findings: VerificationFinding[] }>}
 */
export async function verifyManifestsOnChain(options = {}) {
  const offline = verifyManifestsOffline(options.dir);
  const findings = [...offline.findings];
  if (!offline.ok) return { ok: false, findings };

  const manifests = loadDeploymentManifests(options.dir);
  const selected = options.chainIds
    ? [...manifests.entries()].filter(([id]) => options.chainIds.includes(id))
    : [...manifests.entries()];

  let ok = true;
  for (const [chainId, manifest] of selected) {
    const chainConfig = getChainConfig(chainId);
    const rpcUrl = resolvePublicRpcUrl(chainConfig);
    if (!rpcUrl) {
      findings.push({
        level: "warn",
        chainId,
        contract: "*",
        message: `no public RPC configured for ${chainConfig.displayName}; skipping on-chain checks`,
      });
      continue;
    }

    try {
      await assertRpcChainId(rpcUrl, chainId, { fetchImpl: options.fetchImpl });
      findings.push({
        level: "ok",
        chainId,
        contract: "*",
        message: `RPC chain id verified (${rpcUrl})`,
      });
    } catch (err) {
      ok = false;
      findings.push({
        level: "error",
        chainId,
        contract: "*",
        message: err.message,
      });
      continue;
    }

    for (const [name, entry] of Object.entries(manifest.contracts)) {
      if (entry.status !== "deployed") continue;

      const roleLabel = MANIFEST_CONTRACT_ROLES[name].displayName;
      const proxyInspection = await inspectAddress(rpcUrl, entry.address, {
        fetchImpl: options.fetchImpl,
      });

      if (proxyInspection.role === "empty") {
        ok = false;
        findings.push({
          level: "error",
          chainId,
          contract: name,
          message: `${roleLabel} proxy ${entry.address} has no code on-chain`,
        });
        continue;
      }

      if (entry.kind === "uups-proxy") {
        if (proxyInspection.role !== "proxy") {
          ok = false;
          findings.push({
            level: "error",
            chainId,
            contract: name,
            message: `${roleLabel} ${entry.address} is not classified as a proxy (got ${proxyInspection.role})`,
          });
        } else {
          findings.push({
            level: "ok",
            chainId,
            contract: name,
            message: `${roleLabel} proxy ${entry.address} detected (EIP-1967 implementation ${proxyInspection.eip1967Implementation ?? "unknown"})`,
          });
        }

        const impl = entry.implementation;
        const implInspection = await inspectAddress(rpcUrl, impl.address, {
          fetchImpl: options.fetchImpl,
        });
        if (implInspection.role === "empty") {
          ok = false;
          findings.push({
            level: "error",
            chainId,
            contract: name,
            message: `${roleLabel} implementation ${impl.address} has no code on-chain`,
          });
        } else if (implInspection.role === "proxy") {
          ok = false;
          findings.push({
            level: "error",
            chainId,
            contract: name,
            message: `${roleLabel} implementation ${impl.address} looks like a proxy, not an implementation`,
          });
        } else {
          findings.push({
            level: "ok",
            chainId,
            contract: name,
            message: `${roleLabel} implementation ${impl.address} has contract code`,
          });
        }

        if (proxyInspection.eip1967Implementation) {
          const expected = impl.address.toLowerCase();
          const actual = proxyInspection.eip1967Implementation.toLowerCase();
          if (expected !== actual) {
            ok = false;
            findings.push({
              level: "error",
              chainId,
              contract: name,
              message: `${roleLabel} proxy points to ${actual}, manifest expects ${expected}`,
            });
          }
        }

        const implHash = runtimeBytecodeHash(implInspection.code);
        if (implHash.toLowerCase() !== impl.bytecodeHash.toLowerCase()) {
          ok = false;
          findings.push({
            level: "error",
            chainId,
            contract: name,
            message: `${roleLabel} implementation bytecode hash mismatch (on-chain ${implHash}, manifest ${impl.bytecodeHash})`,
          });
        } else {
          findings.push({
            level: "ok",
            chainId,
            contract: name,
            message: `${roleLabel} implementation bytecode hash matches manifest`,
          });
        }
      } else {
        if (proxyInspection.role === "proxy") {
          ok = false;
          findings.push({
            level: "error",
            chainId,
            contract: name,
            message: `${roleLabel} ${entry.address} is a proxy but manifest marks it as a direct contract`,
          });
          continue;
        }

        const hash = runtimeBytecodeHash(proxyInspection.code);
        if (hash.toLowerCase() !== entry.bytecodeHash.toLowerCase()) {
          ok = false;
          findings.push({
            level: "error",
            chainId,
            contract: name,
            message: `${roleLabel} bytecode hash mismatch (on-chain ${hash}, manifest ${entry.bytecodeHash})`,
          });
        } else {
          findings.push({
            level: "ok",
            chainId,
            contract: name,
            message: `${roleLabel} bytecode hash matches manifest`,
          });
        }
      }
    }
  }

  return { ok, findings };
}

/**
 * Render a human-readable release checklist from verification findings.
 *
 * @param {VerificationFinding[]} findings
 * @returns {string}
 */
export function formatReleaseChecklist(findings) {
  const lines = ["# Setwise Router deployment release checklist", ""];
  const byChain = new Map();
  for (const finding of findings) {
    if (!byChain.has(finding.chainId)) byChain.set(finding.chainId, []);
    byChain.get(finding.chainId).push(finding);
  }

  for (const chainId of [...byChain.keys()].sort((a, b) => a - b)) {
    const label = chainId === 0 ? "registry" : `chain ${chainId}`;
    lines.push(`## ${label}`, "");
    for (const finding of byChain.get(chainId)) {
      const icon =
        finding.level === "ok"
          ? "[x]"
          : finding.level === "skip"
            ? "[ ]"
            : finding.level === "warn"
              ? "[~]"
              : "[!]";
      const contract =
        finding.contract === "*" ? "manifest" : `${finding.contract}`;
      lines.push(`- ${icon} **${contract}**: ${finding.message}`);
    }
    lines.push("");
  }

  const errors = findings.filter((f) => f.level === "error").length;
  const warns = findings.filter((f) => f.level === "warn").length;
  lines.push(
    "## Summary",
    "",
    `- Errors: ${errors}`,
    `- Warnings: ${warns}`,
    `- Release ready: ${errors === 0 ? "yes (pending items may remain)" : "no"}`,
  );
  return lines.join("\n");
}

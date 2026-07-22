#!/usr/bin/env node
/**
 * Verify committed deployment manifests and optionally check on-chain state.
 *
 * Offline schema validation runs without RPC credentials or private keys.
 * `--on-chain` uses each chain's public RPC (or a credentialed URL already
 * present in the environment) after verifying eth_chainId.
 *
 * Usage:
 *   node scripts/verify-deployments.mjs
 *   node scripts/verify-deployments.mjs --on-chain
 *   node scripts/verify-deployments.mjs --checklist > checklist.md
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatReleaseChecklist,
  verifyManifestsOffline,
  verifyManifestsOnChain,
} from "../deployments/verify.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = {
    onChain: false,
    checklist: false,
    chainIds: [],
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--on-chain") options.onChain = true;
    else if (arg === "--checklist") options.checklist = true;
    else if (arg === "--chain") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value)) throw new Error("--chain requires a numeric chain id");
      options.chainIds.push(value);
    } else if (arg === "--out") {
      options.out = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  process.stdout.write(`verify-deployments — schema and on-chain deployment checks

Options:
  --on-chain          Verify code presence, bytecode hashes, and UUPS proxies
  --checklist         Print a human-readable release checklist
  --chain <id>        Limit on-chain verification to one chain (repeatable)
  --out <path>        Write checklist markdown to a file
  -h, --help          Show this help
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const chainIds = options.chainIds.length > 0 ? options.chainIds : undefined;

  const result = options.onChain
    ? await verifyManifestsOnChain({ chainIds })
    : verifyManifestsOffline();

  if (options.checklist || options.out) {
    const checklist = formatReleaseChecklist(result.findings);
    if (options.out) {
      writeFileSync(join(root, options.out), checklist);
      console.log(`wrote ${options.out}`);
    } else {
      console.log(checklist);
    }
  } else {
    for (const finding of result.findings) {
      const prefix =
        finding.level === "error"
          ? "ERROR"
          : finding.level === "warn"
            ? "WARN"
            : finding.level === "skip"
              ? "SKIP"
              : "OK";
      const scope =
        finding.chainId === 0
          ? "registry"
          : `chain ${finding.chainId}/${finding.contract}`;
      console.log(`${prefix} ${scope}: ${finding.message}`);
    }
  }

  if (!result.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});

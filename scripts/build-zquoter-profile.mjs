#!/usr/bin/env node
/**
 * Build zFi-main with the `zquoter` Foundry profile (optimizer_runs=20, yul=false).
 *
 * Upstream DAO contracts fail under yul=false, so they are skipped — matching
 * zFi-main/script/extract_zQuoter_bytecode.sh — without mutating the tree.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveForge, runForge } from "./lib/forge.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const zfi = join(root, "zFi-main");

const forge = resolveForge();
if (!forge) {
  console.error("forge not found. Install Foundry from https://getfoundry.sh/");
  process.exit(1);
}

const result = runForge(
  forge,
  [
    "build",
    "--skip",
    "src/dao/**",
    "--skip",
    "test/**",
    "--skip",
    "script/**",
  ],
  {
    cwd: zfi,
    env: { ...process.env, FOUNDRY_PROFILE: "zquoter" },
  },
);

process.exit(result.status ?? 1);

#!/usr/bin/env node
/**
 * Gate deployed bytecode sizes for the contracts that must stay deployable.
 *
 * - zRouter: measured under the default Foundry profile (production recipe).
 * - zQuoter: measured under the `zquoter` profile (EIP-170 deploy recipe).
 *
 * Fails when either runtime size exceeds EIP-170 (24,576 bytes), or when the
 * soft headroom budget is exhausted so regressions fail *before* the hard limit.
 *
 * By default each contract is rebuilt under its profile before measuring, because
 * Foundry writes both artifacts into the same `out/` directory.
 *
 * Flags:
 *   --artifacts-only   Do not rebuild; measure whatever is currently in `out/`.
 *   --only <name>      Check a single contract (`zRouter` or `zQuoter`).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EIP170_MAX, deployedBytecodeSize } from "./lib/forge.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "zFi-main", "out");
const artifactsOnly = process.argv.includes("--artifacts-only");

const onlyIdx = process.argv.indexOf("--only");
const onlyName =
  onlyIdx >= 0 && process.argv[onlyIdx + 1]
    ? process.argv[onlyIdx + 1]
    : null;

/** Soft budget: fail a few bytes before EIP-170 so CI catches regressions early. */
const SOFT_HEADROOM = 16;

const ALL_CHECKS = [
  {
    name: "zRouter",
    profile: "default",
    buildScript: "build-zfi-baseline.mjs",
    artifact: join(outDir, "zRouter.sol", "zRouter.json"),
    softMax: EIP170_MAX - SOFT_HEADROOM,
  },
  {
    name: "zQuoter",
    profile: "zquoter",
    buildScript: "build-zquoter-profile.mjs",
    artifact: join(outDir, "zQuoter.sol", "zQuoter.json"),
    softMax: EIP170_MAX - SOFT_HEADROOM,
  },
];

const CHECKS = onlyName
  ? ALL_CHECKS.filter((c) => c.name.toLowerCase() === onlyName.toLowerCase())
  : ALL_CHECKS;

if (onlyName && CHECKS.length === 0) {
  console.error(`unknown --only value: ${onlyName} (expected zRouter or zQuoter)`);
  process.exit(1);
}

function loadSize(path) {
  if (!existsSync(path)) return null;
  return deployedBytecodeSize(JSON.parse(readFileSync(path, "utf8")));
}

function runBuild(script) {
  const result = spawnSync(process.execPath, [join(root, "scripts", script)], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  if ((result.status ?? 1) !== 0) {
    console.error(`build failed: ${script}`);
    process.exit(result.status ?? 1);
  }
}

const rows = [];
let failed = false;

for (const check of CHECKS) {
  if (!artifactsOnly) {
    console.log(`\n==> building ${check.name} with ${check.profile} profile`);
    runBuild(check.buildScript);
  }

  const size = loadSize(check.artifact);
  if (size === null) {
    console.error(
      `missing ${check.name} artifact (${check.profile} profile). ` +
        (artifactsOnly
          ? "Build the required profile before --artifacts-only."
          : "Build step did not produce the artifact."),
    );
    failed = true;
    continue;
  }

  const margin = EIP170_MAX - size;
  const hardOk = size <= EIP170_MAX;
  const softOk = size <= check.softMax;
  rows.push({ ...check, size, margin, hardOk, softOk });

  console.log(
    `${check.name} (${check.profile}): ${size} bytes, ` +
      `EIP-170 margin ${margin} (limit ${EIP170_MAX}, soft max ${check.softMax})`,
  );

  if (!hardOk) {
    console.error(`FAIL ${check.name}: exceeds EIP-170 by ${-margin} bytes`);
    failed = true;
  } else if (!softOk) {
    console.error(
      `FAIL ${check.name}: within EIP-170 but past soft budget ` +
        `(${size} > ${check.softMax}; only ${margin} bytes of headroom)`,
    );
    failed = true;
  }
}

if (process.env.GITHUB_STEP_SUMMARY) {
  const table = [
    "## Bytecode sizes",
    "",
    "| Contract | Profile | Runtime (B) | EIP-170 margin (B) | Soft max (B) |",
    "| --- | --- | ---: | ---: | ---: |",
    ...rows.map(
      (r) =>
        `| ${r.name} | \`${r.profile}\` | ${r.size} | ${r.margin} | ${r.softMax} |`,
    ),
    "",
    failed ? "**Result:** failed" : "**Result:** passed",
    "",
  ].join("\n");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
}

process.exit(failed ? 1 : 0);
